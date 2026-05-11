from __future__ import annotations

from backend.app.database import db_session
from backend.app.models import AdminOperationLog, User, UserLoginLog


def test_list_users_returns_seeded_admins(client, admin_headers):
    response = client.get("/admin/users", headers=admin_headers)
    assert response.status_code == 200

    payload = response.json()
    assert payload["total"] >= 2
    assert any(item["account"] == "admin" for item in payload["items"])


def test_user_detail_contains_login_and_admin_logs(client, admin_headers):
    with db_session() as db:
        target = db.query(User).filter(User.account == "ops_admin").first()
        db.add(
            UserLoginLog(
                user_id=target.id,
                login_type="password",
                login_status="success",
                ip_address="127.0.0.1",
                user_agent="pytest",
                token_version=target.token_version,
            )
        )
        db.add(
            AdminOperationLog(
                admin_user_id=1,
                target_user_id=target.id,
                action="update-user",
                detail="更新用户资料",
                ip_address="127.0.0.1",
                user_agent="pytest",
            )
        )

    response = client.get("/admin/users/2", headers=admin_headers)
    assert response.status_code == 200
    payload = response.json()["user"]
    assert payload["account"] == "ops_admin"
    assert len(payload["recent_login_logs"]) == 1
    assert len(payload["recent_admin_operation_logs"]) == 1


def test_disable_user_updates_status_and_token_version(client, admin_headers):
    before = client.get("/admin/users/2", headers=admin_headers).json()["user"]
    response = client.post("/admin/users/2/disable", headers=admin_headers)
    assert response.status_code == 200

    payload = response.json()
    assert payload["user"]["status"] == "disabled"
    assert payload["user"]["token_version"] == before["token_version"] + 1

    with db_session() as db:
        log = (
            db.query(AdminOperationLog)
            .filter(
                AdminOperationLog.target_user_id == 2,
                AdminOperationLog.action == "disable-user",
            )
            .order_by(AdminOperationLog.id.desc())
            .first()
        )
        assert log is not None


def test_enable_user_updates_status_and_writes_admin_log(client, admin_headers):
    client.post("/admin/users/2/disable", headers=admin_headers)
    response = client.post("/admin/users/2/enable", headers=admin_headers)
    assert response.status_code == 200
    payload = response.json()
    assert payload["user"]["status"] == "active"

    with db_session() as db:
        actions = [
            item.action
            for item in db.query(AdminOperationLog)
            .filter(AdminOperationLog.target_user_id == 2)
            .order_by(AdminOperationLog.id.asc())
            .all()
        ]
        assert "disable-user" in actions
        assert "enable-user" in actions
