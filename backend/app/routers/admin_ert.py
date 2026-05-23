from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Literal, Optional

from celery.result import AsyncResult
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from starlette.responses import FileResponse
from starlette import status

from ..celery_app import celery_app
from ..deps import get_current_admin_user
from ..models import User
from ..schemas import EMAP1TaskCreateResponse, EMAP1TaskStatusResponse
from ..services.pygimli_ert import _create_surfer_outputs_from_vtk, _write_surfer_srf_script
from ..tasks.ert_tasks import run_ert_inversion_task
from .admin_emap1 import _extract_meta, _normalize_status, _progress_from_meta

router = APIRouter(prefix="/admin/ert", tags=["admin-ert"])

_ERT_ARCHIVE_ROOT = Path(__file__).resolve().parents[2] / "data" / "ert_archives"
_ERT_RESULT_SUFFIXES = {
    ".bln",
    ".bmat",
    ".bms",
    ".clr",
    ".dat",
    ".grd",
    ".pdf",
    ".bas",
    ".srf",  # kept for users who run the .bas locally and re-upload the result
    ".txt",  # README_Surfer.txt
    ".vec",
    ".vector",
    ".vtk",
    ".xyz",
    ".npz",
}

_ERT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024  # 256 MB hard cap to avoid memory blow-ups
_ERT_LOCAL_INPUT_SUFFIXES = {".dat", ".shm", ".txt", ".csv", ".xyz", ".npz"}


class ERTArchiveRequest(BaseModel):
    project_id: str = Field(..., description="External project id used for the archive namespace")
    source_file_name: str = Field(..., description="Original ERT input file name")


def _safe_path_part(value: str, fallback: str = "unnamed") -> str:
    text = str(value or "").strip()
    text = re.sub(r"[<>:\"/\\|?*\x00-\x1f]+", "_", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text[:120] or fallback


def _archive_file_url(project_token: str, folder_token: str, file_name: str) -> str:
    return (
        "/admin/ert/archive-files/"
        f"{project_token}/{folder_token}/{_safe_path_part(file_name, 'file')}"
    )


def _resolve_archive_file(project_token: str, folder_token: str, file_name: str) -> Path:
    archive_root = _ERT_ARCHIVE_ROOT.resolve()
    target = (archive_root / project_token / folder_token / file_name).resolve()
    if archive_root not in target.parents:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid archive path")
    if not target.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Archive file not found")
    return target


def _existing_ert_result_files(result: Dict[str, Any]) -> list[Path]:
    source_files = result.get("files") or result.get("output_files") or []
    candidates = [Path(str(item)) for item in source_files if str(item or "").strip()]

    output_dir = result.get("output_dir")
    if output_dir:
        output_path = Path(str(output_dir))
        if output_path.is_dir():
            for vtk_path in output_path.rglob("resistivity.vtk"):
                try:
                    _create_surfer_outputs_from_vtk(vtk_path)
                except Exception:
                    pass
            candidates.extend(
                path
                for path in output_path.rglob("*")
                if path.is_file() and path.suffix.lower() in _ERT_RESULT_SUFFIXES
            )

    existing_files: list[Path] = []
    seen = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if not resolved.is_file() or resolved in seen:
            continue
        seen.add(resolved)
        existing_files.append(resolved)
    return existing_files


def _rewrite_archived_surfer_script(script_path: Path) -> None:
    name = script_path.name
    if not name.endswith("_surfer_export.bas"):
        return
    base_stem = name[: -len("_surfer_export.bas")]
    if base_stem == "resistivity":
        grid_name = "resistivity_surfer.grd"
        boundary_name = "resistivity_boundary.bln"
        color_name = "resistivity_rainbow.clr"
        blanked_grid_name = "resistivity_surfer_blanked.grd"
        srf_name = "resistivity_surfer.srf"
    else:
        grid_name = f"{base_stem}_surfer.grd"
        boundary_name = f"{base_stem}_boundary.bln"
        color_name = f"{base_stem}_rainbow.clr"
        blanked_grid_name = f"{base_stem}_surfer_blanked.grd"
        srf_name = f"{base_stem}_surfer.srf"
    folder = script_path.parent
    _write_surfer_srf_script(
        script_path,
        folder / grid_name,
        folder / boundary_name,
        folder / color_name,
        folder / blanked_grid_name,
        folder / srf_name,
    )


def _load_live_simpeg_iteration_results(task: Dict[str, Any]) -> list[dict[str, Any]]:
    output_dir = task.get("output_dir")
    if not output_dir:
        return []
    output_path = Path(str(output_dir))
    if not output_path.is_dir():
        return []

    cached = task.setdefault("iteration_preview_cache", {})
    results: list[dict[str, Any]] = []
    try:
        from ..services.simpeg_ert import build_simpeg_preview_from_npz

        for npz_path in sorted(output_path.glob("iteration_*.npz")):
            cache_key = str(npz_path)
            stat = npz_path.stat()
            cached_item = cached.get(cache_key)
            if (
                isinstance(cached_item, dict)
                and cached_item.get("mtime") == stat.st_mtime
                and cached_item.get("size") == stat.st_size
            ):
                payload = cached_item.get("payload")
            else:
                payload = build_simpeg_preview_from_npz(npz_path)
                vector_path = npz_path.with_suffix(".vector")
                if vector_path.is_file():
                    payload["vector"] = str(vector_path)
                cached[cache_key] = {
                    "mtime": stat.st_mtime,
                    "size": stat.st_size,
                    "payload": payload,
                }
            if isinstance(payload, dict):
                results.append(payload)
    except Exception:
        return results
    return results


def _load_live_pygimli_iteration_results(task: Dict[str, Any]) -> list[dict[str, Any]]:
    output_dir = task.get("output_dir")
    if not output_dir:
        return []
    output_path = Path(str(output_dir))
    iterations_dir = output_path / "ERTManager" / "iterations"
    if not iterations_dir.is_dir():
        return []

    cached = task.setdefault("iteration_preview_cache", {})
    results: list[dict[str, Any]] = []
    try:
        from ..services.pygimli_ert import (
            _extract_vtk_polygon_mesh,
            _extract_vtk_cell_resistivity_points,
            _extract_vtk_node_resistivity_points,
            _read_surfer_ascii_grid_points,
            _read_surfer_boundary_bln,
            _surfer_output_paths,
        )

        for vtk_path in sorted(iterations_dir.glob("iteration_*.vtk")):
            cache_key = str(vtk_path)
            stat = vtk_path.stat()
            cached_item = cached.get(cache_key)
            if (
                isinstance(cached_item, dict)
                and cached_item.get("mtime") == stat.st_mtime
                and cached_item.get("size") == stat.st_size
            ):
                payload = cached_item.get("payload")
            else:
                stem = vtk_path.stem
                match = re.search(r"iteration_(\d+)", stem)
                iteration_index = int(match.group(1)) if match else 0

                vector_path = vtk_path.with_suffix(".vector")
                surfer_paths = _surfer_output_paths(vtk_path)

                grid_path = surfer_paths.get("grid")
                surfer_preview_points = []
                if grid_path and grid_path.is_file():
                    surfer_preview_points = _read_surfer_ascii_grid_points(grid_path)

                boundary_path = surfer_paths.get("boundary")
                surfer_boundary_points = []
                if boundary_path and boundary_path.is_file():
                    surfer_boundary_points = _read_surfer_boundary_bln(boundary_path)

                payload = {
                    "iteration": iteration_index,
                    "vector": str(vector_path) if vector_path.is_file() else None,
                    "vtk": str(vtk_path),
                    "vtk_mesh": _extract_vtk_polygon_mesh(vtk_path),
                    "preview_points": _extract_vtk_cell_resistivity_points(vtk_path),
                    "mesh_node_points": _extract_vtk_node_resistivity_points(vtk_path),
                    "surfer_preview_points": surfer_preview_points,
                    "surfer_boundary_points": surfer_boundary_points,
                    "surfer_grid": str(grid_path) if grid_path and grid_path.is_file() else None,
                    "surfer_auxiliary_files": [
                        str(p) for p in surfer_paths.values()
                        if p.is_file() and p != vtk_path and p != grid_path
                    ],
                    "surfer_macro_script": str(surfer_paths.get("script")) if surfer_paths.get("script") and surfer_paths["script"].is_file() else None,
                    "surfer_readme": str(surfer_paths.get("readme")) if surfer_paths.get("readme") and surfer_paths["readme"].is_file() else None,
                }
                cached[cache_key] = {
                    "mtime": stat.st_mtime,
                    "size": stat.st_size,
                    "payload": payload,
                }
            if isinstance(payload, dict):
                results.append(payload)
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("Error loading live pyGIMLi iteration results: %s", exc)
        return results
    return results



def parse_npz_to_dat_content(npz_bytes: bytes) -> str:
    import io
    import numpy as np
    
    with np.load(io.BytesIO(npz_bytes), allow_pickle=True) as data:
        a = data.get("a_locations")
        if a is None:
            a = data.get("a")
        b = data.get("b_locations")
        if b is None:
            b = data.get("b")
        m = data.get("m_locations")
        if m is None:
            m = data.get("m")
        n = data.get("n_locations")
        if n is None:
            n = data.get("n")
            
        if a is None or m is None:
            raise ValueError("NPZ数据文件中缺少必要的电极位置数据(a_locations, m_locations)")
            
        n_obs = len(a)
        
        rhoa = data.get("apparent_resistivity")
        if rhoa is None:
            rhoa = data.get("rhoa")
        if rhoa is None:
            dobs = data.get("dobs")
            if dobs is None:
                dobs = data.get("resistivity")
            if dobs is None:
                dobs = data.get("data")
            if dobs is not None:
                k = data.get("geometric_factor")
                if k is not None:
                    rhoa = dobs * k
                else:
                    rhoa = dobs
            else:
                raise ValueError("NPZ数据文件中缺少电阻率或电阻数据")
                
        error = data.get("error")
        if error is None:
            error = data.get("standard_deviation")
        if error is None:
            error = data.get("std")
            
        all_x = []
        for arr in [a, b, m, n]:
            if arr is not None:
                for pt in arr:
                    if pt is not None and not np.any(np.isnan(pt)):
                        x = pt[0]
                        if abs(x - 999999) > 1 and abs(x + 999999) > 1:
                            all_x.append(x)
        if len(all_x) > 1:
            all_x = sorted(list(set(all_x)))
            diffs = [all_x[i+1] - all_x[i] for i in range(len(all_x)-1)]
            unit_spacing = min(diffs) if diffs else 1.0
        else:
            unit_spacing = 1.0
            
        if unit_spacing <= 0:
            unit_spacing = 1.0
            
        out_lines = []
        out_lines.append("NPZ Imported Data")
        out_lines.append(f"{unit_spacing:.3f}")
        out_lines.append("11")  # General array
        out_lines.append(f"{n_obs}")
        out_lines.append("0")   # x_location_type
        out_lines.append("0")   # ip_flag
        
        for i in range(n_obs):
            ax = a[i][0]
            az = a[i][2] if len(a[i]) > 2 else a[i][1]
            
            if b is not None and i < len(b) and b[i] is not None and not np.any(np.isnan(b[i])):
                bx = b[i][0]
                bz = b[i][2] if len(b[i]) > 2 else b[i][1]
                if abs(bx - 999999) < 1 or abs(bx + 999999) < 1:
                    bx, bz = 999999.0, 0.0
            else:
                bx, bz = 999999.0, 0.0
                
            mx = m[i][0]
            mz = m[i][2] if len(m[i]) > 2 else m[i][1]
            
            if n is not None and i < len(n) and n[i] is not None and not np.any(np.isnan(n[i])):
                nx = n[i][0]
                nz = n[i][2] if len(n[i]) > 2 else n[i][1]
                if abs(nx - 999999) < 1 or abs(nx + 999999) < 1:
                    nx, nz = 999999.0, 0.0
            else:
                nx, nz = 999999.0, 0.0
                
            r_val = float(rhoa[i])
            err_str = ""
            if error is not None and i < len(error) and error[i] is not None:
                err_str = f" {float(error[i]):.6f}"
                
            out_lines.append(f"{ax:.3f} {az:.3f} {bx:.3f} {bz:.3f} {mx:.3f} {mz:.3f} {nx:.3f} {nz:.3f} {r_val:.4f}{err_str}")
            
        return "\n".join(out_lines) + "\n"


def _extract_points_from_observations(observations) -> list[tuple[float, float, float]]:
    points = []
    for d in observations:
        xs = []
        zs = []
        
        xs.append(d.ax)
        zs.append(d.az)
        
        if d.bx is not None and abs(d.bx - 999999) > 1 and abs(d.bx + 999999) > 1:
            xs.append(d.bx)
            zs.append(d.bz if d.bz is not None else 0.0)
            
        xs.append(d.mx)
        zs.append(d.mz)
        
        if d.nx is not None and abs(d.nx - 999999) > 1 and abs(d.nx + 999999) > 1:
            xs.append(d.nx)
            zs.append(d.nz if d.nz is not None else 0.0)
            
        x = sum(xs) / len(xs) if xs else 0.0
        
        if xs:
            l_span = max(xs) - min(xs)
        else:
            l_span = 0.0
        depth = l_span / 4.0
        
        z_mean = sum(zs) / len(zs) if zs else 0.0
        z = z_mean - depth
        
        points.append((x, z, d.apparent_resistivity))
    return points


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stream_upload_to_disk(upload: UploadFile, target: Path) -> int:
    target.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with target.open("wb") as out:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > _ERT_MAX_UPLOAD_BYTES:
                out.close()
                target.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"上传文件超过 {_ERT_MAX_UPLOAD_BYTES // (1024 * 1024)} MB 限制",
                )
            out.write(chunk)
    return written


def _resolve_local_input_file(file_name: str) -> Path:
    safe_name = _safe_path_part(Path(str(file_name or "")).name, "")
    if not safe_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid file name")
    if Path(safe_name).suffix.lower() not in _ERT_LOCAL_INPUT_SUFFIXES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported ERT input file")

    root = Path(__file__).resolve().parents[3]
    search_roots = [
        root / "tmp",
        root / "backend" / "data" / "ert_archives",
    ]
    for search_root in search_roots:
        if not search_root.exists():
            continue
        exact = search_root / safe_name
        if exact.is_file():
            return exact
        for candidate in search_root.rglob(safe_name):
            if candidate.is_file():
                return candidate
        if safe_name.lower() == "e-1.dat":
            for candidate in search_root.rglob("input_data.dat"):
                if candidate.is_file():
                    return candidate

    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Local ERT input file not found")


@router.get("/local-input-files/{file_name}")
def download_local_ert_input_file(
    file_name: str,
    _: User = Depends(get_current_admin_user),
):
    target = _resolve_local_input_file(file_name)
    return FileResponse(
        path=str(target),
        filename=file_name,
        media_type=mimetypes.guess_type(file_name)[0] or "application/octet-stream",
    )


@router.post("/parse-data-file")
def parse_ert_data_file(
    data_file: UploadFile = File(..., description="ERT data file (.dat, .shm, or .npz)"),
    _: User = Depends(get_current_admin_user),
):
    if not data_file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="缺少文件名",
        )
    
    try:
        content_bytes = data_file.file.read()
        # 限制上传大小
        if len(content_bytes) > _ERT_MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="文件太大，超出限制",
            )
            
        filename = data_file.filename.lower()
        
        # 转换为 .dat 格式文本
        if filename.endswith(".npz"):
            dat_content = parse_npz_to_dat_content(content_bytes)
        else:
            dat_content = content_bytes.decode("utf-8-sig", errors="replace")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"数据文件读取或转换失败：{exc}",
        )
        
    with tempfile.NamedTemporaryFile(mode="w", suffix=".dat", delete=False, encoding="utf-8") as temp_file:
        temp_file.write(dat_content)
        temp_file_path = temp_file.name
        
    try:
        from ..services.res2dinv_to_simpeg import parse_res2dinv_dat
        result = parse_res2dinv_dat(temp_file_path)
        
        points = _extract_points_from_observations(result.observations)
        
        from ..services.pygimli_ert import _parse_terrain_points_from_text
        topography = _parse_terrain_points_from_text(dat_content)
        
        all_xs = set()
        for d in result.observations:
            all_xs.add(d.ax)
            if d.bx is not None and abs(d.bx - 999999) > 1 and abs(d.bx + 999999) > 1:
                all_xs.add(d.bx)
            all_xs.add(d.mx)
            if d.nx is not None and abs(d.nx - 999999) > 1 and abs(d.nx + 999999) > 1:
                all_xs.add(d.nx)
        electrode_count = len(all_xs)
        
        if all_xs:
            profile_length = max(all_xs) - min(all_xs)
        else:
            profile_length = 0.0
            
        return {
            "points": points,
            "spacing": result.unit_spacing,
            "electrode_count": electrode_count,
            "profile_length": profile_length,
            "topography": topography or None,
        }
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"数据文件格式错误或无法解析：{exc}",
        )
    finally:
        try:
            os.unlink(temp_file_path)
        except Exception:
            pass


@router.post("/invert", response_model=EMAP1TaskCreateResponse)
def trigger_ert_inversion(
    data_file: UploadFile = File(..., description="ERT data file (.dat, .shm, or .npz)"),
    terrain_file: Optional[UploadFile] = File(None, description="Optional terrain/topography file"),
    output_dir: Optional[str] = Form(None),
    inversion_backend: Literal["pygimli", "simpeg"] = Form("pygimli"),
    z_weight: float = Form(0.2),
    max_iter: int = Form(20),
    lambda_param: int = Form(20),
    error: float = Form(0.03),
    _: User = Depends(get_current_admin_user),
):
    if not data_file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="缺少 ERT 数据文件",
        )

    resolved_output_dir = output_dir or os.path.join(
        tempfile.gettempdir(), "geoyun_ert_inv", str(uuid.uuid4())
    )
    output_path = Path(resolved_output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    data_path = output_path / "input_data.dat"
    
    # 拦截并转换 npz
    if data_file.filename.lower().endswith(".npz"):
        try:
            npz_bytes = data_file.file.read()
            data_file.file.seek(0)
            dat_content = parse_npz_to_dat_content(npz_bytes)
            with open(data_path, "w", encoding="utf-8") as f:
                f.write(dat_content)
            written = len(dat_content)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"解析上传的 NPZ 文件并转换为 DAT 失败: {exc}",
            )
    else:
        written = _stream_upload_to_disk(data_file, data_path)

    if written == 0:
        data_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{data_file.filename} 内容为空，无法进行二维反演",
        )

    terrain_path: Optional[Path] = None
    terrain_name: Optional[str] = None
    if terrain_file is not None and terrain_file.filename:
        terrain_path = output_path / "terrain.txt"
        terrain_written = _stream_upload_to_disk(terrain_file, terrain_path)
        if terrain_written == 0:
            terrain_path.unlink(missing_ok=True)
            terrain_path = None
        else:
            terrain_name = terrain_file.filename

    task_payload: Dict[str, Any] = {
        "output_dir": str(output_path),
        "data_file_path": str(data_path),
        "data_file_name": data_file.filename,
        "terrain_file_path": str(terrain_path) if terrain_path else None,
        "terrain_file_name": terrain_name,
        "inversion_backend": inversion_backend,
        "z_weight": z_weight,
        "max_iter": max_iter,
        "lambda_param": lambda_param,
        "error": error,
        "created_at": _utc_now(),
    }

    try:
        async_result = run_ert_inversion_task.apply_async(args=[task_payload])
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"无法提交后台任务：{exc}",
        ) from exc
    return EMAP1TaskCreateResponse(task_id=async_result.id, status="queued")


@router.get("/tasks/{task_id}", response_model=EMAP1TaskStatusResponse)
def get_ert_task_status(
    task_id: str,
    _: User = Depends(get_current_admin_user),
):
    async_result = AsyncResult(task_id, app=celery_app)
    normalized_status = _normalize_status(async_result.state)
    meta = _extract_meta(async_result)

    task_data = async_result.result if async_result.state == "SUCCESS" else meta
    if not isinstance(task_data, dict):
        task_data = {}

    progress = dict(task_data.get("progress") or {})
    progress.setdefault("current", 1 if normalized_status in {"success", "failed"} else 0)
    progress.setdefault("total", int(task_data.get("max_iter") or 1))
    progress.setdefault("percent", 100 if normalized_status in {"success", "failed"} else 10)
    progress.setdefault(
        "message",
        "二维反演完成"
        if normalized_status == "success"
        else "二维反演失败"
        if normalized_status == "failed"
        else "二维反演计算中",
    )
    progress["logs"] = list(task_data.get("logs") or progress.get("logs") or [])

    inversion_backend = str(task_data.get("inversion_backend") or "").lower()
    if inversion_backend == "simpeg":
        iteration_results = _load_live_simpeg_iteration_results(task_data)
        if iteration_results:
            latest_iteration = iteration_results[-1]
            latest_index = int(latest_iteration.get("iteration") or len(iteration_results))
            progress["iteration_results"] = iteration_results
            progress["latest_iteration_result"] = latest_iteration
            progress["current"] = max(int(progress.get("current") or 0), latest_index)
            progress["message"] = f"正在进行第 {latest_index}/{progress.get('total') or task_data.get('max_iter') or 1} 次迭代"
    elif inversion_backend == "pygimli":
        iteration_results = _load_live_pygimli_iteration_results(task_data)
        if iteration_results:
            latest_iteration = iteration_results[-1]
            latest_index = int(latest_iteration.get("iteration") or len(iteration_results))
            progress["iteration_results"] = iteration_results
            progress["latest_iteration_result"] = latest_iteration
            progress["current"] = max(int(progress.get("current") or 0), latest_index)
            progress["message"] = f"正在进行第 {latest_index}/{progress.get('total') or task_data.get('max_iter') or 1} 次迭代"


    return EMAP1TaskStatusResponse(
        task_id=task_id,
        status=normalized_status,
        progress=progress,
        error=task_data.get("error") or (meta.get("error") if isinstance(meta, dict) else None),
        created_at=task_data.get("created_at"),
        started_at=task_data.get("started_at"),
        finished_at=task_data.get("finished_at"),
    )


@router.get("/tasks/{task_id}/result")
def get_ert_task_result(
    task_id: str,
    _: User = Depends(get_current_admin_user),
):
    async_result = AsyncResult(task_id, app=celery_app)
    normalized_status = _normalize_status(async_result.state)
    meta = _extract_meta(async_result)

    if normalized_status in {"queued", "running"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="任务尚未完成")
    if normalized_status in {"failed", "revoked"}:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=meta.get("error") or "任务执行失败",
        )

    payload = async_result.result
    if not isinstance(payload, dict) or "result" not in payload:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="任务结果格式无效",
        )
    return payload["result"]


@router.post("/tasks/{task_id}/archive")
def archive_ert_task_result(
    task_id: str,
    payload: ERTArchiveRequest,
    _: User = Depends(get_current_admin_user),
):
    async_result = AsyncResult(task_id, app=celery_app)
    normalized_status = _normalize_status(async_result.state)
    meta = _extract_meta(async_result)

    if normalized_status in {"queued", "running"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="任务尚未完成")
    if normalized_status in {"failed", "revoked"} or async_result.state != "SUCCESS":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="任务尚未完成或执行失败")

    task_payload = async_result.result
    if not isinstance(task_payload, dict) or "result" not in task_payload:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="任务结果格式无效",
        )

    result = task_payload.get("result") or {}
    existing_files = _existing_ert_result_files(result)
    if not existing_files:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No ERT result files found")

    project_token = _safe_path_part(payload.project_id, "project")
    source_stem = Path(_safe_path_part(payload.source_file_name, "ert_result")).stem or "ert_result"
    folder_name = source_stem
    folder_token = _safe_path_part(folder_name, "ert_result")
    target_dir = _ERT_ARCHIVE_ROOT / project_token / folder_token
    target_dir.mkdir(parents=True, exist_ok=True)
    for stale_path in target_dir.iterdir():
        if stale_path.is_file():
            stale_path.unlink(missing_ok=True)

    archived_files = []
    for source_path in existing_files:
        file_name = _safe_path_part(source_path.name, "result.dat")
        target_path = target_dir / file_name
        shutil.copy2(source_path, target_path)
        if target_path.suffix.lower() == ".bas":
            _rewrite_archived_surfer_script(target_path)
        mime_type = mimetypes.guess_type(file_name)[0] or "application/octet-stream"
        archived_files.append(
            {
                "name": file_name,
                "size": target_path.stat().st_size,
                "mime_type": mime_type,
                "file_url": _archive_file_url(project_token, folder_token, file_name),
                "local_path": str(target_path),
            }
        )

    return {
        "status": "success",
        "project_id": payload.project_id,
        "folder_name": folder_name,
        "folder_token": folder_token,
        "archive_dir": str(target_dir),
        "files": archived_files,
    }


@router.get("/archive-files/{project_token}/{folder_token}/{file_name}/preview")
def preview_ert_archive_file(
    project_token: str,
    folder_token: str,
    file_name: str,
    _: User = Depends(get_current_admin_user),
):
    target = _resolve_archive_file(
        _safe_path_part(project_token, "project"),
        _safe_path_part(folder_token, "ert_result"),
        _safe_path_part(file_name, "file"),
    )
    if target.suffix.lower() != ".npz":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only SimPEG npz previews are supported")

    try:
        from ..services.simpeg_ert import build_simpeg_preview_from_npz

        return build_simpeg_preview_from_npz(target)
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc


@router.get("/archive-files/{project_token}/{folder_token}/{file_name}")
def download_ert_archive_file(
    project_token: str,
    folder_token: str,
    file_name: str,
    _: User = Depends(get_current_admin_user),
):
    target = _resolve_archive_file(
        _safe_path_part(project_token, "project"),
        _safe_path_part(folder_token, "ert_result"),
        _safe_path_part(file_name, "file"),
    )
    return FileResponse(
        path=str(target),
        filename=target.name,
        media_type=mimetypes.guess_type(target.name)[0] or "application/octet-stream",
    )
