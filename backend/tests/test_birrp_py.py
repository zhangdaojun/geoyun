import math
from pathlib import Path

from mt_parse.birrp_py.calibration import ComplexResponse, combine_responses, load_complex_response
from mt_parse.birrp_py.core import BIRRPConfig, birrp_process, robust_z_for_frequency


def test_combine_responses_multiplies_complex_values():
    channel = ComplexResponse(freqs=[1.0, 10.0], values=[2.0 + 0.0j, 2.0 + 0.0j])
    sensor = ComplexResponse(freqs=[1.0, 10.0], values=[0.5 + 0.0j, 0.5 + 0.0j])
    combined = combine_responses(channel, sensor, [1.0, 5.0, 10.0])
    assert len(combined) == 3
    for value in combined:
        assert abs(value - (1.0 + 0.0j)) < 1e-9


def test_load_complex_response_csv_amp_phase(tmp_path: Path):
    csv_path = tmp_path / "response.csv"
    csv_path.write_text("freq_hz,amp,phase_deg\n1,2,0\n10,2,90\n", encoding="utf-8")
    response = load_complex_response(csv_path)
    assert response.freqs == [1.0, 10.0]
    assert abs(response.values[0] - complex(2.0, 0.0)) < 1e-9
    assert abs(response.values[1] - complex(0.0, 2.0)) < 1e-9


def test_birrp_process_recovers_cross_components():
    sample_rate = 128.0
    duration = 16.0
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
    ex = [0.1 * hx_value + 2.0 * hy_value for hx_value, hy_value in zip(hx, hy)]
    ey = [3.0 * hx_value - 0.2 * hy_value for hx_value, hy_value in zip(hx, hy)]

    config = BIRRPConfig(
        sampling_rate_hz=sample_rate,
        nfft=128,
        overlap=0.5,
        window="hann",
        max_iter=8,
    )
    result = birrp_process(ex, ey, hx, hy, config=config)

    nearest_index = min(
        range(1, len(result.freqs_hz)),
        key=lambda idx: abs(result.freqs_hz[idx] - freq_hy),
    )
    assert abs(result.zxx[nearest_index].real - 0.1) < 0.3
    assert abs(result.zxy[nearest_index].real - 2.0) < 0.3
    assert abs(result.zyx[nearest_index].real - 3.0) < 0.3
    assert abs(result.zyy[nearest_index].real + 0.2) < 0.3


def test_remote_reference_path_matches_local_solution_when_reference_equals_local():
    hx_segments = [
        complex(1.0, 0.2),
        complex(0.7, -0.1),
        complex(1.3, 0.5),
        complex(0.4, -0.6),
    ]
    hy_segments = [
        complex(0.5, -0.3),
        complex(1.1, 0.4),
        complex(0.6, 0.8),
        complex(1.4, -0.2),
    ]
    ex_segments = [0.1 * hx + 2.0 * hy for hx, hy in zip(hx_segments, hy_segments)]
    ey_segments = [3.0 * hx - 0.2 * hy for hx, hy in zip(hx_segments, hy_segments)]

    local_z, _ = robust_z_for_frequency(ex_segments, ey_segments, hx_segments, hy_segments)
    rr_z, _ = robust_z_for_frequency(
        ex_segments,
        ey_segments,
        hx_segments,
        hy_segments,
        rx_segments=hx_segments,
        ry_segments=hy_segments,
    )

    for row in range(2):
        for col in range(2):
            assert abs(local_z[row][col] - rr_z[row][col]) < 1e-9

    assert abs(rr_z[0][0].real - 0.1) < 1e-9
    assert abs(rr_z[0][1].real - 2.0) < 1e-9
    assert abs(rr_z[1][0].real - 3.0) < 1e-9
    assert abs(rr_z[1][1].real + 0.2) < 1e-9


def test_birrp_process_scalar_modes():
    sample_rate = 128.0
    duration = 16.0
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

    config_xy = BIRRPConfig(
        sampling_rate_hz=sample_rate,
        mode="scalar_xy",
        nfft=128,
        overlap=0.5,
        window="hann",
        max_iter=8,
    )
    config_yx = BIRRPConfig(
        sampling_rate_hz=sample_rate,
        mode="scalar_yx",
        nfft=128,
        overlap=0.5,
        window="hann",
        max_iter=8,
    )
    config_both = BIRRPConfig(
        sampling_rate_hz=sample_rate,
        mode="scalar_both",
        nfft=128,
        overlap=0.5,
        window="hann",
        max_iter=8,
    )

    result_xy = birrp_process(ex, ey, hx, hy, config=config_xy)
    result_yx = birrp_process(ex, ey, hx, hy, config=config_yx)
    result_both = birrp_process(ex, ey, hx, hy, config=config_both)

    xy_index = min(
        range(1, len(result_xy.freqs_hz)),
        key=lambda idx: abs(result_xy.freqs_hz[idx] - freq_hy),
    )
    yx_index = min(
        range(1, len(result_yx.freqs_hz)),
        key=lambda idx: abs(result_yx.freqs_hz[idx] - freq_hx),
    )

    assert math.isnan(result_xy.zxx[xy_index].real)
    assert abs(result_xy.zxy[xy_index].real - 2.0) < 0.3
    assert math.isnan(result_xy.zyx[xy_index].real)
    assert math.isnan(result_xy.zyy[xy_index].real)

    assert math.isnan(result_yx.zxx[yx_index].real)
    assert math.isnan(result_yx.zxy[yx_index].real)
    assert abs(result_yx.zyx[yx_index].real - 3.0) < 0.3
    assert math.isnan(result_yx.zyy[yx_index].real)

    assert abs(result_both.zxy[xy_index].real - 2.0) < 0.3
    assert abs(result_both.zyx[yx_index].real - 3.0) < 0.3
