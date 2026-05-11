from __future__ import annotations

import math
import sys
from pathlib import Path

from backend.app.config import get_settings


def _build_synthetic_channels(sample_rate: float = 128.0, duration: float = 16.0):
    count = int(sample_rate * duration)
    freq_hx = 7.0
    freq_hy = 4.0

    hx = [
        math.sin(2.0 * math.pi * freq_hx * index / sample_rate)
        + 0.35 * math.cos(2.0 * math.pi * 13.0 * index / sample_rate)
        for index in range(count)
    ]
    hy = [
        math.cos(2.0 * math.pi * freq_hy * index / sample_rate)
        + 0.25 * math.sin(2.0 * math.pi * 11.0 * index / sample_rate)
        for index in range(count)
    ]
    ex = [2.0 * hy_value for hy_value in hy]
    ey = [3.0 * hx_value for hx_value in hx]
    return ex, ey, hx, hy


def _result_for_task(client, admin_headers, response):
    assert response.status_code == 200
    created = response.json()
    assert created["task_id"]
    assert created["status"] == "queued"

    status_response = client.get(f"/admin/emap1/tasks/{created['task_id']}", headers=admin_headers)
    assert status_response.status_code == 200
    assert status_response.json()["status"] == "success"

    result_response = client.get(
        f"/admin/emap1/tasks/{created['task_id']}/result",
        headers=admin_headers,
    )
    assert result_response.status_code == 200
    return result_response.json()


def _post_process(client, admin_headers, payload):
    response = client.post("/admin/emap1/process", headers=admin_headers, json=payload)
    return _result_for_task(client, admin_headers, response)


def _post_batch(client, admin_headers, payload):
    response = client.post("/admin/emap1/batch-process", headers=admin_headers, json=payload)
    return _result_for_task(client, admin_headers, response)


def test_emap1_unknown_task_status_and_result_are_safe(client, admin_headers):
    status_response = client.get("/admin/emap1/tasks/not-created", headers=admin_headers)
    assert status_response.status_code == 200
    assert status_response.json()["status"] == "queued"

    result_response = client.get("/admin/emap1/tasks/not-created/result", headers=admin_headers)
    assert result_response.status_code == 409


def test_emap1_process_endpoint_supports_inline_channels(client, admin_headers):
    ex, ey, hx, hy = _build_synthetic_channels()
    payload = {
        "sampling_rate_hz": 128.0,
        "mode": "scalar_both",
        "nfft": 128,
        "overlap": 0.5,
        "window": "hann",
        "channels": {
            "ex": {"values": ex},
            "ey": {"values": ey},
            "hx": {"values": hx},
            "hy": {"values": hy},
        },
    }

    body = _post_process(client, admin_headers, payload)
    assert body["summary"]["engine"] == "aurora-python"
    assert body["summary"]["mode"] == "scalar_both"
    assert body["summary"]["sample_count"] == len(ex)
    assert body["summary"]["segment_count"] > 0
    assert body["summary"]["frequency_count"] == 65
    assert body["summary"]["remote_reference_used"] is False
    assert len(body["rows"]) == 65

    row_xy = min(body["rows"][1:], key=lambda item: abs(item["freq_hz"] - 4.0))
    row_yx = min(body["rows"][1:], key=lambda item: abs(item["freq_hz"] - 7.0))
    assert abs(row_xy["zxy_real"] - 2.0) < 0.3
    assert abs(row_yx["zyx_real"] - 3.0) < 0.3
    assert row_xy["zxx_real"] is None
    assert row_xy["zyy_real"] is None


def test_emap1_process_endpoint_supports_file_channels_and_output_csv(
    client,
    admin_headers,
    tmp_path,
):
    ex, ey, hx, hy = _build_synthetic_channels()

    def write_channel(name: str, values):
        path = tmp_path / f"{name}.txt"
        path.write_text("\n".join(str(value) for value in values), encoding="utf-8")
        return path

    output_path = tmp_path / "results" / "emap1.csv"
    payload = {
        "sampling_rate_hz": 128.0,
        "mode": "scalar_xy",
        "nfft": 128,
        "channels": {
            "ex": {"file_path": str(write_channel("ex", ex))},
            "ey": {"file_path": str(write_channel("ey", ey))},
            "hx": {"file_path": str(write_channel("hx", hx))},
            "hy": {"file_path": str(write_channel("hy", hy))},
        },
        "output_csv_path": str(output_path),
        "return_rows": False,
    }

    body = _post_process(client, admin_headers, payload)
    assert body["summary"]["engine"] == "aurora-python"
    assert body["summary"]["output_csv_path"] == str(output_path)
    assert body["rows"] == []
    assert output_path.exists() is True


def test_emap1_batch_process_endpoint_scans_directory_and_writes_outputs(
    client,
    admin_headers,
    tmp_path,
):
    ex, ey, hx, hy = _build_synthetic_channels()
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir()

    def write_group(group_name: str, include_all: bool = True):
        group_channels = {
            "ex": ex,
            "ey": ey,
            "hx": hx,
            "hy": hy,
        }
        if not include_all:
            group_channels.pop("hy")
        for channel_name, values in group_channels.items():
            path = input_dir / f"{group_name}_{channel_name}.txt"
            path.write_text("\n".join(str(value) for value in values), encoding="utf-8")

    write_group("P001")
    write_group("P002")
    write_group("BROKEN", include_all=False)

    payload = {
        "input_dir": str(input_dir),
        "output_dir": str(output_dir),
        "sampling_rate_hz": 128.0,
        "mode": "scalar_xy",
        "nfft": 128,
        "return_rows": False,
    }

    body = _post_batch(client, admin_headers, payload)
    assert body["summary"]["total_groups"] == 3
    assert body["summary"]["processed_count"] == 2
    assert body["summary"]["skipped_count"] == 1
    assert Path(body["summary"]["manifest_path"]).exists() is True

    processed_items = [item for item in body["items"] if item["status"] == "processed"]
    skipped_items = [item for item in body["items"] if item["status"] == "skipped"]

    assert {item["group_key"] for item in processed_items} == {"P001", "P002"}
    assert skipped_items[0]["group_key"] == "BROKEN"
    assert "missing required channels" in skipped_items[0]["reason"]
    for item in processed_items:
        assert item["rows"] == []
        assert Path(item["output_csv_path"]).exists() is True


def test_emap1_batch_process_endpoint_returns_rows_for_chart(
    client,
    admin_headers,
    tmp_path,
):
    ex, ey, hx, hy = _build_synthetic_channels()
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir()

    for channel_name, values in {"ex": ex, "ey": ey, "hx": hx, "hy": hy}.items():
        path = input_dir / f"P001_{channel_name}.txt"
        path.write_text("\n".join(str(value) for value in values), encoding="utf-8")

    payload = {
        "input_dir": str(input_dir),
        "output_dir": str(output_dir),
        "sampling_rate_hz": 128.0,
        "mode": "scalar_xy",
        "nfft": 128,
        "return_rows": True,
    }

    body = _post_batch(client, admin_headers, payload)
    assert body["summary"]["processed_count"] == 1
    processed_item = body["items"][0]
    assert processed_item["status"] == "processed"
    assert processed_item["rows"]
    chart_row = min(processed_item["rows"][1:], key=lambda item: abs(item["freq_hz"] - 4.0))
    assert chart_row["rho_xy"] > 0
    assert chart_row["phase_xy_deg"] is not None


def test_emap1_process_endpoint_supports_scalar_xy_with_only_ex_hy_channels(
    client,
    admin_headers,
):
    ex, _, _, hy = _build_synthetic_channels()
    payload = {
        "sampling_rate_hz": 128.0,
        "mode": "scalar_xy",
        "nfft": 128,
        "channels": {
            "ex": {"values": ex},
            "hy": {"values": hy},
        },
    }

    body = _post_process(client, admin_headers, payload)
    assert body["summary"]["engine"] == "aurora-python"
    assert body["summary"]["mode"] == "scalar_xy"
    row_xy = min(body["rows"][1:], key=lambda item: abs(item["freq_hz"] - 4.0))
    assert abs(row_xy["zxy_real"] - 2.0) < 0.3
    assert row_xy["zyx_real"] is None


def test_emap1_process_endpoint_converts_millivolt_electric_channels_using_dipole_length(
    client,
    admin_headers,
):
    _, _, _, hy = _build_synthetic_channels()
    dipole_ex_m = 25.0
    ex_millivolts = [2.0 * hy_value * dipole_ex_m * 1000.0 for hy_value in hy]
    payload = {
        "sampling_rate_hz": 128.0,
        "mode": "scalar_xy",
        "nfft": 128,
        "dipole_ex_m": dipole_ex_m,
        "channels": {
            "ex": {"values": ex_millivolts, "unit": "mV"},
            "hy": {"values": hy},
        },
    }

    body = _post_process(client, admin_headers, payload)
    row_xy = min(body["rows"][1:], key=lambda item: abs(item["freq_hz"] - 4.0))
    assert abs(row_xy["zxy_real"] - 2.0) < 0.3
    assert row_xy["rho_xy"] > 1000.0


def test_emap1_process_endpoint_can_force_legacy_engine(client, admin_headers, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAP1_ENGINE", "legacy")
    get_settings.cache_clear()

    ex, _, _, hy = _build_synthetic_channels()
    payload = {
        "sampling_rate_hz": 128.0,
        "mode": "scalar_xy",
        "nfft": 128,
        "channels": {
            "ex": {"values": ex},
            "hy": {"values": hy},
        },
    }

    body = _post_process(client, admin_headers, payload)
    assert body["summary"]["engine"] == "legacy-birrp"
    get_settings.cache_clear()


def test_emap1_process_endpoint_uses_external_aurora_command_when_configured(
    client,
    admin_headers,
    tmp_path,
    monkeypatch,
):
    script_path = tmp_path / "fake_aurora.py"
    script_path.write_text(
        "\n".join(
            [
                "import json, sys",
                "from pathlib import Path",
                "input_path = Path(sys.argv[-2])",
                "output_path = Path(sys.argv[-1])",
                "payload = json.loads(input_path.read_text(encoding='utf-8'))",
                "channels = payload.get('channels', {})",
                "sample_count = len((channels.get('ex') or {}).get('values', []))",
                "if not sample_count:",
                "    sample_count = len((channels.get('hy') or {}).get('values', []))",
                "response = {",
                "  'summary': {",
                "    'engine': 'aurora-external',",
                "    'mode': payload.get('mode', 'scalar_xy'),",
                "    'sample_count': sample_count,",
                "    'segment_count': 1,",
                "    'frequency_count': 1,",
                "    'remote_reference_used': False,",
                "    'output_csv_path': None,",
                "    'calibrated_channels': []",
                "  },",
                "  'rows': [",
                "    {",
                "      'freq_hz': 10.0,",
                "      'zxy_real': 12.5,",
                "      'rho_xy': 34.5,",
                "      'phase_xy_deg': 56.7,",
                "      'coherency_xy': 0.98",
                "    }",
                "  ]",
                "}",
                "output_path.write_text(json.dumps(response), encoding='utf-8')",
            ]
        ),
        encoding="utf-8",
    )

    monkeypatch.setenv("ADMIN_EMAP1_ENGINE", "aurora")
    monkeypatch.setenv("ADMIN_AURORA_COMMAND", sys.executable)
    monkeypatch.setenv("ADMIN_AURORA_ARGS", str(script_path))
    monkeypatch.setenv("ADMIN_AURORA_FALLBACK_TO_LEGACY", "0")
    get_settings.cache_clear()

    ex, _, _, hy = _build_synthetic_channels()
    payload = {
        "sampling_rate_hz": 128.0,
        "mode": "scalar_xy",
        "nfft": 128,
        "channels": {
            "ex": {"values": ex},
            "hy": {"values": hy},
        },
    }

    body = _post_process(client, admin_headers, payload)
    assert body["summary"]["engine"] == "aurora-external"
    assert body["summary"]["sample_count"] == len(ex)
    assert body["rows"][0]["rho_xy"] == 34.5
    assert body["rows"][0]["coherency_xy"] == 0.98
    get_settings.cache_clear()
