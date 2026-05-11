# BIRRP-like Python implementation

This module implements a pure Python BIRRP-like MT impedance workflow with:

- channel calibration
- sensor calibration
- optional remote reference (`Rx`, `Ry`)
- dipole length conversion
- segmented FFT
- robust Huber reweighting
- impedance, apparent resistivity, phase, and coherency output

Run it with:

```bash
py -3 -m mt_parse.birrp_py.cli path\\to\\config.json
```

Minimal config:

```json
{
  "sampling_rate_hz": 1024,
  "mode": "tensor",
  "nfft": 1024,
  "overlap": 0.5,
  "use_remote_reference": true,
  "dipole_ex_m": 25.0,
  "dipole_ey_m": 25.0,
  "inputs": {
    "ex": "data/ex.txt",
    "ey": "data/ey.txt",
    "hx": "data/hx.txt",
    "hy": "data/hy.txt",
    "rx": "data/rx.txt",
    "ry": "data/ry.txt"
  },
  "calibration": {
    "ex": {
      "channel_response": "cal/ex_channel.csv",
      "sensor_response": "cal/ex_sensor.csv"
    },
    "ey": {
      "channel_response": "cal/ey_channel.csv",
      "sensor_response": "cal/ey_sensor.csv"
    },
    "hx": {
      "channel_response": "cal/hx_channel.csv",
      "sensor_response": "cal/hx_sensor.csv"
    },
    "hy": {
      "channel_response": "cal/hy_channel.csv",
      "sensor_response": "cal/hy_sensor.csv"
    },
    "rx": {
      "channel_response": "cal/rx_channel.csv",
      "sensor_response": "cal/rx_sensor.csv"
    },
    "ry": {
      "channel_response": "cal/ry_channel.csv",
      "sensor_response": "cal/ry_sensor.csv"
    }
  },
  "output_csv": "out/birrp_result.csv"
}
```

Supported modes:

- `tensor`: full 2x2 impedance tensor
- `scalar_xy`: scalar `Ex/Hy`
- `scalar_yx`: scalar `Ey/Hx`
- `scalar_both`: both scalar branches

When `rx` / `ry` are present, the solver estimates:

```text
Z = <E R^H> · <H R^H>^-1
```

Residuals for robust reweighting are still computed from the local magnetic channels.

For scalar modes:

```text
scalar_xy  -> Zxy = <Ex Ry^H> / <Hy Ry^H>   or   <Ex Hy^H> / <Hy Hy^H>
scalar_yx  -> Zyx = <Ey Rx^H> / <Hx Rx^H>   or   <Ey Hx^H> / <Hx Hx^H>
```

Response CSV files can use either:

```text
freq_hz,real,imag
```

or:

```text
freq_hz,amp,phase_deg
```
