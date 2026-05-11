use crate::mt_parse::utils::{system_time_from_local, system_time_to_millis, ParseUtils};
use anyhow::Result;
use byteorder::{LittleEndian, ReadBytesExt};
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Cursor;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UmtfxIndexEntry {
    pub index: u32,
    pub cpu_id1: u32,
    pub cpu_id2: u32,
    pub cpu_id3: u32,
    pub device_type: u32,
    pub device_id: u32,
    pub project: String,
    pub line: String,
    pub point: String,
    pub gps_status: u8,
    pub satellite_count: u8,
    pub gps_sync: u8,
    pub time_zone: u8,
    pub start_time_millis: i64,
    pub gps_longitude: f64,
    pub gps_latitude: f64,
    pub gps_elevation: f64,
    pub ex_len: f32,
    pub ey_len: f32,
    pub hx_angle: f32,
    pub hy_angle: f32,
    pub hx_serial_number: String,
    pub hy_serial_number: String,
    pub u_slot: u32,
    pub u_l2ns: u32,
    pub u_l3ns: u32,
    pub u_l4ns: u32,
    pub u_srl2: u32,
    pub u_srl3: u32,
    pub u_srl4: u32,
    pub u_h_buff: u32,
    pub u_e_buff: u32,
    pub u_pre_amp: u32,
    pub u_adjust: u32,
    pub u_eh4_control_mode: u32,
    pub u_eh4_band: u32,
    pub u_eh4_e_gain: u32,
    pub u_eh4_m_gain: u32,
    pub coh_select_ex_hy: f64,
    pub coh_select_ey_hx: f64,
    pub use_result_coh_ex_hy: f64,
    pub use_result_coh_ey_hx: f64,
    pub extra_algorithm: Vec<u32>,
    pub f_pgae0_value: Vec<f32>,
    pub f_pgah0_value: Vec<f32>,
    pub f_pgae1_value: Vec<f32>,
    pub f_pgah1_value: Vec<f32>,
    pub stack_size: u32,
    pub parzen_cr_multi_band: u32,
    pub parzen_cr_log_value: u32,
    pub numbers_per_log_x: u32,
    pub parzen_cr: f32,
    pub parzen_start_freq: Vec<f32>,
    pub parzen_end_freq: Vec<f32>,
    pub notch_50hz_end_freq: f32,
    pub u_eh4_e_gain_m: u32,
    pub u_eh4_m_gain_m: u32,
    pub u_eh4_e_gain_l: u32,
    pub u_eh4_m_gain_l: u32,
    pub use_trend_remove: u32,
    pub use_pulse_remove: u32,
    pub pre_amp_type: u32,
    pub ep_serial_number: String,
    pub decimation: Vec<u32>,
    pub down_multiple: Vec<u32>,
    pub sample_mode: u32,
    pub use_r_filter: u32,
    pub calc_mode: u32,
    pub band_l_inner_ref: u32,
    pub band_l_direct_sample: u32,
    pub notch_50hz_width: f32,
    pub sample_time_len: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UmtfxIndexFile {
    pub file_path: String,
    pub entries: Vec<UmtfxIndexEntry>,
}

fn read_fixed_string(cursor: &mut Cursor<&[u8]>, length: usize) -> Result<String> {
    let s: String = ParseUtils::read_char_array_fixed(cursor, length)?
        .into_iter()
        .take_while(|c| *c != '\0')
        .collect();
    Ok(s.trim().to_string())
}

pub fn parse_umtfx_index_file(path: &Path) -> Result<UmtfxIndexFile> {
    let file = File::open(path)?;
    let mmap = unsafe { Mmap::map(&file)? };
    let data = mmap.as_ref();

    let mut entries = Vec::new();
    let mut offset = 0usize;
    while offset + 512 <= data.len() {
        let block = &data[offset..offset + 512];
        let mut cursor = Cursor::new(block);

        let index = cursor.read_u32::<LittleEndian>()?;
        let cpu_id1 = cursor.read_u32::<LittleEndian>()?;
        let cpu_id2 = cursor.read_u32::<LittleEndian>()?;
        let cpu_id3 = cursor.read_u32::<LittleEndian>()?;
        let device_type = cursor.read_u32::<LittleEndian>()?;
        let device_id = cursor.read_u32::<LittleEndian>()?;
        let project = read_fixed_string(&mut cursor, 8)?;
        let line = read_fixed_string(&mut cursor, 8)?;
        let point = read_fixed_string(&mut cursor, 16)?;
        let gps_status = cursor.read_u8()?;
        let satellite_count = cursor.read_u8()?;
        let gps_sync = cursor.read_u8()?;
        let time_zone = cursor.read_u8()?;

        let second = cursor.read_u8()? as u32;
        let minute = cursor.read_u8()? as u32;
        let hour = cursor.read_u8()? as u32;
        let day = cursor.read_u8()? as u32;
        let month = cursor.read_u8()? as u32;
        let year_low = cursor.read_u8()? as i32;
        let _day_of_week = cursor.read_u8()?;
        let century = cursor.read_u8()? as i32;
        let year = century * 100 + year_low;
        let start_time = system_time_from_local(year, month, day, hour, minute, second);
        let start_time_millis = system_time_to_millis(&start_time);

        let _ = cursor.read_u32::<LittleEndian>()?;
        let gps_longitude = cursor.read_f64::<LittleEndian>()?;
        let gps_latitude = cursor.read_f64::<LittleEndian>()?;
        let gps_elevation = cursor.read_f64::<LittleEndian>()?;
        let ex_len = cursor.read_f32::<LittleEndian>()?;
        let ey_len = cursor.read_f32::<LittleEndian>()?;
        let hx_angle = cursor.read_f32::<LittleEndian>()?;
        let hy_angle = cursor.read_f32::<LittleEndian>()?;
        let hx_serial_number = read_fixed_string(&mut cursor, 8)?;
        let hy_serial_number = read_fixed_string(&mut cursor, 8)?;

        // eprintln!("hx_serial_number: {}", hx_serial_number.clone().trim());
        // eprintln!("hy_serial_number: {}", hy_serial_number.clone().trim());

        let u_slot = cursor.read_u32::<LittleEndian>()?;
        let u_l2ns = cursor.read_u32::<LittleEndian>()?;
        let u_l3ns = cursor.read_u32::<LittleEndian>()?;
        let u_l4ns = cursor.read_u32::<LittleEndian>()?;
        let u_srl2 = cursor.read_u32::<LittleEndian>()?;
        let u_srl3 = cursor.read_u32::<LittleEndian>()?;
        let u_srl4 = cursor.read_u32::<LittleEndian>()?;
        let u_h_buff = cursor.read_u32::<LittleEndian>()?;
        let u_e_buff = cursor.read_u32::<LittleEndian>()?;
        let u_pre_amp = cursor.read_u32::<LittleEndian>()?;
        let u_adjust = cursor.read_u32::<LittleEndian>()?;
        let u_eh4_control_mode = cursor.read_u32::<LittleEndian>()?;
        let u_eh4_band = cursor.read_u32::<LittleEndian>()?;
        let u_eh4_e_gain = cursor.read_u32::<LittleEndian>()?;
        let u_eh4_m_gain = cursor.read_u32::<LittleEndian>()?;

        let _ = cursor.read_u32::<LittleEndian>()?;
        let coh_select_ex_hy = cursor.read_f64::<LittleEndian>()?;
        let coh_select_ey_hx = cursor.read_f64::<LittleEndian>()?;
        let use_result_coh_ex_hy = cursor.read_f64::<LittleEndian>()?;
        let use_result_coh_ey_hx = cursor.read_f64::<LittleEndian>()?;

        let mut extra_algorithm = Vec::with_capacity(3);
        for _ in 0..3 {
            extra_algorithm.push(cursor.read_u32::<LittleEndian>()?);
        }

        let mut f_pgae0_value = Vec::with_capacity(3);
        for _ in 0..3 {
            f_pgae0_value.push(cursor.read_f32::<LittleEndian>()?);
        }

        let mut f_pgah0_value = Vec::with_capacity(3);
        for _ in 0..3 {
            f_pgah0_value.push(cursor.read_f32::<LittleEndian>()?);
        }

        let mut f_pgae1_value = Vec::with_capacity(3);
        for _ in 0..3 {
            f_pgae1_value.push(cursor.read_f32::<LittleEndian>()?);
        }

        let mut f_pgah1_value = Vec::with_capacity(3);
        for _ in 0..3 {
            f_pgah1_value.push(cursor.read_f32::<LittleEndian>()?);
        }

        let stack_size = cursor.read_u32::<LittleEndian>()?;
        let parzen_cr_multi_band = cursor.read_u32::<LittleEndian>()?;
        let parzen_cr_log_value = cursor.read_u32::<LittleEndian>()?;
        let numbers_per_log_x = cursor.read_u32::<LittleEndian>()?;
        let parzen_cr = cursor.read_f32::<LittleEndian>()?;

        let mut parzen_start_freq = Vec::with_capacity(3);
        for _ in 0..3 {
            parzen_start_freq.push(cursor.read_f32::<LittleEndian>()?);
        }

        let mut parzen_end_freq = Vec::with_capacity(3);
        for _ in 0..3 {
            parzen_end_freq.push(cursor.read_f32::<LittleEndian>()?);
        }

        let notch_50hz_end_freq = cursor.read_f32::<LittleEndian>()?;
        let u_eh4_e_gain_m = cursor.read_u32::<LittleEndian>()?;
        let u_eh4_m_gain_m = cursor.read_u32::<LittleEndian>()?;
        let u_eh4_e_gain_l = cursor.read_u32::<LittleEndian>()?;
        let u_eh4_m_gain_l = cursor.read_u32::<LittleEndian>()?;
        let use_trend_remove = cursor.read_u32::<LittleEndian>()?;
        let use_pulse_remove = cursor.read_u32::<LittleEndian>()?;
        let pre_amp_type = cursor.read_u32::<LittleEndian>()?;
        let ep_serial_number = read_fixed_string(&mut cursor, 8)?;
        eprintln!("ep_serial_number: {}", ep_serial_number.clone().trim());

        let mut decimation = Vec::with_capacity(3);
        for _ in 0..3 {
            decimation.push(cursor.read_u32::<LittleEndian>()?);
        }

        let mut down_multiple = Vec::with_capacity(3);
        for _ in 0..3 {
            down_multiple.push(cursor.read_u32::<LittleEndian>()?);
        }

        let sample_mode = cursor.read_u32::<LittleEndian>()?;
        let use_r_filter = cursor.read_u32::<LittleEndian>()?;
        let calc_mode = cursor.read_u32::<LittleEndian>()?;
        let band_l_inner_ref = cursor.read_u32::<LittleEndian>()?;
        let band_l_direct_sample = cursor.read_u32::<LittleEndian>()?;
        let notch_50hz_width = cursor.read_f32::<LittleEndian>()?;
        let sample_time_len = cursor.read_u32::<LittleEndian>()?;

        if !(project.is_empty() && line.is_empty() && point.is_empty()) {
            entries.push(UmtfxIndexEntry {
                index,
                cpu_id1,
                cpu_id2,
                cpu_id3,
                device_type,
                device_id,
                project,
                line,
                point,
                gps_status,
                satellite_count,
                gps_sync,
                time_zone,
                start_time_millis,
                gps_longitude,
                gps_latitude,
                gps_elevation,
                ex_len,
                ey_len,
                hx_angle,
                hy_angle,
                hx_serial_number,
                hy_serial_number,
                u_slot,
                u_l2ns,
                u_l3ns,
                u_l4ns,
                u_srl2,
                u_srl3,
                u_srl4,
                u_h_buff,
                u_e_buff,
                u_pre_amp,
                u_adjust,
                u_eh4_control_mode,
                u_eh4_band,
                u_eh4_e_gain,
                u_eh4_m_gain,
                coh_select_ex_hy,
                coh_select_ey_hx,
                use_result_coh_ex_hy,
                use_result_coh_ey_hx,
                extra_algorithm,
                f_pgae0_value,
                f_pgah0_value,
                f_pgae1_value,
                f_pgah1_value,
                stack_size,
                parzen_cr_multi_band,
                parzen_cr_log_value,
                numbers_per_log_x,
                parzen_cr,
                parzen_start_freq,
                parzen_end_freq,
                notch_50hz_end_freq,
                u_eh4_e_gain_m,
                u_eh4_m_gain_m,
                u_eh4_e_gain_l,
                u_eh4_m_gain_l,
                use_trend_remove,
                use_pulse_remove,
                pre_amp_type,
                ep_serial_number,
                decimation,
                down_multiple,
                sample_mode,
                use_r_filter,
                calc_mode,
                band_l_inner_ref,
                band_l_direct_sample,
                notch_50hz_width,
                sample_time_len,
            });
        }

        offset += 512;
    }

    Ok(UmtfxIndexFile {
        file_path: path.display().to_string(),
        entries,
    })
}
