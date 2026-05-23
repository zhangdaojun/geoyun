from __future__ import annotations

import logging
import math
import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

logger = logging.getLogger(__name__)

TerrainPoint = tuple[float, float]

ERT_RESULT_SUFFIXES = {
    ".bln",
    ".bmat",
    ".bms",
    ".clr",
    ".dat",
    ".grd",
    ".pdf",
    ".bas",
    ".srf",
    ".vec",
    ".vector",
    ".vtk",
    ".xyz",
    ".npz",
}


def _build_pygimli_fit_comparison(manager, data) -> dict[str, Any] | None:
    """Extract observed vs predicted apparent resistivity for the fit chart.

    Returns None if arrays cannot be aligned. `manager.inv.response` is the
    forward response in the data-vector space; for ERTManager defaulting to
    apparent resistivity, this is rhoa. We fall back to multiplying by the
    geometric factor `k` when the response magnitudes look like resistance.
    """
    try:
        obs = [float(v) for v in data("rhoa")]
        response = list(manager.inv.response)
        pred = [float(v) for v in response]
        n = min(len(obs), len(pred))
        if n == 0:
            return None
        obs = obs[:n]
        pred = pred[:n]

        # Heuristic: if predicted magnitudes are far below observed, response
        # is likely resistance and needs k to become apparent resistivity.
        obs_med = sorted(v for v in obs if math.isfinite(v) and v > 0)
        pred_med = sorted(v for v in pred if math.isfinite(v) and v > 0)
        if obs_med and pred_med:
            o_mid = obs_med[len(obs_med) // 2]
            p_mid = pred_med[len(pred_med) // 2]
            if p_mid > 0 and (o_mid / p_mid > 10 or p_mid / o_mid > 10) and data.haveData("k"):
                k_values = [float(v) for v in data("k")]
                pred = [pred[i] * k_values[i] for i in range(n)]

        misfit_pct = []
        sq_sum = 0.0
        sq_count = 0
        for o, p in zip(obs, pred):
            if math.isfinite(o) and math.isfinite(p) and abs(o) > 1e-12:
                rel = (p - o) / o * 100.0
                misfit_pct.append(rel)
                sq_sum += rel * rel
                sq_count += 1
            else:
                misfit_pct.append(0.0)
        rms_pct = math.sqrt(sq_sum / sq_count) if sq_count else 0.0

        return {
            "obs": obs,
            "pred": pred,
            "misfit_pct": misfit_pct,
            "rms_pct": rms_pct,
            "n": n,
            "unit": "ohm_m",
        }
    except Exception as exc:  # noqa: BLE001
        logger.info("Unable to build pyGIMLi fit comparison: %s", exc)
        return None


def _finite_positive_values(values) -> list[float]:
    output = []
    for value in values:
        number = float(value)
        if math.isfinite(number) and number > 0:
            output.append(number)
    return output


def _has_valid_rhoa(data) -> bool:
    if not data.haveData("rhoa"):
        return False
    return len(_finite_positive_values(data("rhoa"))) == int(data.size())


def _sync_resistance_with_rhoa_and_k(data) -> None:
    if not data.haveData("rhoa") or not data.haveData("k"):
        return
    resistance_values = []
    for rhoa, factor in zip(data("rhoa"), data("k")):
        rhoa_value = float(rhoa)
        factor_value = float(factor)
        if not math.isfinite(rhoa_value) or not math.isfinite(factor_value) or abs(factor_value) < 1e-12:
            resistance_values.append(0.0)
        else:
            resistance_values.append(rhoa_value / factor_value)
    if len(resistance_values) == int(data.size()):
        data.set("r", resistance_values)


def _set_geometric_factors(data) -> bool:
    success = False
    try:
        if hasattr(data, "createGeometricFactors"):
            data.set("k", data.createGeometricFactors())
        else:
            from pygimli.physics import ert

            data.set("k", ert.createGeometricFactors(data))
        success = True
    except Exception:
        success = False
    _sync_resistance_with_rhoa_and_k(data)
    return success


def _numbers(line: str) -> list[float]:
    pattern = r"[-+]?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?"
    normalized = str(line or "").replace(",", " ")
    return [float(item) for item in re.findall(pattern, normalized)]


def _first_int(line: str) -> Optional[int]:
    values = _numbers(line)
    if not values:
        return None
    value = values[0]
    if not math.isfinite(value):
        return None
    return int(value)


def _read_nonempty_lines(path: str | Path) -> list[str]:
    text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    return [line.strip() for line in text.splitlines() if line.strip()]


def _collect_result_files(output_dir: str | Path, out_prefix: str | Path) -> list[str]:
    candidates: list[Path] = []
    prefix_path = Path(out_prefix)

    for suffix in (".vtk", ".xyz", ".bmat", ".vec", ".vector", ".bms", ".pdf", ".grd", ".bln", ".clr", ".bas", ".srf"):
        candidates.append(prefix_path.with_suffix(suffix))

    search_roots = []
    if prefix_path.is_dir():
        search_roots.append(prefix_path)
    output_path = Path(output_dir)
    if output_path.is_dir() and output_path not in search_roots:
        search_roots.append(output_path)

    for root in search_roots:
        candidates.extend(
            path
            for path in root.rglob("*")
            if path.is_file() and path.suffix.lower() in ERT_RESULT_SUFFIXES
        )

    output = []
    seen = set()
    for path in candidates:
        resolved = path.resolve()
        if not resolved.is_file() or resolved in seen:
            continue
        seen.add(resolved)
        output.append(str(resolved))
    return output


def _tokenize_ascii_vtk(path: str | Path) -> list[str]:
    return Path(path).read_text(encoding="utf-8", errors="replace").split()


def _read_vtk_section_values(tokens: list[str], start_index: int, count: int) -> tuple[list[float], int]:
    values: list[float] = []
    index = start_index
    while index < len(tokens) and len(values) < count:
        values.append(float(tokens[index]))
        index += 1
    if len(values) != count:
        raise ValueError("VTK section ended before all numeric values were read")
    return values, index


def _extract_vtk_points_cells_and_resistivity(
    vtk_path: str | Path,
) -> tuple[list[tuple[float, float, float]], list[list[int]], list[float]]:
    tokens = _tokenize_ascii_vtk(vtk_path)

    points_index = tokens.index("POINTS")
    point_count = int(tokens[points_index + 1])
    point_values, next_index = _read_vtk_section_values(tokens, points_index + 3, point_count * 3)
    points = [
        (point_values[index], point_values[index + 1], point_values[index + 2])
        for index in range(0, len(point_values), 3)
    ]

    cells_index = tokens.index("CELLS", next_index)
    cell_count = int(tokens[cells_index + 1])
    cells = []
    index = cells_index + 3
    for _ in range(cell_count):
        vertex_count = int(tokens[index])
        index += 1
        cell = [int(tokens[index + offset]) for offset in range(vertex_count)]
        index += vertex_count
        cells.append(cell)

    scalar_index = None
    for index in range(0, len(tokens) - 2):
        if tokens[index] == "SCALARS" and tokens[index + 1] == "Resistivity":
            scalar_index = index
            break
    if scalar_index is None:
        raise ValueError("VTK file does not contain a Resistivity scalar field")

    lookup_index = tokens.index("LOOKUP_TABLE", scalar_index)
    resistivity_values, _ = _read_vtk_section_values(tokens, lookup_index + 2, cell_count)
    return points, cells, resistivity_values


def _extract_vtk_cell_resistivity_points(vtk_path: str | Path) -> list[tuple[float, float, float]]:
    points, cells, resistivity_values = _extract_vtk_points_cells_and_resistivity(vtk_path)

    output = []
    for cell, resistivity in zip(cells, resistivity_values):
        vertices = [points[point_index] for point_index in cell if 0 <= point_index < len(points)]
        if not vertices:
            continue
        x = sum(vertex[0] for vertex in vertices) / len(vertices)
        y = sum(vertex[1] for vertex in vertices) / len(vertices)
        value = float(resistivity)
        if math.isfinite(x) and math.isfinite(y) and math.isfinite(value):
            output.append((x, y, value))
    return output


def _extract_vtk_polygon_mesh(vtk_path: str | Path) -> dict[str, Any] | None:
    points, cells, resistivity_values = _extract_vtk_points_cells_and_resistivity(vtk_path)

    mesh_cells: list[dict[str, Any]] = []
    for cell, resistivity in zip(cells, resistivity_values):
        value = float(resistivity)
        vertices = [points[point_index] for point_index in cell if 0 <= point_index < len(points)]
        polygon = [
            [float(vertex[0]), float(vertex[1])]
            for vertex in vertices
            if math.isfinite(float(vertex[0])) and math.isfinite(float(vertex[1]))
        ]
        if len(polygon) >= 3 and math.isfinite(value) and value > 0:
            mesh_cells.append({"points": polygon, "rho": value})

    if not mesh_cells:
        return None
    x_values = [point[0] for cell in mesh_cells for point in cell["points"]]
    y_values = [point[1] for cell in mesh_cells for point in cell["points"]]
    return {
        "cells": mesh_cells,
        "bounds": {
            "xMin": min(x_values),
            "xMax": max(x_values),
            "yMin": min(y_values),
            "yMax": max(y_values),
        },
    }


def _extract_vtk_node_resistivity_points(vtk_path: str | Path) -> list[tuple[float, float, float]]:
    points, cells, resistivity_values = _extract_vtk_points_cells_and_resistivity(vtk_path)

    accum: dict[int, list[float]] = {}
    for cell, resistivity in zip(cells, resistivity_values):
        value = float(resistivity)
        if not math.isfinite(value):
            continue
        for point_index in cell:
            if 0 <= point_index < len(points):
                bucket = accum.setdefault(point_index, [0.0, 0.0])
                bucket[0] += value
                bucket[1] += 1.0

    output = []
    for point_index, (total, count) in accum.items():
        if count <= 0:
            continue
        x, y, _ = points[point_index]
        value = total / count
        if math.isfinite(x) and math.isfinite(y) and math.isfinite(value):
            output.append((x, y, value))
    output.sort(key=lambda point: (point[1], point[0]))
    return output


def _build_outer_boundary(points: list[tuple[float, float, float]], cells: list[list[int]]) -> list[tuple[float, float]]:
    edge_counts: dict[tuple[int, int], int] = {}
    for cell in cells:
        if len(cell) < 2:
            continue
        for index, start in enumerate(cell):
            end = cell[(index + 1) % len(cell)]
            key = tuple(sorted((start, end)))
            edge_counts[key] = edge_counts.get(key, 0) + 1

    adjacency: dict[int, list[int]] = {}
    for (start, end), count in edge_counts.items():
        if count != 1:
            continue
        adjacency.setdefault(start, []).append(end)
        adjacency.setdefault(end, []).append(start)

    if not adjacency:
        return []

    start_vertex = min(adjacency, key=lambda vertex: (points[vertex][0], points[vertex][1]))
    polygon = [start_vertex]
    previous = None
    current = start_vertex
    for _ in range(len(adjacency) + 5):
        neighbors = adjacency.get(current, [])
        candidates = [neighbor for neighbor in neighbors if neighbor != previous]
        if not candidates:
            break
        next_vertex = candidates[0]
        if next_vertex == start_vertex:
            polygon.append(start_vertex)
            break
        polygon.append(next_vertex)
        previous, current = current, next_vertex

    if polygon[-1] != polygon[0]:
        polygon.append(polygon[0])

    return [(points[vertex][0], points[vertex][1]) for vertex in polygon]


def _write_surfer_boundary_bln(output_path: str | Path, boundary: list[tuple[float, float]]) -> str:
    if len(boundary) < 4:
        raise ValueError("At least four closed boundary points are required to create a Surfer BLN")

    lines = [f'{len(boundary)},0,"ERT inversion boundary"']
    lines.extend(f"{x:.12g},{y:.12g}" for x, y in boundary)
    target = Path(output_path)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(target)


def _read_surfer_boundary_bln(path: str | Path) -> list[tuple[float, float]]:
    source = Path(path)
    if not source.is_file():
        return []
    lines = [line.strip() for line in source.read_text(encoding="utf-8-sig", errors="replace").splitlines() if line.strip()]
    if len(lines) < 3:
        return []
    point_count = _first_int(lines[0]) or 0
    points: list[tuple[float, float]] = []
    for line in lines[1 : 1 + point_count]:
        values = _numbers(line)
        if len(values) >= 2 and math.isfinite(values[0]) and math.isfinite(values[1]):
            points.append((values[0], values[1]))
    return points


def _write_surfer_resistivity_color_spectrum(output_path: str | Path) -> str:
    colors = [
        (0, 0, 139),
        (0, 0, 255),
        (0, 255, 255),
        (0, 255, 0),
        (255, 255, 0),
        (255, 140, 0),
        (255, 0, 0),
        (139, 0, 0),
    ]
    step = 100.0 / max(len(colors) - 1, 1)
    lines = ["ColorMap 1 1"]
    lines.extend(
        f"{index * step:.12g} {red} {green} {blue}"
        for index, (red, green, blue) in enumerate(colors)
    )
    target = Path(output_path)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(target)


def _surfer_output_paths(vtk_path: str | Path) -> dict[str, Path]:
    source = Path(vtk_path)
    stem = source.stem
    if stem == "resistivity":
        return {
            "grid": source.with_name("resistivity_surfer.grd"),
            "boundary": source.with_name("resistivity_boundary.bln"),
            "color": source.with_name("resistivity_rainbow.clr"),
            "blanked_grid": source.with_name("resistivity_surfer_blanked.grd"),
            "srf": source.with_name("resistivity_surfer.srf"),
            "script": source.with_name("resistivity_surfer_export.bas"),
            "readme": source.with_name("README_Surfer.txt"),
        }
    return {
        "grid": source.with_name(f"{stem}_surfer.grd"),
        "boundary": source.with_name(f"{stem}_boundary.bln"),
        "color": source.with_name(f"{stem}_rainbow.clr"),
        "blanked_grid": source.with_name(f"{stem}_surfer_blanked.grd"),
        "srf": source.with_name(f"{stem}_surfer.srf"),
        "script": source.with_name(f"{stem}_surfer_export.bas"),
        "readme": source.with_name(f"{stem}_README_Surfer.txt"),
    }


def _surfer_string(value: str | Path) -> str:
    return str(value).replace('"', '""')


_SURFER_README_TEMPLATE = """ERT 二维反演 - Surfer 出图说明
================================

本目录包含以下与 Surfer 相关的文件：

  {grid_name}                 反演结果 ASCII 网格（电阻率）
  {boundary_name}             反演域外轮廓（用于裁剪）
  {color_name}                推荐色标
  {script_name}               Surfer Scripter 自动出图宏（VBA）
  resistivity.vtk             原始 VTK 网格（可在 ParaView / VisIt 直接打开）

【一键出图（推荐）】
  1. 启动 Golden Software Surfer（任意支持 Scripter 的版本均可）。
  2. 打开 Scripter（菜单：工具 → Scripter，或直接双击 {script_name}）。
  3. 在 Scripter 中按 F5（或菜单 Script → Run）执行宏。
  4. 几秒后会在本目录生成 {srf_name}（工程文件）和
     {blanked_name}（按外轮廓裁剪后的网格）。
  5. 双击 {srf_name} 即可查看带边界裁剪的彩色等值图。

【手动操作】
  - 新建 → 网格图 → 选择 {grid_name}
  - 网格 → 数据空白化（GridAssignNoData 或 GridBlank）→
    选择 {boundary_name} 作为裁剪边界
  - 颜色映射加载 {color_name}

【无 Surfer 时的替代】
  使用 ParaView / VisIt 直接打开 resistivity.vtk，
  或在云端结果页查看自动生成的剖面图预览。
"""


def _write_surfer_readme(readme_path: str | Path, paths: dict[str, Path]) -> str:
    target = Path(readme_path)
    content = _SURFER_README_TEMPLATE.format(
        grid_name=paths["grid"].name,
        boundary_name=paths["boundary"].name,
        color_name=paths["color"].name,
        script_name=paths["script"].name,
        srf_name=paths["srf"].name,
        blanked_name=paths["blanked_grid"].name,
    )
    target.write_text(content, encoding="utf-8")
    return str(target)


def _write_surfer_srf_script(
    script_path: str | Path,
    grid_path: str | Path,
    boundary_path: str | Path,
    color_path: str | Path,
    blanked_grid_path: str | Path,
    srf_path: str | Path,
) -> str:
    script = f'''Sub Main
    On Error GoTo AutomationError

    Dim SurferApp As Object
    Set SurferApp = CreateObject("Surfer.Application")
    SurferApp.Visible = False

    Dim InGrid As String
    Dim BoundaryFile As String
    Dim ColorFile As String
    Dim BlankedGrid As String
    Dim OutSrf As String

    InGrid = "{_surfer_string(grid_path)}"
    BoundaryFile = "{_surfer_string(boundary_path)}"
    ColorFile = "{_surfer_string(color_path)}"
    BlankedGrid = "{_surfer_string(blanked_grid_path)}"
    OutSrf = "{_surfer_string(srf_path)}"

    ' Try GridAssignNoData first (Surfer 16+), fallback to GridBlank (Surfer 15-)
    On Error Resume Next
    SurferApp.GridAssignNoData InGrid, BoundaryFile, BlankedGrid
    If Err.Number <> 0 Then
        Err.Clear
        SurferApp.GridBlank InGrid, BoundaryFile, BlankedGrid
    End If
    On Error GoTo AutomationError

    Dim Plot As Object
    Set Plot = SurferApp.Documents.Add

    Dim MapFrame As Object
    Set MapFrame = Plot.Shapes.AddColorReliefMap(BlankedGrid)

    Dim ColorLayer As Object
    Set ColorLayer = MapFrame.Overlays(1)
    
    ' 2 = srfTerrainRepresentationColorOnly
    ColorLayer.TerrainRepresentation = 2
    ColorLayer.ColorMap.LoadFile ColorFile
    ColorLayer.ShowColorScale = True
    
    ' Try newer RGBA first, fallback to older MissingDataColor
    On Error Resume Next
    ' 15 = srfColorWhite
    ColorLayer.MissingDataColorRGBA.Color = 15
    ColorLayer.MissingDataColorRGBA.Opacity = 0
    If Err.Number <> 0 Then
        Err.Clear
        ColorLayer.MissingDataColor = 15
    End If
    On Error GoTo AutomationError

    Plot.SaveAs OutSrf
    ' 2 = srfSaveChangesNo
    Plot.Close 2
    SurferApp.Quit
    Exit Sub

AutomationError:
    ' We suppress MsgBox so it doesn't block the backend process, just quit
    SurferApp.Quit
End Sub
'''
    target = Path(script_path)
    target.write_text(script, encoding="utf-8")
    return str(target)


def _create_surfer_export_macro(
    grid_path: str | Path,
    boundary_path: str | Path,
    color_path: str | Path,
) -> dict[str, str | None]:
    """Write the Surfer Scripter macro (.bas) and a README; do not execute Surfer.

    The macro is meant to be run by the end user inside Surfer Scripter on their
    own machine. The backend never invokes Surfer, so this works on any OS.
    """
    grid = Path(grid_path)
    boundary = Path(boundary_path)
    color = Path(color_path)
    if not grid.is_file() or not boundary.is_file() or not color.is_file():
        return {"script": None, "readme": None, "error": "Missing Surfer input files"}

    if grid.name == "resistivity_surfer.grd":
        paths = _surfer_output_paths(grid.with_name("resistivity.vtk"))
    else:
        stem = grid.stem.removesuffix("_surfer")
        paths = _surfer_output_paths(grid.with_name(f"{stem}.vtk"))
    blanked_grid = paths["blanked_grid"]
    srf = paths["srf"]
    script = paths["script"]
    readme = paths["readme"]
    _write_surfer_srf_script(script, grid, boundary, color, blanked_grid, srf)
    _write_surfer_readme(readme, paths)
    return {"script": str(script), "readme": str(readme), "error": None}


def _create_surfer_auxiliary_files_from_vtk(vtk_path: str | Path) -> list[str]:
    source = Path(vtk_path)
    if not source.is_file():
        return []
    points, cells, _ = _extract_vtk_points_cells_and_resistivity(source)
    output_paths = _surfer_output_paths(source)
    output_files = []

    boundary = _build_outer_boundary(points, cells)
    if boundary:
        output_files.append(_write_surfer_boundary_bln(output_paths["boundary"], boundary))

    output_files.append(
        _write_surfer_resistivity_color_spectrum(output_paths["color"])
    )
    return output_files


def _create_surfer_outputs_from_vtk(vtk_path: str | Path, **_legacy_kwargs: Any) -> dict[str, Any]:
    """Create grid + boundary + color + Scripter macro + README for Surfer.

    The Surfer Scripter (`Scripter.exe`) is intentionally NOT invoked by the
    backend. Users run the generated `.bas` macro inside Surfer themselves to
    produce the `.srf` file. This keeps the pipeline cross-platform.
    """
    grid_path = _create_surfer_grid_from_vtk(vtk_path)
    auxiliary_paths = _create_surfer_auxiliary_files_from_vtk(vtk_path)
    boundary_path = next((path for path in auxiliary_paths if path.lower().endswith(".bln")), None)
    color_path = next((path for path in auxiliary_paths if path.lower().endswith(".clr")), None)
    macro_result = (
        _create_surfer_export_macro(grid_path, boundary_path, color_path)
        if grid_path and boundary_path and color_path
        else {"script": None, "readme": None, "error": "Missing Surfer auxiliary files"}
    )
    return {
        "grid": grid_path,
        "auxiliary_files": auxiliary_paths,
        "script": macro_result.get("script"),
        "readme": macro_result.get("readme"),
        "macro_error": macro_result.get("error"),
    }


def _save_iteration_model_snapshot(
    manager: Any,
    model: Any,
    iterations_dir: str | Path,
    iteration_index: int,
) -> dict[str, Any] | None:
    try:
        import numpy as np
        import pygimli as pg

        values = np.asarray(model, dtype=float)
        if values.size <= 0:
            return None

        target_dir = Path(iterations_dir)
        target_dir.mkdir(parents=True, exist_ok=True)
        stem = f"iteration_{int(iteration_index):03d}"
        vector_path = target_dir / f"{stem}.vector"
        vtk_path = target_dir / f"{stem}.vtk"
        np.savetxt(vector_path, values)

        mesh = pg.Mesh(manager.paraDomain)
        if mesh.cellCount() != values.size:
            logger.info(
                "Skipping ERT iteration %s snapshot: model length %s does not match mesh cell count %s.",
                iteration_index,
                values.size,
                mesh.cellCount(),
            )
            return None

        mesh["Resistivity"] = values
        positive_values = np.where(values > 0, values, np.nan)
        mesh["Resistivity (log10)"] = np.log10(positive_values)
        mesh.exportVTK(str(vtk_path))

        surfer_outputs = _create_surfer_outputs_from_vtk(vtk_path)
        surfer_preview_points = _read_surfer_ascii_grid_points(surfer_outputs.get("grid") or "")
        surfer_boundary_points = _read_surfer_boundary_bln(
            next(
                (path for path in surfer_outputs.get("auxiliary_files") or [] if str(path).lower().endswith(".bln")),
                "",
            )
        )
        return {
            "iteration": int(iteration_index),
            "vector": str(vector_path),
            "vtk": str(vtk_path),
            "vtk_mesh": _extract_vtk_polygon_mesh(vtk_path),
            "preview_points": _extract_vtk_cell_resistivity_points(vtk_path),
            "mesh_node_points": _extract_vtk_node_resistivity_points(vtk_path),
            "surfer_preview_points": surfer_preview_points,
            "surfer_boundary_points": surfer_boundary_points,
            "surfer_grid": surfer_outputs.get("grid"),
            "surfer_auxiliary_files": surfer_outputs.get("auxiliary_files") or [],
            "surfer_macro_script": surfer_outputs.get("script"),
            "surfer_readme": surfer_outputs.get("readme"),
        }
    except Exception as exc:
        logger.info("Unable to save ERT iteration %s snapshot: %s", iteration_index, exc)
        return None


def _surfer_grid_size(x_span: float, y_span: float, target_x_count: int = 220) -> tuple[int, int]:
    x_count = max(40, min(241, target_x_count))
    cell_size = x_span / max(x_count - 1, 1)
    y_count = int(round(y_span / max(cell_size, 1e-9))) + 1
    if y_count > 181:
        y_count = 181
        cell_size = y_span / max(y_count - 1, 1)
        x_count = int(round(x_span / max(cell_size, 1e-9))) + 1
    return max(2, x_count), max(2, y_count)


def _idw_value(x: float, y: float, samples: list[tuple[float, float, float]], nearest_count: int = 12) -> float:
    nearest = sorted(
        ((sample_x - x) ** 2 + (sample_y - y) ** 2, value) for sample_x, sample_y, value in samples
    )[:nearest_count]
    if nearest and nearest[0][0] < 1e-18:
        return nearest[0][1]
    weighted_sum = 0.0
    total_weight = 0.0
    for distance_squared, value in nearest:
        weight = 1.0 / max(distance_squared, 1e-18)
        weighted_sum += value * weight
        total_weight += weight
    return weighted_sum / total_weight if total_weight else float("nan")


def _write_surfer_ascii_grid(
    output_path: str | Path,
    samples: list[tuple[float, float, float]],
    target_x_count: int = 220,
) -> str:
    if len(samples) < 3:
        raise ValueError("At least three samples are required to create a Surfer grid")

    x_values = [sample[0] for sample in samples]
    y_values = [sample[1] for sample in samples]
    x_min, x_max = min(x_values), max(x_values)
    y_min, y_max = min(y_values), max(y_values)
    x_span = max(x_max - x_min, 1e-9)
    y_span = max(y_max - y_min, 1e-9)
    x_count, y_count = _surfer_grid_size(x_span, y_span, target_x_count)
    grid_values: list[list[float]] = []
    z_min = float("inf")
    z_max = float("-inf")

    for row_index in range(y_count):
        y = y_min + (row_index / max(y_count - 1, 1)) * y_span
        row = []
        for col_index in range(x_count):
            x = x_min + (col_index / max(x_count - 1, 1)) * x_span
            value = _idw_value(x, y, samples)
            row.append(value)
            if math.isfinite(value):
                z_min = min(z_min, value)
                z_max = max(z_max, value)
        grid_values.append(row)

    if not math.isfinite(z_min) or not math.isfinite(z_max):
        raise ValueError("Surfer grid interpolation produced no finite values")

    lines = [
        "DSAA",
        f"{x_count} {y_count}",
        f"{x_min:.12g} {x_max:.12g}",
        f"{y_min:.12g} {y_max:.12g}",
        f"{z_min:.12g} {z_max:.12g}",
    ]
    for row in grid_values:
        lines.append(" ".join(f"{value:.12g}" for value in row))

    target = Path(output_path)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(target)


def _read_surfer_ascii_grid_points(grid_path: str | Path) -> list[tuple[float, float, float]]:
    path = Path(grid_path)
    if not path.is_file():
        return []
    lines = [line.strip() for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    if len(lines) < 6 or lines[0].upper() != "DSAA":
        return []

    counts = _numbers(lines[1])
    x_range = _numbers(lines[2])
    y_range = _numbers(lines[3])
    if len(counts) < 2 or len(x_range) < 2 or len(y_range) < 2:
        return []

    x_count = int(counts[0])
    y_count = int(counts[1])
    if x_count <= 1 or y_count <= 1:
        return []

    x_min, x_max = x_range[:2]
    y_min, y_max = y_range[:2]
    values: list[float] = []
    for line in lines[5:]:
        values.extend(_numbers(line))
        if len(values) >= x_count * y_count:
            break
    if len(values) < x_count * y_count:
        return []

    output: list[tuple[float, float, float]] = []
    for row_index in range(y_count):
        y = y_min + (row_index / max(y_count - 1, 1)) * (y_max - y_min)
        for col_index in range(x_count):
            x = x_min + (col_index / max(x_count - 1, 1)) * (x_max - x_min)
            value = values[row_index * x_count + col_index]
            if math.isfinite(x) and math.isfinite(y) and math.isfinite(value):
                output.append((x, y, value))
    return output


def _create_surfer_grid_from_vtk(vtk_path: str | Path) -> str | None:
    source = Path(vtk_path)
    if not source.is_file():
        return None
    samples = _extract_vtk_cell_resistivity_points(source)
    target = _surfer_output_paths(source)["grid"]
    return _write_surfer_ascii_grid(target, samples)


def _dedupe_terrain_points(points: Iterable[TerrainPoint]) -> list[TerrainPoint]:
    sorted_points = sorted(
        (
            (float(x), float(z))
            for x, z in points
            if math.isfinite(float(x)) and math.isfinite(float(z))
        ),
        key=lambda item: item[0],
    )
    output: list[TerrainPoint] = []
    for x, z in sorted_points:
        if output and abs(output[-1][0] - x) < 1e-8:
            output[-1] = (output[-1][0], z)
        else:
            output.append((x, z))
    return output


def _interpolate_terrain_z(points: list[TerrainPoint], x: float) -> float:
    if not points:
        return 0.0
    if x <= points[0][0]:
        return points[0][1]
    if x >= points[-1][0]:
        return points[-1][1]
    for index in range(1, len(points)):
        x0, z0 = points[index - 1]
        x1, z1 = points[index]
        if x0 <= x <= x1:
            if abs(x1 - x0) < 1e-12:
                return z1
            ratio = (x - x0) / (x1 - x0)
            return z0 + ratio * (z1 - z0)
    return points[-1][1]


def _parse_surface_electrodes(lines: list[str]) -> list[TerrainPoint]:
    for index, line in enumerate(lines):
        if not re.search(r"surface\s+electrodes", line, re.I):
            continue
        count = _first_int(lines[index + 1]) if index + 1 < len(lines) else None
        if not count or count < 2:
            return []
        points: list[TerrainPoint] = []
        for row in lines[index + 2 : index + 2 + count]:
            values = _numbers(row)
            if len(values) >= 2:
                points.append((values[0], values[1]))
        return _dedupe_terrain_points(points)
    return []


def _res2dinv_tail_start(lines: list[str]) -> int:
    if len(lines) < 6:
        return 0
    array_type = _first_int(lines[2])
    if array_type == 11:
        for index in range(4, min(len(lines) - 2, 18)):
            data_count = _first_int(lines[index])
            x_location_type = _first_int(lines[index + 1])
            ip_flag = _first_int(lines[index + 2])
            if data_count is None or data_count < 0:
                continue
            if x_location_type not in {0, 1, 2} or ip_flag not in {0, 1}:
                continue
            return min(index + 3 + data_count, len(lines))
        return 0
    data_count = _first_int(lines[3])
    if data_count is None or data_count < 0:
        return 0
    return min(6 + data_count, len(lines))


def _parse_res2dinv_topography_block(lines: list[str], start_index: int = 0) -> list[TerrainPoint]:
    cursor = max(int(start_index or 0), 0)
    while cursor < len(lines):
        flag = _first_int(lines[cursor])
        if flag not in {1, 2}:
            cursor += 1
            continue
        count_index = cursor + 1
        point_count = _first_int(lines[count_index]) if count_index < len(lines) else None
        if not point_count or point_count <= 0 or point_count > 4000:
            cursor += 1
            continue
        rows = lines[count_index + 1 : count_index + 1 + point_count]
        points: list[TerrainPoint] = []
        for row in rows:
            values = _numbers(row)
            if len(values) >= 2:
                points.append((values[0], values[1]))
        if len(points) == point_count:
            return _dedupe_terrain_points(points)
        cursor += 1
    return []


def _parse_terrain_points_from_res2dinv(path: str | Path) -> list[TerrainPoint]:
    lines = _read_nonempty_lines(path)
    topography = _parse_res2dinv_topography_block(lines, _res2dinv_tail_start(lines))
    if topography:
        return topography
    return _parse_surface_electrodes(lines)


def _parse_terrain_points_from_text(text: str) -> list[TerrainPoint]:
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    if not lines:
        return []
    topography = _parse_res2dinv_topography_block(lines, 0)
    if topography:
        return topography
    surface = _parse_surface_electrodes(lines)
    if surface:
        return surface

    points: list[TerrainPoint] = []
    for line in lines:
        values = _numbers(line)
        if len(values) >= 2:
            points.append((values[0], values[1]))
    return _dedupe_terrain_points(points)


def _load_terrain_points(
    data_file_path: str,
    terrain_file_path: str | None = None,
) -> list[TerrainPoint]:
    if terrain_file_path and os.path.exists(terrain_file_path):
        terrain_points = _parse_terrain_points_from_text(
            Path(terrain_file_path).read_text(encoding="utf-8-sig", errors="replace")
        )
        if len(terrain_points) >= 2:
            logger.info("Loaded %s terrain points from external terrain file.", len(terrain_points))
            return terrain_points
        logger.info("External terrain file did not contain enough terrain points; trying DAT terrain.")

    terrain_points = _parse_terrain_points_from_res2dinv(data_file_path)
    if len(terrain_points) >= 2:
        logger.info("Loaded %s terrain points from RES2DINV DAT file.", len(terrain_points))
        return terrain_points
    return []


def _build_data_from_res2dinv(
    data_file_path: str,
    relative_error: float,
    terrain_points: list[TerrainPoint] | None = None,
):
    import pygimli as pg

    from .res2dinv_to_simpeg import parse_res2dinv_dat

    parsed = parse_res2dinv_dat(data_file_path, relative_error=relative_error)
    valid_observations = [
        item
        for item in parsed.observations
        if math.isfinite(float(item.apparent_resistivity)) and float(item.apparent_resistivity) > 0
    ]
    if not valid_observations:
        raise ValueError("数据文件没有可用于反演的正值视电阻率 rhoa")

    data = pg.DataContainerERT()
    sensor_index_by_position: dict[tuple[float, float, float], int] = {}
    normalized_terrain = _dedupe_terrain_points(terrain_points or [])

    def sensor_id(x: float | None, y: float | None, z: float | None) -> int:
        if x is None or y is None or z is None:
            return -1
        sensor_z = (
            _interpolate_terrain_z(normalized_terrain, float(x))
            if normalized_terrain
            else float(z)
        )
        key = (round(float(x), 8), round(float(y), 8), round(sensor_z, 8))
        if key not in sensor_index_by_position:
            sensor_index_by_position[key] = int(data.createSensor(key))
        return sensor_index_by_position[key]

    rhoa_values = []
    err_values = []
    resistance_values = []
    for index, datum in enumerate(valid_observations):
        data.createFourPointData(
            index,
            sensor_id(datum.ax, datum.ay, datum.az),
            sensor_id(datum.bx, datum.by, datum.bz),
            sensor_id(datum.mx, datum.my, datum.mz),
            sensor_id(datum.nx, datum.ny, datum.nz),
        )
        rhoa_values.append(float(datum.apparent_resistivity))
        resistance_values.append(float(datum.resistance))
        err_values.append(max(float(relative_error), 1e-4))

    data.set("rhoa", rhoa_values)
    data.set("r", resistance_values)
    data.set("err", err_values)

    if not _set_geometric_factors(data):
        logger.info("DataContainerERT geometric-factor creation failed; continuing with parsed rhoa.")

    data.removeUnusedSensors()
    logger.info(
        "Built pyGIMLi ERT container from RES2DINV: %s observations, %s sensors",
        data.size(),
        data.sensorCount(),
    )
    return data


def _apply_terrain_to_loaded_data(data, terrain_points: list[TerrainPoint]):
    if not terrain_points:
        return data
    import pygimli as pg

    updated_positions = []
    for index in range(int(data.sensorCount())):
        pos = data.sensorPosition(index)
        updated_positions.append(
            pg.Pos(float(pos.x()), float(pos.y()), _interpolate_terrain_z(terrain_points, float(pos.x())))
        )
    data.setSensorPositions(updated_positions)
    if not _set_geometric_factors(data):
        logger.info("Unable to recompute geometric factors after applying terrain.")
    return data


def _load_ert_data(
    data_file_path: str,
    relative_error: float,
    terrain_points: list[TerrainPoint] | None = None,
):
    from pygimli.physics import ert

    try:
        data = ert.load(data_file_path)
        if _has_valid_rhoa(data):
            return _apply_terrain_to_loaded_data(data, terrain_points or [])
        logger.info("pyGIMLi loaded data without valid rhoa; trying RES2DINV parser fallback.")
    except Exception as exc:
        logger.info("pyGIMLi ert.load failed; trying RES2DINV parser fallback: %s", exc)

    return _build_data_from_res2dinv(data_file_path, relative_error, terrain_points or [])


def run_pygimli_inversion(
    data_file_path: str,
    output_dir: str,
    z_weight: float = 0.2,
    max_iter: int = 20,
    lambda_param: int = 20,
    error: float = 0.03,
    terrain_file_path: str | None = None,
) -> Dict[str, Any]:
    """
    Run ERT inversion using pyGIMLi.
    Expects a valid ERT data file, usually RES2DINV .dat/.shm.
    If a terrain file is supplied, or if the DAT contains a RES2DINV
    topography/surface-electrode block, sensor elevations are applied.
    """
    os.environ.setdefault("MPLBACKEND", "Agg")
    try:
        import matplotlib

        matplotlib.use("Agg", force=True)
    except Exception:
        logger.info("Unable to force matplotlib Agg backend; continuing.")

    try:
        from pygimli.physics import ert
    except ImportError as exc:
        raise RuntimeError("pyGIMLi 未安装，无法进行电法反演计算。请确认当前 Python 环境已安装 pyGIMLi。") from exc

    if not os.path.exists(data_file_path):
        raise FileNotFoundError(f"数据文件不存在：{data_file_path}")

    os.makedirs(output_dir, exist_ok=True)
    out_prefix = os.path.join(output_dir, "inv_result")

    try:
        terrain_points = _load_terrain_points(data_file_path, terrain_file_path)
        data = _load_ert_data(data_file_path, error, terrain_points)
        logger.info("Loaded ERT data fields: %s", list(data.dataMap().keys()))
        if terrain_points:
            logger.info("Using terrain/topography with %s points for ERT inversion.", len(terrain_points))

        if not _has_valid_rhoa(data):
            raise ValueError("数据文件缺少有效的正值视电阻率 rhoa，无法进行二维反演")

        if not data.haveData("err") or not data.allNonZero("err"):
            data.set("err", [max(float(error), 1e-4)] * int(data.size()))

        if not data.haveData("k") or not data.allNonZero("k"):
            if not _set_geometric_factors(data):
                logger.info("Unable to create geometric factors; continuing with rhoa-only inversion data.")
        else:
            _sync_resistance_with_rhoa_and_k(data)

        manager = ert.ERTManager(data)
        iteration_snapshots: list[dict[str, Any]] = []
        iterations_dir = Path(output_dir) / "ERTManager" / "iterations"
        previous_post_step = getattr(manager.inv, "_postStep", None)

        def save_iteration_snapshot(iteration_index, inversion):
            if previous_post_step and callable(previous_post_step):
                previous_post_step(iteration_index, inversion)
            snapshot = _save_iteration_model_snapshot(
                manager,
                inversion.model,
                iterations_dir,
                int(iteration_index),
            )
            if snapshot:
                iteration_snapshots.append(snapshot)

        manager.inv._postStep = save_iteration_snapshot
        logger.info(
            "Starting ERT inversion with zWeight=%s, maxIter=%s, lam=%s, terrain=%s",
            z_weight,
            max_iter,
            lambda_param,
            bool(terrain_points),
        )
        manager.invert(zWeight=z_weight, maxIter=max_iter, lam=lambda_param, verbose=True)
        manager.saveResult(out_prefix)
        # 自动通过 VTK 生成 Surfer 支持的网格和成图脚本
        surfer_outputs: dict[str, Any] = {}
        for vtk_path in Path(output_dir).rglob("resistivity.vtk"):
            try:
                surfer_outputs = _create_surfer_outputs_from_vtk(vtk_path)
                surfer_outputs["vtk_mesh"] = _extract_vtk_polygon_mesh(vtk_path)
                surfer_outputs["preview_points"] = _extract_vtk_cell_resistivity_points(vtk_path)
                surfer_outputs["mesh_node_points"] = _extract_vtk_node_resistivity_points(vtk_path)
                surfer_outputs["surfer_preview_points"] = _read_surfer_ascii_grid_points(surfer_outputs.get("grid") or "")
                surfer_outputs["surfer_boundary_points"] = _read_surfer_boundary_bln(
                    next(
                        (path for path in surfer_outputs.get("auxiliary_files") or [] if str(path).lower().endswith(".bln")),
                        "",
                    )
                )
                break
            except Exception as exc:
                logger.info("Unable to create Surfer files from %s: %s", vtk_path, exc)
        try:
            import matplotlib.pyplot as plt

            plt.close("all")
        except Exception:
            logger.info("Unable to close matplotlib figures after saving pyGIMLi results.")

        chi2 = manager.inv.getChi2() if hasattr(manager, "inv") and hasattr(manager.inv, "getChi2") else 0.0
        rrms = manager.inv.relrms() if hasattr(manager, "inv") and hasattr(manager.inv, "relrms") else 0.0

        fit_comparison = _build_pygimli_fit_comparison(manager, data)

        return {
            "status": "success",
            "chi2": float(chi2),
            "rrms": float(rrms),
            "fit_comparison": fit_comparison,
            "output_dir": output_dir,
            "terrain_used": bool(terrain_points),
            "terrain_point_count": len(terrain_points),
            "surfer_grid": surfer_outputs.get("grid"),
            "surfer_auxiliary_files": surfer_outputs.get("auxiliary_files") or [],
            "surfer_macro_script": surfer_outputs.get("script"),
            "surfer_readme": surfer_outputs.get("readme"),
            "surfer_macro_error": surfer_outputs.get("macro_error"),
            "vtk_mesh": surfer_outputs.get("vtk_mesh"),
            "preview_points": surfer_outputs.get("preview_points") or [],
            "mesh_node_points": surfer_outputs.get("mesh_node_points") or [],
            "surfer_preview_points": surfer_outputs.get("surfer_preview_points") or [],
            "surfer_boundary_points": surfer_outputs.get("surfer_boundary_points") or [],
            "iteration_results": iteration_snapshots,
            "iteration_result_count": len(iteration_snapshots),
            "files": _collect_result_files(output_dir, out_prefix),
        }
    except Exception as exc:
        logger.exception("pyGIMLi 反演过程中发生错误")
        raise RuntimeError(f"pyGIMLi 反演失败：{exc}") from exc
