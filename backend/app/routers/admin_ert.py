from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
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
from .admin_emap1 import _extract_meta, _normalize_status, _progress_from_meta

router = APIRouter(prefix="/admin/ert", tags=["admin-ert"])

_LOCAL_ERT_TASK_RESULTS: Dict[str, Dict[str, Any]] = {}
_LOCAL_ERT_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ert-local")
_LOCAL_ERT_QUEUE_LOCK = threading.Lock()
_LOCAL_ERT_QUEUE_ORDER: list[str] = []  # task ids waiting to start, FIFO
_ERT_INVERSION_TIMEOUT_SECONDS = int(os.environ.get("ERT_INVERSION_TIMEOUT_SECONDS", 60 * 30))
_ERT_TERMINATE_GRACE_SECONDS = 10
_ERT_KILL_GRACE_SECONDS = 5


def _terminate_subprocess_tree(process: subprocess.Popen) -> None:
    """Kill the inversion subprocess (and any descendants) with escalation: SIGTERM → SIGKILL."""
    if process.poll() is not None:
        return

    pid = process.pid
    if os.name == "nt":
        # taskkill /T walks the job tree on Windows; suppresses the noisy stderr.
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                check=False,
                capture_output=True,
                timeout=_ERT_KILL_GRACE_SECONDS,
            )
        except Exception:
            pass
        try:
            process.terminate()
        except Exception:
            pass
    else:
        try:
            process.terminate()
        except Exception:
            pass

    try:
        process.wait(timeout=_ERT_TERMINATE_GRACE_SECONDS)
        return
    except subprocess.TimeoutExpired:
        pass

    try:
        process.kill()
    except Exception:
        pass
    try:
        process.wait(timeout=_ERT_KILL_GRACE_SECONDS)
    except Exception:
        pass


def _enqueue_task(task_id: str) -> tuple[int, int]:
    with _LOCAL_ERT_QUEUE_LOCK:
        _LOCAL_ERT_QUEUE_ORDER.append(task_id)
        position = len(_LOCAL_ERT_QUEUE_ORDER)
        return position, position


def _dequeue_task(task_id: str) -> None:
    with _LOCAL_ERT_QUEUE_LOCK:
        try:
            _LOCAL_ERT_QUEUE_ORDER.remove(task_id)
        except ValueError:
            pass


def _queue_position_for(task_id: str) -> tuple[Optional[int], Optional[int]]:
    with _LOCAL_ERT_QUEUE_LOCK:
        total = len(_LOCAL_ERT_QUEUE_ORDER)
        if total == 0:
            return None, None
        try:
            index = _LOCAL_ERT_QUEUE_ORDER.index(task_id)
        except ValueError:
            return None, total
        return index + 1, total
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
}


def _summarize_ert_error(message: str) -> str:
    text = str(message or "").strip()
    if "There are data values equals 0.0" in text:
        return "数据中存在 0 值测点，pyGIMLi 无法反演；请剔除视电阻率/电阻为 0 的数据后重试。"
    if "rhoa" in text or "apparent resistivity" in text:
        return "数据文件缺少有效的正值视电阻率 rhoa；请确认 DAT 为 RES2DINV 格式且视电阻率列不为 0。"
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("RuntimeError:") or line.startswith("ValueError:"):
            return line.split(":", 1)[1].strip() or line
    return text[-1000:] or "二维反演失败"


def _append_task_log(task_id: str, line: str) -> None:
    cleaned = re.sub(r"\x1b\[[0-9;]*m", "", str(line or "")).strip()
    if not cleaned:
        return
    task = _LOCAL_ERT_TASK_RESULTS.get(task_id)
    if not task:
        return
    logs = task.setdefault("logs", [])
    logs.append(cleaned)
    del logs[:-80]

    max_iter = max(int(task.get("max_iter") or 1), 1)
    iteration_match = re.search(r"(?:iter(?:ation)?|Iteration)\D*(\d+)", cleaned)
    if not iteration_match:
        iteration_match = re.match(r"\s*(\d+)\s*:", cleaned)
    if not iteration_match:
        iteration_match = re.match(r"\s*(\d+)\s+[-+0-9.eE]+", cleaned)
    if iteration_match:
        current = min(max(int(iteration_match.group(1)), 1), max_iter)
        percent = min(95, max(30, int(30 + (current / max_iter) * 65)))
        task["progress"] = {
            "current": current,
            "total": max_iter,
            "percent": percent,
            "message": f"正在进行第 {current}/{max_iter} 次迭代",
            "logs": list(logs),
        }
    else:
        count_match = re.match(r"\s*(\d+)\s*/\s*(\d+)\s*$", cleaned)
        if count_match:
            current = int(count_match.group(1))
            total = max(int(count_match.group(2)), 1)
            percent = min(60, max(15, int(15 + (current / total) * 40)))
            task["progress"] = {
                "current": current,
                "total": total,
                "percent": percent,
                "message": f"正在计算 Jacobian {current}/{total}",
                "logs": list(logs),
            }
            return
        progress = dict(task.get("progress") or {})
        progress.update({"logs": list(logs), "message": cleaned[-120:]})
        task["progress"] = progress


_ERT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024  # 256 MB hard cap to avoid memory blow-ups
_ERT_LOCAL_INPUT_SUFFIXES = {".dat", ".shm", ".txt", ".csv", ".xyz"}


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


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run_local_ert_subprocess(task_id: str, task_payload: Dict[str, Any]) -> None:
    _dequeue_task(task_id)
    _LOCAL_ERT_TASK_RESULTS[task_id].update(
        {
            "status": "running",
            "started_at": _utc_now(),
            "progress": {
                "current": 0,
                "total": int(task_payload.get("max_iter") or 1),
                "percent": 10,
                "message": "正在准备反演数据",
                "logs": ["任务已启动，正在准备反演数据..."],
            },
        }
    )
    output_dir = Path(str(task_payload["output_dir"]))
    output_dir.mkdir(parents=True, exist_ok=True)
    payload_path = output_dir / "local_ert_payload.json"
    result_path = output_dir / "local_ert_result.json"
    payload_path.write_text(json.dumps(task_payload, ensure_ascii=False), encoding="utf-8")

    code = r"""
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from backend.app.services.pygimli_ert import run_pygimli_inversion
from backend.app.services.simpeg_ert import run_simpeg_inversion

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
result_path = Path(sys.argv[2])
output_dir = Path(str(payload["output_dir"]))
output_dir.mkdir(parents=True, exist_ok=True)
data_file_path = Path(str(payload["data_file_path"]))
if not data_file_path.is_file():
    raise FileNotFoundError(f"ERT input file missing: {data_file_path}")
terrain_file_path = None
terrain_value = payload.get("terrain_file_path")
if terrain_value:
    candidate = Path(str(terrain_value))
    if candidate.is_file():
        terrain_file_path = candidate

backend = str(payload.get("inversion_backend") or "pygimli").lower()
if backend == "simpeg":
    result = run_simpeg_inversion(
        data_file_path=str(data_file_path),
        output_dir=str(output_dir),
        z_weight=float(payload.get("z_weight", 0.2)),
        max_iter=int(payload.get("max_iter", 20)),
        lambda_param=int(payload.get("lambda_param", 20)),
        error=float(payload.get("error", 0.03)),
        terrain_file_path=str(terrain_file_path) if terrain_file_path else None,
    )
else:
    result = run_pygimli_inversion(
        data_file_path=str(data_file_path),
        output_dir=str(output_dir),
        z_weight=float(payload.get("z_weight", 0.2)),
        max_iter=int(payload.get("max_iter", 20)),
        lambda_param=int(payload.get("lambda_param", 20)),
        error=float(payload.get("error", 0.03)),
        terrain_file_path=str(terrain_file_path) if terrain_file_path else None,
    )
result_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
"""

    process: Optional[subprocess.Popen] = None
    timed_out = {"flag": False}
    watchdog: Optional[threading.Timer] = None

    try:
        popen_kwargs: Dict[str, Any] = dict(
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env={
                **os.environ,
                "MPLBACKEND": "Agg",
                "QT_QPA_PLATFORM": "offscreen",
                "PYTHONIOENCODING": "utf-8",
            },
        )
        # Group child process so we can kill the whole tree on timeout
        # (matters if pyGIMLi/SimPEG fork helper workers).
        if os.name == "nt":
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_kwargs["start_new_session"] = True

        process = subprocess.Popen(
            [sys.executable, "-c", code, str(payload_path), str(result_path)],
            cwd=str(Path(__file__).resolve().parents[3]),
            **popen_kwargs,
        )
        assert process.stdout is not None

        def _on_timeout() -> None:
            if process and process.poll() is None:
                timed_out["flag"] = True
                _append_task_log(
                    task_id,
                    f"⚠️ 任务执行已超过 {_ERT_INVERSION_TIMEOUT_SECONDS // 60} 分钟，正在终止子进程...",
                )
                _terminate_subprocess_tree(process)

        watchdog = threading.Timer(_ERT_INVERSION_TIMEOUT_SECONDS, _on_timeout)
        watchdog.daemon = True
        watchdog.start()

        for output_line in process.stdout:
            _append_task_log(task_id, output_line)
        return_code = process.wait()

        if timed_out["flag"]:
            raise RuntimeError(
                f"二维反演超时（超过 {_ERT_INVERSION_TIMEOUT_SECONDS // 60} 分钟），已自动终止子进程。"
                "请减小数据规模或调低最大迭代次数后重试。"
            )
        if return_code != 0:
            error = "\n".join(_LOCAL_ERT_TASK_RESULTS[task_id].get("logs", []))
            raise RuntimeError(_summarize_ert_error(error))
        result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.exists() else {}
        logs = _LOCAL_ERT_TASK_RESULTS[task_id].get("logs", [])
        _LOCAL_ERT_TASK_RESULTS[task_id].update(
            {
                "status": "success",
                "result": result,
                "progress": {
                    "current": int(task_payload.get("max_iter") or 1),
                    "total": int(task_payload.get("max_iter") or 1),
                    "percent": 100,
                    "message": "二维反演完成",
                    "logs": list(logs),
                },
                "finished_at": _utc_now(),
            }
        )
    except Exception as exc:
        logs = _LOCAL_ERT_TASK_RESULTS[task_id].get("logs", [])
        _LOCAL_ERT_TASK_RESULTS[task_id].update(
            {
                "status": "failed",
                "error": _summarize_ert_error(str(exc)),
                "progress": {
                    "current": 1,
                    "total": int(task_payload.get("max_iter") or 1),
                    "percent": 100,
                    "message": "二维反演超时已终止" if timed_out["flag"] else "二维反演失败",
                    "logs": list(logs),
                },
                "finished_at": _utc_now(),
            }
        )
    finally:
        if watchdog is not None:
            watchdog.cancel()
        # Defensive: if the loop above exited via an unexpected exception
        # (e.g., disk full when reading stdout), make sure we don't leak the child.
        if process is not None and process.poll() is None:
            _terminate_subprocess_tree(process)


def _start_local_ert_task(task_payload: Dict[str, Any]) -> str:
    local_task_id = f"local-{uuid.uuid4()}"
    now = _utc_now()
    position, total = _enqueue_task(local_task_id)
    if position <= 1:
        message = "任务已提交，即将开始计算..."
    else:
        message = f"任务排队中：第 {position}/{total} 位，前面还有 {position - 1} 个任务"
    _LOCAL_ERT_TASK_RESULTS[local_task_id] = {
        "status": "queued",
        "created_at": now,
        "started_at": None,
        "finished_at": None,
        "max_iter": int(task_payload.get("max_iter") or 1),
        "logs": [message],
        "progress": {
            "current": 0,
            "total": int(task_payload.get("max_iter") or 1),
            "percent": 0,
            "message": message,
            "logs": [message],
            "queue_position": position,
            "queue_total": total,
        },
    }
    _LOCAL_ERT_EXECUTOR.submit(_run_local_ert_subprocess, local_task_id, task_payload)
    return local_task_id


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


@router.post("/invert", response_model=EMAP1TaskCreateResponse)
def trigger_ert_inversion(
    data_file: UploadFile = File(..., description="ERT data file (.dat or .shm)"),
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
    }

    local_task_id = _start_local_ert_task(task_payload)
    return EMAP1TaskCreateResponse(task_id=local_task_id, status="queued")


@router.get("/tasks/{task_id}", response_model=EMAP1TaskStatusResponse)
def get_ert_task_status(
    task_id: str,
    _: User = Depends(get_current_admin_user),
):
    local_result = _LOCAL_ERT_TASK_RESULTS.get(task_id)
    if local_result:
        normalized_status = local_result["status"]
        progress = dict(local_result.get("progress") or {})
        progress.setdefault("current", 1 if normalized_status in {"success", "failed"} else 0)
        progress.setdefault("total", int(local_result.get("max_iter") or 1))
        progress.setdefault("percent", 100 if normalized_status in {"success", "failed"} else 10)
        progress.setdefault(
            "message",
            "二维反演完成"
            if normalized_status == "success"
            else "二维反演失败"
            if normalized_status == "failed"
            else "二维反演计算中",
        )
        progress["logs"] = list(local_result.get("logs") or progress.get("logs") or [])

        if normalized_status == "queued":
            position, queue_total = _queue_position_for(task_id)
            progress["queue_position"] = position
            progress["queue_total"] = queue_total
            if position is not None and queue_total is not None:
                if position <= 1:
                    progress["message"] = "即将开始计算..."
                else:
                    progress["message"] = (
                        f"任务排队中：第 {position}/{queue_total} 位，"
                        f"前面还有 {position - 1} 个任务"
                    )
        else:
            progress["queue_position"] = None
            progress["queue_total"] = None

        return EMAP1TaskStatusResponse(
            task_id=task_id,
            status=normalized_status,
            progress=progress,
            error=local_result.get("error"),
            created_at=local_result.get("created_at"),
            started_at=local_result.get("started_at"),
            finished_at=local_result.get("finished_at"),
        )

    async_result = AsyncResult(task_id, app=celery_app)
    normalized_status = _normalize_status(async_result.state)
    meta = _extract_meta(async_result)
    return EMAP1TaskStatusResponse(
        task_id=task_id,
        status=normalized_status,
        progress=_progress_from_meta(meta, normalized_status),
        error=meta.get("error"),
        created_at=meta.get("created_at"),
        started_at=meta.get("started_at"),
        finished_at=meta.get("finished_at"),
    )


@router.get("/tasks/{task_id}/result")
def get_ert_task_result(
    task_id: str,
    _: User = Depends(get_current_admin_user),
):
    local_result = _LOCAL_ERT_TASK_RESULTS.get(task_id)
    if local_result:
        if local_result["status"] in {"queued", "running"}:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="任务尚未完成")
        if local_result["status"] == "failed":
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=local_result.get("error") or "任务执行失败",
            )
        return local_result.get("result") or {}

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
    local_result = _LOCAL_ERT_TASK_RESULTS.get(task_id)
    if not local_result:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="ERT task not found")
    if local_result.get("status") != "success":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="ERT task is not finished")

    result = local_result.get("result") or {}
    existing_files = _existing_ert_result_files(result)
    if not existing_files:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No ERT result files found")

    project_token = _safe_path_part(payload.project_id, "project")
    source_stem = Path(_safe_path_part(payload.source_file_name, "ert_result")).stem or "ert_result"
    folder_name = source_stem
    folder_token = _safe_path_part(folder_name, "ert_result")
    target_dir = _ERT_ARCHIVE_ROOT / project_token / folder_token
    target_dir.mkdir(parents=True, exist_ok=True)

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
