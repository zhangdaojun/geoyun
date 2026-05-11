from __future__ import annotations

from celery import Celery

from .config import get_settings

celery_app = Celery(
    "geoyun_admin",
    include=[
        "backend.app.tasks.emap1_tasks",
        "backend.app.tasks.ert_tasks",
    ],
)


def configure_celery() -> None:
    settings = get_settings()
    broker_url = "memory://" if settings.celery_task_always_eager else settings.redis_url
    result_backend = "cache+memory://" if settings.celery_task_always_eager else settings.redis_url

    celery_app.conf.update(
        broker_url=broker_url,
        result_backend=result_backend,
        task_track_started=True,
        result_expires=settings.celery_result_expires,
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        timezone="Asia/Shanghai",
        enable_utc=True,
        task_always_eager=settings.celery_task_always_eager,
        task_store_eager_result=True,
    )
    celery_app._backend_cache = None
    if hasattr(celery_app._local, "backend"):
        del celery_app._local.backend


configure_celery()
