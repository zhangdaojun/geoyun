use crate::mt_parse::extra_meta::UMTFxExtraMeta;
use crate::mt_parse::mt::{ChannelType, MTFileParser, TimeSeries};
use crate::mt_parse::utils::system_time_from_local;
use crate::mt_parse::utils::ParseUtils;
use anyhow::{anyhow, Result};
use byteorder::{ByteOrder, LittleEndian, ReadBytesExt};
use memmap2::Mmap;
use ndarray::Array1;
use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::SystemTime;

#[derive(Debug, Clone)]
pub struct UMTFxParser {}

impl UMTFxParser {
    fn parse_header(cursor: &mut Cursor<&[u8]>) -> Result<UMTFxExtraMeta> {
        let u_cpuid1 = cursor.read_u32::<LittleEndian>()?;
        let u_cpuid2 = cursor.read_u32::<LittleEndian>()?;
        let u_cpuid3 = cursor.read_u32::<LittleEndian>()?;
        let device_id = cursor.read_u32::<LittleEndian>()?;
        let sub_second = cursor.read_u16::<LittleEndian>()?;
        let year = cursor.read_u16::<LittleEndian>()?;
        let month = cursor.read_u8()?;
        let day = cursor.read_u8()?;
        let hour = cursor.read_u8()?;
        let minute = cursor.read_u8()?;
        let second = cursor.read_u8()?;
        let band = cursor.read_u8()?;

        let tag_size = cursor.read_u8()?;
        let status = cursor.read_u8()?;
        let saturation = cursor.read_u8()?;
        let gps_status = cursor.read_u8()?;
        let satellites = cursor.read_u8()?;
        let clock_status = cursor.read_u8()?;
        let channels = cursor.read_u8()?;
        let sample_bytes = cursor.read_u8()?;
        let valid_bytes = cursor.read_u8()?;
        let start_byte = cursor.read_u8()?;
        let data_type = cursor.read_u8()?;
        let data_big_endian = cursor.read_u8()?;

        let u_ex_channel_no = cursor.read_u8()?;
        let u_ey_channel_no = cursor.read_u8()?;
        let u_ez_channel_no = cursor.read_u8()?;
        let u_hx_channel_no = cursor.read_u8()?;
        let u_hy_channel_no = cursor.read_u8()?;
        let u_hz_channel_no = cursor.read_u8()?;

        let line_no = cursor.read_i32::<LittleEndian>()?;
        let point_no = cursor.read_i32::<LittleEndian>()?;
        let scans = cursor.read_u32::<LittleEndian>()?;

        // Skip channel names logic here, handled later with channel numbers

        let sample_rate = cursor.read_f32::<LittleEndian>()?;
        let f_lsb_val = cursor.read_f32::<LittleEndian>()?;
        let f_v_ref = cursor.read_f32::<LittleEndian>()?;
        let f_pga_val_e = cursor.read_f32::<LittleEndian>()?;
        let f_pga_val_h = cursor.read_f32::<LittleEndian>()?;

        let f_x_length = cursor.read_f32::<LittleEndian>()?;
        let f_y_length = cursor.read_f32::<LittleEndian>()?;

        let u_ns = cursor.read_u32::<LittleEndian>()?;
        let u_slot = cursor.read_u32::<LittleEndian>()?;
        let buff_size = cursor.read_u32::<LittleEndian>()?;

        let gps_longitude = cursor.read_f64::<LittleEndian>()?;
        let gps_latitude = cursor.read_f64::<LittleEndian>()?;
        let gps_elevation = cursor.read_f64::<LittleEndian>()?;

        let u_eh4_band = cursor.read_u32::<LittleEndian>()?;
        let u_eh4_e_gain = cursor.read_u32::<LittleEndian>()?;
        let u_eh4_m_gain = cursor.read_u32::<LittleEndian>()?;

        let f_pga_val_e1 = cursor.read_f32::<LittleEndian>()?;
        let f_pga_val_h1 = cursor.read_f32::<LittleEndian>()?;

        // Skip placeholder
        cursor.seek(SeekFrom::Current(48))?;

        let band_l_direct_sample = cursor.read_u32::<LittleEndian>()?;
        let data_interweave = cursor.read_u32::<LittleEndian>()?;
        let decimation = cursor.read_u32::<LittleEndian>()?;
        let down_multiple = cursor.read_u32::<LittleEndian>()?;
        let down_band_index = cursor.read_u32::<LittleEndian>()?;

        let project = ParseUtils::read_char_array_fixed(cursor, 16)?
            .into_iter()
            .filter(|c| *c != '\0')
            .collect();
        let company = ParseUtils::read_char_array_fixed(cursor, 16)?
            .into_iter()
            .filter(|c| *c != '\0')
            .collect();
        let operator = ParseUtils::read_char_array_fixed(cursor, 16)?
            .into_iter()
            .collect::<String>()
            .trim()
            .to_string();

        Ok(UMTFxExtraMeta {
            u_cpuid1,
            u_cpuid2,
            u_cpuid3,
            device_id,
            sub_second,
            year,
            month,
            day,
            hour,
            minute,
            second,
            band,
            tag_size,
            status,
            saturation,
            gps_status,
            satellites,
            clock_status,
            channels,
            sample_bytes,
            valid_bytes,
            start_byte,
            data_type,
            data_big_endian,
            u_ex_channel_no,
            u_ey_channel_no,
            u_ez_channel_no,
            u_hx_channel_no,
            u_hy_channel_no,
            u_hz_channel_no,
            line_no,
            point_no,
            scans,
            sample_rate,
            f_lsb_val,
            f_v_ref,
            f_pga_val_e,
            f_pga_val_h,
            f_x_length,
            f_y_length,
            u_ns,
            u_slot,
            buff_size,
            gps_longitude,
            gps_latitude,
            gps_elevation,
            u_eh4_band,
            u_eh4_e_gain,
            u_eh4_m_gain,
            f_pga_val_e1,
            f_pga_val_h1,
            band_l_direct_sample,
            data_interweave,
            decimation,
            down_multiple,
            down_band_index,
            project,
            company,
            operator,
            device_type: None,
            hx_serial_number: None,
            hy_serial_number: None,
            ep_serial_number: None,
        })
    }
}

impl MTFileParser for UMTFxParser {
    fn parse(path: &Path) -> Result<Vec<TimeSeries>> {
        let file = File::open(path)?;
        let mmap = unsafe { Mmap::map(&file)? };
        let mut cursor = Cursor::new(mmap.as_ref());

        // Check if it's a file header or buffer header
        // The Dart code has logic for `fromFile` which reads some running info first.
        // Assuming we are parsing the file directly as in `parseFile` in Dart,
        // which iterates chunks. But `parseFromByteData` handles the header.
        // Wait, `parseFile` in Dart reads chunks of `PresetData.rawDataBufferLen`.
        // And for each chunk it calls `parseFromByteData(byteData, true)`.
        // The `true` means it reads the running info first.

        // However, the `MTFileParser` trait expects to parse a whole file representing a time series.
        // If the file is a sequence of chunks, we need to handle that.
        // The Dart code loops through chunks.

        // Let's assume the file passed here is a single raw data file which might contain multiple chunks.
        // We need to replicate the loop in `parseFile`.

        // Constant from Dart code (PresetData.rawDataBufferLen) is not available here.
        // We need to infer or define it. In Dart it seems to be a fixed size buffer.
        // Let's look at `parseFromByteData`. It reads a header and then data.
        // The header size is fixed.
        // 4*7 + 228 (running info) + header fields.

        // Actually, let's look at `parseFromByteData` again.
        // It reads `running` info (4*7 + 228 bytes) if `fromFile` is true.
        // Then it reads `buffer.data.head`.

        // If the input file is a raw dump, it likely contains these blocks.
        // We should loop until EOF.

        let mut all_time_series: Vec<TimeSeries> = Vec::new();
        let mut channel_data_map: std::collections::HashMap<u8, Vec<f64>> =
            std::collections::HashMap::new();

        // We need to accumulate data across chunks for each channel.
        // And we need to capture metadata from the first chunk (or check consistency).

        let mut first_header: Option<UMTFxExtraMeta> = None;
        let mut start_time = std::time::SystemTime::UNIX_EPOCH;

        let file_len = mmap.len() as u64;
        let mut pos = 0;

        while pos < file_len {
            cursor.set_position(pos);

            // Read running info (256 bytes total: 4*7 + 228)
            if pos + 256 > file_len {
                break;
            }

            // Skip running info for now as we don't seem to use it for TimeSeries construction
            // except maybe for validation?
            cursor.seek(SeekFrom::Current(256))?;

            let header_start_pos = cursor.position();
            let header = Self::parse_header(&mut cursor)?;

            if first_header.is_none() {
                first_header = Some(header.clone());
                start_time = system_time_from_local(
                    header.year as i32,
                    header.month as u32,
                    header.day as u32,
                    header.hour as u32,
                    header.minute as u32,
                    header.second as u32,
                );
            }

            let scans = header.scans as usize;
            let channels = header.channels as usize;
            let data_type = header.data_type;
            let data_big_endian = header.data_big_endian;
            let start_byte = header.start_byte;
            let valid_bytes = header.valid_bytes;
            let sample_bytes = header.sample_bytes;
            let f_v_ref = header.f_v_ref;
            let f_lsb_val = header.f_lsb_val;
            let data_interweave = header.data_interweave;

            // Initialize vectors for this chunk
            let mut chunk_data: Vec<Vec<f64>> = vec![vec![0.0; scans]; channels];

            if data_interweave == 0 {
                for i_scan in 0..scans {
                    for i_ch in 0..channels {
                        let val = read_sample(
                            &mut cursor,
                            data_type,
                            data_big_endian,
                            start_byte,
                            valid_bytes,
                            sample_bytes,
                            f_v_ref,
                            f_lsb_val,
                        )?;
                        chunk_data[i_ch][i_scan] = val;
                    }
                }
            } else {
                for i_ch in 0..channels {
                    for i_scan in 0..scans {
                        let val = read_sample(
                            &mut cursor,
                            data_type,
                            data_big_endian,
                            start_byte,
                            valid_bytes,
                            sample_bytes,
                            f_v_ref,
                            f_lsb_val,
                        )?;
                        chunk_data[i_ch][i_scan] = val;
                    }
                }
            }

            // Accumulate data
            for i_ch in 0..channels {
                let ch_idx = match i_ch {
                    idx if idx == header.u_ex_channel_no as usize => header.u_ex_channel_no,
                    idx if idx == header.u_ey_channel_no as usize => header.u_ey_channel_no,
                    idx if idx == header.u_ez_channel_no as usize => header.u_ez_channel_no,
                    idx if idx == header.u_hx_channel_no as usize => header.u_hx_channel_no,
                    idx if idx == header.u_hy_channel_no as usize => header.u_hy_channel_no,
                    idx if idx == header.u_hz_channel_no as usize => header.u_hz_channel_no,
                    _ => 255, // Unknown
                };

                if ch_idx != 255 {
                    channel_data_map
                        .entry(ch_idx)
                        .or_insert_with(Vec::new)
                        .extend_from_slice(&chunk_data[i_ch]);
                }
            }

            pos = cursor.position();
        }

        let extra_meta = first_header.ok_or_else(|| anyhow!("No header found"))?;
        let header = &extra_meta; // Use extra_meta as header since they are the same now

        // Construct TimeSeries for each channel
        let mut result = Vec::new();

        let channel_map = [
            (header.u_ex_channel_no, ChannelType::Ex),
            (header.u_ey_channel_no, ChannelType::Ey),
            (header.u_hx_channel_no, ChannelType::Hx),
            (header.u_hy_channel_no, ChannelType::Hy),
            (header.u_hz_channel_no, ChannelType::Hz),
        ];

        for (ch_no, ch_type) in channel_map {
            if ch_no < 255 {
                if let Some(data) = channel_data_map.remove(&ch_no) {
                    let len = data.len();
                    let duration = len as f64 / header.sample_rate as f64;
                    let end_time = start_time + std::time::Duration::from_secs_f64(duration);

                    let electrode_distance = match ch_type {
                        ChannelType::Ex => header.f_x_length,
                        ChannelType::Ey => header.f_y_length,
                        _ => 0.0,
                    };

                    result.push(TimeSeries {
                        channel: ch_type,
                        start_time, // Needs proper calculation
                        end_time,
                        sample_rate: header.sample_rate,
                        electrode_distance,
                        file_path: path.to_string_lossy().to_string(),
                        data: Array1::from(data),
                        extra: Some(Box::new(extra_meta.clone())),
                    });
                }
            }
        }

        Ok(result)
    }

    fn can_parse(path: &Path) -> bool {
        path.extension()
            .and_then(|s| s.to_str())
            .map_or(false, |ext| {
                ext.to_ascii_uppercase().eq_ignore_ascii_case("FH")
                    || ext.to_ascii_uppercase().eq_ignore_ascii_case("FL")
                    || ext.to_ascii_uppercase().eq_ignore_ascii_case("FM")
            })
    }
}

fn read_sample(
    cursor: &mut Cursor<&[u8]>,
    data_type: u8,
    data_big_endian: u8,
    start_byte: u8,
    valid_bytes: u8,
    sample_bytes: u8,
    f_v_ref: f32,
    f_lsb_val: f32,
) -> Result<f64> {
    let mut temp_v = 0.0;
    if data_type == 0 {
        let sb = sample_bytes as usize;
        if sb == 0 || sb > 4 {
            return Err(anyhow!("invalid sample_bytes: {}", sample_bytes));
        }
        let mut buf = [0u8; 4];
        cursor.read_exact(&mut buf[..sb])?;

        let mut data_raw: i32;
        if data_big_endian > 0 {
            let start = start_byte as usize;
            let end = start + valid_bytes as usize;
            if end > sb {
                return Err(anyhow!(
                    "invalid start_byte/valid_bytes: start={}, valid={}, sample_bytes={}",
                    start_byte,
                    valid_bytes,
                    sample_bytes
                ));
            }
            let mut be = [0u8; 4];
            let dst_start = 4 - (end - start);
            be[dst_start..4].copy_from_slice(&buf[start..end]);
            data_raw = i32::from_be_bytes(be);
            data_raw >>= (4 - valid_bytes as i32) * 8;
        } else {
            data_raw = i32::from_le_bytes(buf);
            data_raw <<= (start_byte as i32) * 8;
            data_raw >>= (4 - valid_bytes as i32) * 8;
        }

        temp_v = (f_v_ref * f_lsb_val) as f64 * data_raw as f64;
    } else if data_type == 1 {
        let data_raw = cursor.read_f32::<LittleEndian>()?;
        temp_v = data_raw as f64 * 0.001;
    }

    Ok(temp_v * 1000.0) // mV
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_system_time_from_local() {
        let system_time = system_time_from_local(2024, 1, 1, 0, 0, 0);
        eprintln!(
            "system_time: {:?}",
            system_time
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        );
    }

    #[test]
    fn test_parse_umtfx_directly() {
        let f3_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test_f3");

        for entry in std::fs::read_dir(f3_dir).expect("无法读取测试数据目录") {
            let entry = entry.expect("无法读取目录条目");
            let path_buf = entry.path();
            eprintln!(
                "Parsing file: {}",
                path_buf.to_str().expect("无法转换文件路径为字符串")
            );
            if !UMTFxParser::can_parse(path_buf.as_path()) {
                eprintln!("Skipping file (can_parse returned false): {:?}", path_buf);
                continue;
            }

            let ts_vec = UMTFxParser::parse(path_buf.as_path()).expect("解析UMTFx文件失败");

            if ts_vec.is_empty() {
                eprintln!("Warning: Parsed result is empty for file: {:?}", path_buf);
                continue;
            }

            for ts in &ts_vec {
                let extra = ts.extra.as_ref().expect("缺少额外元数据");
                let umtfx_meta = extra
                    .as_any()
                    .downcast_ref::<UMTFxExtraMeta>()
                    .expect("无法转换为UMTFx元数据");

                eprintln!(
                    "channel: {:?}, data_len: {}, sample_rate: {}, start_time: {:?}",
                    ts.channel,
                    ts.data.len(),
                    ts.sample_rate,
                    ts.start_time
                );

                // Basic assertions
                assert!(ts.data.len() > 0);
                let head_end = ts.data.len().min(20);
                println!("--- head (first {}) ---", head_end);
                for i in 0..head_end {
                    println!("{:>6}: {}", i, ts.data[i]);
                }
                // 最后 20
                let tail_start = ts.data.len().saturating_sub(20);
                println!("--- tail (last {}) ---", ts.data.len() - tail_start);
                for i in tail_start..ts.data.len() {
                    println!("{:>6}: {}", i, ts.data[i]);
                }
                assert!(ts.sample_rate > 0.0);
                assert_eq!(ts.sample_rate, umtfx_meta.sample_rate);
            }
        }
    }
}
