use serde::{Deserialize, Serialize};

pub trait ExtraMeta: std::fmt::Debug + Send + Sync + 'static {
    fn as_any(&self) -> &dyn std::any::Any;
    fn clone_box(&self) -> Box<dyn ExtraMeta>;

    // Calibration-related methods with default implementations
    fn get_system_type(&self) -> Option<&str> {
        None
    }
    fn get_sensor(&self) -> Option<&str> {
        None
    }
    fn get_internal_gain_amplification(&self) -> Option<i32> {
        None
    }
    fn get_adu_serial_number(&self) -> Option<i32> {
        None
    }
    fn get_sensor_number(&self) -> Option<i32> {
        None
    }

    fn get_sample_rate_hz(&self) -> Option<f64> {
        None
    }

    fn get_dipole_length_m(&self) -> Option<f64> {
        None
    }

    fn get_pga_e0(&self) -> Option<f64> {
        None
    }

    fn get_pga_e1(&self) -> Option<f64> {
        None
    }

    fn get_pga_h0(&self) -> Option<f64> {
        None
    }

    fn get_pga_h1(&self) -> Option<f64> {
        None
    }

    fn get_band_l_direct_sample(&self) -> Option<u32> {
        None
    }

    fn get_eh4_e_gain(&self) -> Option<u32> {
        None
    }

    fn get_eh4_m_gain(&self) -> Option<u32> {
        None
    }

    fn get_eh4_band(&self) -> Option<u32> {
        None
    }
}

impl Clone for Box<dyn ExtraMeta> {
    fn clone(&self) -> Box<dyn ExtraMeta> {
        self.clone_box()
    }
}

#[derive(Debug, Clone)]
pub struct AtsExtraMeta {
    /// 文件名里面的信息
    pub station_id: String,
    /// ATS 文件头长度，通常为256字节
    pub length: i16,
    pub version: i16,
    pub nsamples: i32,
    pub sfreq: f32,
    pub start: i32,
    pub lsb: f64,
    pub gmt_offset: i32,
    pub original_sample_freq: f32,
    pub adu_serial_number: i16,
    pub adu_adb: i16,
    pub channel_number: i8,
    pub sensor_chopper: i8,
    pub channel_type: String,
    pub sensor: String,
    pub sensor_number: i16,
    pub x1: f32,
    pub y1: f32,
    pub z1: f32,
    pub x2: f32,
    pub y2: f32,
    pub z2: f32,
    pub dipole_length: f32,
    pub dipole_angle: f32,
    pub probe_resistivity: f32,
    pub dc_offset: f32,
    pub internal_gain_amplification: f32,
    pub pos_gain: f32,
    pub latitude: i32,
    pub longitude: i32,
    pub elevation: i32,
    pub lat_long_type: String,
    pub additional_coordinates_type: i8,
    pub reference_meridian: i16,
    pub x_coordinate: f64,
    pub y_coordinate: f64,
    pub gps_status: String,
    pub gps_accuracy: i8,
    pub utc_offset: i16,
    pub system_type: String,
    pub survey_header_filename: String,
    pub measurement_type: String,
    pub dc_offset_correction_value: f64,
    pub dc_offset_correction_on: i8,
    pub input_divisor_on: i8,
    pub bit_indicator: i16,
    pub self_test_result: String,
    pub number_slice: u16,
    pub number_calibration_frequencies: u16,
}

impl ExtraMeta for AtsExtraMeta {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn clone_box(&self) -> Box<dyn ExtraMeta> {
        Box::new(self.clone())
    }

    fn get_system_type(&self) -> Option<&str> {
        Some(&self.system_type)
    }

    fn get_sensor(&self) -> Option<&str> {
        Some(&self.sensor)
    }

    fn get_internal_gain_amplification(&self) -> Option<i32> {
        Some(self.internal_gain_amplification as i32)
    }

    fn get_adu_serial_number(&self) -> Option<i32> {
        Some(self.adu_serial_number as i32)
    }

    fn get_sensor_number(&self) -> Option<i32> {
        Some(self.sensor_number as i32)
    }

    fn get_sample_rate_hz(&self) -> Option<f64> {
        Some(self.sfreq as f64)
    }

    fn get_dipole_length_m(&self) -> Option<f64> {
        Some(self.dipole_length as f64)
    }
}

#[derive(Debug, Clone)]
pub struct MttsExtraMeta {
    pub station_id: String,
    pub length: i16,
    pub version: i16,
    pub nsamples: i32,
    pub nsamples_in_file: i32,
    pub sfreq: f32,
    pub start: i32,
    pub lsb: f64,
    pub gmt_offset: i32,
    pub original_sample_freq: f32,
    pub adu_serial_number: i16,
    pub adu_adb: i16,
    pub channel_number: i8,
    pub sensor_chopper: i8,
    pub channel_type: String,
    pub sensor: String,
    pub sensor_number: i16,
    pub x1: f32,
    pub y1: f32,
    pub z1: f32,
    pub x2: f32,
    pub y2: f32,
    pub z2: f32,
    pub dipole_length: f32,
    pub dipole_angle: f32,
    pub probe_resistivity: f32,
    pub dc_offset: f32,
    pub internal_gain_amplification: f32,
    pub pos_gain: f32,
    pub latitude: i32,
    pub longitude: i32,
    pub elevation: i32,
    pub lat_long_type: String,
    pub additional_coordinates_type: i8,
    pub reference_meridian: i16,
    pub x_coordinate: f64,
    pub y_coordinate: f64,
    pub gps_status: String,
    pub gps_accuracy: i8,
    pub utc_offset: i16,
    pub system_type: String,
    pub survey_header_filename: String,
    pub measurement_type: String,
    pub dc_offset_correction_value: f64,
    pub dc_offset_correction_on: i8,
    pub input_divisor_on: i8,
    pub bit_indicator: i16,
    pub self_test_result: String,
    pub number_slice: u16,
    pub number_calibration_frequencies: u16,
}

impl ExtraMeta for MttsExtraMeta {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn clone_box(&self) -> Box<dyn ExtraMeta> {
        Box::new(self.clone())
    }

    fn get_system_type(&self) -> Option<&str> {
        Some(&self.system_type)
    }

    fn get_sensor(&self) -> Option<&str> {
        Some(&self.sensor)
    }

    fn get_internal_gain_amplification(&self) -> Option<i32> {
        Some(self.internal_gain_amplification as i32)
    }

    fn get_adu_serial_number(&self) -> Option<i32> {
        Some(self.adu_serial_number as i32)
    }

    fn get_sensor_number(&self) -> Option<i32> {
        Some(self.sensor_number as i32)
    }

    fn get_sample_rate_hz(&self) -> Option<f64> {
        Some(self.sfreq as f64)
    }

    fn get_dipole_length_m(&self) -> Option<f64> {
        Some(self.dipole_length as f64)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AtsExtraMetaFfi {
    /// 文件名里面的信息
    pub station_id: String,
    /// ATS 文件头长度，通常为256字节
    pub length: i16,
    pub version: i16,
    pub nsamples: i32,
    pub sfreq: f32,
    pub start: i32,
    pub lsb: f64,
    pub gmt_offset: i32,
    pub original_sample_freq: f32,
    pub adu_serial_number: i16,
    pub adu_adb: i16,
    pub channel_number: i8,
    pub sensor_chopper: i8,
    pub channel_type: String,
    pub sensor: String,
    pub sensor_number: i16,
    pub x1: f32,
    pub y1: f32,
    pub z1: f32,
    pub x2: f32,
    pub y2: f32,
    pub z2: f32,
    pub dipole_length: f32,
    pub dipole_angle: f32,
    pub probe_resistivity: f32,
    pub dc_offset: f32,
    pub internal_gain_amplification: f32,
    pub pos_gain: f32,
    pub latitude: i32,
    pub longitude: i32,
    pub elevation: i32,
    pub lat_long_type: String,
    pub additional_coordinates_type: i8,
    pub reference_meridian: i16,
    pub x_coordinate: f64,
    pub y_coordinate: f64,
    pub gps_status: String,
    pub gps_accuracy: i8,
    pub utc_offset: i16,
    pub system_type: String,
    pub survey_header_filename: String,
    pub measurement_type: String,
    pub dc_offset_correction_value: f64,
    pub dc_offset_correction_on: i8,
    pub input_divisor_on: i8,
    pub bit_indicator: i16,
    pub self_test_result: String,
    pub number_slice: u16,
    pub number_calibration_frequencies: u16,
}

impl From<&AtsExtraMeta> for AtsExtraMetaFfi {
    fn from(a: &AtsExtraMeta) -> Self {
        Self {
            station_id: a.station_id.clone(),
            length: a.length,
            version: a.version,
            nsamples: a.nsamples,
            sfreq: a.sfreq,
            start: a.start,
            lsb: a.lsb,
            gmt_offset: a.gmt_offset,
            original_sample_freq: a.original_sample_freq,
            adu_serial_number: a.adu_serial_number,
            adu_adb: a.adu_adb,
            channel_number: a.channel_number,
            sensor_chopper: a.sensor_chopper,
            channel_type: a.channel_type.clone(),
            sensor: a.sensor.clone(),
            sensor_number: a.sensor_number,
            x1: a.x1,
            y1: a.y1,
            z1: a.z1,
            x2: a.x2,
            y2: a.y2,
            z2: a.z2,
            dipole_length: a.dipole_length,
            dipole_angle: a.dipole_angle,
            probe_resistivity: a.probe_resistivity,
            dc_offset: a.dc_offset,
            internal_gain_amplification: a.internal_gain_amplification,
            pos_gain: a.pos_gain,
            latitude: a.latitude,
            longitude: a.longitude,
            elevation: a.elevation,
            lat_long_type: a.lat_long_type.clone(),
            additional_coordinates_type: a.additional_coordinates_type,
            reference_meridian: a.reference_meridian,
            x_coordinate: a.x_coordinate,
            y_coordinate: a.y_coordinate,
            gps_status: a.gps_status.clone(),
            gps_accuracy: a.gps_accuracy,
            utc_offset: a.utc_offset,
            system_type: a.system_type.clone(),
            survey_header_filename: a.survey_header_filename.clone(),
            measurement_type: a.measurement_type.clone(),
            dc_offset_correction_value: a.dc_offset_correction_value,
            dc_offset_correction_on: a.dc_offset_correction_on,
            input_divisor_on: a.input_divisor_on,
            bit_indicator: a.bit_indicator,
            self_test_result: a.self_test_result.clone(),
            number_slice: a.number_slice,
            number_calibration_frequencies: a.number_calibration_frequencies,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MttsExtraMetaFfi {
    pub station_id: String,
    pub length: i16,
    pub version: i16,
    pub nsamples: i32,
    pub nsamples_in_file: i32,
    pub sfreq: f32,
    pub start: i32,
    pub lsb: f64,
    pub gmt_offset: i32,
    pub original_sample_freq: f32,
    pub adu_serial_number: i16,
    pub adu_adb: i16,
    pub channel_number: i8,
    pub sensor_chopper: i8,
    pub channel_type: String,
    pub sensor: String,
    pub sensor_number: i16,
    pub x1: f32,
    pub y1: f32,
    pub z1: f32,
    pub x2: f32,
    pub y2: f32,
    pub z2: f32,
    pub dipole_length: f32,
    pub dipole_angle: f32,
    pub probe_resistivity: f32,
    pub dc_offset: f32,
    pub internal_gain_amplification: f32,
    pub pos_gain: f32,
    pub latitude: i32,
    pub longitude: i32,
    pub elevation: i32,
    pub lat_long_type: String,
    pub additional_coordinates_type: i8,
    pub reference_meridian: i16,
    pub x_coordinate: f64,
    pub y_coordinate: f64,
    pub gps_status: String,
    pub gps_accuracy: i8,
    pub utc_offset: i16,
    pub system_type: String,
    pub survey_header_filename: String,
    pub measurement_type: String,
    pub dc_offset_correction_value: f64,
    pub dc_offset_correction_on: i8,
    pub input_divisor_on: i8,
    pub bit_indicator: i16,
    pub self_test_result: String,
    pub number_slice: u16,
    pub number_calibration_frequencies: u16,
}

impl From<&MttsExtraMeta> for MttsExtraMetaFfi {
    fn from(a: &MttsExtraMeta) -> Self {
        Self {
            station_id: a.station_id.clone(),
            length: a.length,
            version: a.version,
            nsamples: a.nsamples,
            nsamples_in_file: a.nsamples_in_file,
            sfreq: a.sfreq,
            start: a.start,
            lsb: a.lsb,
            gmt_offset: a.gmt_offset,
            original_sample_freq: a.original_sample_freq,
            adu_serial_number: a.adu_serial_number,
            adu_adb: a.adu_adb,
            channel_number: a.channel_number,
            sensor_chopper: a.sensor_chopper,
            channel_type: a.channel_type.clone(),
            sensor: a.sensor.clone(),
            sensor_number: a.sensor_number,
            x1: a.x1,
            y1: a.y1,
            z1: a.z1,
            x2: a.x2,
            y2: a.y2,
            z2: a.z2,
            dipole_length: a.dipole_length,
            dipole_angle: a.dipole_angle,
            probe_resistivity: a.probe_resistivity,
            dc_offset: a.dc_offset,
            internal_gain_amplification: a.internal_gain_amplification,
            pos_gain: a.pos_gain,
            latitude: a.latitude,
            longitude: a.longitude,
            elevation: a.elevation,
            lat_long_type: a.lat_long_type.clone(),
            additional_coordinates_type: a.additional_coordinates_type,
            reference_meridian: a.reference_meridian,
            x_coordinate: a.x_coordinate,
            y_coordinate: a.y_coordinate,
            gps_status: a.gps_status.clone(),
            gps_accuracy: a.gps_accuracy,
            utc_offset: a.utc_offset,
            system_type: a.system_type.clone(),
            survey_header_filename: a.survey_header_filename.clone(),
            measurement_type: a.measurement_type.clone(),
            dc_offset_correction_value: a.dc_offset_correction_value,
            dc_offset_correction_on: a.dc_offset_correction_on,
            input_divisor_on: a.input_divisor_on,
            bit_indicator: a.bit_indicator,
            self_test_result: a.self_test_result.clone(),
            number_slice: a.number_slice,
            number_calibration_frequencies: a.number_calibration_frequencies,
        }
    }
}

#[derive(Debug, Clone)]
pub struct UMTFxExtraMeta {
    pub u_cpuid1: u32,
    pub u_cpuid2: u32,
    pub u_cpuid3: u32,
    pub device_id: u32,
    pub sub_second: u16,
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
    pub band: u8,
    pub tag_size: u8,
    pub status: u8,
    pub saturation: u8,
    pub gps_status: u8,
    pub satellites: u8,
    pub clock_status: u8,
    pub channels: u8,
    pub sample_bytes: u8,
    pub valid_bytes: u8,
    pub start_byte: u8,
    pub data_type: u8,
    pub data_big_endian: u8,
    pub u_ex_channel_no: u8,
    pub u_ey_channel_no: u8,
    pub u_ez_channel_no: u8,
    pub u_hx_channel_no: u8,
    pub u_hy_channel_no: u8,
    pub u_hz_channel_no: u8,
    pub line_no: i32,
    pub point_no: i32,
    pub scans: u32,
    pub sample_rate: f32,
    pub f_lsb_val: f32,
    pub f_v_ref: f32,
    pub f_pga_val_e: f32,
    pub f_pga_val_h: f32,
    pub f_x_length: f32,
    pub f_y_length: f32,
    pub u_ns: u32,
    pub u_slot: u32,
    pub buff_size: u32,
    pub gps_longitude: f64,
    pub gps_latitude: f64,
    pub gps_elevation: f64,
    pub u_eh4_band: u32,
    pub u_eh4_e_gain: u32,
    pub u_eh4_m_gain: u32,
    pub f_pga_val_e1: f32,
    pub f_pga_val_h1: f32,
    pub band_l_direct_sample: u32,
    pub data_interweave: u32,
    pub decimation: u32,
    pub down_multiple: u32,
    pub down_band_index: u32,
    pub project: String,
    pub company: String,
    pub operator: String,
    pub device_type: Option<u32>,
    pub hx_serial_number: Option<String>,
    pub hy_serial_number: Option<String>,
    pub ep_serial_number: Option<String>,
}

impl ExtraMeta for UMTFxExtraMeta {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn clone_box(&self) -> Box<dyn ExtraMeta> {
        Box::new(self.clone())
    }

    fn get_system_type(&self) -> Option<&str> {
        Some("UMTFX")
    }

    fn get_internal_gain_amplification(&self) -> Option<i32> {
        Some(1)
    }

    fn get_adu_serial_number(&self) -> Option<i32> {
        Some(self.device_id as i32)
    }

    fn get_sample_rate_hz(&self) -> Option<f64> {
        Some(self.sample_rate as f64)
    }

    fn get_dipole_length_m(&self) -> Option<f64> {
        Some(self.f_x_length as f64)
    }

    fn get_pga_e0(&self) -> Option<f64> {
        Some(self.f_pga_val_e as f64)
    }

    fn get_pga_e1(&self) -> Option<f64> {
        Some(self.f_pga_val_e1 as f64)
    }

    fn get_pga_h0(&self) -> Option<f64> {
        Some(self.f_pga_val_h as f64)
    }

    fn get_pga_h1(&self) -> Option<f64> {
        Some(self.f_pga_val_h1 as f64)
    }

    fn get_band_l_direct_sample(&self) -> Option<u32> {
        Some(self.band_l_direct_sample)
    }

    fn get_eh4_e_gain(&self) -> Option<u32> {
        Some(self.u_eh4_e_gain)
    }

    fn get_eh4_m_gain(&self) -> Option<u32> {
        Some(self.u_eh4_m_gain)
    }

    fn get_eh4_band(&self) -> Option<u32> {
        Some(self.u_eh4_band)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UMTFxExtraMetaFfi {
    pub u_cpuid1: u32,
    pub u_cpuid2: u32,
    pub u_cpuid3: u32,
    pub device_id: u32,
    pub sub_second: u16,
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
    pub band: u8,
    pub tag_size: u8,
    pub status: u8,
    pub saturation: u8,
    pub gps_status: u8,
    pub satellites: u8,
    pub clock_status: u8,
    pub channels: u8,
    pub sample_bytes: u8,
    pub valid_bytes: u8,
    pub start_byte: u8,
    pub data_type: u8,
    pub data_big_endian: u8,
    pub u_ex_channel_no: u8,
    pub u_ey_channel_no: u8,
    pub u_ez_channel_no: u8,
    pub u_hx_channel_no: u8,
    pub u_hy_channel_no: u8,
    pub u_hz_channel_no: u8,
    pub line_no: i32,
    pub point_no: i32,
    pub scans: u32,
    pub sample_rate: f32,
    pub f_lsb_val: f32,
    pub f_v_ref: f32,
    pub f_pga_val_e: f32,
    pub f_pga_val_h: f32,
    pub f_x_length: f32,
    pub f_y_length: f32,
    pub u_ns: u32,
    pub u_slot: u32,
    pub buff_size: u32,
    pub gps_longitude: f64,
    pub gps_latitude: f64,
    pub gps_elevation: f64,
    pub u_eh4_band: u32,
    pub u_eh4_e_gain: u32,
    pub u_eh4_m_gain: u32,
    pub f_pga_val_e1: f32,
    pub f_pga_val_h1: f32,
    pub band_l_direct_sample: u32,
    pub data_interweave: u32,
    pub decimation: u32,
    pub down_multiple: u32,
    pub down_band_index: u32,
    pub project: String,
    pub company: String,
    pub operator: String,
    pub device_type: Option<u32>,
    pub hx_serial_number: Option<String>,
    pub hy_serial_number: Option<String>,
    pub ep_serial_number: Option<String>,
}

impl From<&UMTFxExtraMeta> for UMTFxExtraMetaFfi {
    fn from(a: &UMTFxExtraMeta) -> Self {
        Self {
            u_cpuid1: a.u_cpuid1,
            u_cpuid2: a.u_cpuid2,
            u_cpuid3: a.u_cpuid3,
            device_id: a.device_id,
            sub_second: a.sub_second,
            year: a.year,
            month: a.month,
            day: a.day,
            hour: a.hour,
            minute: a.minute,
            second: a.second,
            band: a.band,
            tag_size: a.tag_size,
            status: a.status,
            saturation: a.saturation,
            gps_status: a.gps_status,
            satellites: a.satellites,
            clock_status: a.clock_status,
            channels: a.channels,
            sample_bytes: a.sample_bytes,
            valid_bytes: a.valid_bytes,
            start_byte: a.start_byte,
            data_type: a.data_type,
            data_big_endian: a.data_big_endian,
            u_ex_channel_no: a.u_ex_channel_no,
            u_ey_channel_no: a.u_ey_channel_no,
            u_ez_channel_no: a.u_ez_channel_no,
            u_hx_channel_no: a.u_hx_channel_no,
            u_hy_channel_no: a.u_hy_channel_no,
            u_hz_channel_no: a.u_hz_channel_no,
            line_no: a.line_no,
            point_no: a.point_no,
            scans: a.scans,
            sample_rate: a.sample_rate,
            f_lsb_val: a.f_lsb_val,
            f_v_ref: a.f_v_ref,
            f_pga_val_e: a.f_pga_val_e,
            f_pga_val_h: a.f_pga_val_h,
            f_x_length: a.f_x_length,
            f_y_length: a.f_y_length,
            u_ns: a.u_ns,
            u_slot: a.u_slot,
            buff_size: a.buff_size,
            gps_longitude: a.gps_longitude,
            gps_latitude: a.gps_latitude,
            gps_elevation: a.gps_elevation,
            u_eh4_band: a.u_eh4_band,
            u_eh4_e_gain: a.u_eh4_e_gain,
            u_eh4_m_gain: a.u_eh4_m_gain,
            f_pga_val_e1: a.f_pga_val_e1,
            f_pga_val_h1: a.f_pga_val_h1,
            band_l_direct_sample: a.band_l_direct_sample,
            data_interweave: a.data_interweave,
            decimation: a.decimation,
            down_multiple: a.down_multiple,
            down_band_index: a.down_band_index,
            project: a.project.clone(),
            company: a.company.clone(),
            operator: a.operator.clone(),
            device_type: a.device_type,
            hx_serial_number: a.hx_serial_number.clone(),
            hy_serial_number: a.hy_serial_number.clone(),
            ep_serial_number: a.ep_serial_number.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ExtraMetaEnum {
    Ats(AtsExtraMetaFfi),
    Mtts(MttsExtraMetaFfi),
    UMTFx(UMTFxExtraMetaFfi),
}

pub fn extrameta_box_to_enum(opt: Option<Box<dyn ExtraMeta>>) -> Option<ExtraMetaEnum> {
    match opt {
        Some(b) => {
            let any_ref = b.as_any();
            // 尝试 downcast 为 AtsExtraMeta
            if let Some(ats) = any_ref.downcast_ref::<AtsExtraMeta>() {
                Some(ExtraMetaEnum::Ats(AtsExtraMetaFfi::from(ats)))
            } else if let Some(mtts) = any_ref.downcast_ref::<MttsExtraMeta>() {
                Some(ExtraMetaEnum::Mtts(MttsExtraMetaFfi::from(mtts)))
            } else if let Some(umtfx) = any_ref.downcast_ref::<UMTFxExtraMeta>() {
                Some(ExtraMetaEnum::UMTFx(UMTFxExtraMetaFfi::from(umtfx)))
            } else {
                // 返回None而不是错误，表示无法转换
                eprintln!("Warning: Unknown ExtraMeta concrete type, returning None");
                None
            }
        }
        None => None,
    }
}
