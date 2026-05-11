from __future__ import annotations


def test_list_projects_returns_seeded_hierarchy(client, admin_headers):
    response = client.get("/admin/projects", headers=admin_headers)
    assert response.status_code == 200

    payload = response.json()
    assert payload["total"] >= 2
    assert any(item["external_id"] == "PJ-2023-002" for item in payload["items"])
    assert any(item["line_count"] >= 1 for item in payload["items"])
    assert any(item["point_count"] >= 1 for item in payload["items"])


def test_project_detail_returns_lines_and_points(client, admin_headers):
    list_response = client.get("/admin/projects", headers=admin_headers)
    assert list_response.status_code == 200
    target_project_id = list_response.json()["items"][0]["id"]

    response = client.get(f"/admin/projects/{target_project_id}", headers=admin_headers)
    assert response.status_code == 200

    payload = response.json()["project"]
    assert payload["survey_lines"]
    assert payload["survey_lines"][0]["survey_points"]


def test_project_detail_returns_404_for_missing_project(client, admin_headers):
    response = client.get("/admin/projects/999999", headers=admin_headers)
    assert response.status_code == 404
    assert response.json()["detail"] == "项目不存在"


def test_create_project_with_lines_and_points(client, admin_headers):
    payload = {
        "external_id": "PJ-NEW-001",
        "name": "新建数据库项目",
        "location": "青海省西宁市",
        "method": "大地电磁",
        "status": "planning",
        "manager": "张三",
        "center_latitude": 36.6171,
        "center_longitude": 101.7782,
        "project_members": [
            {
                "user_id": "u_admin",
                "name": "管理员",
                "account": "admin",
                "project_role": "owner",
                "status": "active",
                "joined_at": "2026-04-21 15:00:00",
                "sort_order": 0,
            }
        ],
        "project_files": [
            {
                "file_id": "PJ-NEW-001_design",
                "parent_id": None,
                "item_type": "folder",
                "name": "01_方案设计",
                "category": "design",
                "task_name": "方案规划",
                "metadata_json": {"instrumentType": "EH4"},
                "sort_order": 0,
            }
        ],
        "activity_logs": [
            {
                "log_id": "log_create_project",
                "node_id": "planning",
                "node_name": "方案规划",
                "level": "info",
                "title": "创建项目",
                "detail": "完成初始项目创建",
                "actor_name": "管理员",
                "event_time": "2026-04-21 15:00:00",
                "sort_order": 0,
            }
        ],
        "project_invitations": [
            {
                "invitation_id": "invite_001",
                "contact_type": "phone",
                "contact_value": "13800138000",
                "project_role": "viewer",
                "status": "pending",
                "recipient_status": "unregistered",
                "invite_channel": "sms",
                "invite_code": "ABCD1234",
                "invite_link": "geoyun://invite/PJ-NEW-001/ABCD1234",
                "invited_at": "2026-04-21 15:00:00",
                "sent_count": 1,
                "invited_by": "管理员",
                "invite_logs_json": [],
                "sort_order": 0,
            }
        ],
        "survey_lines": [
            {
                "line_code": "L-01",
                "instrument": "EH4",
                "display_name": "测线 L-01 · EH4",
                "sort_order": 0,
                "survey_points": [
                    {
                        "point_code": "001",
                        "instrument": "EH4",
                        "longitude": 101.7782,
                        "latitude": 36.6171,
                        "elevation": 2265.0,
                        "point_status": "pending",
                        "matched_data_count": 0,
                        "has_existing_data": False,
                        "source_coord_file_id": "coord_file_001",
                        "source_coord_file_name": "西南铁路沿线滑坡监测设计坐标.xlsx",
                        "matched_data_paths_json": ["02_野外采集/22/GEGZ.0026.FH"],
                        "sort_order": 0,
                    }
                ],
            }
        ],
    }
    response = client.post("/admin/projects", headers=admin_headers, json=payload)
    assert response.status_code == 201
    body = response.json()["project"]
    assert body["external_id"] == "PJ-NEW-001"
    assert len(body["survey_lines"]) == 1
    assert len(body["survey_lines"][0]["survey_points"]) == 1
    first_point = body["survey_lines"][0]["survey_points"][0]
    assert first_point["source_coord_file_id"] == "coord_file_001"
    assert first_point["matched_data_paths_json"] == ["02_野外采集/22/GEGZ.0026.FH"]
    assert len(body["project_members"]) == 1
    assert len(body["project_files"]) == 1
    assert len(body["activity_logs"]) == 1
    assert len(body["project_invitations"]) == 1


def test_update_project_replaces_line_points(client, admin_headers):
    list_response = client.get("/admin/projects", headers=admin_headers)
    project_id = next(
        item["id"]
        for item in list_response.json()["items"]
        if item["external_id"] == "PJ-2023-002"
    )
    detail_response = client.get(f"/admin/projects/{project_id}", headers=admin_headers)
    project = detail_response.json()["project"]

    payload = {
        "external_id": project["external_id"],
        "name": project["name"],
        "location": project["location"],
        "method": project["method"],
        "status": "active",
        "manager": project["manager"],
        "center_latitude": project["center_latitude"],
        "center_longitude": project["center_longitude"],
        "survey_lines": [
            {
                "line_code": "0",
                "instrument": "EH4",
                "display_name": "测线 0 · EH4",
                "sort_order": 0,
                "survey_points": [
                    {
                        "point_code": "99999",
                        "instrument": "EH4",
                        "longitude": 80.79999,
                        "latitude": 30.99999,
                        "elevation": 4000.0,
                        "point_status": "matched",
                        "matched_data_count": 1,
                        "has_existing_data": True,
                        "source_coord_file_id": "coord_file_99999",
                        "source_coord_file_name": "更新坐标.xlsx",
                        "matched_data_paths_json": ["02_野外采集/22/ZGEGZ.999"],
                        "sort_order": 0,
                    }
                ],
            }
        ],
    }

    response = client.put(f"/admin/projects/{project_id}", headers=admin_headers, json=payload)
    assert response.status_code == 200
    body = response.json()["project"]
    assert len(body["survey_lines"]) == 1
    updated_point = body["survey_lines"][0]["survey_points"][0]
    assert updated_point["point_code"] == "99999"
    assert updated_point["matched_data_paths_json"] == ["02_野外采集/22/ZGEGZ.999"]


def test_delete_project_removes_project(client, admin_headers):
    create_payload = {
        "external_id": "PJ-DELETE-001",
        "name": "待删除项目",
        "location": "测试区域",
        "method": "大地电磁",
        "status": "planning",
        "manager": "管理员",
        "center_latitude": 30.1,
        "center_longitude": 80.2,
        "survey_lines": [
            {
                "line_code": "L-02",
                "instrument": "F3",
                "display_name": "测线 L-02 · F3",
                "sort_order": 0,
                "survey_points": [
                    {
                        "point_code": "010",
                        "instrument": "F3",
                        "longitude": 80.2,
                        "latitude": 30.1,
                        "elevation": 4500.0,
                        "point_status": "pending",
                        "matched_data_count": 0,
                        "has_existing_data": False,
                        "sort_order": 0,
                    }
                ],
            }
        ],
    }
    create_response = client.post("/admin/projects", headers=admin_headers, json=create_payload)
    assert create_response.status_code == 201
    project_id = create_response.json()["project"]["id"]

    delete_response = client.delete(f"/admin/projects/{project_id}", headers=admin_headers)
    assert delete_response.status_code == 200
    assert delete_response.json()["ok"] is True

    detail_response = client.get(f"/admin/projects/{project_id}", headers=admin_headers)
    assert detail_response.status_code == 404


def test_support_can_update_project_when_project_has_no_members(
    client,
    admin_headers,
    support_headers,
):
    list_response = client.get("/admin/projects", headers=admin_headers)
    project_id = next(
        item["id"]
        for item in list_response.json()["items"]
        if item["external_id"] == "PJ-2023-003"
    )
    detail_response = client.get(f"/admin/projects/{project_id}", headers=admin_headers)
    project = detail_response.json()["project"]

    payload = {
        "external_id": project["external_id"],
        "name": project["name"],
        "location": project["location"],
        "method": project["method"],
        "status": "active",
        "manager": project["manager"],
        "center_latitude": project["center_latitude"],
        "center_longitude": project["center_longitude"],
        "survey_lines": project["survey_lines"],
        "project_members": project["project_members"],
        "project_files": project["project_files"],
        "activity_logs": project["activity_logs"],
        "project_invitations": project["project_invitations"],
    }

    response = client.put(f"/admin/projects/{project_id}", headers=support_headers, json=payload)
    assert response.status_code == 200
    assert response.json()["project"]["status"] == "active"
