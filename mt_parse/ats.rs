use crate::mt_parse::extra_meta::*;
use crate::mt_parse::mt::{ChannelType, MTFileParser, TimeSeries};
use crate::mt_parse::utils::ParseUtils;
use anyhow::{anyhow, bail, Result};
use byteorder::{BigEndian, LittleEndian, ReadBytesExt};
use memmap2::Mmap;
use ndarray::Array1;
use num_complex::Complex;
use std::fs::{read_dir, File};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

fn read_next_sample(cursor: &mut Cursor<&[u8]>, lsb: &f64) -> Result<Option<f64>> {
    if (cursor.position() as usize) < cursor.get_ref().len() {
        // let raw_value = cursor.read_i32::<BigEndian>()?;
        // Ok(Some(raw_value as f64 * lsb * 1000.0))
        let raw_value = cursor.read_i32::<LittleEndian>()?;
        Ok(Some(raw_value as f64 * lsb))
    } else {
        Ok(None)
    }
}

#[derive(Debug, Clone)]
pub struct AtsCalibrationData {
    pub freqs: Array1<f64>,
    pub responses: Array1<Complex<f64>>,
}

#[derive(Debug, Clone)]
pub struct AtsParser {}

impl AtsParser {
    // 时间转换：SystemTime -> i64 (nanos since epoch)
    fn system_time_to_millis(t: &SystemTime) -> i64 {
        match t.duration_since(SystemTime::UNIX_EPOCH) {
            Ok(d) => d.as_millis() as i64,
            Err(e) => -(e.duration().as_millis() as i64),
        }
    }

    pub fn parse_station_id(file_name: &str) -> Option<String> {
        file_name.split('_').next().map(|s| s.to_string())
    }
    /*
        pub fn parse_bound_frequency(file_name: &str) -> anyhow::Result<FrequencyBand> {
            let last_band_str = file_name
                .split('_')
                .last()
                .ok_or_else(|| anyhow::anyhow!("Invalid file name format: {}", file_name))?;
            println!("last_band_str: {}", last_band_str);
            let band_str = last_band_str
                .char_indices()
                .last()
                .map(|(i, _)| &last_band_str[i..])
                .unwrap();

            FrequencyBand::try_from(band_str)
        }
    */
    pub fn get_calibration_file_name(path: &Path) -> anyhow::Result<PathBuf> {
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("无法获取文件名"))?;
        let pure_file_name = if let Some(dot_index) = file_name.find('.') {
            &file_name[..dot_index]
        } else {
            file_name
        };
        let split_file_name: Vec<&str> = pure_file_name.split('_').collect();
        let station_id = split_file_name
            .first()
            .ok_or_else(|| anyhow!("文件名格式无效，无法提取站点ID"))?;
        let last_band_str = format!(
            "{}.xml",
            split_file_name
                .last()
                .ok_or_else(|| anyhow!("文件名格式无效，无法提取频带信息"))?
        );
        let dir = path.parent().ok_or_else(|| anyhow!("无法获取文件父目录"))?;
        for entry in read_dir(dir)? {
            let entry = entry?;
            let file_name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow!("无法转换文件名"))?;
            if file_name.starts_with(station_id) && file_name.ends_with(&last_band_str) {
                return Ok(entry.path());
            }
        }
        Err(anyhow!(
            "Calibration file not found for station {} and band {}",
            station_id,
            last_band_str
        ))
    }

    pub fn parse_calibration_file(
        path: &Path,
        channel_type: &ChannelType,
        chopper: i8,
    ) -> anyhow::Result<AtsCalibrationData> {
        let file = File::open(path)?;
        let mut reader = std::io::BufReader::new(file);
        let mut content = String::new();
        reader.read_to_string(&mut content)?;

        let doc = roxmltree::Document::parse(&content)?;
        let mut freqs = Vec::new();
        let mut responses = Vec::new();

        // === Step 1: 找 configuration/channel 中的 id ===
        let mut channel_id: Option<String> = None;
        for channel in doc.descendants().filter(|n| n.has_tag_name("channel")) {
            if let Some(ctype) = channel
                .children()
                .find(|n| n.has_tag_name("channel_type"))
                .and_then(|n| n.text())
            {
                if ctype.trim()
                    == match channel_type {
                        ChannelType::Ex => "Ex",
                        ChannelType::Ey => "Ey",
                        ChannelType::Hx => "Hx",
                        ChannelType::Hy => "Hy",
                        ChannelType::Hz => "Hz",
                    }
                {
                    if let Some(id_attr) = channel.attribute("id") {
                        channel_id = Some(id_attr.to_string());
                        break;
                    }
                }
            }
        }

        let channel_type_str: String = (*channel_type).into();
        let id = match channel_id {
            Some(v) => v,
            None => return bail!("channel_type {} not found", channel_type_str),
        };
        eprintln!("found channel_type={} => id={}", channel_type_str, id);

        let chopper_candidates: [&str; 3] = match chopper {
            0 => ["off", "ukn", "on"],
            1 => ["on", "ukn", "off"],
            _ => ["ukn", "on", "off"],
        };

        let is_magnetic = matches!(
            channel_type,
            ChannelType::Hx | ChannelType::Hy | ChannelType::Hz
        );

        if is_magnetic {
            if let Some(sensor_ch) = doc
                .descendants()
                .find(|n| n.has_tag_name("calibration_sensors"))
            {
                for ch in sensor_ch.children().filter(|n| n.has_tag_name("channel")) {
                    if ch.attribute("id") == Some(id.as_str()) {
                        // 查找calibration元素，然后在其中查找caldata元素
                        for calibration in ch.children().filter(|n| n.has_tag_name("calibration")) {
                            for chopper_value in chopper_candidates {
                                let mut tmp_freqs = Vec::new();
                                let mut tmp_responses = Vec::new();
                                for caldata in calibration
                                    .children()
                                    .filter(|n| n.has_tag_name("caldata"))
                                    .filter(|n| n.attribute("chopper") == Some(chopper_value))
                                {
                                    let mut freq = 0.0;
                                    let mut gain = 0.0;
                                    let mut phase = 0.0;
                                    for c in caldata.children().filter(|n| n.is_element()) {
                                        let val = c.text().unwrap_or("").trim();
                                        if val.is_empty() {
                                            continue;
                                        }
                                        match c.tag_name().name() {
                                            "c1" => {
                                                freq = val.parse::<f64>().map_err(|e| {
                                                    anyhow!(
                                                        "Failed to parse c1 value '{}': {}",
                                                        val,
                                                        e
                                                    )
                                                })?
                                            }
                                            "c2" => {
                                                gain = val.parse::<f64>().map_err(|e| {
                                                    anyhow!(
                                                        "Failed to parse c2 value '{}': {}",
                                                        val,
                                                        e
                                                    )
                                                })?
                                            }
                                            "c3" => {
                                                phase = val.parse::<f64>().map_err(|e| {
                                                    anyhow!(
                                                        "Failed to parse c3 value '{}': {}",
                                                        val,
                                                        e
                                                    )
                                                })?
                                            }
                                            _ => {}
                                        }
                                    }
                                    if !(freq.is_finite() && gain.is_finite() && phase.is_finite())
                                    {
                                        continue;
                                    }
                                    if freq < 0.0 {
                                        continue;
                                    }
                                    tmp_freqs.push(freq);
                                    let magnitude = freq * gain * 1000.0f64;
                                    let phase_radians = phase.to_radians();
                                    tmp_responses.push(Complex::new(
                                        magnitude * phase_radians.cos(),
                                        magnitude * phase_radians.sin(),
                                    ));
                                }
                                if !tmp_freqs.is_empty() && tmp_freqs.len() == tmp_responses.len() {
                                    freqs = tmp_freqs;
                                    responses = tmp_responses;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        } else {
            // 电场的校正读取
        }

        if !freqs.is_empty() && freqs.len() == responses.len() {
            let mut pairs: Vec<(f64, Complex<f64>)> = freqs
                .into_iter()
                .zip(responses.into_iter())
                .filter(|(f, _)| f.is_finite())
                .collect();
            pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

            let mut freqs_sorted: Vec<f64> = Vec::with_capacity(pairs.len());
            let mut resp_sorted: Vec<Complex<f64>> = Vec::with_capacity(pairs.len());
            for (f, z) in pairs {
                if let Some(prev) = freqs_sorted.last() {
                    if (f - *prev).abs() <= f64::EPSILON {
                        continue;
                    }
                }
                freqs_sorted.push(f);
                resp_sorted.push(z);
            }
            freqs = freqs_sorted;
            responses = resp_sorted;
        }

        Ok(AtsCalibrationData {
            freqs: Array1::from(freqs),
            responses: Array1::from(responses),
        })
    }

    pub fn parse_header_only(path: &Path) -> anyhow::Result<AtsExtraMeta> {
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("无法获取文件名"))?;

        let station_id =
            AtsParser::parse_station_id(file_name).ok_or_else(|| anyhow!("无法解析站点ID"))?;
        let file = File::open(path)?;
        let mmap = unsafe { Mmap::map(&file)? };

        let mut cursor = Cursor::new(mmap.as_ref());
        let length = cursor.read_i16::<LittleEndian>()?;
        let version = cursor.read_i16::<LittleEndian>()?;
        let nsamples = cursor.read_i32::<LittleEndian>()?;
        if nsamples < 0 {
            return Err(anyhow!("Invalid number of samples: {}", nsamples));
        }

        let sfreq = cursor.read_f32::<LittleEndian>()?;
        let start = cursor.read_i32::<LittleEndian>()?;

        let lsb = cursor.read_f64::<LittleEndian>()?;
        if lsb <= 0.0 {
            return Err(anyhow!("Invalid LSB value: {}", lsb));
        }
        let gmt_offset = cursor.read_i32::<LittleEndian>()?;
        let original_sample_freq = cursor.read_f32::<LittleEndian>()?;
        let adu_serial_number = cursor.read_i16::<LittleEndian>()?;
        let adu_adb = cursor.read_i16::<LittleEndian>()?;
        let channel_number = cursor.read_i8()?;
        let sensor_chopper = cursor.read_i8()?;
        let channel_type: String = ParseUtils::read_char_array_fixed(&mut cursor, 2)?
            .into_iter()
            .map(|c| c.to_ascii_lowercase())
            .collect();
        let sensor: String = ParseUtils::read_char_array_fixed(&mut cursor, 6)?
            .into_iter()
            .filter(|c| *c != '\0')
            .collect();
        let sensor_number = cursor.read_i16::<LittleEndian>()?;
        let x1 = cursor.read_f32::<LittleEndian>()?;
        let y1 = cursor.read_f32::<LittleEndian>()?;
        let z1 = cursor.read_f32::<LittleEndian>()?;
        let x2 = cursor.read_f32::<LittleEndian>()?;
        let y2 = cursor.read_f32::<LittleEndian>()?;
        let z2 = cursor.read_f32::<LittleEndian>()?;
        let dipole_length = cursor.read_f32::<LittleEndian>()?;
        let dipole_angle = cursor.read_f32::<LittleEndian>()?;
        let probe_resistivity = cursor.read_f32::<LittleEndian>()?;
        let dc_offset = cursor.read_f32::<LittleEndian>()?;
        let internal_gain_amplification = cursor.read_f32::<LittleEndian>()?;
        let pos_gain = cursor.read_f32::<LittleEndian>()?;
        let latitude = cursor.read_i32::<LittleEndian>()?;
        let longitude = cursor.read_i32::<LittleEndian>()?;
        let elevation = cursor.read_i32::<LittleEndian>()?;
        let lat_long_type = ParseUtils::read_char_array_fixed(&mut cursor, 1)?
            .into_iter()
            .collect::<String>();
        let additional_coordinates_type = cursor.read_i8()?;
        let reference_meridian = cursor.read_i16::<LittleEndian>()?;
        let x_coordinate = cursor.read_f64::<LittleEndian>()?;
        let y_coordinate = cursor.read_f64::<LittleEndian>()?;
        let gps_status = ParseUtils::read_char_array_fixed(&mut cursor, 1)?
            .into_iter()
            .collect::<String>();
        let gps_accuracy = cursor.read_i8()?;
        let utc_offset = cursor.read_i16::<LittleEndian>()?;
        let system_type: String = ParseUtils::read_char_array_fixed(&mut cursor, 12)?
            .into_iter()
            .filter(|c| *c != '\0')
            .collect();

        let survey_header_filename: String = ParseUtils::read_char_array_fixed(&mut cursor, 12)?
            .into_iter()
            .collect();
        let measurement_type = ParseUtils::read_char_array_fixed(&mut cursor, 4)?
            .into_iter()
            .collect::<String>();
        let dc_offset_correction_value = cursor.read_f64::<LittleEndian>()?;
        let dc_offset_correction_on = cursor.read_i8()?;
        let input_divisor_on = cursor.read_i8()?;
        let bit_indicator = cursor.read_i16::<LittleEndian>()?;
        let self_test_result = ParseUtils::read_char_array_fixed(&mut cursor, 2)?
            .into_iter()
            .collect::<String>();
        let number_slice = cursor.read_u16::<LittleEndian>()?;
        let number_calibration_frequencies = cursor.read_u16::<LittleEndian>()?;

        Ok(AtsExtraMeta {
            station_id,
            length,
            version,
            nsamples,
            sfreq,
            start,
            lsb,
            gmt_offset,
            original_sample_freq,
            adu_serial_number,
            adu_adb,
            channel_number,
            sensor_chopper,
            channel_type,
            sensor,
            sensor_number,
            x1,
            y1,
            z1,
            x2,
            y2,
            z2,
            dipole_length,
            dipole_angle,
            probe_resistivity,
            dc_offset,
            internal_gain_amplification,
            pos_gain,
            latitude,
            longitude,
            elevation,
            lat_long_type,
            additional_coordinates_type,
            reference_meridian,
            x_coordinate,
            y_coordinate,
            gps_status,
            gps_accuracy,
            utc_offset,
            system_type,
            survey_header_filename,
            measurement_type,
            dc_offset_correction_value,
            dc_offset_correction_on,
            input_divisor_on,
            bit_indicator,
            self_test_result,
            number_slice,
            number_calibration_frequencies,
        })
    }
}

impl MTFileParser for AtsParser {
    fn parse(path: &Path) -> anyhow::Result<Vec<TimeSeries>> {
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("无法获取文件名"))?;

        let _station_id =
            AtsParser::parse_station_id(file_name).ok_or_else(|| anyhow!("无法解析站点ID"))?;
        let file = File::open(path)?;
        let mmap = unsafe { Mmap::map(&file)? };

        // 直接从内存映射创建Cursor并解析
        let mut cursor = Cursor::new(mmap.as_ref());
        let length = cursor.read_i16::<LittleEndian>()?;
        let version = cursor.read_i16::<LittleEndian>()?;

        // 一路解析header字段
        let nsamples = cursor.read_i32::<LittleEndian>()?;
        if nsamples < 0 {
            return Err(anyhow!("Invalid number of samples: {}", nsamples));
        }

        let sfreq = cursor.read_f32::<LittleEndian>()?;
        let start = cursor.read_i32::<LittleEndian>()?;

        let lsb = cursor.read_f64::<LittleEndian>()?;
        eprintln!("lsb: {}", lsb);
        if lsb <= 0.0 {
            return Err(anyhow!("Invalid LSB value: {}", lsb));
        }
        let gmt_offset = cursor.read_i32::<LittleEndian>()?;
        let original_sample_freq = cursor.read_f32::<LittleEndian>()?;
        let adu_serial_number = cursor.read_i16::<LittleEndian>()?;
        let adu_adb = cursor.read_i16::<LittleEndian>()?;
        let channel_number = cursor.read_i8()?;
        let sensor_chopper = cursor.read_i8()?;
        let channel_type: String = ParseUtils::read_char_array_fixed(&mut cursor, 2)?
            .into_iter()
            .map(|c| c.to_ascii_lowercase())
            .collect();
        eprintln!("channel_type: {}", channel_type);
        let sensor: String = ParseUtils::read_char_array_fixed(&mut cursor, 6)?
            .into_iter()
            .filter(|c| *c != '\0')
            .collect();
        let sensor_number = cursor.read_i16::<LittleEndian>()?;
        let x1 = cursor.read_f32::<LittleEndian>()?;
        let y1 = cursor.read_f32::<LittleEndian>()?;
        let z1 = cursor.read_f32::<LittleEndian>()?;
        let x2 = cursor.read_f32::<LittleEndian>()?;
        let y2 = cursor.read_f32::<LittleEndian>()?;
        let z2 = cursor.read_f32::<LittleEndian>()?;
        let dipole_length = cursor.read_f32::<LittleEndian>()?;
        let dipole_angle = cursor.read_f32::<LittleEndian>()?;
        let probe_resistivity = cursor.read_f32::<LittleEndian>()?;
        let dc_offset = cursor.read_f32::<LittleEndian>()?;
        let internal_gain_amplification = cursor.read_f32::<LittleEndian>()?;
        let pos_gain = cursor.read_f32::<LittleEndian>()?;
        eprintln!(
            "internal_gain_amplification: {}, pos_gain: {}",
            internal_gain_amplification, pos_gain
        );
        let latitude = cursor.read_i32::<LittleEndian>()?;
        let longitude = cursor.read_i32::<LittleEndian>()?;
        let elevation = cursor.read_i32::<LittleEndian>()?;
        let lat_long_type = ParseUtils::read_char_array_fixed(&mut cursor, 1)?
            .into_iter()
            .collect::<String>();
        let additional_coordinates_type = cursor.read_i8()?;
        let reference_meridian = cursor.read_i16::<LittleEndian>()?;
        let x_coordinate = cursor.read_f64::<LittleEndian>()?;
        let y_coordinate = cursor.read_f64::<LittleEndian>()?;
        let gps_status = ParseUtils::read_char_array_fixed(&mut cursor, 1)?
            .into_iter()
            .collect::<String>();
        let gps_accuracy = cursor.read_i8()?;
        let utc_offset = cursor.read_i16::<LittleEndian>()?;
        let system_type: String = ParseUtils::read_char_array_fixed(&mut cursor, 12)?
            .into_iter()
            .filter(|c| *c != '\0')
            .collect();

        let survey_header_filename: String = ParseUtils::read_char_array_fixed(&mut cursor, 12)?
            .into_iter()
            .collect();
        let measurement_type = ParseUtils::read_char_array_fixed(&mut cursor, 4)?
            .into_iter()
            .collect::<String>();
        let dc_offset_correction_value = cursor.read_f64::<LittleEndian>()?;
        let dc_offset_correction_on = cursor.read_i8()?;
        let input_divisor_on = cursor.read_i8()?;
        let bit_indicator = cursor.read_i16::<LittleEndian>()?;
        let self_test_result = ParseUtils::read_char_array_fixed(&mut cursor, 2)?
            .into_iter()
            .collect::<String>();
        let number_slice = cursor.read_u16::<LittleEndian>()?;
        let number_calibration_frequencies = cursor.read_u16::<LittleEndian>()?;

        eprintln!(
            "system_type: {}, adu_serial_number: {}, sensor: {}, sensor_number: {}",
            system_type, adu_serial_number, sensor, sensor_number,
        );
        let extra_meta = AtsExtraMeta {
            station_id: _station_id,
            length,
            version,
            nsamples,
            sfreq,
            start,
            lsb,
            gmt_offset,
            original_sample_freq,
            adu_serial_number,
            adu_adb,
            channel_number,
            sensor_chopper,
            channel_type,
            sensor,
            sensor_number,
            x1,
            y1,
            z1,
            x2,
            y2,
            z2,
            dipole_length,
            dipole_angle,
            probe_resistivity,
            dc_offset,
            internal_gain_amplification,
            pos_gain,
            latitude,
            longitude,
            elevation,
            lat_long_type,
            additional_coordinates_type,
            reference_meridian,
            x_coordinate,
            y_coordinate,
            gps_status,
            gps_accuracy,
            utc_offset,
            system_type,
            survey_header_filename,
            measurement_type,
            dc_offset_correction_value,
            dc_offset_correction_on,
            input_divisor_on,
            bit_indicator,
            self_test_result,
            number_slice,
            number_calibration_frequencies,
        };

        // 计算剩余数据大小并验证
        let data_size = (nsamples as usize) * std::mem::size_of::<i32>();
        let remaining_bytes = cursor.get_ref().len() - length as usize;

        if remaining_bytes < data_size {
            return Err(anyhow!(
                "Insufficient data: expected {} bytes, got {} bytes",
                data_size,
                remaining_bytes
            ));
        }

        cursor.set_position(length as u64);
        let mut data = Vec::with_capacity(extra_meta.nsamples as usize);
        for _ in 0..extra_meta.nsamples {
            if let Some(sample) = read_next_sample(
                &mut cursor,
                &extra_meta.lsb,
                //extra_meta.internal_gain_amplification as f64,
            )? {
                data.push(sample);
            } else {
                break;
            }
        }
        let utc_secs =
            (extra_meta.start as i64) - (extra_meta.gmt_offset as i64).saturating_mul(3600);
        let start_time = if utc_secs >= 0 {
            std::time::SystemTime::UNIX_EPOCH
                .checked_add(std::time::Duration::from_secs(utc_secs as u64))
        } else {
            std::time::SystemTime::UNIX_EPOCH
                .checked_sub(std::time::Duration::from_secs((-utc_secs) as u64))
        }
        .ok_or_else(|| {
            anyhow!(
                "start_time overflow: start={}, gmt_offset={}",
                extra_meta.start,
                extra_meta.gmt_offset
            )
        })?;

        let end_time = start_time
            .checked_add(std::time::Duration::from_secs_f32(
                (extra_meta.nsamples as f32) / extra_meta.sfreq,
            ))
            .ok_or_else(|| anyhow!("end_time overflow"))?;
        eprintln!("start_time: {:?}", Self::system_time_to_millis(&start_time));
        eprintln!("end_time: {:?}", Self::system_time_to_millis(&end_time));

        let channel_type = ChannelType::from(extra_meta.channel_type.clone());

        eprintln!(
            "chennel_type: {:?},x1: {}, x2: {}, y1: {}, y2: {}",
            channel_type, extra_meta.x1, extra_meta.x2, extra_meta.y1, extra_meta.y2
        );

        let electrode_distance = match channel_type {
            ChannelType::Ex => extra_meta.x1.abs() + extra_meta.x2.abs(),
            ChannelType::Ey => extra_meta.y1.abs() + extra_meta.y2.abs(),
            _ => 0.0,
        };

        eprintln!("electrode_distance: {}", electrode_distance);

        Ok(vec![TimeSeries {
            channel: channel_type,
            start_time: start_time,
            end_time: end_time,
            sample_rate: extra_meta.sfreq,
            electrode_distance: electrode_distance,
            file_path: path
                .to_str()
                .ok_or_else(|| anyhow!("无法转换文件路径为字符串"))?
                .to_string(),
            data: Array1::from(data),
            extra: Some(Box::new(extra_meta)),
        }])
    }

    fn can_parse(path: &Path) -> bool {
        path.extension()
            .and_then(|s| s.to_str())
            .map_or(false, |ext| ext.eq_ignore_ascii_case("ats"))
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ats_directly() {
        fn collect_ats_files(root: &Path) -> Vec<std::path::PathBuf> {
            let mut out = Vec::new();
            let mut stack = vec![root.to_path_buf()];
            while let Some(dir) = stack.pop() {
                let entries = match std::fs::read_dir(&dir) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        stack.push(path);
                        continue;
                    }
                    if AtsParser::can_parse(&path) {
                        out.push(path);
                    }
                }
            }
            out
        }

        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let dirs = [
            base.join("new_test"),
            base.join("test").join("meas_1943-11-30_17-41-00"),
        ];

        for dir in dirs {
            if !dir.exists() {
                continue;
            }
            for path_buf in collect_ats_files(&dir) {
                eprintln!(
                    "Parsing file: {}",
                    path_buf.to_str().expect("无法转换文件路径为字符串")
                );
                let ts_vec = AtsParser::parse(path_buf.as_path()).expect("解析ATS文件失败");
                let ts = &ts_vec[0];
                let extra = ts.extra.as_ref().expect("缺少额外元数据");
                let ats_meta = extra
                    .as_any()
                    .downcast_ref::<AtsExtraMeta>()
                    .expect("无法转换为ATS元数据");
                eprintln!(
                    "channel_type: {:?}, 读取到 {} 个数据点, nsamples: {}",
                    ts.channel,
                    ts.data.len(),
                    ats_meta.nsamples
                );

                assert_eq!(ts.data.len(), ats_meta.nsamples as usize);
            }
        }
    }
}
