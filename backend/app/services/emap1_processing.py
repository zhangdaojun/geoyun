from __future__ import annotations

import builtins
import csv
import importlib
import json
import math
import re
import tempfile
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np
import xarray as xr

from mt_parse.birrp_py.calibration import (
    ComplexResponse,
    combine_responses,
    load_complex_response,
)
from mt_parse.birrp_py.core import (
    BIRRPConfig,
    BIRRPResult,
    apparent_resistivity_phase,
    birrp_process,
    calibrate_segments,
    save_result_csv,
    segment_rfft,
)

from .. import schemas
from ..config import get_settings
from .aurora_adapter import process_with_aurora_adapter

_NUMBER_SPLIT_PATTERN = re.compile(r"[\s,;]+")
_CHANNEL_SUFFIX_PATTERN = re.compile(
    r"^(?P<base>.*?)(?:[_\-. ]?)(?P<channel>ex|ey|hx|hy|rx|ry)$",
    re.IGNORECASE,
)
_REQUIRED_CHANNELS = ("ex", "ey", "hx", "hy")
_OPTIONAL_CHANNELS = ("rx", "ry")
_ALL_CHANNELS = _REQUIRED_CHANNELS + _OPTIONAL_CHANNELS


def _load_aurora_regression_classes():
    original_open = builtins.open

    def patched_open(file, mode="r", *args, **kwargs):
        if (
            "b" not in mode
            and "encoding" not in kwargs
            and isinstance(file, (str, Path))
            and str(file).replace("/", "\\").endswith("mt_metadata\\data\\licenses.json")
        ):
            kwargs["encoding"] = "utf-8"
        return original_open(file, mode, *args, **kwargs)

    builtins.open = patched_open
    try:
        rme_module = importlib.import_module("aurora.transfer_function.regression.RME")
        rme_rr_module = importlib.import_module("aurora.transfer_function.regression.RME_RR")
        iter_module = importlib.import_module(
            "aurora.transfer_function.regression.iter_control"
        )
        return rme_module.RME, rme_rr_module.RME_RR, iter_module.IterControl
    finally:
        builtins.open = original_open


def process_emap1_request(payload: schemas.EMAP1ProcessRequest) -> schemas.EMAP1ProcessResponse:
    return process_with_aurora_adapter(
        payload,
        package_processor=_process_emap1_request_aurora_package,
        fallback=_process_emap1_request_legacy,
    )


def _process_emap1_request_aurora_package(
    payload: schemas.EMAP1ProcessRequest,
) -> schemas.EMAP1ProcessResponse:
    required_channels = _required_channels_for_mode(payload.mode)
    loaded_channels = {
        channel_name: _load_channel_samples(channel_name, getattr(payload.channels, channel_name))
        for channel_name in required_channels
    }
    for channel_name in _OPTIONAL_CHANNELS:
        source = getattr(payload.channels, channel_name)
        if source is not None:
            loaded_channels[channel_name] = _load_channel_samples(channel_name, source)

    _validate_channel_lengths(payload.nfft, loaded_channels)

    sample_count = len(next(iter(loaded_channels.values())))
    spectra_by_channel, freqs = _build_channel_spectra(payload, loaded_channels)
    segment_count = len(next(iter(spectra_by_channel.values())))
    rows = _run_aurora_regression_rows(payload, spectra_by_channel, freqs)

    output_csv_path = None
    if payload.output_csv_path:
        output_path = Path(payload.output_csv_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        _save_result_rows_csv(output_path, rows)
        output_csv_path = str(output_path)

    summary = schemas.EMAP1ProcessSummaryOut(
        engine="aurora-python",
        mode=payload.mode,
        sample_count=sample_count,
        segment_count=segment_count,
        frequency_count=len(freqs),
        remote_reference_used=_aurora_remote_reference_used(payload, spectra_by_channel),
        output_csv_path=output_csv_path,
        calibrated_channels=_collect_calibrated_channels(payload.calibration),
    )
    return schemas.EMAP1ProcessResponse(
        summary=summary,
        rows=[_serialize_row(row) for row in rows] if payload.return_rows else [],
    )


def _process_emap1_request_legacy(
    payload: schemas.EMAP1ProcessRequest,
) -> schemas.EMAP1ProcessResponse:
    prepared = _prepare_channel_samples(payload)
    ex_samples = prepared["ex"]
    ey_samples = prepared["ey"]
    hx_samples = prepared["hx"]
    hy_samples = prepared["hy"]

    rx_samples = (
        _load_channel_samples("rx", payload.channels.rx)
        if payload.channels.rx is not None
        else None
    )
    ry_samples = (
        _load_channel_samples("ry", payload.channels.ry)
        if payload.channels.ry is not None
        else None
    )

    _validate_channel_lengths(
        payload.nfft,
        {
            "ex": ex_samples,
            "ey": ey_samples,
            "hx": hx_samples,
            "hy": hy_samples,
            "rx": rx_samples,
            "ry": ry_samples,
        },
    )

    calibration = (
        _load_calibration_bundle(payload.calibration) if payload.calibration is not None else None
    )

    config = BIRRPConfig(
        sampling_rate_hz=payload.sampling_rate_hz,
        mode=payload.mode,
        nfft=payload.nfft,
        overlap=payload.overlap,
        window=payload.window,
        huber_threshold=payload.huber_threshold,
        max_iter=payload.max_iter,
        tolerance=payload.tolerance,
        dipole_ex_m=payload.dipole_ex_m,
        dipole_ey_m=payload.dipole_ey_m,
        allow_response_extrapolation=payload.allow_response_extrapolation,
        use_remote_reference=payload.use_remote_reference,
    )

    result = birrp_process(
        ex_samples,
        ey_samples,
        hx_samples,
        hy_samples,
        rx_samples,
        ry_samples,
        config=config,
        calibration=calibration,
    )

    output_csv_path = None
    if payload.output_csv_path:
        output_path = Path(payload.output_csv_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        save_result_csv(str(output_path), result)
        output_csv_path = str(output_path)

    rows = [_serialize_row(row) for row in result.to_rows()] if payload.return_rows else []
    segment_count = _infer_segment_count(result)
    sample_count = len(ex_samples)

    summary = schemas.EMAP1ProcessSummaryOut(
        engine="legacy-birrp",
        mode=config.mode,
        sample_count=sample_count,
        segment_count=segment_count,
        frequency_count=len(result.freqs_hz),
        remote_reference_used=bool(
            config.use_remote_reference and rx_samples is not None and ry_samples is not None
        ),
        output_csv_path=output_csv_path,
        calibrated_channels=sorted(list(calibration.keys())) if calibration else [],
    )
    return schemas.EMAP1ProcessResponse(summary=summary, rows=rows)


def process_emap1_batch_request(
    payload: schemas.EMAP1BatchProcessRequest,
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
) -> schemas.EMAP1BatchProcessResponse:
    input_dir: Optional[Path] = None
    output_dir = Path(payload.output_dir) if payload.output_dir else None
    if output_dir is not None:
        output_dir.mkdir(parents=True, exist_ok=True)

    inline_groups = list(payload.browser_groups or [])
    if inline_groups:
        grouped_files = {}
    else:
        if not payload.input_dir:
            raise ValueError("input_dir is required when browser_groups is empty")
        input_dir = Path(payload.input_dir)
        if not input_dir.exists():
            raise FileNotFoundError(f"input directory not found: {input_dir}")
        if not input_dir.is_dir():
            raise ValueError(f"input path is not a directory: {input_dir}")

        grouped_files = _scan_emap1_directory(
            input_dir=input_dir,
            recursive=payload.recursive,
            file_glob=payload.file_glob,
        )

    items: List[schemas.EMAP1BatchProcessItemOut] = []
    processed_count = 0
    skipped_count = 0
    required_channels = _required_channels_for_mode(payload.mode)
    total_groups = len(inline_groups) if inline_groups else len(grouped_files)

    if progress_callback is not None:
        progress_callback(0, total_groups, "EMAP1 batch processing started")

    if inline_groups:
        for index, group in enumerate(inline_groups):
            group_key = group.group_key
            channel_files = group.channel_files or {}
            provided_channels = {
                channel_name
                for channel_name in _ALL_CHANNELS
                if getattr(group.channels, channel_name) is not None
            }
            missing_channels = [
                channel_name
                for channel_name in required_channels
                if channel_name not in provided_channels
            ]
            if progress_callback is not None:
                progress_callback(index, total_groups, f"Processing {group_key}")

            if missing_channels:
                items.append(
                    schemas.EMAP1BatchProcessItemOut(
                        group_key=group_key,
                        status="skipped",
                        reason=f"missing required channels: {', '.join(missing_channels)}",
                        channel_files=channel_files,
                    )
                )
                skipped_count += 1
                if progress_callback is not None:
                    progress_callback(index + 1, total_groups, f"Skipped {group_key}")
                continue

            request = _build_single_request_from_inline_group(payload, group)
            result = process_emap1_request(request)
            items.append(
                schemas.EMAP1BatchProcessItemOut(
                    group_key=group_key,
                    status="processed",
                    channel_files=channel_files,
                    output_csv_path=result.summary.output_csv_path,
                    summary=result.summary,
                    rows=result.rows,
                )
            )
            processed_count += 1
            if progress_callback is not None:
                progress_callback(index + 1, total_groups, f"Processed {group_key}")

        summary = schemas.EMAP1BatchProcessSummaryOut(
            input_dir=payload.input_dir or "browser-upload",
            output_dir=str(output_dir) if output_dir is not None else None,
            recursive=payload.recursive,
            file_glob=payload.file_glob,
            total_groups=total_groups,
            processed_count=processed_count,
            skipped_count=skipped_count,
            manifest_path=None,
        )
        return schemas.EMAP1BatchProcessResponse(summary=summary, items=items)

    for group_key in sorted(grouped_files.keys()):
        group_index = len(items)
        if progress_callback is not None:
            progress_callback(group_index, total_groups, f"Processing {group_key}")
        group = grouped_files[group_key]
        channel_files = {name: str(path) for name, path in sorted(group["channels"].items())}
        duplicate_channels = sorted(group["duplicates"].keys())
        missing_channels = [
            channel_name
            for channel_name in required_channels
            if channel_name not in group["channels"]
        ]

        if duplicate_channels or missing_channels:
            reasons: List[str] = []
            if missing_channels:
                reasons.append(f"missing required channels: {', '.join(missing_channels)}")
            if duplicate_channels:
                reasons.append(f"duplicate channels: {', '.join(duplicate_channels)}")
            items.append(
                schemas.EMAP1BatchProcessItemOut(
                    group_key=group_key,
                    status="skipped",
                    reason="; ".join(reasons),
                    channel_files=channel_files,
                )
            )
            skipped_count += 1
            if progress_callback is not None:
                progress_callback(group_index + 1, total_groups, f"Skipped {group_key}")
            continue

        request = _build_single_request_from_group(
            payload,
            group_key,
            group["channels"],
            output_dir,
        )
        result = process_emap1_request(request)
        items.append(
            schemas.EMAP1BatchProcessItemOut(
                group_key=group_key,
                status="processed",
                channel_files=channel_files,
                output_csv_path=result.summary.output_csv_path,
                summary=result.summary,
                rows=result.rows,
            )
        )
        processed_count += 1
        if progress_callback is not None:
            progress_callback(group_index + 1, total_groups, f"Processed {group_key}")

    manifest_path = None
    summary = schemas.EMAP1BatchProcessSummaryOut(
        input_dir=str(input_dir),
        output_dir=str(output_dir) if output_dir is not None else None,
        recursive=payload.recursive,
        file_glob=payload.file_glob,
        total_groups=len(grouped_files),
        processed_count=processed_count,
        skipped_count=skipped_count,
        manifest_path=None,
    )
    response = schemas.EMAP1BatchProcessResponse(summary=summary, items=items)

    if output_dir is not None:
        manifest_file = output_dir / "emap1_batch_manifest.json"
        manifest_file.write_text(
            json.dumps(response.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        manifest_path = str(manifest_file)
        response.summary.manifest_path = manifest_path

    return response


def _build_single_request_from_inline_group(
    batch: schemas.EMAP1BatchProcessRequest,
    group: schemas.EMAP1BatchInlineGroupIn,
) -> schemas.EMAP1ProcessRequest:
    return schemas.EMAP1ProcessRequest(
        sampling_rate_hz=batch.sampling_rate_hz,
        mode=batch.mode,
        nfft=batch.nfft,
        overlap=batch.overlap,
        window=batch.window,
        huber_threshold=batch.huber_threshold,
        max_iter=batch.max_iter,
        tolerance=batch.tolerance,
        dipole_ex_m=batch.dipole_ex_m,
        dipole_ey_m=batch.dipole_ey_m,
        allow_response_extrapolation=batch.allow_response_extrapolation,
        use_remote_reference=batch.use_remote_reference,
        return_rows=batch.return_rows,
        channels=group.channels,
        calibration=batch.calibration,
    )


def _scan_emap1_directory(
    *,
    input_dir: Path,
    recursive: bool,
    file_glob: str,
) -> Dict[str, Dict[str, Dict[str, Path]]]:
    grouped: Dict[str, Dict[str, Dict[str, Path]]] = {}
    walker = input_dir.rglob(file_glob) if recursive else input_dir.glob(file_glob)

    for candidate in walker:
        if not candidate.is_file():
            continue
        inferred = _infer_group_key_and_channel(input_dir, candidate)
        if inferred is None:
            continue
        group_key, channel_name = inferred
        group = grouped.setdefault(group_key, {"channels": {}, "duplicates": {}})
        existing = group["channels"].get(channel_name)
        if existing is not None:
            group["duplicates"].setdefault(channel_name, []).append(candidate)
            continue
        group["channels"][channel_name] = candidate

    return grouped


def _infer_group_key_and_channel(root_dir: Path, file_path: Path) -> Optional[Tuple[str, str]]:
    match = _CHANNEL_SUFFIX_PATTERN.match(file_path.stem.strip())
    if not match:
        return None

    base = match.group("base").strip(" _-.")
    channel_name = match.group("channel").lower()
    relative_parent = file_path.parent.relative_to(root_dir)
    parent_key = "" if str(relative_parent) == "." else relative_parent.as_posix()

    if base:
        group_key = f"{parent_key}/{base}" if parent_key else base
    else:
        group_key = parent_key or root_dir.name or file_path.parent.name or "emap1"
    return group_key, channel_name


def _build_single_request_from_group(
    batch: schemas.EMAP1BatchProcessRequest,
    group_key: str,
    channels: Dict[str, Path],
    output_dir: Optional[Path],
) -> schemas.EMAP1ProcessRequest:
    channel_bundle = schemas.EMAP1ChannelBundleIn(
        ex=(
            schemas.EMAP1ChannelSourceIn(file_path=str(channels["ex"]))
            if "ex" in channels
            else None
        ),
        ey=(
            schemas.EMAP1ChannelSourceIn(file_path=str(channels["ey"]))
            if "ey" in channels
            else None
        ),
        hx=(
            schemas.EMAP1ChannelSourceIn(file_path=str(channels["hx"]))
            if "hx" in channels
            else None
        ),
        hy=(
            schemas.EMAP1ChannelSourceIn(file_path=str(channels["hy"]))
            if "hy" in channels
            else None
        ),
        rx=(
            schemas.EMAP1ChannelSourceIn(file_path=str(channels["rx"]))
            if "rx" in channels
            else None
        ),
        ry=(
            schemas.EMAP1ChannelSourceIn(file_path=str(channels["ry"]))
            if "ry" in channels
            else None
        ),
    )
    output_csv_path = None
    if output_dir is not None:
        output_csv_path = str(output_dir / f"{_sanitize_group_key(group_key)}.csv")

    return schemas.EMAP1ProcessRequest(
        sampling_rate_hz=batch.sampling_rate_hz,
        mode=batch.mode,
        nfft=batch.nfft,
        overlap=batch.overlap,
        window=batch.window,
        huber_threshold=batch.huber_threshold,
        max_iter=batch.max_iter,
        tolerance=batch.tolerance,
        dipole_ex_m=batch.dipole_ex_m,
        dipole_ey_m=batch.dipole_ey_m,
        allow_response_extrapolation=batch.allow_response_extrapolation,
        use_remote_reference=batch.use_remote_reference,
        return_rows=batch.return_rows,
        output_csv_path=output_csv_path,
        channels=channel_bundle,
        calibration=batch.calibration,
    )


def _sanitize_group_key(group_key: str) -> str:
    sanitized = re.sub(r"[^\w.-]+", "_", group_key, flags=re.UNICODE).strip("._")
    return sanitized or "emap1"


def _load_channel_samples(
    channel_name: str,
    source: Optional[schemas.EMAP1ChannelSourceIn],
) -> List[float]:
    if source is None:
        raise ValueError(f"channel '{channel_name}' is required")
    if source.values:
        return [float(value) * source.scale for value in source.values]
    if source.file_path:
        return _read_numeric_file(
            Path(source.file_path),
            column_index=source.column_index,
            skip_rows=source.skip_rows,
            scale=source.scale,
        )
    raise ValueError(f"channel '{channel_name}' must provide values or file_path")


def _required_channels_for_mode(mode: str) -> Tuple[str, ...]:
    normalized = (mode or "tensor").strip().lower()
    if normalized == "scalar_xy":
        return ("ex", "hy")
    if normalized == "scalar_yx":
        return ("ey", "hx")
    if normalized in {"scalar_both", "tensor"}:
        return ("ex", "ey", "hx", "hy")
    raise ValueError(f"unsupported EMAP-1 mode: {mode}")


def _prepare_channel_samples(payload: schemas.EMAP1ProcessRequest) -> Dict[str, List[float]]:
    required_channels = _required_channels_for_mode(payload.mode)
    loaded_required = {
        channel_name: _load_channel_samples(channel_name, getattr(payload.channels, channel_name))
        for channel_name in required_channels
    }
    _validate_channel_lengths(payload.nfft, loaded_required)

    base_length = len(next(iter(loaded_required.values())))
    zero_fill = [0.0] * base_length

    prepared: Dict[str, List[float]] = {}
    for channel_name in _REQUIRED_CHANNELS:
        if channel_name in loaded_required:
            prepared[channel_name] = loaded_required[channel_name]
        else:
            prepared[channel_name] = list(zero_fill)
    return prepared


def _build_channel_spectra(
    payload: schemas.EMAP1ProcessRequest,
    channels: Dict[str, Sequence[float]],
) -> Tuple[Dict[str, List[List[complex]]], List[float]]:
    spectra_by_channel: Dict[str, List[List[complex]]] = {}
    freqs: List[float] = []
    for channel_name, samples in channels.items():
        spectra, _ = segment_rfft(
            samples,
            payload.nfft,
            overlap=payload.overlap,
            window=payload.window,
        )
        spectra_by_channel[channel_name] = spectra
        if not freqs:
            nfreq = len(spectra[0])
            freqs = [index * payload.sampling_rate_hz / payload.nfft for index in range(nfreq)]

    calibration = _load_calibration_bundle(payload.calibration) if payload.calibration else None
    if calibration and freqs:
        for channel_name, spectra in list(spectra_by_channel.items()):
            calibration_sources = calibration.get(channel_name)
            if calibration_sources is None:
                continue
            response = combine_responses(
                calibration_sources[0],
                calibration_sources[1],
                freqs,
                allow_extrapolation=payload.allow_response_extrapolation,
            )
            spectra_by_channel[channel_name] = calibrate_segments(spectra, response)

    if "ex" in spectra_by_channel:
        spectra_by_channel["ex"] = _normalize_electric_channel_segments(
            spectra_by_channel["ex"],
            payload.dipole_ex_m,
            payload.channels.ex,
        )
    if "ey" in spectra_by_channel:
        spectra_by_channel["ey"] = _normalize_electric_channel_segments(
            spectra_by_channel["ey"],
            payload.dipole_ey_m,
            payload.channels.ey,
        )

    return spectra_by_channel, freqs


def _normalize_electric_channel_segments(
    segments: List[List[complex]],
    dipole_length_m: Optional[float],
    source: Optional[schemas.EMAP1ChannelSourceIn],
) -> List[List[complex]]:
    dipole = dipole_length_m or 1.0
    normalized = [[value / dipole for value in segment] for segment in segments]
    unit = _normalize_unit_name(source.unit if source is not None else None)
    if unit in {"mv", "millivolt", "millivolts"}:
        return [[value / 1000.0 for value in segment] for segment in normalized]
    if unit in {"uv", "microvolt", "microvolts"}:
        return [[value / 1_000_000.0 for value in segment] for segment in normalized]
    return normalized


def _normalize_unit_name(unit: Optional[str]) -> str:
    if unit is None:
        return ""
    normalized = str(unit).strip().lower()
    normalized = normalized.replace("μ", "u")
    normalized = normalized.replace("µ", "u")
    return normalized


def _run_aurora_regression_rows(
    payload: schemas.EMAP1ProcessRequest,
    spectra_by_channel: Dict[str, List[List[complex]]],
    freqs: Sequence[float],
) -> List[Dict[str, float]]:
    rows: List[Dict[str, float]] = []
    for freq_index, freq_hz in enumerate(freqs):
        if freq_index == 0:
            rows.append(
                {
                    "freq_hz": freq_hz,
                    "zxx_real": 0.0,
                    "zxx_imag": 0.0,
                    "zxy_real": 0.0,
                    "zxy_imag": 0.0,
                    "zyx_real": 0.0,
                    "zyx_imag": 0.0,
                    "zyy_real": 0.0,
                    "zyy_imag": 0.0,
                    "rho_xy": float("nan"),
                    "rho_yx": float("nan"),
                    "phase_xy_deg": float("nan"),
                    "phase_yx_deg": float("nan"),
                    "coherency_xy": float("nan"),
                    "coherency_yx": float("nan"),
                }
            )
            continue

        if payload.mode == "tensor":
            row = _estimate_tensor_row(payload, spectra_by_channel, freq_index, freq_hz)
        elif payload.mode == "scalar_xy":
            row = _estimate_scalar_xy_row(payload, spectra_by_channel, freq_index, freq_hz)
        elif payload.mode == "scalar_yx":
            row = _estimate_scalar_yx_row(payload, spectra_by_channel, freq_index, freq_hz)
        elif payload.mode == "scalar_both":
            row = _estimate_scalar_both_row(payload, spectra_by_channel, freq_index, freq_hz)
        else:
            raise ValueError(f"unsupported EMAP-1 mode: {payload.mode}")
        rows.append(row)
    return rows


def _estimate_tensor_row(
    payload: schemas.EMAP1ProcessRequest,
    spectra_by_channel: Dict[str, List[List[complex]]],
    freq_index: int,
    freq_hz: float,
) -> Dict[str, float]:
    observations = _collect_frequency_observations(
        spectra_by_channel,
        freq_index,
        ["hx", "hy", "ex", "ey", "rx", "ry"],
        allow_missing=("rx", "ry"),
    )
    valid_obs = [
        item
        for item in observations
        if all(name in item for name in ("hx", "hy", "ex", "ey"))
    ]
    if not valid_obs:
        return _empty_emap1_row(freq_hz)

    use_rr = payload.use_remote_reference and all(
        "rx" in item and "ry" in item for item in valid_obs
    )
    estimator = _build_aurora_estimator(
        valid_obs,
        ("hx", "hy"),
        ("ex", "ey"),
        ("rx", "ry") if use_rr else (),
        payload,
    )
    if estimator is None:
        return _empty_emap1_row(freq_hz)

    estimator = _run_aurora_estimate(
        estimator,
        rebuild_estimator=lambda: _build_aurora_estimator(
            valid_obs,
            ("hx", "hy"),
            ("ex", "ey"),
            ("rx", "ry") if use_rr else (),
            payload,
        ),
    )
    coefficients = np.asarray(estimator.b)
    zxx = complex(coefficients[0, 0])
    zxy = complex(coefficients[1, 0])
    zyx = complex(coefficients[0, 1])
    zyy = complex(coefficients[1, 1])
    rho_xy, phase_xy = apparent_resistivity_phase(freq_hz, zxy)
    rho_yx, phase_yx = apparent_resistivity_phase(freq_hz, zyx)
    coherency = _coherency_values(estimator, 2)
    return {
        "freq_hz": freq_hz,
        "zxx_real": zxx.real,
        "zxx_imag": zxx.imag,
        "zxy_real": zxy.real,
        "zxy_imag": zxy.imag,
        "zyx_real": zyx.real,
        "zyx_imag": zyx.imag,
        "zyy_real": zyy.real,
        "zyy_imag": zyy.imag,
        "rho_xy": rho_xy,
        "rho_yx": rho_yx,
        "phase_xy_deg": phase_xy,
        "phase_yx_deg": phase_yx,
        "coherency_xy": coherency[0],
        "coherency_yx": coherency[1],
    }


def _estimate_scalar_xy_row(
    payload: schemas.EMAP1ProcessRequest,
    spectra_by_channel: Dict[str, List[List[complex]]],
    freq_index: int,
    freq_hz: float,
) -> Dict[str, float]:
    observations = _collect_frequency_observations(
        spectra_by_channel,
        freq_index,
        ["ex", "hy", "ry"],
        allow_missing=("ry",),
    )
    valid_obs = [item for item in observations if "ex" in item and "hy" in item]
    if not valid_obs:
        return _empty_emap1_row(freq_hz)

    use_rr = payload.use_remote_reference and all("ry" in item for item in valid_obs)
    estimator = _build_aurora_estimator(
        valid_obs,
        ("hy",),
        ("ex",),
        ("ry",) if use_rr else (),
        payload,
    )
    if estimator is None:
        return _empty_emap1_row(freq_hz)

    estimator = _run_aurora_estimate(
        estimator,
        rebuild_estimator=lambda: _build_aurora_estimator(
            valid_obs,
            ("hy",),
            ("ex",),
            ("ry",) if use_rr else (),
            payload,
        ),
    )
    coefficients = np.asarray(estimator.b)
    zxy = complex(coefficients[0, 0])
    rho_xy, phase_xy = apparent_resistivity_phase(freq_hz, zxy)
    coherency_xy = _coherency_values(estimator, 1)[0]
    return {
        "freq_hz": freq_hz,
        "zxx_real": float("nan"),
        "zxx_imag": float("nan"),
        "zxy_real": zxy.real,
        "zxy_imag": zxy.imag,
        "zyx_real": float("nan"),
        "zyx_imag": float("nan"),
        "zyy_real": float("nan"),
        "zyy_imag": float("nan"),
        "rho_xy": rho_xy,
        "rho_yx": float("nan"),
        "phase_xy_deg": phase_xy,
        "phase_yx_deg": float("nan"),
        "coherency_xy": coherency_xy,
        "coherency_yx": float("nan"),
    }


def _estimate_scalar_yx_row(
    payload: schemas.EMAP1ProcessRequest,
    spectra_by_channel: Dict[str, List[List[complex]]],
    freq_index: int,
    freq_hz: float,
) -> Dict[str, float]:
    observations = _collect_frequency_observations(
        spectra_by_channel,
        freq_index,
        ["ey", "hx", "rx"],
        allow_missing=("rx",),
    )
    valid_obs = [item for item in observations if "ey" in item and "hx" in item]
    if not valid_obs:
        return _empty_emap1_row(freq_hz)

    use_rr = payload.use_remote_reference and all("rx" in item for item in valid_obs)
    estimator = _build_aurora_estimator(
        valid_obs,
        ("hx",),
        ("ey",),
        ("rx",) if use_rr else (),
        payload,
    )
    if estimator is None:
        return _empty_emap1_row(freq_hz)

    estimator = _run_aurora_estimate(
        estimator,
        rebuild_estimator=lambda: _build_aurora_estimator(
            valid_obs,
            ("hx",),
            ("ey",),
            ("rx",) if use_rr else (),
            payload,
        ),
    )
    coefficients = np.asarray(estimator.b)
    zyx = complex(coefficients[0, 0])
    rho_yx, phase_yx = apparent_resistivity_phase(freq_hz, zyx)
    coherency_yx = _coherency_values(estimator, 1)[0]
    return {
        "freq_hz": freq_hz,
        "zxx_real": float("nan"),
        "zxx_imag": float("nan"),
        "zxy_real": float("nan"),
        "zxy_imag": float("nan"),
        "zyx_real": zyx.real,
        "zyx_imag": zyx.imag,
        "zyy_real": float("nan"),
        "zyy_imag": float("nan"),
        "rho_xy": float("nan"),
        "rho_yx": rho_yx,
        "phase_xy_deg": float("nan"),
        "phase_yx_deg": phase_yx,
        "coherency_xy": float("nan"),
        "coherency_yx": coherency_yx,
    }


def _estimate_scalar_both_row(
    payload: schemas.EMAP1ProcessRequest,
    spectra_by_channel: Dict[str, List[List[complex]]],
    freq_index: int,
    freq_hz: float,
) -> Dict[str, float]:
    xy_row = _estimate_scalar_xy_row(payload, spectra_by_channel, freq_index, freq_hz)
    yx_row = _estimate_scalar_yx_row(payload, spectra_by_channel, freq_index, freq_hz)
    return {
        "freq_hz": freq_hz,
        "zxx_real": float("nan"),
        "zxx_imag": float("nan"),
        "zxy_real": xy_row["zxy_real"],
        "zxy_imag": xy_row["zxy_imag"],
        "zyx_real": yx_row["zyx_real"],
        "zyx_imag": yx_row["zyx_imag"],
        "zyy_real": float("nan"),
        "zyy_imag": float("nan"),
        "rho_xy": xy_row["rho_xy"],
        "rho_yx": yx_row["rho_yx"],
        "phase_xy_deg": xy_row["phase_xy_deg"],
        "phase_yx_deg": yx_row["phase_yx_deg"],
        "coherency_xy": xy_row["coherency_xy"],
        "coherency_yx": yx_row["coherency_yx"],
    }


def _collect_frequency_observations(
    spectra_by_channel: Dict[str, List[List[complex]]],
    freq_index: int,
    channel_names: Sequence[str],
    *,
    allow_missing: Sequence[str] = (),
) -> List[Dict[str, complex]]:
    segment_count = len(next(iter(spectra_by_channel.values())))
    allow_missing_set = set(allow_missing)
    observations: List[Dict[str, complex]] = []
    for segment_index in range(segment_count):
        observation: Dict[str, complex] = {}
        include = True
        for channel_name in channel_names:
            channel_segments = spectra_by_channel.get(channel_name)
            if channel_segments is None:
                if channel_name in allow_missing_set:
                    continue
                include = False
                break
            value = channel_segments[segment_index][freq_index]
            if not np.isfinite(value.real) or not np.isfinite(value.imag):
                if channel_name in allow_missing_set:
                    continue
                include = False
                break
            observation[channel_name] = complex(value)
        if include:
            observations.append(observation)
    return observations


def _build_aurora_estimator(
    observations: Sequence[Dict[str, complex]],
    input_names: Sequence[str],
    output_names: Sequence[str],
    remote_names: Sequence[str] = (),
    payload: Optional[schemas.EMAP1ProcessRequest] = None,
):
    required_names = tuple(input_names) + tuple(output_names) + tuple(remote_names)
    filtered = [item for item in observations if all(name in item for name in required_names)]
    if len(filtered) <= len(input_names):
        return None

    x_dataset = _build_complex_dataset(filtered, input_names)
    y_dataset = _build_complex_dataset(filtered, output_names)
    rme_class, rme_rr_class, iter_control_class = _load_aurora_regression_classes()
    iter_control = iter_control_class(
        max_number_of_iterations=max(1, int(payload.max_iter if payload is not None else 10)),
        r0=float(payload.huber_threshold if payload is not None else 1.4),
        tolerance=float(payload.tolerance if payload is not None else 5e-4),
    )
    if remote_names:
        z_dataset = _build_complex_dataset(filtered, remote_names)
        return rme_rr_class(X=x_dataset, Y=y_dataset, Z=z_dataset, iter_control=iter_control)
    return rme_class(X=x_dataset, Y=y_dataset, iter_control=iter_control)


def _build_complex_dataset(
    observations: Sequence[Dict[str, complex]],
    channel_names: Sequence[str],
) -> xr.Dataset:
    return xr.Dataset(
        {
            channel_name: (
                "obs",
                np.asarray([item[channel_name] for item in observations], dtype=np.complex128),
            )
            for channel_name in channel_names
        }
    )


def _run_aurora_estimate(estimator, rebuild_estimator=None):
    try:
        estimator.estimate()
        coefficients = np.asarray(estimator.b)
        if not np.isfinite(coefficients.real).all() or not np.isfinite(coefficients.imag).all():
            raise ValueError("Aurora estimate contains non-finite coefficients")
    except Exception:
        if rebuild_estimator is not None:
            rebuilt = rebuild_estimator()
            if rebuilt is not None:
                estimator = rebuilt
        estimator.qr_decomposition()
        estimator.update_b()
        estimator.update_y_hat()
        estimator.update_residual_variance()
        coefficients = np.asarray(estimator.b)
        if not np.isfinite(coefficients.real).all() or not np.isfinite(coefficients.imag).all():
            raise ValueError("Aurora OLS fallback contains non-finite coefficients")
        if getattr(estimator.iter_control, "return_covariance", False):
            try:
                estimator.compute_inverse_signal_covariance()
                estimator.compute_noise_covariance()
                estimator.compute_squared_coherence()
            except Exception:
                estimator.R2 = None
    return estimator


def _coherency_values(estimator, expected_count: int) -> List[float]:
    if getattr(estimator, "R2", None) is None:
        return [float("nan")] * expected_count
    values = np.asarray(estimator.R2.values, dtype=float).tolist()
    if not isinstance(values, list):
        values = [float(values)]
    while len(values) < expected_count:
        values.append(float("nan"))
    normalized: List[float] = []
    for value in values[:expected_count]:
        if not math.isfinite(value):
            normalized.append(float("nan"))
            continue
        normalized.append(max(0.0, min(1.0, float(value))))
    return normalized


def _empty_emap1_row(freq_hz: float) -> Dict[str, float]:
    return {
        "freq_hz": freq_hz,
        "zxx_real": float("nan"),
        "zxx_imag": float("nan"),
        "zxy_real": float("nan"),
        "zxy_imag": float("nan"),
        "zyx_real": float("nan"),
        "zyx_imag": float("nan"),
        "zyy_real": float("nan"),
        "zyy_imag": float("nan"),
        "rho_xy": float("nan"),
        "rho_yx": float("nan"),
        "phase_xy_deg": float("nan"),
        "phase_yx_deg": float("nan"),
        "coherency_xy": float("nan"),
        "coherency_yx": float("nan"),
    }


def _save_result_rows_csv(path: Path, rows: Sequence[Dict[str, float]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def _collect_calibrated_channels(
    calibration: Optional[schemas.EMAP1CalibrationBundleIn],
) -> List[str]:
    if calibration is None:
        return []
    return [name for name in _ALL_CHANNELS if getattr(calibration, name) is not None]


def _aurora_remote_reference_used(
    payload: schemas.EMAP1ProcessRequest,
    spectra_by_channel: Dict[str, List[List[complex]]],
) -> bool:
    if not payload.use_remote_reference:
        return False
    if payload.mode == "scalar_xy":
        return "ry" in spectra_by_channel
    if payload.mode == "scalar_yx":
        return "rx" in spectra_by_channel
    return "rx" in spectra_by_channel and "ry" in spectra_by_channel


def _read_numeric_file(
    path: Path,
    *,
    column_index: int = 0,
    skip_rows: int = 0,
    scale: float = 1.0,
) -> List[float]:
    if not path.exists():
        raise FileNotFoundError(f"input file not found: {path}")

    if path.suffix.lower() == ".json":
        payload = json.loads(_read_text(path))
        if isinstance(payload, list):
            return [float(value) * scale for value in payload]
        if isinstance(payload, dict) and isinstance(payload.get("values"), list):
            return [float(value) * scale for value in payload["values"]]
        raise ValueError(f"unsupported json channel format: {path}")

    values: List[float] = []
    for line_number, raw_line in enumerate(_read_text(path).splitlines()):
        if line_number < skip_rows:
            continue
        content = raw_line.split("#", 1)[0].strip()
        if not content:
            continue
        tokens = [token for token in _NUMBER_SPLIT_PATTERN.split(content) if token]
        if not tokens or column_index >= len(tokens):
            continue
        try:
            values.append(float(tokens[column_index]) * scale)
        except ValueError:
            continue

    if not values:
        raise ValueError(f"no numeric samples found in file: {path}")
    return values


def _read_text(path: Path) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="latin-1")


def _validate_channel_lengths(
    nfft: int,
    channels: Dict[str, Optional[Sequence[float]]],
) -> None:
    base_length = None
    for channel_name, samples in channels.items():
        if samples is None:
            continue
        if len(samples) < nfft:
            raise ValueError(
                f"channel '{channel_name}' sample length {len(samples)} is shorter than nfft {nfft}"
            )
        if base_length is None:
            base_length = len(samples)
            continue
        if len(samples) != base_length:
            raise ValueError(
                f"channel '{channel_name}' sample length {len(samples)} "
                f"does not match other channels {base_length}"
            )


def _load_calibration_bundle(
    payload: schemas.EMAP1CalibrationBundleIn,
) -> Dict[str, Tuple[ComplexResponse, ComplexResponse]]:
    bundle: Dict[str, Tuple[ComplexResponse, ComplexResponse]] = {}
    for name in _ALL_CHANNELS:
        source = getattr(payload, name)
        if source is None:
            continue
        has_channel_response = _has_calibration_source(
            source.channel_response_path,
            source.channel_response_text,
        )
        has_sensor_response = _has_calibration_source(
            source.sensor_response_path,
            source.sensor_response_text,
        )
        if not has_channel_response or not has_sensor_response:
            raise ValueError(
                f"calibration '{name}' requires both channel_response_path and sensor_response_path"
            )
        bundle[name] = (
            _load_complex_response_from_source(
                source.channel_response_path,
                source.channel_response_text,
                source.channel_response_name,
            ),
            _load_complex_response_from_source(
                source.sensor_response_path,
                source.sensor_response_text,
                source.sensor_response_name,
            ),
        )
    return bundle


def _has_calibration_source(path: Optional[str], text: Optional[str]) -> bool:
    return bool(path) or bool(text)


def _load_complex_response_from_source(
    path: Optional[str],
    text: Optional[str],
    name: Optional[str],
) -> ComplexResponse:
    if path:
        return load_complex_response(path)
    if text is None:
        raise ValueError("calibration source text is missing")
    settings = get_settings()
    runtime_dir = settings.aurora_runtime_dir
    runtime_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(name or "response.txt").suffix or ".txt"
    temp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            suffix=suffix,
            dir=str(runtime_dir),
            delete=False,
        ) as handle:
            handle.write(text)
            temp_path = Path(handle.name)
        return load_complex_response(str(temp_path))
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def _infer_segment_count(result: BIRRPResult) -> int:
    for weights in result.weights_xy + result.weights_yx:
        if weights:
            return len(weights)
    return 0


def _serialize_row(row: Dict[str, float]) -> schemas.EMAP1ResultRowOut:
    normalized = {key: _clean_number(value) for key, value in row.items()}
    return schemas.EMAP1ResultRowOut(**normalized)


def _clean_number(value: object) -> Optional[float]:
    if value is None:
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return number
