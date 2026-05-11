use crate::mt_parse::mt::ComplexFfi;
use anyhow::{anyhow, Result};
use byteorder::{LittleEndian, ReadBytesExt};
use flutter_rust_bridge::frb;
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Cursor;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[frb]
pub struct UmtfxPsdChunk {
    pub freq: f32,
    pub bandwidth: f32,
    pub num_of_avg: f32,
    pub ch1_ch1: f32,
    pub ch1_ch2_imag: f32,
    pub ch1_ch3_imag: f32,
    pub ch1_ch4_imag: f32,
    pub ch2_ch1_real: f32,
    pub ch2_ch2: f32,
    pub ch2_ch3_imag: f32,
    pub ch2_ch4_imag: f32,
    pub ch3_ch1_real: f32,
    pub ch3_ch2_real: f32,
    pub ch3_ch3: f32,
    pub ch3_ch4_imag: f32,
    pub ch4_ch1_real: f32,
    pub ch4_ch2_real: f32,
    pub ch4_ch3_real: f32,
    pub ch4_ch4: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[frb]
pub struct UmtfxPsdResult {
    pub file_path: String,
    pub chunks: Vec<UmtfxPsdChunk>,
    pub freq_min: f32,
    pub freq_max: f32,
    pub freq: Vec<f32>,
    pub ex: Vec<f32>,
    pub ey: Vec<f32>,
    pub hx: Vec<f32>,
    pub hy: Vec<f32>,
    pub pha_ex_hy: Vec<f32>,
    pub pha_ey_hx: Vec<f32>,
    pub coh_ex_hy: Vec<f32>,
    pub coh_ey_hx: Vec<f32>,
    pub amplitude_min: f32,
    pub amplitude_max: f32,
    pub phase_min: f32,
    pub phase_max: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[frb]
pub struct UmtfxResistivityChunk {
    pub freq: f32,
    pub coh_ex_hy: f32,
    pub rho_ex_hy: f32,
    pub pha_ex_hy: f32,
    pub coh_ey_hx: f32,
    pub rho_ey_hx: f32,
    pub pha_ey_hx: f32,
    pub zxx: ComplexFfi,
    pub zxy: ComplexFfi,
    pub zyx: ComplexFfi,
    pub zyy: ComplexFfi,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[frb]
pub struct UmtfxResistivityResult {
    pub file_path: String,
    pub chunks: Vec<UmtfxResistivityChunk>,
    pub freq_min: f32,
    pub freq_max: f32,
    pub phase_min: f32,
    pub phase_max: f32,
    pub resistivity_min: f32,
    pub resistivity_max: f32,
    pub freq: Vec<f32>,
    pub ar_exhy: Vec<f32>,
    pub phase_exhy: Vec<f32>,
    pub coherency_exhy: Vec<f32>,
    pub error_bar_exhy: Vec<(f32, f32)>,
    pub ar_eyhx: Vec<f32>,
    pub phase_eyhx: Vec<f32>,
    pub coherency_eyhx: Vec<f32>,
    pub error_bar_eyhx: Vec<(f32, f32)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[frb]
pub enum MTResult {
    Psd { psd: UmtfxPsdResult },
    Resistivity { resistivity: UmtfxResistivityResult },
}

pub trait MTResultFileParser: std::fmt::Debug + Send + Sync + 'static {
    type Output;
    fn parse(path: &Path) -> Result<Self::Output>;
    fn can_parse(path: &Path) -> bool;
}

#[derive(Debug, Clone)]
pub struct UmtfxPsdParser {}

impl MTResultFileParser for UmtfxPsdParser {
    type Output = UmtfxPsdResult;

    fn parse(path: &Path) -> Result<Self::Output> {
        let file = File::open(path)?;
        let metadata = file.metadata()?;
        if metadata.len() < 4 {
            return Err(anyhow!("File is too small"));
        }

        let mmap = unsafe { Mmap::map(&file)? };
        let mut cursor = Cursor::new(mmap.as_ref());
        let count = cursor.read_u32::<LittleEndian>()? as usize;

        let expected_len = 4usize
            .checked_add(count.checked_mul(76).ok_or_else(|| anyhow!("Overflow"))?)
            .ok_or_else(|| anyhow!("Overflow"))?;
        if (metadata.len() as usize) < expected_len {
            return Err(anyhow!("File length mismatch"));
        }

        let mut chunks = Vec::with_capacity(count);
        let mut freq_min = f32::MAX;
        let mut freq_max = f32::MIN;
        let mut freqs: Vec<f32> = Vec::with_capacity(count);
        let mut ex: Vec<f32> = Vec::with_capacity(count);
        let mut ey: Vec<f32> = Vec::with_capacity(count);
        let mut hx: Vec<f32> = Vec::with_capacity(count);
        let mut hy: Vec<f32> = Vec::with_capacity(count);
        let mut pha_ex_hy: Vec<f32> = Vec::with_capacity(count);
        let mut pha_ey_hx: Vec<f32> = Vec::with_capacity(count);
        let mut coh_ex_hy: Vec<f32> = Vec::with_capacity(count);
        let mut coh_ey_hx: Vec<f32> = Vec::with_capacity(count);
        let mut amplitude_min = f32::MAX;
        let mut amplitude_max = f32::MIN;
        let mut phase_min = f32::MAX;
        let mut phase_max = f32::MIN;
        for _ in 0..count {
            let chunk_freq = cursor.read_f32::<LittleEndian>()?;
            let bandwidth = cursor.read_f32::<LittleEndian>()?;
            let num_of_avg = cursor.read_f32::<LittleEndian>()?;
            let ch1_ch1 = cursor.read_f32::<LittleEndian>()?;
            let ch1_ch2_imag = cursor.read_f32::<LittleEndian>()?;
            let ch1_ch3_imag = cursor.read_f32::<LittleEndian>()?;
            let ch1_ch4_imag = cursor.read_f32::<LittleEndian>()?;
            let ch2_ch1_real = cursor.read_f32::<LittleEndian>()?;
            let ch2_ch2 = cursor.read_f32::<LittleEndian>()?;
            let ch2_ch3_imag = cursor.read_f32::<LittleEndian>()?;
            let ch2_ch4_imag = cursor.read_f32::<LittleEndian>()?;
            let ch3_ch1_real = cursor.read_f32::<LittleEndian>()?;
            let ch3_ch2_real = cursor.read_f32::<LittleEndian>()?;
            let ch3_ch3 = cursor.read_f32::<LittleEndian>()?;
            let ch3_ch4_imag = cursor.read_f32::<LittleEndian>()?;
            let ch4_ch1_real = cursor.read_f32::<LittleEndian>()?;
            let ch4_ch2_real = cursor.read_f32::<LittleEndian>()?;
            let ch4_ch3_real = cursor.read_f32::<LittleEndian>()?;
            let ch4_ch4 = cursor.read_f32::<LittleEndian>()?;
            freq_min = freq_min.min(chunk_freq);
            freq_max = freq_max.max(chunk_freq);

            let norm = if num_of_avg < 0.001 || bandwidth.abs() <= f32::EPSILON {
                0.0
            } else {
                1.0 / num_of_avg / bandwidth
            };

            let hy_amp = (ch1_ch1 * norm).max(0.0).sqrt();
            let hx_amp = (ch3_ch3 * norm).max(0.0).sqrt();
            let ex_amp = (ch2_ch2 * chunk_freq * 0.000005 * norm).max(0.0).sqrt();
            let ey_amp = (ch4_ch4 * chunk_freq * 0.000005 * norm).max(0.0).sqrt();

            let local_min = hy_amp.min(hx_amp.min(ex_amp.min(ey_amp)));
            let local_max = hy_amp.max(hx_amp.max(ex_amp.max(ey_amp)));
            amplitude_min = amplitude_min.min(local_min);
            amplitude_max = amplitude_max.max(local_max);

            let pha_ex_hy_deg = if ch2_ch1_real.abs() < 1e-30 {
                if ch1_ch2_imag > 0.0 {
                    90.0
                } else {
                    -90.0
                }
            } else {
                (ch1_ch2_imag / ch2_ch1_real).atan() * 180.0 / std::f32::consts::PI
            };

            let pha_ey_hx_deg = if ch4_ch3_real.abs() < 1e-30 {
                if ch3_ch4_imag > 0.0 {
                    90.0
                } else {
                    -90.0
                }
            } else {
                (ch3_ch4_imag / ch4_ch3_real).atan() * 180.0 / std::f32::consts::PI
            };

            phase_min = phase_min.min(pha_ex_hy_deg.min(pha_ey_hx_deg));
            phase_max = phase_max.max(pha_ex_hy_deg.max(pha_ey_hx_deg));

            let coh_ex_hy_val = {
                let denom = ch1_ch1 * ch2_ch2;
                if denom > 0.0 {
                    ((ch1_ch2_imag * ch1_ch2_imag + ch2_ch1_real * ch2_ch1_real) / denom)
                        .max(0.0)
                        .sqrt()
                } else {
                    0.0
                }
            };
            let coh_ey_hx_val = {
                let denom = ch3_ch3 * ch4_ch4;
                if denom > 0.0 {
                    ((ch3_ch4_imag * ch3_ch4_imag + ch4_ch3_real * ch4_ch3_real) / denom)
                        .max(0.0)
                        .sqrt()
                } else {
                    0.0
                }
            };

            freqs.push(chunk_freq);
            ex.push(ex_amp);
            ey.push(ey_amp);
            hx.push(hx_amp);
            hy.push(hy_amp);
            pha_ex_hy.push(pha_ex_hy_deg);
            pha_ey_hx.push(pha_ey_hx_deg);
            coh_ex_hy.push(coh_ex_hy_val);
            coh_ey_hx.push(coh_ey_hx_val);

            chunks.push(UmtfxPsdChunk {
                freq: chunk_freq,
                bandwidth,
                num_of_avg,
                ch1_ch1,
                ch1_ch2_imag,
                ch1_ch3_imag,
                ch1_ch4_imag,
                ch2_ch1_real,
                ch2_ch2,
                ch2_ch3_imag,
                ch2_ch4_imag,
                ch3_ch1_real,
                ch3_ch2_real,
                ch3_ch3,
                ch3_ch4_imag,
                ch4_ch1_real,
                ch4_ch2_real,
                ch4_ch3_real,
                ch4_ch4,
            });
        }

        let phase_min = if phase_min < -90.0 {
            -180.0
        } else if phase_min > -90.0 && phase_min < 0.0 {
            -90.0
        } else {
            0.0
        };
        let phase_max = if phase_max > 90.0 { 180.0 } else { 90.0 };

        Ok(UmtfxPsdResult {
            file_path: path.display().to_string(),
            chunks,
            freq_min,
            freq_max,
            freq: freqs,
            ex,
            ey,
            hx,
            hy,
            pha_ex_hy,
            pha_ey_hx,
            coh_ex_hy,
            coh_ey_hx,
            amplitude_min,
            amplitude_max,
            phase_min,
            phase_max,
        })
    }

    fn can_parse(path: &Path) -> bool {
        path.extension()
            .and_then(|s| s.to_str())
            .map_or(false, |ext| ext.eq_ignore_ascii_case("PSD"))
    }
}

#[derive(Debug, Clone)]
pub struct UmtfxResistivityParser {}

impl MTResultFileParser for UmtfxResistivityParser {
    type Output = UmtfxResistivityResult;

    fn parse(path: &Path) -> Result<Self::Output> {
        let file = File::open(path)?;
        let metadata = file.metadata()?;
        if metadata.len() < 4 {
            return Err(anyhow!("File is too small"));
        }

        let mmap = unsafe { Mmap::map(&file)? };
        let mut cursor = Cursor::new(mmap.as_ref());
        let count = cursor.read_u32::<LittleEndian>()? as usize;

        let expected_len = 4usize
            .checked_add(count.checked_mul(60).ok_or_else(|| anyhow!("Overflow"))?)
            .ok_or_else(|| anyhow!("Overflow"))?;
        if (metadata.len() as usize) < expected_len {
            return Err(anyhow!("File length mismatch"));
        }

        let mut chunks = Vec::with_capacity(count);
        let mut freq_min = f32::MAX;
        let mut freq_max = f32::MIN;
        let mut phase_min = f32::MAX;
        let mut phase_max = f32::MIN;
        let mut resistivity_min = f32::MAX;
        let mut resistivity_max = f32::MIN;
        let mut freq: Vec<f32> = Vec::with_capacity(count);
        let mut ar_exhy: Vec<f32> = Vec::with_capacity(count);
        let mut phase_exhy: Vec<f32> = Vec::with_capacity(count);
        let mut coherency_exhy: Vec<f32> = Vec::with_capacity(count);
        let mut error_bar_exhy: Vec<(f32, f32)> = Vec::with_capacity(count);
        let mut ar_eyhx: Vec<f32> = Vec::with_capacity(count);
        let mut phase_eyhx: Vec<f32> = Vec::with_capacity(count);
        let mut coherency_eyhx: Vec<f32> = Vec::with_capacity(count);
        let mut error_bar_eyhx: Vec<(f32, f32)> = Vec::with_capacity(count);
        for _ in 0..count {
            let chunk_freq = cursor.read_f32::<LittleEndian>()?;
            let coh_ex_hy = cursor.read_f32::<LittleEndian>()?;
            let rho_ex_hy = cursor.read_f32::<LittleEndian>()?;
            let pha_ex_hy = cursor.read_f32::<LittleEndian>()?;
            let coh_ey_hx = cursor.read_f32::<LittleEndian>()?;
            let rho_ey_hx = cursor.read_f32::<LittleEndian>()?;
            let pha_ey_hx = cursor.read_f32::<LittleEndian>()?;

            let zxx_re = cursor.read_f32::<LittleEndian>()? as f64;
            let zxx_im = cursor.read_f32::<LittleEndian>()? as f64;
            let zxy_re = cursor.read_f32::<LittleEndian>()? as f64;
            let zxy_im = cursor.read_f32::<LittleEndian>()? as f64;
            let zyx_re = cursor.read_f32::<LittleEndian>()? as f64;
            let zyx_im = cursor.read_f32::<LittleEndian>()? as f64;
            let zyy_re = cursor.read_f32::<LittleEndian>()? as f64;
            let zyy_im = cursor.read_f32::<LittleEndian>()? as f64;

            freq_min = freq_min.min(chunk_freq);
            freq_max = freq_max.max(chunk_freq);
            phase_min = phase_min.min(pha_ex_hy);
            phase_max = phase_max.max(pha_ex_hy);
            phase_min = phase_min.min(pha_ey_hx);
            phase_max = phase_max.max(pha_ey_hx);
            resistivity_min = resistivity_min.min(rho_ex_hy);
            resistivity_max = resistivity_max.max(rho_ex_hy);
            resistivity_min = resistivity_min.min(rho_ey_hx);
            resistivity_max = resistivity_max.max(rho_ey_hx);

            freq.push(chunk_freq);
            ar_exhy.push(rho_ex_hy);
            phase_exhy.push(pha_ex_hy);
            coherency_exhy.push(coh_ex_hy);
            ar_eyhx.push(rho_ey_hx);
            phase_eyhx.push(pha_ey_hx);
            coherency_eyhx.push(coh_ey_hx);

            let mut calc_coherency = 0.0_f32;
            let mut diff = 0.0_f32;
            calc_coherency = if coh_ex_hy > 1.0 { 1.0 } else { coh_ex_hy };
            diff = 10.0_f32.powf(1.0_f32 - calc_coherency);
            error_bar_exhy.push((rho_ex_hy / diff, rho_ex_hy * diff));

            calc_coherency = if coh_ey_hx > 1.0 { 1.0 } else { coh_ey_hx };
            diff = 10.0_f32.powf(1.0_f32 - calc_coherency);
            error_bar_eyhx.push((rho_ey_hx / diff, rho_ey_hx * diff));

            chunks.push(UmtfxResistivityChunk {
                freq: chunk_freq,
                coh_ex_hy,
                rho_ex_hy,
                pha_ex_hy,
                coh_ey_hx,
                rho_ey_hx,
                pha_ey_hx,
                zxx: ComplexFfi {
                    re: zxx_re,
                    im: zxx_im,
                },
                zxy: ComplexFfi {
                    re: zxy_re,
                    im: zxy_im,
                },
                zyx: ComplexFfi {
                    re: zyx_re,
                    im: zyx_im,
                },
                zyy: ComplexFfi {
                    re: zyy_re,
                    im: zyy_im,
                },
            });
        }

        Ok(UmtfxResistivityResult {
            file_path: path.display().to_string(),
            chunks,
            freq_min,
            freq_max,
            phase_min,
            phase_max,
            resistivity_min,
            resistivity_max,
            freq,
            ar_exhy,
            phase_exhy,
            coherency_exhy,
            error_bar_exhy,
            ar_eyhx,
            phase_eyhx,
            coherency_eyhx,
            error_bar_eyhx,
        })
    }

    fn can_parse(path: &Path) -> bool {
        path.extension()
            .and_then(|s| s.to_str())
            .map_or(false, |ext| ext.eq_ignore_ascii_case("R"))
    }
}

pub(crate) fn parse_result_file(path: &Path) -> Result<MTResult> {
    if UmtfxPsdParser::can_parse(path) {
        Ok(MTResult::Psd {
            psd: UmtfxPsdParser::parse(path)?,
        })
    } else if UmtfxResistivityParser::can_parse(path) {
        Ok(MTResult::Resistivity {
            resistivity: UmtfxResistivityParser::parse(path)?,
        })
    } else {
        Err(anyhow!("Unsupported result file: {:?}", path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use byteorder::{LittleEndian, WriteBytesExt};
    use std::io::Write;

    #[test]
    fn test_parse_psd_minimal() -> Result<()> {
        let dir = std::env::temp_dir();
        let path = dir.join("umtfx_test.PSD");
        let mut f = File::create(&path)?;
        f.write_u32::<LittleEndian>(1)?;
        f.write_f32::<LittleEndian>(1.0)?;
        f.write_f32::<LittleEndian>(2.0)?;
        f.write_f32::<LittleEndian>(3.0)?;
        for i in 0..16 {
            f.write_f32::<LittleEndian>(10.0 + i as f32)?;
        }
        f.flush()?;

        let parsed = UmtfxPsdParser::parse(&path)?;
        assert_eq!(parsed.chunks.len(), 1);
        assert_eq!(parsed.freq.len(), 1);
        assert_eq!(parsed.ex.len(), 1);
        assert_eq!(parsed.ey.len(), 1);
        assert_eq!(parsed.hx.len(), 1);
        assert_eq!(parsed.hy.len(), 1);
        assert_eq!(parsed.pha_ex_hy.len(), 1);
        assert_eq!(parsed.pha_ey_hx.len(), 1);
        assert_eq!(parsed.coh_ex_hy.len(), 1);
        assert_eq!(parsed.coh_ey_hx.len(), 1);
        assert!(parsed.amplitude_max >= parsed.amplitude_min);
        assert!(parsed.phase_max >= parsed.phase_min);
        assert!((parsed.chunks[0].freq - 1.0).abs() < 1e-6);
        Ok(())
    }

    #[test]
    fn test_parse_resistivity_minimal() -> Result<()> {
        let dir = std::env::temp_dir();
        let path = dir.join("umtfx_test.R");
        let mut f = File::create(&path)?;
        f.write_u32::<LittleEndian>(1)?;
        for i in 0..7 {
            f.write_f32::<LittleEndian>(1.0 + i as f32)?;
        }
        for i in 0..8 {
            f.write_f32::<LittleEndian>(100.0 + i as f32)?;
        }
        f.flush()?;

        let parsed = UmtfxResistivityParser::parse(&path)?;
        assert_eq!(parsed.chunks.len(), 1);
        assert!((parsed.chunks[0].freq - 1.0).abs() < 1e-6);
        assert!((parsed.chunks[0].zxx.re - 100.0).abs() < 1e-6);
        assert!((parsed.chunks[0].zxx.im - 101.0).abs() < 1e-6);
        Ok(())
    }
}
