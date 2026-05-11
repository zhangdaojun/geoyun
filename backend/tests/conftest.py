from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "admin-test.sqlite3"
    monkeypatch.setenv("ADMIN_DATABASE_URL", f"sqlite:///{db_path.as_posix()}")
    monkeypatch.setenv("ADMIN_CELERY_TASK_ALWAYS_EAGER", "1")
    monkeypatch.setenv("ADMIN_REDIS_URL", "redis://127.0.0.1:6379/15")
    monkeypatch.setenv("OSS_ACCESS_KEY_ID", "")
    monkeypatch.setenv("OSS_ACCESS_KEY_SECRET", "")
    monkeypatch.setenv("OSS_ENDPOINT", "")
    monkeypatch.setenv("OSS_BUCKET_NAME", "")

    from backend.app.config import get_settings

    get_settings.cache_clear()

    from backend.app import database
    from backend.app.celery_app import configure_celery
    from backend.app.main import app

    configure_celery()
    database.configure_database(os.environ["ADMIN_DATABASE_URL"])
    database.Base.metadata.drop_all(bind=database.engine)
    database.Base.metadata.create_all(bind=database.engine)

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def admin_headers(client):
    response = client.post(
        "/admin/auth/login/password",
        json={"identifier": "admin", "password": "123456"},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest.fixture()
def support_headers(client):
    response = client.post(
        "/admin/auth/login/password",
        json={"identifier": "support", "password": "123456"},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['token']}"}
