from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Dict, List, Tuple

from .calibration import ComplexResponse, load_complex_response
from .core import BIRRPConfig, birrp_process, save_result_csv


def read_series(path: str) -> List[float]:
    values: List[float] = []
    with open(path, "r", encoding="utf-8-sig") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "," in line:
                line = line.split(",")[0].strip()
            values.append(float(line))
    return values


def load_calibration_map(
    payload: Dict[str, Dict[str, str]]
) -> Dict[str, Tuple[ComplexResponse, ComplexResponse]]:
    calibration_map: Dict[str, Tuple[ComplexResponse, ComplexResponse]] = {}
    for channel in ("ex", "ey", "hx", "hy", "rx", "ry"):
        channel_payload = payload.get(channel)
        if not channel_payload:
            continue
        calibration_map[channel] = (
            load_complex_response(channel_payload["channel_response"]),
            load_complex_response(channel_payload["sensor_response"]),
        )
    return calibration_map


def main() -> None:
    parser = argparse.ArgumentParser(description="Pure Python BIRRP-like MT processor")
    parser.add_argument("config", help="Path to JSON config file")
    args = parser.parse_args()

    config_path = Path(args.config)
    payload = json.loads(config_path.read_text(encoding="utf-8"))

    ex = read_series(payload["inputs"]["ex"])
    ey = read_series(payload["inputs"]["ey"])
    hx = read_series(payload["inputs"]["hx"])
    hy = read_series(payload["inputs"]["hy"])
    rx = read_series(payload["inputs"]["rx"]) if payload["inputs"].get("rx") else None
    ry = read_series(payload["inputs"]["ry"]) if payload["inputs"].get("ry") else None

    config = BIRRPConfig(
        sampling_rate_hz=float(payload["sampling_rate_hz"]),
        mode=str(payload.get("mode", "tensor")),
        nfft=int(payload.get("nfft", 4096)),
        overlap=float(payload.get("overlap", 0.5)),
        window=str(payload.get("window", "hann")),
        huber_threshold=float(payload.get("huber_threshold", 1.5)),
        max_iter=int(payload.get("max_iter", 20)),
        tolerance=float(payload.get("tolerance", 1e-4)),
        dipole_ex_m=float(payload.get("dipole_ex_m", 1.0)),
        dipole_ey_m=float(payload.get("dipole_ey_m", 1.0)),
        allow_response_extrapolation=bool(payload.get("allow_response_extrapolation", False)),
        use_remote_reference=bool(payload.get("use_remote_reference", True)),
    )

    calibration = load_calibration_map(payload.get("calibration", {}))
    result = birrp_process(
        ex,
        ey,
        hx,
        hy,
        rx_samples=rx,
        ry_samples=ry,
        config=config,
        calibration=calibration or None,
    )

    output_path = payload.get("output_csv") or str(config_path.with_suffix(".birrp.csv"))
    save_result_csv(output_path, result)
    print(f"Wrote BIRRP result to {output_path}")


if __name__ == "__main__":
    main()
