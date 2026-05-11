from __future__ import annotations

import argparse
import csv
import json
import math
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

ARRAY_NAMES = {
    1: "wenner",
    2: "pole-pole",
    3: "dipole-dipole",
    6: "pole-dipole",
    7: "wenner-schlumberger",
    11: "general",
}


@dataclass(frozen=True)
class Res2DInvDatum:
    index: int
    array_type: int
    array_name: str
    x: float
    a: Optional[float]
    n: Optional[float]
    apparent_resistivity: float
    resistance: float
    geometric_factor: float
    standard_deviation: float
    ax: float
    ay: float
    az: float
    bx: Optional[float]
    by: Optional[float]
    bz: Optional[float]
    mx: float
    my: float
    mz: float
    nx: Optional[float]
    ny: Optional[float]
    nz: Optional[float]
    raw_error: Optional[float] = None


@dataclass(frozen=True)
class Res2DInvParseResult:
    title: str
    unit_spacing: float
    array_type: int
    array_name: str
    data_count: int
    x_location_type: int
    ip_flag: int
    observations: List[Res2DInvDatum]


def parse_res2dinv_dat(
    path: Path | str,
    *,
    relative_error: float = 0.03,
    resistance_floor: float = 1e-4,
) -> Res2DInvParseResult:
    lines = _read_clean_lines(Path(path))
    if len(lines) < 6:
        raise ValueError("RES2DINV DAT file is too short")

    title = lines[0]
    unit_spacing = _first_number(lines[1], default=1.0)
    array_type = int(_first_number(lines[2]))
    array_name = ARRAY_NAMES.get(array_type, f"array-{array_type}")

    if array_type == 11:
        return _parse_general_array(
            title, unit_spacing, array_type, array_name, lines, relative_error, resistance_floor
        )

    data_count = int(_first_number(lines[3]))
    x_location_type = int(_first_number(lines[4], default=0))
    ip_flag = int(_first_number(lines[5], default=0))
    data_lines = _numeric_rows(lines[6:])
    observations: List[Res2DInvDatum] = []

    for row in data_lines:
        if len(observations) >= data_count:
            break
        if _is_zero_flag(row):
            break
        datum = _parse_index_row(
            len(observations) + 1,
            array_type,
            array_name,
            x_location_type,
            row,
            unit_spacing,
            relative_error,
            resistance_floor,
        )
        observations.append(datum)

    if len(observations) != data_count:
        raise ValueError(f"Expected {data_count} data rows, parsed {len(observations)}")

    return Res2DInvParseResult(
        title=title,
        unit_spacing=unit_spacing,
        array_type=array_type,
        array_name=array_name,
        data_count=data_count,
        x_location_type=x_location_type,
        ip_flag=ip_flag,
        observations=observations,
    )


def export_res2dinv_simpeg_input(
    input_dat: Path | str,
    output_dir: Path | str,
    *,
    relative_error: float = 0.03,
    resistance_floor: float = 1e-4,
) -> dict:
    result = parse_res2dinv_dat(
        input_dat, relative_error=relative_error, resistance_floor=resistance_floor
    )
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    csv_path = out / "abmn_resistance.csv"
    json_path = out / "survey.json"
    npz_path = out / "simpeg_dcip_data.npz"

    rows = [asdict(item) for item in result.observations]
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    payload = {
        "title": result.title,
        "unit_spacing": result.unit_spacing,
        "array_type": result.array_type,
        "array_name": result.array_name,
        "data_count": result.data_count,
        "x_location_type": result.x_location_type,
        "ip_flag": result.ip_flag,
        "observations_csv": str(csv_path),
        "simpeg_npz": None,
    }
    with json_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)

    try:
        import numpy as np
    except ImportError:
        pass
    else:
        np.savez(
            npz_path,
            a_locations=np.asarray([[d.ax, d.ay, d.az] for d in result.observations], dtype=float),
            b_locations=_optional_locations([(d.bx, d.by, d.bz) for d in result.observations]),
            m_locations=np.asarray([[d.mx, d.my, d.mz] for d in result.observations], dtype=float),
            n_locations=_optional_locations([(d.nx, d.ny, d.nz) for d in result.observations]),
            dobs=np.asarray([d.resistance for d in result.observations], dtype=float),
            apparent_resistivity=np.asarray(
                [d.apparent_resistivity for d in result.observations], dtype=float
            ),
            geometric_factor=np.asarray(
                [d.geometric_factor for d in result.observations], dtype=float
            ),
            standard_deviation=np.asarray(
                [d.standard_deviation for d in result.observations], dtype=float
            ),
        )
        payload["simpeg_npz"] = str(npz_path)
        with json_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)

    return {
        **payload,
        "survey_json": str(json_path),
        "observation_count": len(result.observations),
    }


def build_simpeg_survey_and_data(result: Res2DInvParseResult):
    import numpy as np
    from simpeg import data
    from simpeg.electromagnetics.static import resistivity as dc

    source_list = []
    dobs = []
    std = []
    for datum in result.observations:
        m = np.r_[datum.mx, datum.my, datum.mz]
        n = None if datum.nx is None else np.r_[datum.nx, datum.ny, datum.nz]
        if n is None:
            receiver = dc.receivers.Pole(locations=m, data_type="volt")
        else:
            receiver = dc.receivers.Dipole(
                locations_m=m[None, :],
                locations_n=n[None, :],
                data_type="volt",
            )

        a = np.r_[datum.ax, datum.ay, datum.az]
        if datum.bx is None:
            source = dc.sources.Pole([receiver], location=a)
        else:
            b = np.r_[datum.bx, datum.by, datum.bz]
            source = dc.sources.Dipole([receiver], location_a=a, location_b=b)
        source_list.append(source)
        dobs.append(datum.resistance)
        std.append(datum.standard_deviation)

    survey = dc.Survey(source_list, survey_geometry="surface")
    dc_data = data.Data(survey=survey, dobs=np.asarray(dobs), standard_deviation=np.asarray(std))
    return survey, dc_data


def _parse_index_row(
    index: int,
    array_type: int,
    array_name: str,
    x_location_type: int,
    row: Sequence[float],
    unit_spacing: float,
    relative_error: float,
    resistance_floor: float,
) -> Res2DInvDatum:
    if array_type in {1, 2}:
        if len(row) < 3:
            raise ValueError(f"Data row {index} requires x, a, rhoa")
        x, a, rhoa = row[:3]
        n = None
        error = row[3] if len(row) >= 4 else None
    else:
        if len(row) < 4:
            raise ValueError(f"Data row {index} requires x, a, n, rhoa")
        x, a, n, rhoa = row[:4]
        error = row[4] if len(row) >= 5 else None

    ax, bx, mx, nx = _abmn_from_index(array_type, x, a, n, x_location_type)
    k = _geometric_factor(ax, bx, mx, nx)
    resistance = rhoa / k
    raw_std = None if error is None else abs(error / k)
    std = (
        raw_std
        if raw_std and raw_std > 0
        else abs(resistance) * relative_error + resistance_floor
    )
    return _datum(
        index,
        array_type,
        array_name,
        x,
        a,
        n,
        rhoa,
        resistance,
        k,
        std,
        ax,
        bx,
        mx,
        nx,
        error,
    )


def _parse_general_array(
    title: str,
    unit_spacing: float,
    array_type: int,
    array_name: str,
    lines: Sequence[str],
    relative_error: float,
    resistance_floor: float,
) -> Res2DInvParseResult:
    numbers_after_header = _numeric_rows(lines[3:])
    if len(numbers_after_header) < 3:
        raise ValueError("General array DAT file is missing header/data rows")

    data_count = int(numbers_after_header[0][0])
    x_location_type = int(numbers_after_header[1][0]) if numbers_after_header[1] else 0
    ip_flag = int(numbers_after_header[2][0]) if numbers_after_header[2] else 0
    observations: List[Res2DInvDatum] = []

    for row in numbers_after_header[3:]:
        if len(observations) >= data_count:
            break
        if _is_zero_flag(row):
            break
        if len(row) < 9:
            raise ValueError(
                "General array rows must be ax az bx bz mx mz nx nz rhoa "
                "(use 999999 or -999999 for remote electrodes)"
            )
        ax = row[0]
        bx = _remote_to_none(row[2])
        mx = row[4]
        nx = _remote_to_none(row[6])
        rhoa = row[8]
        error = row[9] if len(row) >= 10 else None
        a_point = (ax, 0.0, row[1])
        b_point = None if bx is None else (bx, 0.0, row[3])
        m_point = (mx, 0.0, row[5])
        n_point = None if nx is None else (nx, 0.0, row[7])
        k = _geometric_factor(a_point, b_point, m_point, n_point)
        resistance = rhoa / k
        raw_std = None if error is None else abs(error / k)
        std = (
            raw_std
            if raw_std and raw_std > 0
            else abs(resistance) * relative_error + resistance_floor
        )
        observations.append(
            _datum(
                len(observations) + 1,
                array_type,
                array_name,
                0.0,
                None,
                None,
                rhoa,
                resistance,
                k,
                std,
                a_point,
                b_point,
                m_point,
                n_point,
                error,
            )
        )

    if len(observations) != data_count:
        raise ValueError(f"Expected {data_count} general-array rows, parsed {len(observations)}")
    return Res2DInvParseResult(
        title,
        unit_spacing,
        array_type,
        array_name,
        data_count,
        x_location_type,
        ip_flag,
        observations,
    )


def _abmn_from_index(
    array_type: int, x: float, a: float, n: Optional[float], x_location_type: int
) -> Tuple[
    Tuple[float, float, float],
    Optional[Tuple[float, float, float]],
    Tuple[float, float, float],
    Optional[Tuple[float, float, float]],
]:
    if array_type == 1:
        offsets = (0.0, 3.0 * a, a, 2.0 * a)
        center = 1.5 * a
    elif array_type == 2:
        offsets = (0.0, None, a, None)
        center = 0.5 * a
    elif array_type == 3:
        sep = float(n or 1.0)
        offsets = (0.0, a, (sep + 1.0) * a, (sep + 2.0) * a)
        center = (sep + 2.0) * a / 2.0
    elif array_type == 6:
        sep = float(n or 1.0)
        offsets = (0.0, None, sep * a, (sep + 1.0) * a)
        center = (sep + 1.0) * a / 2.0
    elif array_type == 7:
        sep = float(n or 1.0)
        offsets = (0.0, (2.0 * sep + 1.0) * a, sep * a, (sep + 1.0) * a)
        center = (sep + 0.5) * a
    else:
        raise ValueError(f"Unsupported RES2DINV index array type: {array_type}")

    origin = x - center if x_location_type == 1 else x

    def point(offset: Optional[float]) -> Optional[Tuple[float, float, float]]:
        return None if offset is None else (origin + offset, 0.0, 0.0)

    a_point = point(offsets[0])
    b_point = point(offsets[1])
    m_point = point(offsets[2])
    n_point = point(offsets[3])
    if a_point is None or m_point is None:
        raise ValueError("A and M electrodes cannot be remote")
    return a_point, b_point, m_point, n_point


def _geometric_factor(
    a: Tuple[float, float, float],
    b: Optional[Tuple[float, float, float]],
    m: Tuple[float, float, float],
    n: Optional[Tuple[float, float, float]],
) -> float:
    terms = 1.0 / _distance(a, m)
    if n is not None:
        terms -= 1.0 / _distance(a, n)
    if b is not None:
        terms -= 1.0 / _distance(b, m)
        if n is not None:
            terms += 1.0 / _distance(b, n)
    if abs(terms) < 1e-15:
        raise ValueError("Degenerate electrode geometry gives zero geometric factor")
    return abs(2.0 * math.pi / terms)


def _distance(p1: Tuple[float, float, float], p2: Tuple[float, float, float]) -> float:
    dist = math.sqrt(sum((p1[i] - p2[i]) ** 2 for i in range(3)))
    if dist <= 0:
        raise ValueError("Duplicate electrode locations are not valid")
    return dist


def _datum(
    index: int,
    array_type: int,
    array_name: str,
    x: float,
    a: Optional[float],
    n: Optional[float],
    rhoa: float,
    resistance: float,
    k: float,
    std: float,
    a_point: Tuple[float, float, float],
    b_point: Optional[Tuple[float, float, float]],
    m_point: Tuple[float, float, float],
    n_point: Optional[Tuple[float, float, float]],
    error: Optional[float],
) -> Res2DInvDatum:
    return Res2DInvDatum(
        index=index,
        array_type=array_type,
        array_name=array_name,
        x=x,
        a=a,
        n=n,
        apparent_resistivity=rhoa,
        resistance=resistance,
        geometric_factor=k,
        standard_deviation=std,
        ax=a_point[0],
        ay=a_point[1],
        az=a_point[2],
        bx=None if b_point is None else b_point[0],
        by=None if b_point is None else b_point[1],
        bz=None if b_point is None else b_point[2],
        mx=m_point[0],
        my=m_point[1],
        mz=m_point[2],
        nx=None if n_point is None else n_point[0],
        ny=None if n_point is None else n_point[1],
        nz=None if n_point is None else n_point[2],
        raw_error=error,
    )


def _read_clean_lines(path: Path) -> List[str]:
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    return [line.strip() for line in text.splitlines() if line.strip()]


def _numeric_rows(lines: Iterable[str]) -> List[List[float]]:
    return [_numbers(line) for line in lines if _numbers(line)]


def _numbers(line: str) -> List[float]:
    pattern = r"[-+]?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?"
    normalized = str(line or "").replace(",", " ")
    return [float(item) for item in re.findall(pattern, normalized)]


def _first_number(line: str, default: Optional[float] = None) -> float:
    values = _numbers(line)
    if not values:
        if default is None:
            raise ValueError(f"Expected a numeric value in line: {line}")
        return default
    return values[0]


def _is_zero_flag(row: Sequence[float]) -> bool:
    return len(row) >= 4 and all(abs(value) < 1e-12 for value in row[:4])


def _remote_to_none(value: float) -> Optional[float]:
    return None if abs(value) >= 99999 else value


def _optional_locations(values: Sequence[Tuple[Optional[float], Optional[float], Optional[float]]]):
    import numpy as np

    out = np.full((len(values), 3), np.nan, dtype=float)
    for index, triple in enumerate(values):
        if all(value is not None for value in triple):
            out[index, :] = np.asarray(triple, dtype=float)
    return out


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert RES2DINV DAT files to SimPEG DC input arrays."
    )
    parser.add_argument("input_dat", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--relative-error", type=float, default=0.03)
    parser.add_argument("--resistance-floor", type=float, default=1e-4)
    args = parser.parse_args(argv)

    result = export_res2dinv_simpeg_input(
        args.input_dat,
        args.output_dir,
        relative_error=args.relative_error,
        resistance_floor=args.resistance_floor,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
