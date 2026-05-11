from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Sequence


@dataclass
class ComplexResponse:
    freqs: List[float]
    values: List[complex]
    input_unit: str = ""
    output_unit: str = ""
    kind: str = ""


def _unwrap_phase(phases: Sequence[float]) -> List[float]:
    if not phases:
        return []
    unwrapped = [float(phases[0])]
    offset = 0.0
    for prev, current in zip(phases, phases[1:]):
        delta = current - prev
        if delta > math.pi:
            offset -= 2.0 * math.pi
        elif delta < -math.pi:
            offset += 2.0 * math.pi
        unwrapped.append(current + offset)
    return unwrapped


def _interpolate_linear(x0: float, y0: float, x1: float, y1: float, x: float) -> float:
    if x1 == x0:
        return y0
    ratio = (x - x0) / (x1 - x0)
    return y0 + ratio * (y1 - y0)


def interpolate_complex_response(
    response: ComplexResponse,
    target_freqs: Iterable[float],
    *,
    allow_extrapolation: bool = False,
) -> List[complex]:
    source_freqs = list(response.freqs)
    source_vals = list(response.values)
    if len(source_freqs) != len(source_vals):
        raise ValueError("response freqs and values length mismatch")
    if not source_freqs:
        raise ValueError("empty complex response")

    pairs = sorted(zip(source_freqs, source_vals), key=lambda item: item[0])
    source_freqs = [item[0] for item in pairs]
    source_vals = [item[1] for item in pairs]

    amplitudes = [abs(value) for value in source_vals]
    phases = _unwrap_phase([math.atan2(value.imag, value.real) for value in source_vals])

    result: List[complex] = []
    for freq in target_freqs:
        if freq <= 0.0:
            result.append(complex(float("nan"), float("nan")))
            continue

        if freq < source_freqs[0]:
            if not allow_extrapolation:
                result.append(complex(float("nan"), float("nan")))
                continue
            amp = amplitudes[0]
            phase = phases[0]
        elif freq > source_freqs[-1]:
            if not allow_extrapolation:
                result.append(complex(float("nan"), float("nan")))
                continue
            amp = amplitudes[-1]
            phase = phases[-1]
        else:
            idx = 0
            while idx + 1 < len(source_freqs) and source_freqs[idx + 1] < freq:
                idx += 1
            if idx + 1 == len(source_freqs):
                amp = amplitudes[-1]
                phase = phases[-1]
            elif source_freqs[idx] == freq:
                amp = amplitudes[idx]
                phase = phases[idx]
            else:
                amp = _interpolate_linear(
                    source_freqs[idx],
                    amplitudes[idx],
                    source_freqs[idx + 1],
                    amplitudes[idx + 1],
                    freq,
                )
                phase = _interpolate_linear(
                    source_freqs[idx],
                    phases[idx],
                    source_freqs[idx + 1],
                    phases[idx + 1],
                    freq,
                )

        result.append(complex(amp * math.cos(phase), amp * math.sin(phase)))
    return result


def combine_responses(
    channel_response: ComplexResponse,
    sensor_response: ComplexResponse,
    target_freqs: Iterable[float],
    *,
    allow_extrapolation: bool = False,
) -> List[complex]:
    channel_values = interpolate_complex_response(
        channel_response, target_freqs, allow_extrapolation=allow_extrapolation
    )
    sensor_values = interpolate_complex_response(
        sensor_response, target_freqs, allow_extrapolation=allow_extrapolation
    )
    return [channel * sensor for channel, sensor in zip(channel_values, sensor_values)]


def load_complex_response(path: str | Path) -> ComplexResponse:
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix == ".json":
        return _load_complex_response_json(path)
    return _load_complex_response_csv(path)


def _load_complex_response_json(path: Path) -> ComplexResponse:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("rows") or payload.get("data") or []
    freqs: List[float] = []
    values: List[complex] = []
    for row in rows:
        freq = float(row["freq_hz"])
        if "real" in row and "imag" in row:
            value = complex(float(row["real"]), float(row["imag"]))
        else:
            amp = float(row["amp"])
            phase = math.radians(float(row["phase_deg"]))
            value = complex(amp * math.cos(phase), amp * math.sin(phase))
        freqs.append(freq)
        values.append(value)
    return ComplexResponse(
        freqs=freqs,
        values=values,
        input_unit=str(payload.get("input_unit", "")),
        output_unit=str(payload.get("output_unit", "")),
        kind=str(payload.get("kind", "")),
    )


def _load_complex_response_csv(path: Path) -> ComplexResponse:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = [name or "" for name in (reader.fieldnames or [])]
        lower_map = {name.lower(): name for name in fieldnames}
        rows = list(reader)

    freq_key = lower_map.get("freq_hz") or lower_map.get("freq") or lower_map.get("frequency")
    real_key = lower_map.get("real")
    imag_key = lower_map.get("imag")
    amp_key = lower_map.get("amp") or lower_map.get("amplitude")
    phase_key = lower_map.get("phase_deg") or lower_map.get("phase")

    if not freq_key:
        raise ValueError(f"response file {path} is missing freq_hz column")

    freqs: List[float] = []
    values: List[complex] = []
    for row in rows:
        if not row.get(freq_key):
            continue
        freq = float(row[freq_key])
        if real_key and imag_key and row.get(real_key) and row.get(imag_key):
            value = complex(float(row[real_key]), float(row[imag_key]))
        elif amp_key and phase_key and row.get(amp_key) and row.get(phase_key):
            amp = float(row[amp_key])
            phase = math.radians(float(row[phase_key]))
            value = complex(amp * math.cos(phase), amp * math.sin(phase))
        else:
            raise ValueError(
                f"response file {path} must provide either real/imag or amp/phase_deg columns"
            )
        freqs.append(freq)
        values.append(value)
    return ComplexResponse(freqs=freqs, values=values)
