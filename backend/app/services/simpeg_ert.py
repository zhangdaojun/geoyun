from __future__ import annotations

import csv
import json
import logging
import math
import os
from pathlib import Path
from typing import Any, Dict, Iterable, Sequence

logger = logging.getLogger(__name__)


def _get_solver(solver_name: str = "auto"):
    requested = str(solver_name or "auto").lower()
    if requested == "mumps":
        from pymatsolver import Mumps

        return Mumps, "MUMPS"
    if requested == "pardiso":
        from pymatsolver import Pardiso

        return Pardiso, "Pardiso"
    if requested == "lu":
        from pymatsolver import SolverLU

        return SolverLU, "SolverLU"

    try:
        from pymatsolver import Mumps

        return Mumps, "MUMPS"
    except ImportError:
        try:
            from pymatsolver import Pardiso

            return Pardiso, "Pardiso"
        except ImportError:
            from pymatsolver import SolverLU

            return SolverLU, "SolverLU"


def _finite_positive(value: float | None) -> bool:
    if value is None:
        return False
    number = float(value)
    return math.isfinite(number) and number > 0


def _select_2d_datums(observations: Sequence[Any]) -> list[Any]:
    return [
        item
        for item in observations
        if _finite_positive(item.apparent_resistivity)
        and math.isfinite(float(item.resistance))
        and item.ax is not None
        and item.mx is not None
    ]


def _interpolated_z(terrain_points: list[tuple[float, float]], x: float, fallback: float) -> float:
    if not terrain_points:
        return fallback
    from .pygimli_ert import _interpolate_terrain_z

    return float(_interpolate_terrain_z(terrain_points, float(x)))


def _point2(
    x: float | None,
    z: float | None,
    terrain_points: list[tuple[float, float]],
    *,
    mesh: Any | None = None,
    active_cells: Any | None = None,
):
    """Return a 2D electrode coordinate (x, z) suitable for Simulation2DNodal.

    With topography, naively placing the electrode at ``terrain_z(x)`` puts it on
    the active/air interface where Simulation2DNodal's nodal interpolation mixes
    in the σ≈1e-8 air cells, producing a near-singular forward response (we have
    seen apparent_resistivity values in the millions for a uniform halfspace).
    When ``mesh`` and ``active_cells`` are provided we drape the electrode to the
    *top edge of the topmost active cell* in the column containing ``x``; that
    node is shared by an active cell below and an air cell above, but the
    interpolation only references the active-side stencil because the rx is on
    the boundary, not inside the air cell.
    """
    import numpy as np

    if x is None:
        return None
    if mesh is not None and active_cells is not None:
        return np.r_[float(x), _drape_z_to_active_top(mesh, active_cells, float(x))]
    return np.r_[float(x), _interpolated_z(terrain_points, float(x), float(z or 0.0))]


def _drape_z_to_active_top(mesh: Any, active_cells: Any, x: float) -> float:
    import numpy as np

    n_cx, n_cz = mesh.shape_cells
    active_2d = np.asarray(active_cells, dtype=bool).reshape((n_cx, n_cz), order="F")
    nodes_x = np.asarray(mesh.nodes_x, dtype=float)
    nodes_z = np.asarray(mesh.nodes_y, dtype=float)
    ix = int(np.clip(np.searchsorted(nodes_x, x) - 1, 0, n_cx - 1))
    column = active_2d[ix, :]
    if column.any():
        top_iz = int(np.where(column)[0].max())
        return float(nodes_z[top_iz + 1])
    return float(nodes_z[-1])


def _build_2d_survey(
    datums: Sequence[Any],
    *,
    data_type: str,
    relative_error: float,
    terrain_points: list[tuple[float, float]],
    mesh: Any | None = None,
    active_cells: Any | None = None,
):
    import numpy as np
    from simpeg.electromagnetics.static import resistivity as dc

    source_list = []
    dobs = []
    standard_deviation = []

    for datum in datums:
        m = _point2(datum.mx, datum.mz, terrain_points, mesh=mesh, active_cells=active_cells)
        n = _point2(datum.nx, datum.nz, terrain_points, mesh=mesh, active_cells=active_cells)
        if n is None:
            receiver = dc.receivers.Pole(locations=m, data_type=data_type)
        else:
            receiver = dc.receivers.Dipole(locations_m=m, locations_n=n, data_type=data_type)

        a = _point2(datum.ax, datum.az, terrain_points, mesh=mesh, active_cells=active_cells)
        b = _point2(datum.bx, datum.bz, terrain_points, mesh=mesh, active_cells=active_cells)
        if b is None:
            source = dc.sources.Pole(receiver_list=[receiver], location=a)
        else:
            source = dc.sources.Dipole(receiver_list=[receiver], location_a=a, location_b=b)
        source_list.append(source)

        # When topography is in play, draping electrodes onto mesh nodes
        # introduces ~5-10% per-measurement forward-modeling error (verified on
        # a uniform-halfspace test). If the user-supplied relative_error is
        # tighter than that, the inversion mistakes the topographic ghosts for
        # real subsurface structure and produces a biased model. Add a 5% noise
        # floor whenever terrain is present.
        eff_relative_error = max(float(relative_error), 1e-4)
        if terrain_points:
            eff_relative_error = max(eff_relative_error, 0.05)

        if data_type == "apparent_resistivity":
            observed = float(datum.apparent_resistivity)
            dobs.append(observed)
            standard_deviation.append(max(abs(observed) * eff_relative_error, 1.0))
        else:
            observed = float(datum.resistance)
            dobs.append(observed)
            standard_deviation.append(
                max(float(datum.standard_deviation), abs(observed) * eff_relative_error + 1e-4)
            )

    survey = dc.Survey(source_list, survey_geometry="surface")
    if data_type == "apparent_resistivity":
        survey.set_geometric_factor(space_type="halfspace")
    return survey, np.asarray(dobs, dtype=float), np.asarray(standard_deviation, dtype=float)


def _write_simpeg_input_audit(
    output_dir: str | Path,
    datums: Sequence[Any],
    dobs: Sequence[float],
    standard_deviation: Sequence[float],
    *,
    data_type: str,
) -> dict[str, Any]:
    target_dir = Path(output_dir)
    csv_path = target_dir / "simpeg_input_abmn.csv"
    json_path = target_dir / "simpeg_input_summary.json"

    fieldnames = [
        "index",
        "array_name",
        "data_type",
        "ax",
        "az",
        "bx",
        "bz",
        "mx",
        "mz",
        "nx",
        "nz",
        "apparent_resistivity_ohm_m",
        "resistance_ohm",
        "geometric_factor_m",
        "dobs",
        "standard_deviation",
    ]
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for datum, observed, std in zip(datums, dobs, standard_deviation):
            writer.writerow(
                {
                    "index": datum.index,
                    "array_name": datum.array_name,
                    "data_type": data_type,
                    "ax": datum.ax,
                    "az": datum.az,
                    "bx": datum.bx,
                    "bz": datum.bz,
                    "mx": datum.mx,
                    "mz": datum.mz,
                    "nx": datum.nx,
                    "nz": datum.nz,
                    "apparent_resistivity_ohm_m": datum.apparent_resistivity,
                    "resistance_ohm": datum.resistance,
                    "geometric_factor_m": datum.geometric_factor,
                    "dobs": float(observed),
                    "standard_deviation": float(std),
                }
            )

    summary = {
        "format": "geoyun.simpeg.ert2d.input.v1",
        "csv": str(csv_path),
        "data_type": data_type,
        "observation_count": len(datums),
        "coordinate_columns": "2D SimPEG x,z electrode coordinates from RES2DINV ABMN",
        "dobs_units": "ohm-m" if data_type == "apparent_resistivity" else "volt/current resistance",
        "standard_deviation_units": "same as dobs",
    }
    json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"csv": str(csv_path), "summary": str(json_path), **summary}


def _build_tensor_mesh(datums: Sequence[Any], *, unit_spacing: float, terrain_points: list[tuple[float, float]]):
    import discretize
    import numpy as np

    x_values = np.asarray(
        [
            float(value)
            for datum in datums
            for value in (datum.ax, datum.bx, datum.mx, datum.nx)
            if value is not None and math.isfinite(float(value))
        ],
        dtype=float,
    )
    if x_values.size < 2:
        raise ValueError("SimPEG 反演至少需要两个有效电极坐标")

    min_x = float(x_values.min())
    max_x = float(x_values.max())
    line_span = max(max_x - min_x, float(unit_spacing or 1.0))
    dx = max(min(float(unit_spacing or 1.0), line_span / 35.0 if line_span > 0 else 10.0, 10.0), 1.0)
    depth = max(8.0 * dx, line_span * 0.35)
    padding = 10
    n_core_x = max(4, int(math.ceil(line_span / dx)) + 1)
    # Refined surface layer: top ~20% of the section uses dz/3 cells so the
    # Wenner short-spacing data can resolve near-surface contrasts. Below that,
    # cells coarsen back to dx for computational efficiency. Without this the
    # near-surface χ² typically saturates because the model can't represent
    # half-spacing-scale features.
    dz_fine = max(dx / 3.0, 1.0)
    n_fine = max(6, int(math.ceil((depth * 0.2) / dz_fine)))
    n_coarse = max(4, int(math.ceil((depth - n_fine * dz_fine) / dx)))
    hx = [(dx, padding, -1.35), (dx, n_core_x), (dx, padding, 1.35)]
    hz = [(dx, padding, -1.35), (dx, n_coarse), (dz_fine, n_fine)]
    x_origin = min_x - float(sum(discretize.utils.unpack_widths(hx[:1])))
    top_z = max((point[1] for point in terrain_points), default=0.0)
    z_origin = top_z - float(sum(discretize.utils.unpack_widths(hz)))
    return discretize.TensorMesh([hx, hz], origin=[x_origin, z_origin])


def _resistivity_bounds(datums: Sequence[Any]) -> tuple[float, float]:
    """Return (rho_lower, rho_upper) for ProjectedGNCG bounds.

    Apparent resistivity ρ_a is a *spatially smoothed* projection of the true
    subsurface ρ; the true model can contain values well outside the ρ_a range.
    Earlier we used [P2/4, P98×4] which on E-1.dat clamped to [7.95, 439] —
    pyGIMLi (no hard bounds) recovered down to 4.22 Ω·m, and SimPEG, unable to
    reach those low values, biased the entire model 1.5-2× high to compensate.
    Widen to ~1.5 decades each side of the ρ_a range so the optimizer has room
    to resolve real low-ρ targets (clay/water) and high-ρ targets (bedrock).
    """
    import numpy as np

    values = np.asarray(
        [float(item.apparent_resistivity) for item in datums if _finite_positive(item.apparent_resistivity)],
        dtype=float,
    )
    if values.size == 0:
        return 1.0, 10000.0
    low = float(np.nanpercentile(values, 2))
    high = float(np.nanpercentile(values, 98))
    lower = max(low / 30.0, 0.1)
    upper = max(high * 30.0, lower * 100.0)
    return lower, upper


def _mesh_edges(origin: float, widths: Iterable[float]) -> list[float]:
    edges = [float(origin)]
    for width in widths:
        edges.append(edges[-1] + float(width))
    return edges


def _build_simpeg_visualization(
    mesh: Any,
    resistivity: Any,
    viz_mask: Any,
    *,
    terrain_points: list[tuple[float, float]] | None = None,
):
    """Build cell-centred / node-centred points and a regular cell grid from
    a SimPEG inversion result, *without* writing or reading any VTK file.

    Returns
    -------
    preview_points : list[tuple[float, float, float]]
        (x_center, z_center, ρ) for each cell inside ``viz_mask``.
    mesh_node_points : list[tuple[float, float, float]]
        (x_node, z_node, ρ̄) where ρ̄ is the mean of surrounding viz cells —
        kept for backwards-compatible IDW renderers.
    cell_grid : dict
        Per-cell rectangles plus a tight outline polygon. The frontend can
        paint each cell directly (no IDW), giving an exact reproduction of the
        npz model.
    """
    import numpy as np

    n_cx, n_cz = (int(value) for value in mesh.shape_cells)
    hx = np.asarray(mesh.h[0], dtype=float)
    hz = np.asarray(mesh.h[1], dtype=float)
    x_origin = float(mesh.origin[0])
    z_origin = float(mesh.origin[1])

    x_edges = np.concatenate([[x_origin], x_origin + np.cumsum(hx)])
    z_edges = np.concatenate([[z_origin], z_origin + np.cumsum(hz)])
    x_centers = 0.5 * (x_edges[:-1] + x_edges[1:])
    z_centers = 0.5 * (z_edges[:-1] + z_edges[1:])

    rho = np.asarray(resistivity, dtype=float)
    mask = np.asarray(viz_mask, dtype=bool)
    rho_2d = rho.reshape((n_cx, n_cz), order="F")
    mask_2d = mask.reshape((n_cx, n_cz), order="F")

    cells: list[list[float]] = []
    preview_points: list[tuple[float, float, float]] = []
    for iz in range(n_cz):
        for ix in range(n_cx):
            if not mask_2d[ix, iz]:
                continue
            value = float(rho_2d[ix, iz])
            if not math.isfinite(value):
                continue
            x_left = float(x_edges[ix])
            x_right = float(x_edges[ix + 1])
            z_bot = float(z_edges[iz])
            z_top = float(z_edges[iz + 1])
            cx = float(x_centers[ix])
            cz = float(z_centers[iz])
            cells.append([x_left, z_bot, x_right - x_left, z_top - z_bot, value])
            preview_points.append((cx, cz, value))

    # Node points: average ρ from the (up to 4) surrounding viz cells. Kept
    # so any caller still using IDW (e.g. iteration snapshots) keeps working.
    n_nx, n_nz = n_cx + 1, n_cz + 1
    node_sum = np.zeros((n_nx, n_nz), dtype=float)
    node_count = np.zeros((n_nx, n_nz), dtype=float)
    for iz in range(n_cz):
        for ix in range(n_cx):
            if not mask_2d[ix, iz]:
                continue
            value = float(rho_2d[ix, iz])
            if not math.isfinite(value):
                continue
            for nx_off, nz_off in ((0, 0), (1, 0), (1, 1), (0, 1)):
                node_sum[ix + nx_off, iz + nz_off] += value
                node_count[ix + nx_off, iz + nz_off] += 1.0

    mesh_node_points: list[tuple[float, float, float]] = []
    for iz in range(n_nz):
        for ix in range(n_nx):
            count = node_count[ix, iz]
            if count <= 0:
                continue
            mesh_node_points.append(
                (
                    float(x_edges[ix]),
                    float(z_edges[iz]),
                    float(node_sum[ix, iz] / count),
                )
            )

    # Tight outline polygon for the visualisation region. Uses topography along
    # the top edge (so the frontend can clip the heatmap below terrain) and a
    # rectangular bottom along the deepest viz row.
    if cells:
        # Tight bounds = leftmost cell's x_left to rightmost cell's x_right.
        # Earlier we used `min(centers) ± hx[0]/2`, but `hx[0]` is the *leftmost
        # mesh cell's* width, which is the outermost padding cell expanded by
        # 1.35^9 ≈ 16× the core dx. That pushed the visualisation x-range out
        # by ~half a padding-cell width on each side (~100 m on E-1.dat) and
        # wasted ~40% of the chart area on empty padding.
        viz_x_min = min(c[0] for c in cells)
        viz_x_max = max(c[0] + c[2] for c in cells)
    else:
        viz_x_min, viz_x_max = float(x_edges[0]), float(x_edges[-1])
    surveyed_z = [c[1] for c in cells]
    viz_z_min = min(surveyed_z) if surveyed_z else float(z_edges[0])
    cell_z_max = max((c[1] + c[3] for c in cells), default=float(z_edges[-1]))
    if terrain_points:
        sorted_terrain = sorted(
            ((float(x), float(z)) for x, z in terrain_points),
            key=lambda pt: pt[0],
        )
        terrain_in_range = [pt for pt in sorted_terrain if viz_x_min <= pt[0] <= viz_x_max]
        if not terrain_in_range:
            terrain_in_range = sorted_terrain
        top_outline = terrain_in_range
        viz_z_max = max(
            [cell_z_max, *(float(z) for _, z in top_outline)],
        )
    else:
        z_top = float(z_edges[-1])
        top_outline = [(viz_x_min, z_top), (viz_x_max, z_top)]
        viz_z_max = max(cell_z_max, z_top)

    boundary: list[tuple[float, float]] = []
    boundary.append((viz_x_min, viz_z_min))
    boundary.append((viz_x_max, viz_z_min))
    for x, z in reversed(top_outline):
        boundary.append((float(x), float(z)))
    boundary.append((viz_x_min, viz_z_min))

    return preview_points, mesh_node_points, {
        "x_edges": [float(value) for value in x_edges],
        "z_edges": [float(value) for value in z_edges],
        "cells": cells,
        "n_x": n_cx,
        "n_z": n_cz,
        "boundary": boundary,
        "x_min": viz_x_min,
        "x_max": viz_x_max,
        "z_min": viz_z_min,
        "z_max": viz_z_max,
    }


def _build_simpeg_visualization_from_npz(
    npz_path: str | Path,
    *,
    terrain_points: list[tuple[float, float]] | None = None,
):
    """Build frontend display payload directly from the saved SimPEG npz."""
    import numpy as np
    from types import SimpleNamespace

    package = np.load(Path(npz_path))
    hx = np.asarray(package["mesh_hx"], dtype=float)
    hz = np.asarray(package["mesh_hz"], dtype=float)
    origin = np.asarray(package["mesh_origin"], dtype=float)
    resistivity = np.asarray(
        package["visualization_resistivity"]
        if "visualization_resistivity" in package.files
        else package["recovered_resistivity"],
        dtype=float,
    )
    if "visualization_mask" in package.files:
        viz_mask = np.asarray(package["visualization_mask"], dtype=bool)
    else:
        viz_mask = np.isfinite(resistivity)
    if terrain_points is None and "terrain_points" in package.files:
        terrain_array = np.asarray(package["terrain_points"], dtype=float)
        if terrain_array.ndim == 2 and terrain_array.shape[1] >= 2:
            terrain_points = [
                (float(row[0]), float(row[1]))
                for row in terrain_array
                if np.isfinite(row[0]) and np.isfinite(row[1])
            ]

    mesh = SimpleNamespace(
        h=(hx, hz),
        origin=origin,
        shape_cells=(int(hx.size), int(hz.size)),
    )
    return _build_simpeg_visualization(
        mesh,
        resistivity,
        viz_mask,
        terrain_points=terrain_points,
    )


def build_simpeg_preview_from_npz(
    npz_path: str | Path,
    *,
    terrain_points: list[tuple[float, float]] | None = None,
) -> dict[str, Any]:
    import numpy as np

    preview_points, mesh_node_points, simpeg_cell_grid = _build_simpeg_visualization_from_npz(
        npz_path,
        terrain_points=terrain_points,
    )
    payload: dict[str, Any] = {
        "preview_points": preview_points,
        "mesh_node_points": mesh_node_points,
        "surfer_preview_points": preview_points,
        "surfer_boundary_points": simpeg_cell_grid.get("boundary") or [],
        "simpeg_cell_grid": simpeg_cell_grid,
        "npz": str(npz_path),
    }

    package = np.load(Path(npz_path))
    if {"dobs", "dpred", "standard_deviation"}.issubset(set(package.files)):
        dobs = np.asarray(package["dobs"], dtype=float)
        dpred = np.asarray(package["dpred"], dtype=float)
        standard_deviation = np.asarray(package["standard_deviation"], dtype=float)
        if dobs.size and dobs.shape == dpred.shape:
            relative_residual = (dobs - dpred) / np.maximum(np.abs(dobs), 1e-12)
            normalized_residual = (dobs - dpred) / np.maximum(standard_deviation, 1e-12)
            payload["fit_comparison"] = {
                "obs": dobs.tolist(),
                "pred": dpred.tolist(),
                "misfit_pct": (relative_residual * 100.0).tolist(),
                "rms_pct": float(np.sqrt(np.mean(relative_residual**2)) * 100.0),
                "weighted_rms": float(np.sqrt(np.mean(normalized_residual**2))),
                "n": int(dobs.size),
                "unit": "ohm_m",
            }
    if "iteration" in package.files:
        payload["iteration"] = int(np.asarray(package["iteration"]).reshape(-1)[0])
    return payload


def _write_tensor_mesh_vtk(
    mesh: Any,
    resistivity: Sequence[float],
    output_path: str | Path,
    *,
    scalar_name: str = "Resistivity",
) -> str:
    import numpy as np
    import math

    values = np.asarray(resistivity, dtype=float)
    n_x, n_z = [int(value) for value in mesh.shape_cells]
    if values.size != n_x * n_z:
        raise ValueError("SimPEG 模型长度与网格单元数不一致")

    x_edges = _mesh_edges(mesh.origin[0], mesh.h[0])
    z_edges = _mesh_edges(mesh.origin[1], mesh.h[1])
    points = [(x, z, 0.0) for z in z_edges for x in x_edges]
    cells = []
    cell_values = []
    for iz in range(n_z):
        for ix in range(n_x):
            val = float(values[ix + n_x * iz])
            if not math.isfinite(val):
                continue
            p0 = iz * (n_x + 1) + ix
            p1 = p0 + 1
            p2 = p1 + (n_x + 1)
            p3 = p0 + (n_x + 1)
            cells.append((p0, p1, p2, p3))
            cell_values.append(val)

    lines = [
        "# vtk DataFile Version 3.0",
        "SimPEG ERT 2D inversion",
        "ASCII",
        "DATASET UNSTRUCTURED_GRID",
        f"POINTS {len(points)} float",
    ]
    lines.extend(f"{x:.12g} {y:.12g} {z:.12g}" for x, y, z in points)
    lines.append(f"CELLS {len(cells)} {len(cells) * 5}")
    lines.extend("4 " + " ".join(str(index) for index in cell) for cell in cells)
    lines.append(f"CELL_TYPES {len(cells)}")
    lines.extend("9" for _ in cells)
    lines.append(f"CELL_DATA {len(cells)}")
    lines.append(f"SCALARS {scalar_name} float 1")
    lines.append("LOOKUP_TABLE default")
    lines.extend(f"{value:.12g}" for value in cell_values)

    target = Path(output_path)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(target)


def run_simpeg_inversion(
    data_file_path: str,
    output_dir: str,
    z_weight: float = 0.2,
    max_iter: int = 20,
    lambda_param: int = 20,
    error: float = 0.03,
    terrain_file_path: str | None = None,
    solver_name: str = "auto",
    data_type: str = "apparent_resistivity",
) -> Dict[str, Any]:
    try:
        import numpy as np
        from simpeg import data, data_misfit, directives, inverse_problem, inversion, maps, optimization
        from simpeg.electromagnetics.static.resistivity import simulation_2d
        from simpeg.regularization import WeightedLeastSquares
    except ImportError as exc:
        raise RuntimeError("SimPEG 未安装，无法进行高密度电法二维反演计算。请确认后端 Python 环境已安装 simpeg。") from exc

    from .pygimli_ert import (
        _collect_result_files,
        _load_terrain_points,
    )
    from .res2dinv_to_simpeg import parse_res2dinv_dat

    if not os.path.exists(data_file_path):
        raise FileNotFoundError(f"数据文件不存在：{data_file_path}")

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    try:
        parsed = parse_res2dinv_dat(data_file_path, relative_error=max(float(error), 1e-4))
        terrain_points = _load_terrain_points(data_file_path, terrain_file_path)
        datums = _select_2d_datums(parsed.observations)
        if not datums:
            raise ValueError("数据文件没有可用于 SimPEG 反演的正值视电阻率观测")

        # Build the mesh and active-cell mask BEFORE the survey so that source/
        # receiver z-coordinates can be draped onto the active region's top edge.
        # Placing electrodes exactly at terrain elevation puts them on the
        # active/air interface where the nodal interpolation mixes σ≈1e-8 cells
        # into the source stencil and the forward problem becomes nearly
        # singular (we have observed predicted apparent resistivity in the
        # millions for a uniform halfspace test). See _drape_z_to_active_top.
        mesh = _build_tensor_mesh(datums, unit_spacing=parsed.unit_spacing, terrain_points=terrain_points)
        solver, resolved_solver_name = _get_solver(solver_name)

        from discretize.utils import active_from_xyz

        if terrain_points:
            # grid_reference="CC" marks a cell active when its CENTER is below
            # terrain. This gives a smoother active/air boundary than "N" and
            # lets the drape land each electrode on a node whose downward
            # stencil is fully active.
            active_cells = active_from_xyz(mesh, np.asarray(terrain_points), grid_reference="CC")
        else:
            active_cells = np.ones(mesh.nC, dtype=bool)

        survey, dobs, standard_deviation = _build_2d_survey(
            datums,
            data_type=data_type,
            relative_error=error,
            terrain_points=terrain_points,
            mesh=mesh if terrain_points else None,
            active_cells=active_cells if terrain_points else None,
        )
        input_audit = _write_simpeg_input_audit(
            output_path,
            datums,
            dobs,
            standard_deviation,
            data_type=data_type,
        )

        n_active = int(active_cells.sum())
        # Compose maps in *math* order: m_active → m_full (Inject) → σ_full (Exp).
        # SimPEG's `A * B` applies B first, so the outermost (last-applied) map is on the left.
        # Putting Inject on the left mistakenly treats σ as log-σ when filling air cells,
        # which yields negative "conductivity" of -18.4 S/m and breaks the forward pass.
        model_map = maps.ExpMap(mesh) * maps.InjectActiveCells(
            mesh, active_cells, np.log(1e-8)
        )
        
        simulation = simulation_2d.Simulation2DNodal(
            mesh,
            survey=survey,
            sigmaMap=model_map,
            solver=solver,
            storeJ=True,
        )
        dc_data = data.Data(survey=survey, dobs=dobs, standard_deviation=standard_deviation)
        misfit = data_misfit.L2DataMisfit(data=dc_data, simulation=simulation)
        regularization = WeightedLeastSquares(
            mesh,
            active_cells=active_cells,
            alpha_s=max(float(lambda_param), 1.0) * 1e-5,
            alpha_x=1.0,
            alpha_y=max(float(z_weight), 1e-4),
        )
        rho_lower, rho_upper = _resistivity_bounds(datums)
        opt = optimization.ProjectedGNCG(
            maxIter=max(int(max_iter), 1),
            maxIterLS=10,
            cg_maxiter=20,
            cg_atol=1e-3,
            cg_rtol=0.0,
            lower=np.log(1.0 / rho_upper),
            upper=np.log(1.0 / rho_lower),
        )
        inv_problem = inverse_problem.BaseInvProblem(misfit, regularization, opt)
        # Cool β every 2 iterations (was 1) and use a moderate β₀ ratio so the
        # optimizer has room to actually fit data before regularization dominates.
        # The previous schedule (factor=2, rate=1, β₀_ratio=lambda_param=20) shrank
        # β by 32k× over 15 iterations and stalled at χ²≈18; the slower cool lets
        # TargetMisfit(chifact=1.0) kick in near the right β.
        cooling_rate = max(2, int(round(max_iter / 6))) if int(max_iter) > 6 else 2

        # The iteration artifacts intentionally stay in SimPEG-native formats:
        # a compact npz plus a plain resistivity vector. The frontend receives a
        # cell grid derived in-memory, so intermediate results do not need VTK.
        survey_x_values = [
            float(getattr(d, attr))
            for d in datums
            for attr in ("ax", "bx", "mx", "nx")
            if getattr(d, attr, None) is not None and math.isfinite(float(getattr(d, attr)))
        ]
        survey_x_min = min(survey_x_values)
        survey_x_max = max(survey_x_values)
        max_array_span = max(
            (
                abs(float(getattr(d, "bx") or 0.0) - float(getattr(d, "ax") or 0.0))
                for d in datums
                if getattr(d, "ax", None) is not None and getattr(d, "bx", None) is not None
            ),
            default=float(parsed.unit_spacing or 1.0) * 30.0,
        )
        sensitivity_depth = max(max_array_span / 3.0, float(parsed.unit_spacing or 1.0) * 5.0)
        top_z = max((point[1] for point in terrain_points), default=0.0)
        clip_z_min = top_z - sensitivity_depth

        cell_centers_x = np.asarray(mesh.cell_centers[:, 0], dtype=float)
        cell_centers_z = np.asarray(mesh.cell_centers[:, 1], dtype=float)
        viz_mask = active_cells.copy()
        viz_mask &= cell_centers_x >= survey_x_min
        viz_mask &= cell_centers_x <= survey_x_max
        viz_mask &= cell_centers_z >= clip_z_min

        iteration_results: list[dict[str, Any]] = []
        saved_iteration_indices: set[int] = set()

        def save_simpeg_iteration_snapshot(iteration_index: int, active_model: Any) -> dict[str, Any] | None:
            if iteration_index in saved_iteration_indices:
                return None
            active_model_array = np.asarray(active_model, dtype=float)
            if active_model_array.size != n_active:
                return None

            full_sigma_iteration = np.asarray(model_map * active_model_array, dtype=float)
            resistivity_iteration = 1.0 / full_sigma_iteration
            resistivity_iteration[~active_cells] = np.nan

            viz_resistivity_iteration = resistivity_iteration.copy()
            viz_resistivity_iteration[~viz_mask] = np.nan
            predicted_iteration = np.asarray(simulation.dpred(active_model_array), dtype=float)
            relative_residual_iteration = (
                (dobs - predicted_iteration) / np.maximum(np.abs(dobs), 1e-12)
            )
            normalized_residual_iteration = (
                (dobs - predicted_iteration) / np.maximum(standard_deviation, 1e-12)
            )

            stem = f"iteration_{iteration_index:03d}"
            npz_path_iter = output_path / f"{stem}.npz"
            vector_path_iter = output_path / f"{stem}.vector"
            np.savez(
                npz_path_iter,
                mesh_hx=np.asarray(mesh.h[0], dtype=float),
                mesh_hz=np.asarray(mesh.h[1], dtype=float),
                mesh_origin=np.asarray(mesh.origin, dtype=float),
                recovered_log_sigma=active_model_array,
                recovered_resistivity=resistivity_iteration,
                visualization_resistivity=viz_resistivity_iteration,
                visualization_mask=viz_mask,
                terrain_points=np.asarray(terrain_points, dtype=float),
                dobs=dobs,
                dpred=predicted_iteration,
                standard_deviation=standard_deviation,
                iteration=int(iteration_index),
            )
            np.savetxt(vector_path_iter, resistivity_iteration)

            snapshot = build_simpeg_preview_from_npz(npz_path_iter)
            snapshot["vector"] = str(vector_path_iter)
            snapshot["fit_comparison"] = {
                "obs": dobs.tolist(),
                "pred": predicted_iteration.tolist(),
                "misfit_pct": (relative_residual_iteration * 100.0).tolist(),
                "rms_pct": float(np.sqrt(np.mean(relative_residual_iteration**2)) * 100.0),
                "weighted_rms": float(np.sqrt(np.mean(normalized_residual_iteration**2))),
                "n": int(dobs.size),
                "unit": "ohm_m",
            }
            saved_iteration_indices.add(iteration_index)
            return snapshot

        class SaveSimpegIterationSnapshot(directives.InversionDirective):
            def endIter(self):  # noqa: N802 - SimPEG directive hook name
                iteration_index = int(getattr(self.opt, "iter", len(iteration_results) + 1))
                snapshot = save_simpeg_iteration_snapshot(iteration_index, self.opt.xc)
                if snapshot is not None:
                    iteration_results.append(snapshot)
        inv = inversion.BaseInversion(
            inv_problem,
            directiveList=[
                directives.BetaEstimate_ByEig(beta0_ratio=1.0),
                directives.BetaSchedule(coolingFactor=2.0, coolingRate=cooling_rate),
                directives.TargetMisfit(chifact=1.0),
                SaveSimpegIterationSnapshot(),
            ],
        )

        background_rho = float(np.median([item.apparent_resistivity for item in datums]))
        starting_model = np.log(np.ones(n_active) / background_rho)
        recovered_log_sigma = inv.run(starting_model)
        
        # `model_map` already includes ExpMap, so the output is σ (S/m), not log-σ.
        full_sigma = np.asarray(model_map * recovered_log_sigma, dtype=float)
        recovered_resistivity = 1.0 / full_sigma
        recovered_resistivity[~active_cells] = np.nan

        # Restrict the *visualisation* mask to the survey sensitivity zone:
        # horizontally to the actual electrode footprint and vertically to the
        # depth a Wenner array can resolve (~ max array span / 3). Without
        # this clip, ~80% of the TensorMesh cells (deep + lateral padding)
        # are locked at the starting background by the inversion (no data
        # sensitivity), and the frontend IDW interpolation gets dominated by
        # those background-valued cells — every pixel is rendered as the
        # bottom of the colorbar even though the survey-area cells contain
        # the real ρ contrasts. The mask is *only* applied to VTK / preview /
        # Surfer outputs; the npz keeps the full inversion result.
        survey_x_values = [
            float(getattr(d, attr))
            for d in datums
            for attr in ("ax", "bx", "mx", "nx")
            if getattr(d, attr, None) is not None and math.isfinite(float(getattr(d, attr)))
        ]
        survey_x_min = min(survey_x_values)
        survey_x_max = max(survey_x_values)
        max_array_span = max(
            (
                abs(float(getattr(d, "bx") or 0.0) - float(getattr(d, "ax") or 0.0))
                for d in datums
                if getattr(d, "ax", None) is not None and getattr(d, "bx", None) is not None
            ),
            default=float(parsed.unit_spacing or 1.0) * 30.0,
        )
        sensitivity_depth = max(max_array_span / 3.0, float(parsed.unit_spacing or 1.0) * 5.0)
        top_z = max((point[1] for point in terrain_points), default=0.0)
        clip_z_min = top_z - sensitivity_depth

        cell_centers_x = np.asarray(mesh.cell_centers[:, 0], dtype=float)
        cell_centers_z = np.asarray(mesh.cell_centers[:, 1], dtype=float)
        viz_mask = active_cells.copy()
        viz_mask &= cell_centers_x >= survey_x_min
        viz_mask &= cell_centers_x <= survey_x_max
        viz_mask &= cell_centers_z >= clip_z_min

        viz_resistivity = recovered_resistivity.copy()
        viz_resistivity[~viz_mask] = np.nan
        
        predicted = simulation.dpred(recovered_log_sigma)
        normalized_residual = (dobs - predicted) / standard_deviation
        relative_residual = (dobs - predicted) / np.maximum(np.abs(dobs), 1e-12)

        npz_path = output_path / "simpeg_ert_inversion.npz"
        vector_path = output_path / "resistivity.vector"
        summary_path = output_path / "summary.json"
        np.savez(
            npz_path,
            mesh_hx=np.asarray(mesh.h[0], dtype=float),
            mesh_hz=np.asarray(mesh.h[1], dtype=float),
            mesh_origin=np.asarray(mesh.origin, dtype=float),
            recovered_log_sigma=recovered_log_sigma,
            recovered_resistivity=recovered_resistivity,
            visualization_resistivity=viz_resistivity,
            visualization_mask=viz_mask,
            terrain_points=np.asarray(terrain_points, dtype=float),
            dobs=dobs,
            dpred=predicted,
            standard_deviation=standard_deviation,
        )
        np.savetxt(vector_path, recovered_resistivity)

        # Build cell-centred preview / node points and a regular-grid raster
        # directly from the saved npz. The frontend can paint each cell as one
        # rectangle, no VTK roundtrip, no IDW interpolation, no padding-cell
        # dilution.
        preview_points_npz, mesh_node_points_npz, simpeg_cell_grid = _build_simpeg_visualization_from_npz(
            npz_path, terrain_points=terrain_points
        )
        surfer_outputs = {}
        surfer_outputs["preview_points"] = preview_points_npz
        surfer_outputs["mesh_node_points"] = mesh_node_points_npz
        surfer_outputs["surfer_preview_points"] = preview_points_npz
        surfer_outputs["surfer_boundary_points"] = simpeg_cell_grid["boundary"]
        surfer_outputs["simpeg_cell_grid"] = simpeg_cell_grid

        phi_d = float(misfit(recovered_log_sigma))
        normalized_rms = float(np.sqrt(np.mean(normalized_residual**2)))
        relative_rrms_percent = float(np.sqrt(np.mean(relative_residual**2)) * 100.0)
        mean_absolute_percent_error = float(np.mean(np.abs(relative_residual)) * 100.0)
        summary = {
            "backend": "simpeg",
            "input_format": "RES2DINV DAT -> SimPEG 2D DC apparent_resistivity survey",
            "input_audit_csv": input_audit["csv"],
            "input_audit_summary": input_audit["summary"],
            "array_name": parsed.array_name,
            "source_data_count": parsed.data_count,
            "used_data_count": int(survey.nD),
            "source_count": int(survey.nSrc),
            "mesh_cells": int(mesh.nC),
            "mesh_shape": list(mesh.shape_cells),
            "mesh_origin": [float(value) for value in mesh.origin],
            "solver": resolved_solver_name,
            "background_resistivity_ohm_m": background_rho,
            "resistivity_lower_bound_ohm_m": rho_lower,
            "resistivity_upper_bound_ohm_m": rho_upper,
            "phi_d": phi_d,
            "target_phi_d": float(survey.nD),
            "normalized_residual_rms": normalized_rms,
            "weighted_rms": normalized_rms,
            "relative_rrms_percent": relative_rrms_percent,
            "mean_absolute_percent_error": mean_absolute_percent_error,
            "resistivity_min_ohm_m": float(np.nanmin(recovered_resistivity)),
            "resistivity_median_ohm_m": float(np.nanmedian(recovered_resistivity)),
            "resistivity_max_ohm_m": float(np.nanmax(recovered_resistivity)),
            "output_npz": str(npz_path),
        }
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

        files = _collect_result_files(output_path, output_path / "resistivity")
        for extra_path in (npz_path, summary_path, Path(input_audit["csv"]), Path(input_audit["summary"])):
            if str(extra_path) not in files:
                files.append(str(extra_path))
        for iteration_result in iteration_results:
            for key in ("npz", "vector"):
                iteration_path = iteration_result.get(key)
                if iteration_path and iteration_path not in files:
                    files.append(iteration_path)

        relative_misfit_pct = (relative_residual * 100.0).tolist()

        return {
            "status": "success",
            "backend": "simpeg",
            "chi2": phi_d / max(float(survey.nD), 1.0),
            "rrms": relative_rrms_percent,
            "weighted_rms": normalized_rms,
            "mean_absolute_percent_error": mean_absolute_percent_error,
            "fit_comparison": {
                "obs": dobs.tolist(),
                "pred": predicted.tolist(),
                "misfit_pct": relative_misfit_pct,
                "rms_pct": relative_rrms_percent,
                "n": int(survey.nD),
                "unit": "ohm_m",
            },
            "output_dir": str(output_path),
            "terrain_used": bool(terrain_points),
            "terrain_point_count": len(terrain_points),
            "summary": summary,
            "surfer_grid": surfer_outputs.get("grid"),
            "surfer_auxiliary_files": surfer_outputs.get("auxiliary_files") or [],
            "surfer_macro_script": surfer_outputs.get("script"),
            "surfer_readme": surfer_outputs.get("readme"),
            "surfer_macro_error": surfer_outputs.get("macro_error"),
            "preview_points": surfer_outputs.get("preview_points") or [],
            "mesh_node_points": surfer_outputs.get("mesh_node_points") or [],
            "surfer_preview_points": surfer_outputs.get("surfer_preview_points") or [],
            "surfer_boundary_points": surfer_outputs.get("surfer_boundary_points") or [],
            # Direct-from-npz cell raster: one entry per visualisation cell as
            # [x_left, z_bottom, dx, dz, rho]. Frontend should prefer this for
            # SimPEG results — paint each cell as its own rectangle (no IDW).
            "simpeg_cell_grid": surfer_outputs.get("simpeg_cell_grid"),
            "iteration_results": iteration_results,
            "iteration_result_count": len(iteration_results),
            "files": files,
        }
    except Exception as exc:
        logger.exception("SimPEG ERT inversion failed")
        raise RuntimeError(f"SimPEG 反演失败：{exc}") from exc
