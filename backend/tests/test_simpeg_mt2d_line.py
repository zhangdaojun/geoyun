import csv
import json
import zipfile
from pathlib import Path

from backend.app.services.simpeg_mt2d_line import (
    build_simpeg_input_from_csv,
    load_eh4_mt_line_csv,
)


def _write_sample_line_csv(path: Path) -> None:
    rows = [
        {
            "line_code": "L1",
            "point_code": "P01",
            "distance_m": "0",
            "elevation_m": "1000",
            "freq_hz": "10",
            "rho_xy": "120",
            "phase_xy_deg": "45",
            "rho_yx": "140",
            "phase_yx_deg": "43",
        },
        {
            "line_code": "L1",
            "point_code": "P02",
            "distance_m": "50",
            "elevation_m": "995",
            "freq_hz": "10",
            "rho_xy": "130",
            "phase_xy_deg": "44",
            "rho_yx": "150",
            "phase_yx_deg": "42",
        },
        {
            "line_code": "L2",
            "point_code": "P99",
            "distance_m": "0",
            "elevation_m": "900",
            "freq_hz": "10",
            "rho_xy": "999",
            "phase_xy_deg": "1",
            "rho_yx": "",
            "phase_yx_deg": "",
        },
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def test_load_eh4_mt_line_csv_filters_line_and_expands_components(tmp_path: Path):
    csv_path = tmp_path / "line.csv"
    _write_sample_line_csv(csv_path)

    observations = load_eh4_mt_line_csv(csv_path, line_code="L1")

    assert len(observations) == 4
    assert {item.component for item in observations} == {"xy", "yx"}
    assert {item.station for item in observations} == {"P01", "P02"}
    assert observations[0].distance_m == 0.0
    assert observations[-1].distance_m == 50.0


def test_build_simpeg_input_from_csv_writes_manifest_and_npz(tmp_path: Path):
    csv_path = tmp_path / "line.csv"
    out_dir = tmp_path / "simpeg"
    _write_sample_line_csv(csv_path)

    result = build_simpeg_input_from_csv(csv_path, out_dir, line_code="L1")

    assert result.observation_count == 4
    assert result.station_count == 2
    assert result.frequency_count == 1
    survey = json.loads(Path(result.survey_json).read_text(encoding="utf-8"))
    assert survey["format"] == "geoyun.simpeg.mt2d.line.v1"
    assert survey["line"] == "L1"

    with zipfile.ZipFile(result.simpeg_npz) as archive:
        assert sorted(archive.namelist()) == [
            "components.npy",
            "frequencies_hz.npy",
            "impedance_imag.npy",
            "impedance_real.npy",
            "line.npy",
            "locations_xz.npy",
            "phase_deg.npy",
            "rho_ohm_m.npy",
            "station.npy",
            "std_phase_deg.npy",
            "std_rho.npy",
        ]
