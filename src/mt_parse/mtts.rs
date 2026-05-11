use crate::mt_parse::extra_meta::*;
use crate::mt_parse::mt::{ChannelType, MTFileParser, TimeSeries};
use crate::mt_parse::utils::ParseUtils;
use anyhow::{anyhow, Result};
use byteorder::{BigEndian, LittleEndian, ReadBytesExt};
use memmap2::Mmap;
use ndarray::Array1;
use std::fs::File;
use std::io::Cursor;
use std::path::Path;
use std::time::SystemTime;

fn read_next_sample(cursor: &mut Cursor<&[u8]>, lsb: &f64) -> Result<Option<f64>> {
    if (cursor.position() as usize) < cursor.get_ref().len() {
        let raw_value = cursor.read_i32::<BigEndian>()?;
        Ok(Some(raw_value as f64 * lsb * 1000.0))
    } else {
        Ok(None)
    }
}

#[derive(Debug, Clone)]
pub struct MttsParser {}

impl MttsParser {
    fn system_time_to_millis(t: &SystemTime) -> i64 {
        t.duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    pub fn parse_station_id(file_name: &str) -> Option<String> {
        file_name.split('_').next().map(|s| s.to_string())
    }

    pub fn parse_header_only(path: &Path) -> anyhow::Result<MttsExtraMeta> {
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("无法获取文件名"))?;

        let station_id =
            MttsParser::parse_station_id(file_name).ok_or_else(|| anyhow!("无法解析站点ID"))?;
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

        let header_len = i64::from(length);
        if header_len < 0 || header_len as usize > mmap.len() {
            return Err(anyhow!("Invalid header length: {}", length));
        }
        let remaining_bytes = mmap.len() - header_len as usize;
        let available_samples = remaining_bytes / std::mem::size_of::<i32>();
        let expected_samples = nsamples as usize;
        let actual_samples = expected_samples.min(available_samples);

        Ok(MttsExtraMeta {
            station_id,
            length,
            version,
            nsamples,
            nsamples_in_file: actual_samples as i32,
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

impl MTFileParser for MttsParser {
    fn parse(path: &Path) -> anyhow::Result<Vec<TimeSeries>> {
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("无法获取文件名"))?;

        let station_id =
            MttsParser::parse_station_id(file_name).ok_or_else(|| anyhow!("无法解析站点ID"))?;
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
        let mut extra_meta = MttsExtraMeta {
            station_id,
            length,
            version,
            nsamples,
            nsamples_in_file: 0,
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

        let remaining_bytes = cursor.get_ref().len() - length as usize;
        let expected_samples = nsamples as usize;
        let available_samples = remaining_bytes / std::mem::size_of::<i32>();
        eprintln!(
            "expected_samples: {}, available_samples: {}",
            expected_samples, available_samples
        );
        let actual_samples = expected_samples.min(available_samples);
        extra_meta.nsamples_in_file = actual_samples as i32;

        cursor.set_position(length as u64);
        let mut data = Vec::with_capacity(actual_samples);
        for _ in 0..actual_samples {
            if let Some(sample) = read_next_sample(&mut cursor, &extra_meta.lsb)? {
                data.push(sample);
            } else {
                break;
            }
        }

        let start_time = std::time::SystemTime::UNIX_EPOCH
            + std::time::Duration::from_secs(
                (extra_meta.start - extra_meta.gmt_offset * 3600) as u64,
            );
        let end_time = start_time
            + std::time::Duration::from_secs_f32((actual_samples as f32) / extra_meta.sfreq);
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
            start_time,
            end_time,
            sample_rate: extra_meta.sfreq,
            electrode_distance,
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
            .map_or(false, |ext| ext.eq_ignore_ascii_case("mtts"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_mtts_directly() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test")
            .join("260121_085758");
        if !dir.exists() {
            return;
        }

        let mut parsed_any = false;
        for entry in std::fs::read_dir(dir).expect("无法读取测试数据目录") {
            let entry = entry.expect("无法读取目录条目");
            let path_buf = entry.path();
            if !MttsParser::can_parse(path_buf.as_path()) {
                continue;
            }
            parsed_any = true;
            let ts_vec = MttsParser::parse(path_buf.as_path()).expect("解析MTTS文件失败");
            let ts = &ts_vec[0];
            let extra = ts.extra.as_ref().expect("缺少额外元数据");
            let meta = extra
                .as_any()
                .downcast_ref::<MttsExtraMeta>()
                .expect("无法转换为MTTS元数据");
            assert_eq!(ts.data.len(), meta.nsamples_in_file as usize);
            assert!(meta.nsamples_in_file <= meta.nsamples);
            assert!(ts.sample_rate.is_finite());
            assert!(ts.data.iter().all(|v| v.is_finite()));
        }
        assert!(parsed_any);
    }
}
