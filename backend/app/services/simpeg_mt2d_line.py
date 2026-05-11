from __future__ import annotations

import argparse
import csv
import json
import math
import struct
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


MU0 = 4.0 * math.pi * 1e-7
EARTH_RADIUS_M = 6_371_000.0


_FIELD_ALIASES = {
    "station": ("station", "station_id", "station_code", "site", "point", "point_code", "测点"),
    "line": ("line", "line_code", "profile", "survey_line", "测线"),
    "distance_m": ("distance_m", "distance", "offset_m", "x_m", "x", "里程", "测线距"),
    "longitude": ("longitude", "lon", "lng", "经度"),
    "latitude": ("latitude", "lat", "纬度"),
    "elevation_m": ("elevation_m", "elevation", "z_m", "z", "altitude", "高程"),
    "freq_hz": ("freq_hz", "frequency_hz", "frequency", "freq", "f_hz", "频率"),
    "rho_xy": ("rho_xy", "rhoxy", "rho_xy_ohm_m", "app_res_xy", "apparent_resistivity_xy"),
    "rho_yx": ("rho_yx", "rhoyx", "rho_yx_ohm_m", "app_res_yx", "apparent_resistivity_yx"),
    "phase_xy_deg": ("phase_xy_deg", "phase_xy", "phasexy", "phase_xy_degree"),
    "phase_yx_deg": ("phase_yx_deg", "phase_yx", "phaseyx", "phase_yx_degree"),
    "zxy_real": ("zxy_real", "zxy_re"),
    "zxy_imag": ("zxy_imag", "zxy_im"),
    "zyx_real": ("zyx_real", "zyx_re"),
    "zyx_imag": ("zyx_imag", "zyx_im"),
    "std_rho": ("std_rho", "rho_std", "rho_error", "rho_uncertainty"),
    "std_phase_deg": ("std_phase_deg", "phase_std", "phase_error", "phase_uncertainty"),
}


@dataclass(frozen=True)
class MTLineObservation:
    station: str
    line: str
    distance_m: float
    elevation_m: float
    freq_hz: float
    component: str
    rho_ohm_m: float
    phase_deg: Optional[float] = None
    impedance_real: Optional[float] = None
    impedance_imag: Optional[float] = None
    std_rho: Optional[float] = None
    std_phase_deg: Optional[float] = None


@dataclass(frozen=True)
class MTLineExportResult:
    observation_count: int
    station_count: int
    frequency_count: int
    components: List[str]
    output_dir: str
    observations_csv: str
    survey_json: str
    simpeg_npz: str


@dataclass(frozen=True)
class SimpegComputeConfig:
    background_resistivity_ohm_m: float = 100.0
    rho_relative_error: float = 0.10
    phase_floor_deg: float = 2.0
    cell_width_m: float = 50.0
    depth_m: float = 3000.0
    padding_cells: int = 8


def build_simpeg_input_from_csv(
    input_csv: Path | str,
    output_dir: Path | str,
    *,
    line_code: Optional[str] = None,
    components: Sequence[str] = ("xy", "yx"),
    default_station_spacing_m: float = 50.0,
) -> MTLineExportResult:
    observations = load_eh4_mt_line_csv(
        input_csv,
        line_code=line_code,
        components=components,
        default_station_spacing_m=default_station_spacing_m,
    )
    return export_simpeg_input(observations, output_dir)


def build_simpeg_input_from_records(
    records: Sequence[dict],
    output_dir: Path | str,
    *,
    line_code: Optional[str] = None,
    components: Sequence[str] = ("xy", "yx"),
    default_station_spacing_m: float = 50.0,
) -> MTLineExportResult:
    observations = load_eh4_mt_line_records(
        records,
        line_code=line_code,
        components=components,
        default_station_spacing_m=default_station_spacing_m,
    )
    return export_simpeg_input(observations, output_dir)


def load_eh4_mt_line_records(
    records: Sequence[dict],
    *,
    line_code: Optional[str] = None,
    components: Sequence[str] = ("xy", "yx"),
    default_station_spacing_m: float = 50.0,
) -> List[MTLineObservation]:
    if not records:
        raise ValueError("records cannot be empty")
    fieldnames = sorted({str(key) for row in records for key in row.keys()})
    field_map = _resolve_field_map(fieldnames)
    station_positions = _resolve_station_positions(records, field_map, default_station_spacing_m)
    normalized_components = tuple(_normalize_component(component) for component in components)
    observations: List[MTLineObservation] = []

    for index, row in enumerate(records, start=1):
        row_line = _read_text(row, field_map.get("line")) or line_code or "L1"
        if line_code and row_line != line_code:
            continue
        station = _read_text(row, field_map.get("station")) or f"S{index:04d}"
        freq_hz = _read_float(row, field_map.get("freq_hz"))
        if not _is_positive_finite(freq_hz):
            continue

        distance_m, elevation_m = station_positions[station]
        for component in normalized_components:
            rho = _read_float(row, field_map.get(f"rho_{component}"))
            if not _is_positive_finite(rho):
                continue
            phase = _read_float(row, field_map.get(f"phase_{component}_deg"))
            z_real = _read_float(row, field_map.get(f"z{component}_real"))
            z_imag = _read_float(row, field_map.get(f"z{component}_imag"))
            observations.append(
                MTLineObservation(
                    station=station,
                    line=row_line,
                    distance_m=distance_m,
                    elevation_m=elevation_m,
                    freq_hz=float(freq_hz),
                    component=component,
                    rho_ohm_m=float(rho),
                    phase_deg=phase,
                    impedance_real=z_real,
                    impedance_imag=z_imag,
                    std_rho=_read_float(row, field_map.get("std_rho")),
                    std_phase_deg=_read_float(row, field_map.get("std_phase_deg")),
                )
            )

    if not observations:
        raise ValueError("No usable MT apparent-resistivity observations were found")
    return sorted(observations, key=lambda item: (item.line, item.distance_m, item.freq_hz, item.component))


def load_eh4_mt_line_csv(
    input_csv: Path | str,
    *,
    line_code: Optional[str] = None,
    components: Sequence[str] = ("xy", "yx"),
    default_station_spacing_m: float = 50.0,
) -> List[MTLineObservation]:
    path = Path(input_csv)
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise ValueError(f"CSV has no header: {path}")
        rows = list(reader)
        field_map = _resolve_field_map(reader.fieldnames)

    if not rows:
        raise ValueError(f"CSV has no data rows: {path}")

    station_positions = _resolve_station_positions(rows, field_map, default_station_spacing_m)
    normalized_components = tuple(_normalize_component(component) for component in components)
    observations: List[MTLineObservation] = []

    for index, row in enumerate(rows, start=2):
        row_line = _read_text(row, field_map.get("line")) or line_code or "L1"
        if line_code and row_line != line_code:
            continue
        station = _read_text(row, field_map.get("station")) or f"S{index - 1:04d}"
        freq_hz = _read_float(row, field_map.get("freq_hz"))
        if not _is_positive_finite(freq_hz):
            continue

        distance_m, elevation_m = station_positions[station]
        for component in normalized_components:
            rho = _read_float(row, field_map.get(f"rho_{component}"))
            if not _is_positive_finite(rho):
                continue
            phase = _read_float(row, field_map.get(f"phase_{component}_deg"))
            z_real = _read_float(row, field_map.get(f"z{component}_real"))
            z_imag = _read_float(row, field_map.get(f"z{component}_imag"))
            observations.append(
                MTLineObservation(
                    station=station,
                    line=row_line,
                    distance_m=distance_m,
                    elevation_m=elevation_m,
                    freq_hz=freq_hz,
                    component=component,
                    rho_ohm_m=float(rho),
                    phase_deg=phase,
                    impedance_real=z_real,
                    impedance_imag=z_imag,
                    std_rho=_read_float(row, field_map.get("std_rho")),
                    std_phase_deg=_read_float(row, field_map.get("std_phase_deg")),
                )
            )

    if not observations:
        raise ValueError("No usable MT apparent-resistivity observations were found")
    return sorted(observations, key=lambda item: (item.line, item.distance_m, item.freq_hz, item.component))


def export_simpeg_input(
    observations: Sequence[MTLineObservation],
    output_dir: Path | str,
) -> MTLineExportResult:
    if not observations:
        raise ValueError("observations cannot be empty")

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    observations_csv = out_dir / "observations.csv"
    survey_json = out_dir / "survey.json"
    simpeg_npz = out_dir / "simpeg_input.npz"

    with observations_csv.open("w", encoding="utf-8", newline="") as handle:
        fieldnames = list(asdict(observations[0]).keys())
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for item in observations:
            writer.writerow(asdict(item))

    stations = _unique_station_rows(observations)
    frequencies = sorted({float(item.freq_hz) for item in observations})
    components = sorted({item.component for item in observations})
    survey = {
        "format": "geoyun.simpeg.mt2d.line.v1",
        "line": observations[0].line,
        "stations": stations,
        "frequencies_hz": frequencies,
        "components": components,
        "observation_count": len(observations),
        "data_columns": {
            "location": ["distance_m", "elevation_m"],
            "datum": "rho_ohm_m",
            "optional": ["phase_deg", "impedance_real", "impedance_imag"],
        },
    }
    survey_json.write_text(json.dumps(survey, ensure_ascii=False, indent=2), encoding="utf-8")

    _write_npz_compressed(
        simpeg_npz,
        {
            "station": [item.station for item in observations],
            "line": [item.line for item in observations],
            "locations_xz": [[item.distance_m, item.elevation_m] for item in observations],
            "frequencies_hz": [item.freq_hz for item in observations],
            "components": [item.component for item in observations],
            "rho_ohm_m": [item.rho_ohm_m for item in observations],
            "phase_deg": [_nan_if_none(item.phase_deg) for item in observations],
            "impedance_real": [_nan_if_none(item.impedance_real) for item in observations],
            "impedance_imag": [_nan_if_none(item.impedance_imag) for item in observations],
            "std_rho": [_nan_if_none(item.std_rho) for item in observations],
            "std_phase_deg": [_nan_if_none(item.std_phase_deg) for item in observations],
        },
    )

    return MTLineExportResult(
        observation_count=len(observations),
        station_count=len(stations),
        frequency_count=len(frequencies),
        components=components,
        output_dir=str(out_dir),
        observations_csv=str(observations_csv),
        survey_json=str(survey_json),
        simpeg_npz=str(simpeg_npz),
    )


def run_simpeg_forward(
    simpeg_npz: Path | str,
    output_dir: Path | str,
    *,
    config: SimpegComputeConfig = SimpegComputeConfig(),
) -> Dict[str, str | int | float]:
    """Run a small SimPEG MT forward calculation against the exported line package.

    The function intentionally imports SimPEG lazily. Production deployments can install
    `simpeg` and `discretize`; development machines can still use the exporter without
    pulling the full geophysical stack into every backend process.
    """

    try:
        import numpy as np
        from discretize import TensorMesh
        from simpeg import maps
        from simpeg.electromagnetics import natural_source as nsem
    except ImportError as exc:
        raise RuntimeError(
            "SimPEG calculation requires optional packages: simpeg and discretize. "
            "Install them in the backend Python environment before using --run-simpeg."
        ) from exc

    package = np.load(Path(simpeg_npz), allow_pickle=True)
    locations_xz = np.asarray(package["locations_xz"], dtype=float)
    frequencies = sorted({float(value) for value in package["frequencies_hz"]})
    components = [str(value) for value in package["components"]]

    mesh = _build_2d_tensor_mesh(locations_xz[:, 0], config, TensorMesh)
    receiver_groups = _build_nsem_receiver_groups(nsem, locations_xz, package, components)
    source_list = []
    for freq_hz in frequencies:
        receivers = receiver_groups.get(freq_hz, [])
        if receivers:
            source_cls = getattr(nsem.sources, "PlanewaveXYPrimary", nsem.sources.Planewave)
            try:
                source_list.append(
                    source_cls(
                        receivers,
                        frequency=freq_hz,
                        sigma_primary=1.0 / config.background_resistivity_ohm_m,
                    )
                )
            except TypeError:
                source_list.append(source_cls(receivers, frequency=freq_hz))
    if not source_list:
        raise ValueError("No SimPEG receivers were built from the exported observations")

    survey = nsem.Survey(source_list)
    sigma = np.full(mesh.nC, 1.0 / config.background_resistivity_ohm_m, dtype=float)
    sigma_map = maps.IdentityMap(nP=mesh.nC)
    simulation = nsem.Simulation2DElectricField(mesh, survey=survey, sigmaMap=sigma_map)
    predicted = np.asarray(simulation.dpred(sigma), dtype=float)

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    predicted_csv = out_dir / "simpeg_forward_predicted.csv"
    with predicted_csv.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["index", "predicted"])
        for index, value in enumerate(predicted):
            writer.writerow([index, value])

    return {
        "mode": "forward",
        "mesh_cell_count": int(mesh.nC),
        "data_count": int(predicted.size),
        "background_resistivity_ohm_m": float(config.background_resistivity_ohm_m),
        "predicted_csv": str(predicted_csv),
        "predicted_preview": [
            {"index": int(index), "predicted": float(value)}
            for index, value in enumerate(predicted[:100])
        ],
        "process": [
            "Loaded exported MT line package",
            f"Built 2D tensor mesh with {int(mesh.nC)} cells",
            f"Built natural-source survey with {len(source_list)} frequencies",
            "Calculated predicted response for the background model",
            f"Wrote predicted response CSV: {predicted_csv}",
        ],
    }


def _build_nsem_receiver_groups(nsem, locations_xz, package, components: Sequence[str]):
    import numpy as np

    receiver_groups: Dict[float, List[object]] = {}
    frequencies = np.asarray(package["frequencies_hz"], dtype=float)
    phase_deg = np.asarray(package["phase_deg"], dtype=float)

    for freq_hz in sorted({float(value) for value in frequencies}):
        freq_mask = frequencies == freq_hz
        receivers = []
        for component in sorted(set(components)):
            component_mask = np.array([str(value) == component for value in package["components"]])
            mask = freq_mask & component_mask
            if not mask.any():
                continue
            rx_locations = locations_xz[mask]
            orientation = component.upper()
            receivers.append(
                nsem.receivers.Impedance(
                    rx_locations,
                    orientation=orientation,
                    component="apparent_resistivity",
                )
            )
            if np.isfinite(phase_deg[mask]).any():
                receivers.append(
                    nsem.receivers.Impedance(
                        rx_locations,
                        orientation=orientation,
                        component="phase",
                    )
                )
        receiver_groups[freq_hz] = receivers
    return receiver_groups


def _build_2d_tensor_mesh(x_locations, config: SimpegComputeConfig, tensor_mesh_cls):
    import numpy as np

    min_x = float(np.nanmin(x_locations))
    max_x = float(np.nanmax(x_locations))
    width = max(config.cell_width_m, 1.0)
    core_width = max(max_x - min_x, width)
    core_cells = max(4, int(math.ceil(core_width / width)) + 2)
    pad = max(0, int(config.padding_cells))
    hx = [(width, pad, -1.35), (width, core_cells), (width, pad, 1.35)]
    hz = [(width, pad, -1.35), (width, max(4, int(math.ceil(config.depth_m / width))))]
    origin = [min_x - pad * width, -config.depth_m]
    return tensor_mesh_cls([hx, hz], origin=origin)


def _resolve_station_positions(
    rows: Sequence[dict],
    field_map: Dict[str, str],
    default_station_spacing_m: float,
) -> Dict[str, Tuple[float, float]]:
    station_names: List[str] = []
    raw_by_station: Dict[str, dict] = {}
    for index, row in enumerate(rows, start=1):
        station = _read_text(row, field_map.get("station")) or f"S{index:04d}"
        if station not in raw_by_station:
            station_names.append(station)
            raw_by_station[station] = row

    positions: Dict[str, Tuple[float, float]] = {}
    has_distance = all(_read_float(raw_by_station[name], field_map.get("distance_m")) is not None for name in station_names)
    has_lon_lat = all(
        _read_float(raw_by_station[name], field_map.get("longitude")) is not None
        and _read_float(raw_by_station[name], field_map.get("latitude")) is not None
        for name in station_names
    )

    if has_distance:
        for name in station_names:
            row = raw_by_station[name]
            positions[name] = (
                float(_read_float(row, field_map.get("distance_m")) or 0.0),
                float(_read_float(row, field_map.get("elevation_m")) or 0.0),
            )
        return positions

    if has_lon_lat:
        origin_row = raw_by_station[station_names[0]]
        lon0 = math.radians(float(_read_float(origin_row, field_map.get("longitude")) or 0.0))
        lat0 = math.radians(float(_read_float(origin_row, field_map.get("latitude")) or 0.0))
        cos_lat0 = math.cos(lat0)
        projected: Dict[str, Tuple[float, float, float]] = {}
        for name in station_names:
            row = raw_by_station[name]
            lon = math.radians(float(_read_float(row, field_map.get("longitude")) or 0.0))
            lat = math.radians(float(_read_float(row, field_map.get("latitude")) or 0.0))
            east = (lon - lon0) * cos_lat0 * EARTH_RADIUS_M
            north = (lat - lat0) * EARTH_RADIUS_M
            projected[name] = (east, north, float(_read_float(row, field_map.get("elevation_m")) or 0.0))
        end = projected[station_names[-1]]
        azimuth_norm = math.hypot(end[0], end[1]) or 1.0
        ux, uy = end[0] / azimuth_norm, end[1] / azimuth_norm
        for name in station_names:
            east, north, elevation = projected[name]
            positions[name] = (east * ux + north * uy, elevation)
        return positions

    for index, name in enumerate(station_names):
        elevation = float(_read_float(raw_by_station[name], field_map.get("elevation_m")) or 0.0)
        positions[name] = (index * default_station_spacing_m, elevation)
    return positions


def _unique_station_rows(observations: Sequence[MTLineObservation]) -> List[dict]:
    stations: Dict[str, dict] = {}
    for item in observations:
        stations.setdefault(
            item.station,
            {
                "station": item.station,
                "line": item.line,
                "distance_m": item.distance_m,
                "elevation_m": item.elevation_m,
            },
        )
    return sorted(stations.values(), key=lambda item: item["distance_m"])


def _write_npz_compressed(path: Path, arrays: Dict[str, Sequence[object]]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, values in arrays.items():
            archive.writestr(f"{name}.npy", _to_npy_bytes(values))


def _to_npy_bytes(values: Sequence[object]) -> bytes:
    shape = _array_shape(values)
    flattened = list(_flatten(values))
    is_string = any(isinstance(value, str) for value in flattened)
    if is_string:
        max_len = max((len(str(value)) for value in flattened), default=1)
        descr = f"<U{max(max_len, 1)}"
        data = b"".join(str(value).ljust(max_len, "\x00").encode("utf-32le") for value in flattened)
    else:
        descr = "<f8"
        data = b"".join(struct.pack("<d", float(value)) for value in flattened)

    header = {
        "descr": descr,
        "fortran_order": False,
        "shape": shape,
    }
    header_text = repr(header)
    header_text = header_text.replace('"', "'")
    header_bytes = (header_text + " ").encode("latin1")
    prefix_len = 6 + 2 + 2
    padding = 16 - ((prefix_len + len(header_bytes) + 1) % 16)
    header_bytes += b" " * padding + b"\n"
    return b"\x93NUMPY" + bytes([1, 0]) + struct.pack("<H", len(header_bytes)) + header_bytes + data


def _array_shape(values: Sequence[object]) -> Tuple[int, ...]:
    if not values:
        return (0,)
    first = values[0]
    if isinstance(first, (list, tuple)):
        width = len(first)
        if any(not isinstance(item, (list, tuple)) or len(item) != width for item in values):
            raise ValueError("Only rectangular 2D arrays are supported for NPZ export")
        return (len(values), width)
    return (len(values),)


def _flatten(values: Sequence[object]) -> Iterable[object]:
    for value in values:
        if isinstance(value, (list, tuple)):
            yield from value
        else:
            yield value


def _resolve_field_map(fieldnames: Sequence[str]) -> Dict[str, str]:
    normalized = {_normalize_name(name): name for name in fieldnames}
    resolved: Dict[str, str] = {}
    for canonical, aliases in _FIELD_ALIASES.items():
        for alias in aliases:
            match = normalized.get(_normalize_name(alias))
            if match is not None:
                resolved[canonical] = match
                break
    if "freq_hz" not in resolved:
        raise ValueError("CSV must include a frequency column, e.g. freq_hz")
    if "rho_xy" not in resolved and "rho_yx" not in resolved:
        raise ValueError("CSV must include at least one apparent resistivity column: rho_xy or rho_yx")
    return resolved


def _read_text(row: dict, field: Optional[str]) -> Optional[str]:
    if not field:
        return None
    value = row.get(field)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _read_float(row: dict, field: Optional[str]) -> Optional[float]:
    if not field:
        return None
    value = row.get(field)
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = float(text)
    except ValueError:
        return None
    if not math.isfinite(parsed):
        return None
    return parsed


def _normalize_component(component: str) -> str:
    normalized = str(component).strip().lower()
    if normalized not in {"xy", "yx"}:
        raise ValueError(f"unsupported MT component: {component}")
    return normalized


def _normalize_name(name: str) -> str:
    return "".join(char for char in str(name).strip().lower() if char.isalnum())


def _is_positive_finite(value: Optional[float]) -> bool:
    return value is not None and math.isfinite(value) and value > 0.0


def _nan_if_none(value: Optional[float]) -> float:
    return float(value) if value is not None else float("nan")


def _parse_cli(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export one EH4/MT survey line to SimPEG input and optionally run SimPEG."
    )
    parser.add_argument("input_csv", type=Path, help="EH4/MT line CSV with freq_hz and rho_xy/rho_yx columns")
    parser.add_argument("output_dir", type=Path, help="Directory for observations.csv, survey.json and simpeg_input.npz")
    parser.add_argument("--line", dest="line_code", help="Only export one line_code from the CSV")
    parser.add_argument("--components", default="xy,yx", help="Comma-separated components: xy,yx")
    parser.add_argument("--station-spacing-m", type=float, default=50.0)
    parser.add_argument("--run-simpeg", action="store_true", help="Run a SimPEG forward calculation after export")
    parser.add_argument("--background-rho", type=float, default=100.0)
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parse_cli(argv)
    components = [value.strip() for value in args.components.split(",") if value.strip()]
    result = build_simpeg_input_from_csv(
        args.input_csv,
        args.output_dir,
        line_code=args.line_code,
        components=components,
        default_station_spacing_m=args.station_spacing_m,
    )
    payload = {"export": asdict(result)}
    if args.run_simpeg:
        try:
            compute = run_simpeg_forward(
                result.simpeg_npz,
                args.output_dir,
                config=SimpegComputeConfig(background_resistivity_ohm_m=args.background_rho),
            )
            payload["simpeg"] = compute
        except RuntimeError as exc:
            payload["simpeg"] = {"status": "skipped", "reason": str(exc)}
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return 2
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
