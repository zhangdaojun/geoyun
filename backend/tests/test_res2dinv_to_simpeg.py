from __future__ import annotations

import math

from backend.app.services.res2dinv_to_simpeg import parse_res2dinv_dat


def test_parse_wenner_index_format(tmp_path):
    dat = tmp_path / "wenner.dat"
    dat.write_text(
        "\n".join(
            [
                "Example Wenner",
                "1.0",
                "1",
                "2",
                "0",
                "0",
                "0.0 1.0 100.0",
                "1.0 1.0 120.0",
                "0 0 0 0",
            ]
        ),
        encoding="utf-8",
    )

    result = parse_res2dinv_dat(dat)

    assert result.array_name == "wenner"
    assert len(result.observations) == 2
    first = result.observations[0]
    assert (first.ax, first.mx, first.nx, first.bx) == (0.0, 1.0, 2.0, 3.0)
    assert math.isclose(first.geometric_factor, 2.0 * math.pi, rel_tol=1e-12)
    assert math.isclose(first.resistance, 100.0 / (2.0 * math.pi), rel_tol=1e-12)


def test_parse_dipole_dipole_midpoint_format(tmp_path):
    dat = tmp_path / "dd.dat"
    dat.write_text(
        "\n".join(
            [
                "Example Dipole",
                "1.0",
                "3",
                "1",
                "1",
                "0",
                "2.0 1.0 2 200.0",
                "0 0 0 0",
            ]
        ),
        encoding="utf-8",
    )

    result = parse_res2dinv_dat(dat)
    datum = result.observations[0]

    assert result.array_name == "dipole-dipole"
    assert (datum.ax, datum.bx, datum.mx, datum.nx) == (0.0, 1.0, 3.0, 4.0)
    assert datum.resistance > 0


def test_unit_spacing_header_does_not_rescale_data_rows(tmp_path):
    dat = tmp_path / "field_wenner.dat"
    dat.write_text(
        "\n".join(
            [
                "GEOPEN",
                "10",
                "1",
                "1",
                "1",
                "0",
                "15 10 702.69",
                "0 0 0 0",
            ]
        ),
        encoding="utf-8",
    )

    result = parse_res2dinv_dat(dat)
    datum = result.observations[0]

    assert result.unit_spacing == 10
    assert (datum.ax, datum.mx, datum.nx, datum.bx) == (0.0, 10.0, 20.0, 30.0)
    assert math.isclose(datum.geometric_factor, 20.0 * math.pi, rel_tol=1e-12)
