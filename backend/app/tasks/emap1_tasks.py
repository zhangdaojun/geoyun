from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict

from celery import states

from .. import schemas
from ..celery_app import celery_app
from ..services.emap1_processing import process_emap1_batch_request, process_emap1_request


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _progress(current: int, total: int, message: str) -> Dict[str, Any]:
    percent = 0
    if total > 0:
        percent = int(round(max(0, min(current, total)) / total * 100))
    return {
        "current": max(0, int(current)),
        "total": max(0, int(total)),
        "percent": percent,
        "message": message,
    }


def _failure_payload(exc: Exception) -> Dict[str, Any]:
    return {
        "error_type": exc.__class__.__name__,
        "error": str(exc),
        "finished_at": _utc_now(),
    }


@celery_app.task(bind=True, name="emap1.process")
def run_emap1_process_task(self, payload: Dict[str, Any]) -> Dict[str, Any]:
    started_at = _utc_now()
    self.update_state(
        state="PROGRESS",
        meta={
            "status": "running",
            "created_at": started_at,
            "started_at": started_at,
            "progress": _progress(0, 1, "EMAP1/Aurora task started"),
        },
    )
    try:
        request = schemas.EMAP1ProcessRequest.model_validate(payload)
        response = process_emap1_request(request)
        finished_at = _utc_now()
        return {
            "status": "success",
            "kind": "process",
            "created_at": started_at,
            "started_at": started_at,
            "finished_at": finished_at,
            "progress": _progress(1, 1, "EMAP1/Aurora task completed"),
            "result": response.model_dump(mode="json"),
        }
    except Exception as exc:
        meta = {
            "status": "failed",
            "kind": "process",
            "created_at": started_at,
            "started_at": started_at,
            "progress": _progress(1, 1, "EMAP1/Aurora task failed"),
            **_failure_payload(exc),
        }
        self.update_state(state=states.FAILURE, meta=meta)
        raise


@celery_app.task(bind=True, name="emap1.batch_process")
def run_emap1_batch_process_task(self, payload: Dict[str, Any]) -> Dict[str, Any]:
    started_at = _utc_now()

    def report_progress(current: int, total: int, message: str) -> None:
        self.update_state(
            state="PROGRESS",
            meta={
                "status": "running",
                "kind": "batch_process",
                "created_at": started_at,
                "started_at": started_at,
                "progress": _progress(current, total, message),
            },
        )

    report_progress(0, 0, "EMAP1 batch task queued")
    try:
        request = schemas.EMAP1BatchProcessRequest.model_validate(payload)
        response = process_emap1_batch_request(request, progress_callback=report_progress)
        finished_at = _utc_now()
        return {
            "status": "success",
            "kind": "batch_process",
            "created_at": started_at,
            "started_at": started_at,
            "finished_at": finished_at,
            "progress": _progress(
                response.summary.processed_count + response.summary.skipped_count,
                response.summary.total_groups,
                "EMAP1 batch task completed",
            ),
            "result": response.model_dump(mode="json"),
        }
    except Exception as exc:
        meta = {
            "status": "failed",
            "kind": "batch_process",
            "created_at": started_at,
            "started_at": started_at,
            "progress": _progress(0, 0, "EMAP1 batch task failed"),
            **_failure_payload(exc),
        }
        self.update_state(state=states.FAILURE, meta=meta)
        raise

