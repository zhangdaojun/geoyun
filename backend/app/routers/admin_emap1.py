from __future__ import annotations

import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict

from celery.result import AsyncResult
from fastapi import APIRouter, Depends, HTTPException
from starlette import status

from ..celery_app import celery_app
from ..deps import get_current_admin_user
from ..models import User
from ..schemas import (
    EMAP1BatchProcessRequest,
    EMAP1ProcessRequest,
    EMAP1SimpegLineRequest,
    EMAP1SimpegLineResponse,
    EMAP1TaskCreateResponse,
    EMAP1TaskProgress,
    EMAP1TaskStatusResponse,
)
from ..services.simpeg_mt2d_line import (
    SimpegComputeConfig,
    build_simpeg_input_from_records,
    run_simpeg_forward,
)
from ..tasks.emap1_tasks import run_emap1_batch_process_task, run_emap1_process_task

router = APIRouter(prefix="/admin/emap1", tags=["admin-emap1"])


def _submit_task(task, payload: Dict[str, Any]) -> EMAP1TaskCreateResponse:
    try:
        async_result = task.apply_async(args=[payload])
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"无法提交后台任务：{exc}",
        ) from exc
    return EMAP1TaskCreateResponse(task_id=async_result.id, status="queued")


def _normalize_status(state: str) -> str:
    state_upper = str(state or "").upper()
    if state_upper == "SUCCESS":
        return "success"
    if state_upper == "FAILURE":
        return "failed"
    if state_upper == "REVOKED":
        return "revoked"
    if state_upper in {"STARTED", "PROGRESS", "RETRY"}:
        return "running"
    return "queued"


def _extract_meta(async_result: AsyncResult) -> Dict[str, Any]:
    info = async_result.info
    if isinstance(info, dict):
        return info
    if async_result.failed() and info is not None:
        return {"error": str(info)}
    return {}


def _progress_from_meta(meta: Dict[str, Any], normalized_status: str) -> EMAP1TaskProgress:
    progress = meta.get("progress") if isinstance(meta, dict) else None
    if not isinstance(progress, dict):
        if normalized_status == "success":
            progress = {"current": 1, "total": 1, "percent": 100, "message": "任务完成"}
        elif normalized_status == "failed":
            progress = {"current": 0, "total": 0, "percent": 100, "message": "任务失败"}
        else:
            progress = {"current": 0, "total": 0, "percent": 0, "message": "任务排队中"}
    return EMAP1TaskProgress.model_validate(progress)


@router.post("/process", response_model=EMAP1TaskCreateResponse)
def process_emap1(
    payload: EMAP1ProcessRequest,
    _: User = Depends(get_current_admin_user),
):
    return _submit_task(run_emap1_process_task, payload.model_dump(mode="json"))


@router.post("/batch-process", response_model=EMAP1TaskCreateResponse)
def batch_process_emap1(
    payload: EMAP1BatchProcessRequest,
    _: User = Depends(get_current_admin_user),
):
    return _submit_task(run_emap1_batch_process_task, payload.model_dump(mode="json"))


@router.post("/simpeg-line", response_model=EMAP1SimpegLineResponse)
def build_simpeg_line(
    payload: EMAP1SimpegLineRequest,
    _: User = Depends(get_current_admin_user),
):
    if not payload.records:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="缺少测线视电阻率数据")

    output_dir = Path(tempfile.gettempdir()) / "geoyun_simpeg" / (payload.line_code or "line")
    try:
        export_result = build_simpeg_input_from_records(
            [record.model_dump(mode="json", exclude_none=True) for record in payload.records],
            output_dir,
            line_code=payload.line_code,
            components=payload.components,
            default_station_spacing_m=payload.default_station_spacing_m,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    response: Dict[str, Any] = {"export": asdict(export_result)}
    if payload.run_simpeg:
        try:
            response["simpeg"] = run_simpeg_forward(
                export_result.simpeg_npz,
                export_result.output_dir,
                config=SimpegComputeConfig(
                    background_resistivity_ohm_m=payload.background_resistivity_ohm_m
                ),
            )
        except RuntimeError as exc:
            response["simpeg"] = {
                "status": "skipped",
                "reason": str(exc),
                "process": [
                    "Exported SimPEG input files",
                    "Skipped SimPEG calculation because optional runtime packages are missing",
                ],
            }
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"SimPEG 计算失败：{exc}",
            ) from exc
    return response


@router.get("/tasks/{task_id}", response_model=EMAP1TaskStatusResponse)
def get_emap1_task_status(
    task_id: str,
    _: User = Depends(get_current_admin_user),
):
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
def get_emap1_task_result(
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
