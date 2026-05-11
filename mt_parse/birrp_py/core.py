from __future__ import annotations

import cmath
import csv
import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from .calibration import ComplexResponse, combine_responses

MU0 = 4.0 * math.pi * 1e-7


@dataclass
class BIRRPConfig:
    sampling_rate_hz: float
    mode: str = "tensor"
    nfft: int = 4096
    overlap: float = 0.5
    window: str = "hann"
    huber_threshold: float = 1.5
    max_iter: int = 20
    tolerance: float = 1e-4
    dipole_ex_m: float = 1.0
    dipole_ey_m: float = 1.0
    allow_response_extrapolation: bool = False
    use_remote_reference: bool = True


@dataclass
class BIRRPResult:
    freqs_hz: List[float]
    zxx: List[complex]
    zxy: List[complex]
    zyx: List[complex]
    zyy: List[complex]
    rho_xy: List[float]
    rho_yx: List[float]
    phase_xy_deg: List[float]
    phase_yx_deg: List[float]
    coherency_xy: List[float]
    coherency_yx: List[float]
    weights_xy: List[List[float]] = field(default_factory=list)
    weights_yx: List[List[float]] = field(default_factory=list)

    def to_rows(self) -> List[Dict[str, float]]:
        rows: List[Dict[str, float]] = []
        for idx, freq in enumerate(self.freqs_hz):
            rows.append(
                {
                    "freq_hz": freq,
                    "zxx_real": self.zxx[idx].real,
                    "zxx_imag": self.zxx[idx].imag,
                    "zxy_real": self.zxy[idx].real,
                    "zxy_imag": self.zxy[idx].imag,
                    "zyx_real": self.zyx[idx].real,
                    "zyx_imag": self.zyx[idx].imag,
                    "zyy_real": self.zyy[idx].real,
                    "zyy_imag": self.zyy[idx].imag,
                    "rho_xy": self.rho_xy[idx],
                    "rho_yx": self.rho_yx[idx],
                    "phase_xy_deg": self.phase_xy_deg[idx],
                    "phase_yx_deg": self.phase_yx_deg[idx],
                    "coherency_xy": self.coherency_xy[idx],
                    "coherency_yx": self.coherency_yx[idx],
                }
            )
        return rows


def hann_window(size: int) -> List[float]:
    if size <= 1:
        return [1.0] * max(size, 1)
    return [0.5 - 0.5 * math.cos(2.0 * math.pi * index / (size - 1)) for index in range(size)]


def hamming_window(size: int) -> List[float]:
    if size <= 1:
        return [1.0] * max(size, 1)
    return [0.54 - 0.46 * math.cos(2.0 * math.pi * index / (size - 1)) for index in range(size)]


def build_window(name: str, size: int) -> List[float]:
    normalized = (name or "hann").strip().lower()
    if normalized == "hann":
        return hann_window(size)
    if normalized == "hamming":
        return hamming_window(size)
    if normalized in {"boxcar", "rect", "rectangular"}:
        return [1.0] * size
    raise ValueError(f"unsupported window: {name}")


def fft(values: Sequence[complex]) -> List[complex]:
    size = len(values)
    if size == 0:
        return []
    if size == 1:
        return [complex(values[0])]
    if size % 2 != 0:
        return _dft(values)
    even = fft(values[0::2])
    odd = fft(values[1::2])
    output = [0j] * size
    for index in range(size // 2):
        factor = cmath.exp(complex(0.0, -2.0 * math.pi * index / size)) * odd[index]
        output[index] = even[index] + factor
        output[index + size // 2] = even[index] - factor
    return output


def _dft(values: Sequence[complex]) -> List[complex]:
    size = len(values)
    output = []
    for freq_index in range(size):
        accumulator = 0j
        for time_index, value in enumerate(values):
            angle = -2.0 * math.pi * freq_index * time_index / size
            accumulator += value * cmath.exp(complex(0.0, angle))
        output.append(accumulator)
    return output


def rfft(values: Sequence[complex]) -> List[complex]:
    spectrum = fft(values)
    return spectrum[: len(values) // 2 + 1]


def segment_rfft(
    samples: Sequence[float],
    nfft: int,
    *,
    overlap: float = 0.5,
    window: str = "hann",
) -> Tuple[List[List[complex]], List[float]]:
    if nfft <= 0:
        raise ValueError("nfft must be positive")
    if not 0.0 <= overlap < 1.0:
        raise ValueError("overlap must be in [0, 1)")
    if len(samples) < nfft:
        raise ValueError("samples shorter than nfft")

    step = max(1, int(round(nfft * (1.0 - overlap))))
    weights = build_window(window, nfft)
    scale = math.sqrt(sum(weight * weight for weight in weights)) or 1.0

    spectra: List[List[complex]] = []
    starts = range(0, len(samples) - nfft + 1, step)
    for start in starts:
        segment = list(samples[start : start + nfft])
        mean = sum(segment) / len(segment)
        tapered = [(value - mean) * weight / scale for value, weight in zip(segment, weights)]
        spectra.append(rfft([complex(value, 0.0) for value in tapered]))
    return spectra, weights


def estimate_z_from_segments(
    ex_segments: Sequence[complex],
    ey_segments: Sequence[complex],
    hx_segments: Sequence[complex],
    hy_segments: Sequence[complex],
    weights: Optional[Sequence[float]] = None,
) -> List[List[complex]]:
    count = len(ex_segments)
    if not (len(ey_segments) == len(hx_segments) == len(hy_segments) == count):
        raise ValueError("segment arrays length mismatch")
    if weights is None:
        weights = [1.0] * count
    if len(weights) != count:
        raise ValueError("weights length mismatch")

    seh = [[0j, 0j], [0j, 0j]]
    shh = [[0j, 0j], [0j, 0j]]
    for ex_value, ey_value, hx_value, hy_value, weight in zip(
        ex_segments, ey_segments, hx_segments, hy_segments, weights
    ):
        e = [ex_value, ey_value]
        h = [hx_value, hy_value]
        for row in range(2):
            for col in range(2):
                seh[row][col] += weight * e[row] * h[col].conjugate()
                shh[row][col] += weight * h[row] * h[col].conjugate()

    return _matmul_2x2(seh, _inv_2x2(shh))


def estimate_z_remote_reference(
    ex_segments: Sequence[complex],
    ey_segments: Sequence[complex],
    hx_segments: Sequence[complex],
    hy_segments: Sequence[complex],
    rx_segments: Sequence[complex],
    ry_segments: Sequence[complex],
    weights: Optional[Sequence[float]] = None,
) -> List[List[complex]]:
    count = len(ex_segments)
    if not (
        len(ey_segments)
        == len(hx_segments)
        == len(hy_segments)
        == len(rx_segments)
        == len(ry_segments)
        == count
    ):
        raise ValueError("segment arrays length mismatch")
    if weights is None:
        weights = [1.0] * count
    if len(weights) != count:
        raise ValueError("weights length mismatch")

    ser = [[0j, 0j], [0j, 0j]]
    shr = [[0j, 0j], [0j, 0j]]
    for ex_value, ey_value, hx_value, hy_value, rx_value, ry_value, weight in zip(
        ex_segments,
        ey_segments,
        hx_segments,
        hy_segments,
        rx_segments,
        ry_segments,
        weights,
    ):
        e = [ex_value, ey_value]
        h = [hx_value, hy_value]
        r = [rx_value, ry_value]
        for row in range(2):
            for col in range(2):
                ser[row][col] += weight * e[row] * r[col].conjugate()
                shr[row][col] += weight * h[row] * r[col].conjugate()

    return _matmul_2x2(ser, _inv_2x2(shr))


def estimate_scalar_z(
    electric_segments: Sequence[complex],
    magnetic_segments: Sequence[complex],
    reference_segments: Optional[Sequence[complex]] = None,
    weights: Optional[Sequence[float]] = None,
) -> complex:
    count = len(electric_segments)
    if len(magnetic_segments) != count:
        raise ValueError("segment arrays length mismatch")
    if reference_segments is not None and len(reference_segments) != count:
        raise ValueError("reference arrays length mismatch")
    if weights is None:
        weights = [1.0] * count
    if len(weights) != count:
        raise ValueError("weights length mismatch")

    numerator = 0j
    denominator = 0j
    for index, (electric_value, magnetic_value, weight) in enumerate(
        zip(electric_segments, magnetic_segments, weights)
    ):
        reference_value = (
            reference_segments[index].conjugate()
            if reference_segments is not None
            else magnetic_value.conjugate()
        )
        numerator += weight * electric_value * reference_value
        denominator += weight * magnetic_value * reference_value
    if abs(denominator) < 1e-24:
        return complex(float("nan"), float("nan"))
    return numerator / denominator


def robust_z_for_frequency(
    ex_segments: Sequence[complex],
    ey_segments: Sequence[complex],
    hx_segments: Sequence[complex],
    hy_segments: Sequence[complex],
    rx_segments: Optional[Sequence[complex]] = None,
    ry_segments: Optional[Sequence[complex]] = None,
    *,
    max_iter: int = 20,
    tolerance: float = 1e-4,
    huber_threshold: float = 1.5,
) -> Tuple[List[List[complex]], List[float]]:
    use_remote_reference = rx_segments is not None and ry_segments is not None
    if use_remote_reference:
        z = estimate_z_remote_reference(
            ex_segments,
            ey_segments,
            hx_segments,
            hy_segments,
            rx_segments,
            ry_segments,
        )
    else:
        z = estimate_z_from_segments(ex_segments, ey_segments, hx_segments, hy_segments)
    weights = [1.0] * len(ex_segments)

    for _ in range(max_iter):
        residuals = []
        for ex_value, ey_value, hx_value, hy_value in zip(
            ex_segments, ey_segments, hx_segments, hy_segments
        ):
            r0 = ex_value - (z[0][0] * hx_value + z[0][1] * hy_value)
            r1 = ey_value - (z[1][0] * hx_value + z[1][1] * hy_value)
            residuals.append(math.sqrt(abs(r0) ** 2 + abs(r1) ** 2))

        scale = _robust_scale(residuals)
        if scale <= 0.0:
            break
        normalized = [value / scale for value in residuals]
        next_weights = [huber_weight(value, huber_threshold) for value in normalized]
        if use_remote_reference:
            next_z = estimate_z_remote_reference(
                ex_segments,
                ey_segments,
                hx_segments,
                hy_segments,
                rx_segments,
                ry_segments,
                weights=next_weights,
            )
        else:
            next_z = estimate_z_from_segments(
                ex_segments,
                ey_segments,
                hx_segments,
                hy_segments,
                weights=next_weights,
            )
        delta = _matrix_distance(next_z, z)
        base = _matrix_norm(z) or 1.0
        z = next_z
        weights = next_weights
        if delta / base < tolerance:
            break
    return z, weights


def robust_scalar_z_for_frequency(
    electric_segments: Sequence[complex],
    magnetic_segments: Sequence[complex],
    reference_segments: Optional[Sequence[complex]] = None,
    *,
    max_iter: int = 20,
    tolerance: float = 1e-4,
    huber_threshold: float = 1.5,
) -> Tuple[complex, List[float]]:
    z = estimate_scalar_z(electric_segments, magnetic_segments, reference_segments)
    weights = [1.0] * len(electric_segments)

    for _ in range(max_iter):
        residuals = [
            abs(electric_value - z * magnetic_value)
            for electric_value, magnetic_value in zip(electric_segments, magnetic_segments)
        ]
        scale = _robust_scale(residuals)
        if scale <= 0.0:
            break
        next_weights = [huber_weight(value / scale, huber_threshold) for value in residuals]
        next_z = estimate_scalar_z(
            electric_segments,
            magnetic_segments,
            reference_segments,
            weights=next_weights,
        )
        delta = abs(next_z - z)
        base = abs(z) or 1.0
        z = next_z
        weights = next_weights
        if delta / base < tolerance:
            break
    return z, weights


def huber_weight(value: float, threshold: float = 1.5) -> float:
    magnitude = abs(value)
    if magnitude <= threshold or threshold <= 0.0:
        return 1.0
    return threshold / magnitude


def apparent_resistivity_phase(freq_hz: float, impedance: complex) -> Tuple[float, float]:
    if freq_hz <= 0.0:
        return float("nan"), float("nan")
    omega = 2.0 * math.pi * freq_hz
    rho = (abs(impedance) ** 2) / (MU0 * omega)
    phase = math.degrees(math.atan2(impedance.imag, impedance.real))
    return rho, phase


def compute_coherency(
    electric_segments: Sequence[complex],
    magnetic_segments: Sequence[complex],
    weights: Sequence[float],
) -> float:
    cross = 0j
    ee = 0.0
    hh = 0.0
    for electric_value, magnetic_value, weight in zip(
        electric_segments, magnetic_segments, weights
    ):
        cross += weight * electric_value * magnetic_value.conjugate()
        ee += weight * (abs(electric_value) ** 2)
        hh += weight * (abs(magnetic_value) ** 2)
    if ee <= 0.0 or hh <= 0.0:
        return float("nan")
    value = (abs(cross) ** 2) / (ee * hh)
    return max(0.0, min(1.0, value))


def calibrate_segments(
    spectra: Sequence[Sequence[complex]],
    total_response: Sequence[complex],
) -> List[List[complex]]:
    calibrated: List[List[complex]] = []
    for segment in spectra:
        calibrated_segment: List[complex] = []
        for sample, response in zip(segment, total_response):
            if response == 0:
                calibrated_segment.append(complex(float("nan"), float("nan")))
            else:
                calibrated_segment.append(sample / response)
        calibrated.append(calibrated_segment)
    return calibrated


def birrp_process(
    ex_samples: Sequence[float],
    ey_samples: Sequence[float],
    hx_samples: Sequence[float],
    hy_samples: Sequence[float],
    rx_samples: Optional[Sequence[float]] = None,
    ry_samples: Optional[Sequence[float]] = None,
    *,
    config: BIRRPConfig,
    calibration: Optional[Dict[str, Tuple[ComplexResponse, ComplexResponse]]] = None,
) -> BIRRPResult:
    mode = _normalize_mode(config.mode)
    ex_spec, _ = segment_rfft(ex_samples, config.nfft, overlap=config.overlap, window=config.window)
    ey_spec, _ = segment_rfft(ey_samples, config.nfft, overlap=config.overlap, window=config.window)
    hx_spec, _ = segment_rfft(hx_samples, config.nfft, overlap=config.overlap, window=config.window)
    hy_spec, _ = segment_rfft(hy_samples, config.nfft, overlap=config.overlap, window=config.window)
    use_remote_reference = (
        config.use_remote_reference and rx_samples is not None and ry_samples is not None
    )
    rx_spec: Optional[List[List[complex]]] = None
    ry_spec: Optional[List[List[complex]]] = None
    if use_remote_reference:
        rx_spec, _ = segment_rfft(
            rx_samples, config.nfft, overlap=config.overlap, window=config.window
        )
        ry_spec, _ = segment_rfft(
            ry_samples, config.nfft, overlap=config.overlap, window=config.window
        )

    if not (len(ex_spec) == len(ey_spec) == len(hx_spec) == len(hy_spec)):
        raise ValueError("segment count mismatch across channels")
    if use_remote_reference and not (
        len(ex_spec) == len(rx_spec or []) == len(ry_spec or [])
    ):
        raise ValueError("remote reference segment count mismatch")
    if not ex_spec:
        raise ValueError("no spectra generated")

    nfreq = len(ex_spec[0])
    freqs = [index * config.sampling_rate_hz / config.nfft for index in range(nfreq)]

    if calibration:
        ex_resp = combine_responses(
            calibration["ex"][0],
            calibration["ex"][1],
            freqs,
            allow_extrapolation=config.allow_response_extrapolation,
        )
        ey_resp = combine_responses(
            calibration["ey"][0],
            calibration["ey"][1],
            freqs,
            allow_extrapolation=config.allow_response_extrapolation,
        )
        hx_resp = combine_responses(
            calibration["hx"][0],
            calibration["hx"][1],
            freqs,
            allow_extrapolation=config.allow_response_extrapolation,
        )
        hy_resp = combine_responses(
            calibration["hy"][0],
            calibration["hy"][1],
            freqs,
            allow_extrapolation=config.allow_response_extrapolation,
        )
        ex_spec = calibrate_segments(ex_spec, ex_resp)
        ey_spec = calibrate_segments(ey_spec, ey_resp)
        hx_spec = calibrate_segments(hx_spec, hx_resp)
        hy_spec = calibrate_segments(hy_spec, hy_resp)
        if use_remote_reference and rx_spec is not None and ry_spec is not None:
            rx_cal = calibration.get("rx") or calibration.get("hx")
            ry_cal = calibration.get("ry") or calibration.get("hy")
            if not rx_cal or not ry_cal:
                raise ValueError("remote reference calibration missing for rx/ry")
            rx_resp = combine_responses(
                rx_cal[0],
                rx_cal[1],
                freqs,
                allow_extrapolation=config.allow_response_extrapolation,
            )
            ry_resp = combine_responses(
                ry_cal[0],
                ry_cal[1],
                freqs,
                allow_extrapolation=config.allow_response_extrapolation,
            )
            rx_spec = calibrate_segments(rx_spec, rx_resp)
            ry_spec = calibrate_segments(ry_spec, ry_resp)

    ex_scale = config.dipole_ex_m or 1.0
    ey_scale = config.dipole_ey_m or 1.0
    ex_spec = [[value / ex_scale for value in segment] for segment in ex_spec]
    ey_spec = [[value / ey_scale for value in segment] for segment in ey_spec]

    zxx: List[complex] = []
    zxy: List[complex] = []
    zyx: List[complex] = []
    zyy: List[complex] = []
    rho_xy: List[float] = []
    rho_yx: List[float] = []
    phase_xy_deg: List[float] = []
    phase_yx_deg: List[float] = []
    coherency_xy: List[float] = []
    coherency_yx: List[float] = []
    weights_xy: List[List[float]] = []
    weights_yx: List[List[float]] = []

    for freq_index, freq_hz in enumerate(freqs):
        if freq_index == 0:
            zxx.append(0j)
            zxy.append(0j)
            zyx.append(0j)
            zyy.append(0j)
            rho_xy.append(float("nan"))
            rho_yx.append(float("nan"))
            phase_xy_deg.append(float("nan"))
            phase_yx_deg.append(float("nan"))
            coherency_xy.append(float("nan"))
            coherency_yx.append(float("nan"))
            weights_xy.append([1.0] * len(ex_spec))
            weights_yx.append([1.0] * len(ex_spec))
            continue

        ex_segments = [segment[freq_index] for segment in ex_spec]
        ey_segments = [segment[freq_index] for segment in ey_spec]
        hx_segments = [segment[freq_index] for segment in hx_spec]
        hy_segments = [segment[freq_index] for segment in hy_spec]
        rx_segments = (
            [segment[freq_index] for segment in (rx_spec or [])]
            if use_remote_reference
            else None
        )
        ry_segments = (
            [segment[freq_index] for segment in (ry_spec or [])]
            if use_remote_reference
            else None
        )

        zxx_value = complex(float("nan"), float("nan"))
        zxy_value = complex(float("nan"), float("nan"))
        zyx_value = complex(float("nan"), float("nan"))
        zyy_value = complex(float("nan"), float("nan"))
        weights_xy_value = [1.0] * len(ex_spec)
        weights_yx_value = [1.0] * len(ex_spec)

        if mode == "tensor":
            z_matrix, weights = robust_z_for_frequency(
                ex_segments,
                ey_segments,
                hx_segments,
                hy_segments,
                rx_segments,
                ry_segments,
                max_iter=config.max_iter,
                tolerance=config.tolerance,
                huber_threshold=config.huber_threshold,
            )
            zxx_value = z_matrix[0][0]
            zxy_value = z_matrix[0][1]
            zyx_value = z_matrix[1][0]
            zyy_value = z_matrix[1][1]
            weights_xy_value = list(weights)
            weights_yx_value = list(weights)
        else:
            if mode in {"scalar_xy", "scalar_both"}:
                zxy_value, weights_xy_value = robust_scalar_z_for_frequency(
                    ex_segments,
                    hy_segments,
                    ry_segments,
                    max_iter=config.max_iter,
                    tolerance=config.tolerance,
                    huber_threshold=config.huber_threshold,
                )
            if mode in {"scalar_yx", "scalar_both"}:
                zyx_value, weights_yx_value = robust_scalar_z_for_frequency(
                    ey_segments,
                    hx_segments,
                    rx_segments,
                    max_iter=config.max_iter,
                    tolerance=config.tolerance,
                    huber_threshold=config.huber_threshold,
                )

        rho_xy_value, phase_xy_value = apparent_resistivity_phase(freq_hz, zxy_value)
        rho_yx_value, phase_yx_value = apparent_resistivity_phase(freq_hz, zyx_value)

        zxx.append(zxx_value)
        zxy.append(zxy_value)
        zyx.append(zyx_value)
        zyy.append(zyy_value)
        rho_xy.append(rho_xy_value)
        rho_yx.append(rho_yx_value)
        phase_xy_deg.append(phase_xy_value)
        phase_yx_deg.append(phase_yx_value)
        coherency_xy.append(compute_coherency(ex_segments, hy_segments, weights_xy_value))
        coherency_yx.append(compute_coherency(ey_segments, hx_segments, weights_yx_value))
        weights_xy.append(list(weights_xy_value))
        weights_yx.append(list(weights_yx_value))

    return BIRRPResult(
        freqs_hz=freqs,
        zxx=zxx,
        zxy=zxy,
        zyx=zyx,
        zyy=zyy,
        rho_xy=rho_xy,
        rho_yx=rho_yx,
        phase_xy_deg=phase_xy_deg,
        phase_yx_deg=phase_yx_deg,
        coherency_xy=coherency_xy,
        coherency_yx=coherency_yx,
        weights_xy=weights_xy,
        weights_yx=weights_yx,
    )


def _normalize_mode(mode: str) -> str:
    normalized = str(mode or "tensor").strip().lower()
    allowed = {"tensor", "scalar_xy", "scalar_yx", "scalar_both"}
    if normalized not in allowed:
        raise ValueError(f"unsupported BIRRP mode: {mode}")
    return normalized


def save_result_csv(path: str, result: BIRRPResult) -> None:
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(result.to_rows()[0].keys()))
        writer.writeheader()
        writer.writerows(result.to_rows())


def _inv_2x2(matrix: Sequence[Sequence[complex]]) -> List[List[complex]]:
    determinant = matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0]
    if abs(determinant) < 1e-24:
        determinant += complex(1e-24, 0.0)
    inv_det = 1.0 / determinant
    return [
        [matrix[1][1] * inv_det, -matrix[0][1] * inv_det],
        [-matrix[1][0] * inv_det, matrix[0][0] * inv_det],
    ]


def _matmul_2x2(
    left: Sequence[Sequence[complex]], right: Sequence[Sequence[complex]]
) -> List[List[complex]]:
    return [
        [
            left[0][0] * right[0][0] + left[0][1] * right[1][0],
            left[0][0] * right[0][1] + left[0][1] * right[1][1],
        ],
        [
            left[1][0] * right[0][0] + left[1][1] * right[1][0],
            left[1][0] * right[0][1] + left[1][1] * right[1][1],
        ],
    ]


def _matrix_norm(matrix: Sequence[Sequence[complex]]) -> float:
    return math.sqrt(sum(abs(value) ** 2 for row in matrix for value in row))


def _matrix_distance(
    left: Sequence[Sequence[complex]], right: Sequence[Sequence[complex]]
) -> float:
    return math.sqrt(
        sum(abs(left[row][col] - right[row][col]) ** 2 for row in range(2) for col in range(2))
    )


def _robust_scale(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    sorted_values = sorted(values)
    mid = len(sorted_values) // 2
    median = (
        sorted_values[mid]
        if len(sorted_values) % 2 == 1
        else 0.5 * (sorted_values[mid - 1] + sorted_values[mid])
    )
    deviations = sorted(abs(value - median) for value in sorted_values)
    mid_dev = len(deviations) // 2
    mad = deviations[mid_dev] if len(deviations) % 2 == 1 else 0.5 * (
        deviations[mid_dev - 1] + deviations[mid_dev]
    )
    return 1.4826 * mad + 1e-12
