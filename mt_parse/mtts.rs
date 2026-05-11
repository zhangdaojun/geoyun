use crate::mt_parse::extra_meta::*;
use crate::mt_parse::mt::{ChannelType, MTFileParser, TimeSeries};
use crate::mt_parse::utils::ParseUtils;
use anyhow::{anyhow, bail, Result};
use byteorder::{BigEndian, LittleEndian, ReadBytesExt, WriteBytesExt};
use memmap2::Mmap;
use ndarray::Array1;
use std::fs::File;
use std::io::{Cursor, Write};
use std::path::Path;
use std::time::{Duration, SystemTime};

fn read_next_sample(cursor: &mut Cursor<&[u8]>, lsb: f64) -> Result<Option<f64>> {
    if (cursor.position() as usize) >= cursor.get_ref().len() {
        return Ok(None);
    }
    let raw_value = cursor.read_i32::<BigEndian>()?;
    Ok(Some(raw_value as f64 * lsb * 1000.0))
}

fn unix_seconds_to_system_time(seconds: i64) -> SystemTime {
    if seconds >= 0 {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds as u64)
    } else {
        SystemTime::UNIX_EPOCH - Duration::from_secs(seconds.unsigned_abs())
    }
}

fn system_time_to_unix_seconds(time: SystemTime) -> Result<i64> {
    match time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => Ok(duration.as_secs() as i64),
        Err(err) => Ok(-(err.duration().as_secs() as i64)),
    }
}

fn channel_type_to_str(channel: ChannelType) -> &'static str {
    match channel {
        ChannelType::Ex => "ex",
        ChannelType::Ey => "ey",
        ChannelType::Hx => "hx",
        ChannelType::Hy => "hy",
        ChannelType::Hz => "hz",
    }
}

fn calculate_electrode_distance(channel_type: ChannelType, extra_meta: &MttsExtraMeta) -> f32 {
    match channel_type {
        ChannelType::Ex => extra_meta.x1.abs() + extra_meta.x2.abs(),
        ChannelType::Ey => extra_meta.y1.abs() + extra_meta.y2.abs(),
        _ => 0.0,
    }
}

fn write_fixed_string<W: Write>(writer: &mut W, value: &str, length: usize) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.len() > length {
        bail!("字段长度超限，允许 {} 字节，实际 {}", length, bytes.len());
    }
    writer.write_all(bytes)?;
    if bytes.len() < length {
        writer.write_all(&vec![0u8; length - bytes.len()])?;
    }
    Ok(())
}

fn build_header_bytes(extra_meta: &MttsExtraMeta, sample_count: usize) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    body.write_i16::<LittleEndian>(0)?;
    body.write_i16::<LittleEndian>(extra_meta.version)?;
    body.write_i32::<LittleEndian>(sample_count as i32)?;
    body.write_f32::<LittleEndian>(extra_meta.sfreq)?;
    body.write_i32::<LittleEndian>(extra_meta.start)?;
    body.write_f64::<LittleEndian>(extra_meta.lsb)?;
    body.write_i32::<LittleEndian>(extra_meta.gmt_offset)?;
    body.write_f32::<LittleEndian>(extra_meta.original_sample_freq)?;
    body.write_i16::<LittleEndian>(extra_meta.adu_serial_number)?;
    body.write_i16::<LittleEndian>(extra_meta.adu_adb)?;
    body.write_i8(extra_meta.channel_number)?;
    body.write_i8(extra_meta.sensor_chopper)?;
    write_fixed_string(&mut body, &extra_meta.channel_type, 2)?;
    write_fixed_string(&mut body, &extra_meta.sensor, 6)?;
    body.write_i16::<LittleEndian>(extra_meta.sensor_number)?;
    body.write_f32::<LittleEndian>(extra_meta.x1)?;
    body.write_f32::<LittleEndian>(extra_meta.y1)?;
    body.write_f32::<LittleEndian>(extra_meta.z1)?;
    body.write_f32::<LittleEndian>(extra_meta.x2)?;
    body.write_f32::<LittleEndian>(extra_meta.y2)?;
    body.write_f32::<LittleEndian>(extra_meta.z2)?;
    body.write_f32::<LittleEndian>(extra_meta.dipole_length)?;
    body.write_f32::<LittleEndian>(extra_meta.dipole_angle)?;
    body.write_f32::<LittleEndian>(extra_meta.probe_resistivity)?;
    body.write_f32::<LittleEndian>(extra_meta.dc_offset)?;
    body.write_f32::<LittleEndian>(extra_meta.internal_gain_amplification)?;
    body.write_f32::<LittleEndian>(extra_meta.pos_gain)?;
    body.write_i32::<LittleEndian>(extra_meta.latitude)?;
    body.write_i32::<LittleEndian>(extra_meta.longitude)?;
    body.write_i32::<LittleEndian>(extra_meta.elevation)?;
    write_fixed_string(&mut body, &extra_meta.lat_long_type, 1)?;
    body.write_i8(extra_meta.additional_coordinates_type)?;
    body.write_i16::<LittleEndian>(extra_meta.reference_meridian)?;
    body.write_f64::<LittleEndian>(extra_meta.x_coordinate)?;
    body.write_f64::<LittleEndian>(extra_meta.y_coordinate)?;
    write_fixed_string(&mut body, &extra_meta.gps_status, 1)?;
    body.write_i8(extra_meta.gps_accuracy)?;
    body.write_i16::<LittleEndian>(extra_meta.utc_offset)?;
    write_fixed_string(&mut body, &extra_meta.system_type, 12)?;
    write_fixed_string(&mut body, &extra_meta.survey_header_filename, 12)?;
    write_fixed_string(&mut body, &extra_meta.measurement_type, 4)?;
    body.write_f64::<LittleEndian>(extra_meta.dc_offset_correction_value)?;
    body.write_i8(extra_meta.dc_offset_correction_on)?;
    body.write_i8(extra_meta.input_divisor_on)?;
    body.write_i16::<LittleEndian>(extra_meta.bit_indicator)?;
    write_fixed_string(&mut body, &extra_meta.self_test_result, 2)?;
    body.write_u16::<LittleEndian>(extra_meta.number_slice)?;
    body.write_u16::<LittleEndian>(extra_meta.number_calibration_frequencies)?;

    let minimum_header_len = body.len();
    let header_len = if extra_meta.length > 0 && extra_meta.length as usize >= minimum_header_len {
        extra_meta.length as usize
    } else {
        minimum_header_len
    };
    if header_len > i16::MAX as usize {
        bail!("MTTS 头长度过大: {}", header_len);
    }

    let mut bytes = Vec::with_capacity(header_len);
    bytes.write_i16::<LittleEndian>(header_len as i16)?;
    bytes.extend_from_slice(&body[2..]);
    if bytes.len() < header_len {
        bytes.resize(header_len, 0);
    }
    Ok(bytes)
}

fn parse_header(cursor: &mut Cursor<&[u8]>, station_id: String, file_len: usize) -> Result<MttsExtraMeta> {
    let length = cursor.read_i16::<LittleEndian>()?;
    if length <= 0 {
        bail!("Invalid header length: {}", length);
    }

    let version = cursor.read_i16::<LittleEndian>()?;
    let nsamples = cursor.read_i32::<LittleEndian>()?;
    if nsamples < 0 {
        bail!("Invalid number of samples: {}", nsamples);
    }

    let sfreq = cursor.read_f32::<LittleEndian>()?;
    if sfreq <= 0.0 {
        bail!("Invalid sample rate: {}", sfreq);
    }
    let start = cursor.read_i32::<LittleEndian>()?;
    let lsb = cursor.read_f64::<LittleEndian>()?;
    if lsb <= 0.0 {
        bail!("Invalid LSB value: {}", lsb);
    }
    let gmt_offset = cursor.read_i32::<LittleEndian>()?;
    let original_sample_freq = cursor.read_f32::<LittleEndian>()?;
    let adu_serial_number = cursor.read_i16::<LittleEndian>()?;
    let adu_adb = cursor.read_i16::<LittleEndian>()?;
    let channel_number = cursor.read_i8()?;
    let sensor_chopper = cursor.read_i8()?;
    let channel_type: String = ParseUtils::read_char_array_fixed(cursor, 2)?
        .into_iter()
        .map(|c| c.to_ascii_lowercase())
        .collect();
    let sensor: String = ParseUtils::read_char_array_fixed(cursor, 6)?
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
    let lat_long_type = ParseUtils::read_char_array_fixed(cursor, 1)?
        .into_iter()
        .collect::<String>();
    let additional_coordinates_type = cursor.read_i8()?;
    let reference_meridian = cursor.read_i16::<LittleEndian>()?;
    let x_coordinate = cursor.read_f64::<LittleEndian>()?;
    let y_coordinate = cursor.read_f64::<LittleEndian>()?;
    let gps_status = ParseUtils::read_char_array_fixed(cursor, 1)?
        .into_iter()
        .collect::<String>();
    let gps_accuracy = cursor.read_i8()?;
    let utc_offset = cursor.read_i16::<LittleEndian>()?;
    let system_type: String = ParseUtils::read_char_array_fixed(cursor, 12)?
        .into_iter()
        .filter(|c| *c != '\0')
        .collect();
    let survey_header_filename: String = ParseUtils::read_char_array_fixed(cursor, 12)?
        .into_iter()
        .collect();
    let measurement_type = ParseUtils::read_char_array_fixed(cursor, 4)?
        .into_iter()
        .collect::<String>();
    let dc_offset_correction_value = cursor.read_f64::<LittleEndian>()?;
    let dc_offset_correction_on = cursor.read_i8()?;
    let input_divisor_on = cursor.read_i8()?;
    let bit_indicator = cursor.read_i16::<LittleEndian>()?;
    let self_test_result = ParseUtils::read_char_array_fixed(cursor, 2)?
        .into_iter()
        .collect::<String>();
    let number_slice = cursor.read_u16::<LittleEndian>()?;
    let number_calibration_frequencies = cursor.read_u16::<LittleEndian>()?;

    let header_len = length as usize;
    if header_len > file_len {
        bail!("Invalid header length: {}", length);
    }
    let remaining_bytes = file_len - header_len;
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

fn read_samples(cursor: &mut Cursor<&[u8]>, extra_meta: &MttsExtraMeta) -> Result<Vec<f64>> {
    cursor.set_position(extra_meta.length as u64);
    let mut data = Vec::with_capacity(extra_meta.nsamples_in_file as usize);
    for _ in 0..extra_meta.nsamples_in_file {
        if let Some(sample) = read_next_sample(cursor, extra_meta.lsb)? {
            data.push(sample);
        } else {
            break;
        }
    }
    Ok(data)
}

#[derive(Debug, Clone)]
pub struct MttsParser {}

impl MttsParser {
    pub fn parse_station_id(file_name: &str) -> Option<String> {
        file_name.split('_').next().map(|s| s.to_string())
    }

    pub fn parse_header_only(path: &Path) -> Result<MttsExtraMeta> {
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("无法获取文件名"))?;
        let station_id =
            Self::parse_station_id(file_name).ok_or_else(|| anyhow!("无法解析站点ID"))?;

        let file = File::open(path)?;
        let mmap = unsafe { Mmap::map(&file)? };
        let mut cursor = Cursor::new(mmap.as_ref());
        parse_header(&mut cursor, station_id, mmap.len())
    }

    pub fn read_with_meta(path: &Path) -> Result<(MttsExtraMeta, Vec<f64>)> {
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("无法获取文件名"))?;
        let station_id =
            Self::parse_station_id(file_name).ok_or_else(|| anyhow!("无法解析站点ID"))?;

        let file = File::open(path)?;
        let mmap = unsafe { Mmap::map(&file)? };
        let mut cursor = Cursor::new(mmap.as_ref());
        let extra_meta = parse_header(&mut cursor, station_id, mmap.len())?;
        let data = read_samples(&mut cursor, &extra_meta)?;
        Ok((extra_meta, data))
    }

    pub fn write(path: &Path, extra_meta: &MttsExtraMeta, samples: &[f64]) -> Result<()> {
        if extra_meta.lsb <= 0.0 {
            bail!("Invalid LSB value: {}", extra_meta.lsb);
        }

        let header = build_header_bytes(extra_meta, samples.len())?;
        let mut file = File::create(path)?;
        file.write_all(&header)?;

        for sample in samples {
            if !sample.is_finite() {
                bail!("存在非有限样本值");
            }
            let raw = (*sample / (extra_meta.lsb * 1000.0)).round();
            if raw < i32::MIN as f64 || raw > i32::MAX as f64 {
                bail!("样本值超出 MTTS 可写入范围: {}", sample);
            }
            file.write_i32::<BigEndian>(raw as i32)?;
        }
        Ok(())
    }

    pub fn write_time_series(path: &Path, time_series: &TimeSeries) -> Result<()> {
        let extra = time_series
            .extra
            .as_ref()
            .ok_or_else(|| anyhow!("TimeSeries 缺少 MTTS 元数据"))?;
        let extra_meta = extra
            .as_any()
            .downcast_ref::<MttsExtraMeta>()
            .ok_or_else(|| anyhow!("TimeSeries 的额外元数据不是 MttsExtraMeta"))?;

        let mut next_meta = extra_meta.clone();
        next_meta.channel_type = channel_type_to_str(time_series.channel).to_string();
        next_meta.sfreq = time_series.sample_rate;
        next_meta.nsamples = time_series.data.len() as i32;
        next_meta.nsamples_in_file = time_series.data.len() as i32;
        next_meta.start =
            (system_time_to_unix_seconds(time_series.start_time)? + (next_meta.gmt_offset as i64 * 3600))
                .try_into()
                .map_err(|_| anyhow!("TimeSeries 起始时间超出 MTTS 支持范围"))?;

        Self::write(path, &next_meta, &time_series.data.to_vec())
    }
}

impl MTFileParser for MttsParser {
    fn parse(path: &Path) -> Result<Vec<TimeSeries>> {
        let (extra_meta, data) = Self::read_with_meta(path)?;
        let channel = ChannelType::from(extra_meta.channel_type.clone());
        let start_seconds = extra_meta.start as i64 - (extra_meta.gmt_offset as i64 * 3600);
        let start_time = unix_seconds_to_system_time(start_seconds);
        let duration_secs = (extra_meta.nsamples_in_file as f64) / (extra_meta.sfreq as f64);
        let end_time = start_time + Duration::from_secs_f64(duration_secs.max(0.0));

        Ok(vec![TimeSeries {
            channel,
            start_time,
            end_time,
            sample_rate: extra_meta.sfreq,
            electrode_distance: calculate_electrode_distance(channel, &extra_meta),
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

    fn sample_meta() -> MttsExtraMeta {
        MttsExtraMeta {
            station_id: "EMAP001".to_string(),
            length: 178,
            version: 1,
            nsamples: 3,
            nsamples_in_file: 3,
            sfreq: 128.0,
            start: 1_700_000_000,
            lsb: 0.000001,
            gmt_offset: 8,
            original_sample_freq: 128.0,
            adu_serial_number: 1,
            adu_adb: 1,
            channel_number: 1,
            sensor_chopper: 0,
            channel_type: "hx".to_string(),
            sensor: "MFS06".to_string(),
            sensor_number: 1,
            x1: 0.0,
            y1: 0.0,
            z1: 0.0,
            x2: 0.0,
            y2: 0.0,
            z2: 0.0,
            dipole_length: 0.0,
            dipole_angle: 0.0,
            probe_resistivity: 0.0,
            dc_offset: 0.0,
            internal_gain_amplification: 1.0,
            pos_gain: 1.0,
            latitude: 0,
            longitude: 0,
            elevation: 0,
            lat_long_type: "G".to_string(),
            additional_coordinates_type: 0,
            reference_meridian: 0,
            x_coordinate: 0.0,
            y_coordinate: 0.0,
            gps_status: "A".to_string(),
            gps_accuracy: 0,
            utc_offset: 8,
            system_type: "EMAP-1".to_string(),
            survey_header_filename: "survey.xml".to_string(),
            measurement_type: "MT".to_string(),
            dc_offset_correction_value: 0.0,
            dc_offset_correction_on: 0,
            input_divisor_on: 0,
            bit_indicator: 0,
            self_test_result: "OK".to_string(),
            number_slice: 0,
            number_calibration_frequencies: 0,
        }
    }

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

    #[test]
    fn test_mtts_roundtrip_read_write() {
        let meta = sample_meta();
        let samples = vec![1.0, -2.5, 3.75];
        let file_path = std::env::temp_dir().join(format!(
            "mtts_roundtrip_{}_test.mtts",
            std::process::id()
        ));

        MttsParser::write(&file_path, &meta, &samples).expect("写入 MTTS 失败");
        let header = MttsParser::parse_header_only(&file_path).expect("读取 MTTS 头失败");
        let (parsed_meta, parsed_samples) =
            MttsParser::read_with_meta(&file_path).expect("读取 MTTS 数据失败");

        assert_eq!(header.nsamples_in_file as usize, samples.len());
        assert_eq!(parsed_meta.channel_type, meta.channel_type);
        assert_eq!(parsed_samples.len(), samples.len());
        for (parsed, expected) in parsed_samples.iter().zip(samples.iter()) {
            assert!((parsed - expected).abs() <= meta.lsb * 1000.0);
        }

        let _ = std::fs::remove_file(&file_path);
    }
}
