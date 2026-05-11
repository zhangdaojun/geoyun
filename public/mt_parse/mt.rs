use crate::mt_parse::extra_meta::*;
use crate::mt_parse::utils::system_time_to_millis;
use anyhow::Result;
use flutter_rust_bridge::frb;
use ndarray::Array1;
use num_complex::Complex;
use ordered_float::OrderedFloat;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::{collections::BTreeMap, collections::HashMap as Map, path::Path, time::SystemTime};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComplexFfi {
    pub re: f64,
    pub im: f64,
}

impl From<Complex<f64>> for ComplexFfi {
    fn from(c: Complex<f64>) -> Self {
        Self { re: c.re, im: c.im }
    }
}

impl From<ComplexFfi> for Complex<f64> {
    fn from(c: ComplexFfi) -> Self {
        Self::new(c.re, c.im)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ChannelType {
    Ex,
    Ey,
    Hx,
    Hy,
    Hz,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ChannelTypeFfi {
    Ex,
    Ey,
    Hx,
    Hy,
    Hz,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MTDataSource {
    Ats,
    Mtts,
    Umtfx,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MTDataSourceFfi {
    Ats,
    Mtts,
    Umtfx,
}

impl From<&MTDataSource> for MTDataSourceFfi {
    fn from(v: &MTDataSource) -> Self {
        match v {
            MTDataSource::Ats => MTDataSourceFfi::Ats,
            MTDataSource::Mtts => MTDataSourceFfi::Mtts,
            MTDataSource::Umtfx => MTDataSourceFfi::Umtfx,
        }
    }
}

impl From<&ChannelType> for ChannelTypeFfi {
    fn from(c: &ChannelType) -> Self {
        match c {
            ChannelType::Ex => ChannelTypeFfi::Ex,
            ChannelType::Ey => ChannelTypeFfi::Ey,
            ChannelType::Hx => ChannelTypeFfi::Hx,
            ChannelType::Hy => ChannelTypeFfi::Hy,
            ChannelType::Hz => ChannelTypeFfi::Hz,
        }
    }
}

impl From<String> for ChannelType {
    fn from(s: String) -> Self {
        match s.as_str() {
            "ex" => ChannelType::Ex,
            "ey" => ChannelType::Ey,
            "hx" => ChannelType::Hx,
            "hy" => ChannelType::Hy,
            "hz" => ChannelType::Hz,
            _ => panic!("Unknown channel type: {}", s),
        }
    }
}

impl ChannelType {
    pub fn try_from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "ex" => Ok(ChannelType::Ex),
            "ey" => Ok(ChannelType::Ey),
            "hx" => Ok(ChannelType::Hx),
            "hy" => Ok(ChannelType::Hy),
            "hz" => Ok(ChannelType::Hz),
            _ => Err(anyhow::anyhow!("Unknown channel type: {}", s)),
        }
    }
}

impl Into<String> for ChannelType {
    fn into(self) -> String {
        match self {
            ChannelType::Ex => "Ex".to_string(),
            ChannelType::Ey => "Ey".to_string(),
            ChannelType::Hx => "Hx".to_string(),
            ChannelType::Hy => "Hy".to_string(),
            ChannelType::Hz => "Hz".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
#[frb(opaque)]
pub struct TimeSeries {
    pub channel: ChannelType,
    pub start_time: SystemTime,
    pub end_time: SystemTime,
    pub sample_rate: f32,
    pub electrode_distance: f32,
    pub file_path: String,
    pub data: Array1<f64>,
    pub extra: Option<Box<dyn ExtraMeta>>,
}

#[derive(Debug, Clone)]
pub struct MTRecord {
    pub time_series: BTreeMap<ChannelType, TimeSeries>,
    pub start_time: SystemTime,
    pub end_time: SystemTime,
    pub sample_rate: f32,
    pub data_len: u32,
    pub data_source: MTDataSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[frb]
pub struct MTSegmentFFT {
    pub channel: ChannelTypeFfi,
    pub sample_rate: f32,
    pub fft: Vec<Vec<f64>>,
    pub freq: Vec<f64>,
    pub pearson_corr_prev_window: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[frb]
pub struct MTRecordFfi {
    pub time_series: Vec<TimeSeriesFfi>,
    pub start_time_millis: i64,
    pub end_time_millis: i64,
    pub sample_rate: f32,
    pub data_len: u32,
    pub data_source: MTDataSourceFfi,
}

impl From<&MTRecord> for MTRecordFfi {
    fn from(record: &MTRecord) -> Self {
        let time_series: Vec<TimeSeriesFfi> = record
            .time_series
            .iter()
            .map(|(_, v)| TimeSeriesFfi::from(v))
            .collect();

        Self {
            time_series,
            start_time_millis: system_time_to_millis(&record.start_time),
            end_time_millis: system_time_to_millis(&record.end_time),
            sample_rate: record.sample_rate,
            data_len: record.data_len,
            data_source: MTDataSourceFfi::from(&record.data_source),
        }
    }
}

impl MTRecord {
    pub fn align_and_slice(&mut self) {
        let mut first = true;
        let mut aligned_start = SystemTime::UNIX_EPOCH;
        let mut aligned_end = SystemTime::UNIX_EPOCH;
        for ts in self.time_series.values_mut() {
            if first {
                first = false;
                aligned_start = ts.start_time;
                aligned_end = ts.end_time;
                continue;
            }
            if ts.start_time > aligned_start {
                aligned_start = ts.start_time;
            }
            if ts.end_time < aligned_end {
                aligned_end = ts.end_time;
            }
        }

        if aligned_end <= aligned_start {
            return; // 没有重叠时间，无法对齐和切片
        }

        let mut data_len = 0u32;
        // 2. 对每个通道裁剪数据
        for ts in self.time_series.values_mut() {
            let sr = ts.sample_rate as f64;
            let total_samples = ts.data.len();
            let start_offset = ts
                .start_time
                .duration_since(aligned_start)
                .map(|d| -(d.as_secs_f64() * sr).round() as isize)
                .unwrap_or_else(|e| (e.duration().as_secs_f64() * sr).round() as isize);

            let end_offset = ts
                .end_time
                .duration_since(aligned_end)
                .map(|d| total_samples as isize - (d.as_secs_f64() * sr).round() as isize)
                .unwrap_or_else(|e| {
                    total_samples as isize - (e.duration().as_secs_f64() * sr).round() as isize
                });

            let start_idx = start_offset.max(0) as usize;
            let end_idx = end_offset.min(total_samples as isize) as usize;

            ts.data = ts.data.slice(ndarray::s![start_idx..end_idx]).to_owned();
            if data_len == 0 {
                data_len = ts.data.len() as u32;
            } else if data_len > ts.data.len() as u32 {
                data_len = ts.data.len() as u32;
            }
            ts.start_time = aligned_start;
            ts.end_time = aligned_end;
        }

        self.start_time = aligned_start;
        self.end_time = aligned_end;
        self.data_len = data_len;
    }
}

pub struct MTStation {
    pub id: String,
    pub project: String,
    pub directory: String,
    pub location: (f64, f64),
    pub start_time: SystemTime,
    pub end_time: SystemTime,
    pub records: BTreeMap<OrderedFloat<f32>, MTRecord>,
    pub result_psd: Option<crate::mt_parse::umtfx_result::UmtfxPsdResult>,
    pub result_resistivity: Option<crate::mt_parse::umtfx_result::UmtfxResistivityResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[frb]
pub struct MTStationFfi {
    pub id: String,
    pub project: String,
    pub directory: String,
    pub location: (f64, f64),
    pub start_time_millis: i64,
    pub end_time_millis: i64,
    pub records: Vec<MTRecordFfi>,
    pub result_psd: Option<crate::mt_parse::umtfx_result::UmtfxPsdResult>,
    pub result_resistivity: Option<crate::mt_parse::umtfx_result::UmtfxResistivityResult>,
}

impl From<&MTStation> for MTStationFfi {
    fn from(station: &MTStation) -> Self {
        let records: Vec<MTRecordFfi> = station
            .records
            .iter()
            .map(|(_, v)| MTRecordFfi::from(v))
            .collect();

        MTStationFfi {
            id: station.id.clone(),
            project: station.project.clone(),
            directory: station.directory.clone(),
            location: station.location,
            start_time_millis: system_time_to_millis(&station.start_time),
            end_time_millis: system_time_to_millis(&station.end_time),
            records,
            result_psd: station.result_psd.clone(),
            result_resistivity: station.result_resistivity.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[frb]
pub struct MTStationFullFfi {
    pub id: String,
    pub project: String,
    pub directory: String,
    pub location: (f64, f64),
    pub start_time_millis: i64,
    pub end_time_millis: i64,
    pub records: Vec<MTRecordFfi>,
    pub result_psd: Option<crate::mt_parse::umtfx_result::UmtfxPsdResult>,
    pub result_resistivity: Option<crate::mt_parse::umtfx_result::UmtfxResistivityResult>,
}

impl From<&MTStation> for MTStationFullFfi {
    fn from(station: &MTStation) -> Self {
        let records: Vec<MTRecordFfi> = station
            .records
            .iter()
            .map(|(_, v)| MTRecordFfi::from(v))
            .collect();

        MTStationFullFfi {
            id: station.id.clone(),
            project: station.project.clone(),
            directory: station.directory.clone(),
            location: station.location,
            start_time_millis: system_time_to_millis(&station.start_time),
            end_time_millis: system_time_to_millis(&station.end_time),
            records,
            result_psd: station.result_psd.clone(),
            result_resistivity: station.result_resistivity.clone(),
        }
    }
}

/// 解析文件的trait
pub trait MTFileParser: std::fmt::Debug + Send + Sync + 'static {
    fn parse(path: &Path) -> anyhow::Result<Vec<TimeSeries>>;
    fn can_parse(path: &Path) -> bool; // 用于自动识别
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeSeriesFfi {
    pub channel: ChannelTypeFfi,
    pub start_time_millis: i64,
    pub end_time_millis: i64,
    pub sample_rate: f32,
    pub electrode_distance: f32,
    pub file_path: String,
    pub data: Vec<f64>,
    pub extra: Option<ExtraMetaEnum>,
}

// 从 TimeSeries -> TimeSeriesFfi 的转换（示例）
impl From<&TimeSeries> for TimeSeriesFfi {
    fn from(ts: &TimeSeries) -> Self {
        let data = ts.data.to_vec();

        TimeSeriesFfi {
            channel: ChannelTypeFfi::from(&ts.channel),
            start_time_millis: system_time_to_millis(&ts.start_time),
            end_time_millis: system_time_to_millis(&ts.end_time),
            sample_rate: ts.sample_rate,
            electrode_distance: ts.electrode_distance,
            file_path: ts.file_path.clone(),
            data,
            extra: extrameta_box_to_enum(ts.extra.clone()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CalibrationData {
    pub freqs: Array1<f64>,
    pub responses: Array1<Complex<f64>>,
}

#[derive(Debug, Clone)]
pub struct CalibrationItem {
    pub sensor_type: String,
    pub series: i32,
    pub gain: i32,
    pub file_name: String,
}

#[derive(Debug, Clone)]
pub struct CalibrationBundle {
    pub table: Map<String, Vec<CalibrationItem>>, // hashmap<sensor_type, CalibrationItem>
    pub calibration_data: Map<String, CalibrationData>, // hashmap<file_name, CalibrationData>
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CalculateState {
    Start,       //计算开始
    Calculating, // 计算中
    Completed,   // 计算完成
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[frb]
pub struct CalculateEntry {
    pub state: CalculateState,    // 计算状态
    pub total_station: i32,       // 总共测点
    pub calculated_station: i32,  // 计算好的测点
    pub station_id: String,       // 测点id
    pub calculate_result: String, // 计算结果
}

impl CalculateEntry {
    pub fn new(total_station: i32) -> Self {
        CalculateEntry {
            state: CalculateState::Start,
            total_station,
            calculated_station: 0,
            station_id: "".to_string(),
            calculate_result: "".to_string(),
        }
    }

    pub fn calculating(&mut self) {
        self.state = CalculateState::Calculating;
    }

    pub fn complete(&mut self) {
        self.state = CalculateState::Completed;
        self.calculated_station = self.total_station;
    }
}
