use anyhow::Result;
use byteorder::ReadBytesExt;
use chrono::{Local, NaiveDate, TimeZone};
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::SystemTime;

pub struct ParseUtils;

impl ParseUtils {
    pub fn read_char_array_fixed<R: Read>(reader: &mut R, length: usize) -> Result<Vec<char>> {
        let mut chars = Vec::with_capacity(length);

        for _ in 0..length {
            let byte = reader.read_u8()?;
            chars.push(byte as char);
        }

        Ok(chars)
    }
}

// 全局静态 Atomic 计数器
static ID_GENERATOR: OnceLock<AtomicU64> = OnceLock::new();

/// 初始化 ID 生成器（可指定起始值）
pub fn init_id_generator(start: u64) {
    let _ = ID_GENERATOR.set(AtomicU64::new(start));
}

/// 获取全局唯一 ID
pub fn next_id() -> u64 {
    let counter = ID_GENERATOR.get_or_init(|| AtomicU64::new(0));
    counter.fetch_add(1, Ordering::SeqCst)
}

// 时间转换：SystemTime -> i64 (nanos since epoch)
pub fn system_time_to_millis(t: &SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn system_time_from_local(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    min: u32,
    sec: u32,
) -> SystemTime {
    let naive = NaiveDate::from_ymd_opt(year, month, day)
        .unwrap()
        .and_hms_opt(hour, min, sec)
        .unwrap();

    let offset = *Local::now().offset();
    let local_dt = offset.from_local_datetime(&naive).unwrap();
    local_dt.into()
}
