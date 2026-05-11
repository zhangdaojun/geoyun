pub mod ats;
pub mod extra_meta;
pub mod mt;
pub mod mtts;
pub mod umtfx;
pub mod umtfx_index;
pub mod umtfx_result;
pub mod utils;

pub use ats::*;
pub use extra_meta::*;
pub use mt::*;
pub use mtts::*;
pub use umtfx::*;
pub use umtfx_index::*;
pub use umtfx_result::*;
pub use utils::*;

#[derive(Debug, Clone)]
pub(crate) enum ParsedFile {
    Raw { time_series: Vec<TimeSeries> },
    Result { result: MTResult },
    Index { index_file: UmtfxIndexFile },
}

pub(crate) fn parse_file(path: &std::path::Path) -> anyhow::Result<Vec<TimeSeries>> {
    if AtsParser::can_parse(path) {
        AtsParser::parse(path)
    } else if MttsParser::can_parse(path) {
        MttsParser::parse(path)
    } else if UMTFxParser::can_parse(path) {
        UMTFxParser::parse(path)
    } else {
        anyhow::bail!("Unsupported file format: {:?}", path)
    }
}

pub(crate) fn parse_any_file(path: &std::path::Path) -> anyhow::Result<ParsedFile> {
    if path
        .extension()
        .and_then(|s| s.to_str())
        .map_or(false, |ext| {
            ext.eq_ignore_ascii_case("INDEX") || ext.eq_ignore_ascii_case("IDX")
        })
    {
        return Ok(ParsedFile::Index {
            index_file: umtfx_index::parse_umtfx_index_file(path)?,
        });
    }

    if UmtfxPsdParser::can_parse(path) || UmtfxResistivityParser::can_parse(path) {
        return Ok(ParsedFile::Result {
            result: umtfx_result::parse_result_file(path)?,
        });
    }

    Ok(ParsedFile::Raw {
        time_series: parse_file(path)?,
    })
}
