from __future__ import annotations


def _first_project_id(client, admin_headers):
    response = client.get("/admin/projects", headers=admin_headers)
    assert response.status_code == 200
    return response.json()["items"][0]["id"]


def _oss_fields(file_id: str):
    return {
        "storage_provider": "oss",
        "bucket_name": "geoyun",
        "object_key": f"projects/test/{file_id}",
    }


def test_create_file_operation_upserts_file_and_writes_log(client, admin_headers):
    project_id = _first_project_id(client, admin_headers)

    payload = {
        "operations": [
            {
                "project_id": project_id,
                "external_file_id": "fid_upload_001",
                "file_name": "ZGEGZ.026",
                "item_type": "file",
                "file_ext": "edi",
                "mime_type": "application/octet-stream",
                "file_size": "1.50 MB",
                **_oss_fields("fid_upload_001"),
                "access_level": "project_shared",
                "status": "active",
                "operation_type": "upload",
                "result": "success",
                "extra_data": {
                    "category": "processed",
                    "task_name": "处理解释",
                },
            }
        ]
    }

    response = client.post("/admin/files/operations", headers=admin_headers, json=payload)
    assert response.status_code == 201
    body = response.json()
    assert body["total"] == 1
    assert body["items"][0]["operation_type"] == "upload"
    assert body["items"][0]["file"]["external_file_id"] == "fid_upload_001"
    assert body["items"][0]["file"]["file_size"] == 1572864
    assert body["items"][0]["file"]["storage_provider"] == "oss"
    assert body["items"][0]["file"]["metadata_json"]["object_key"] == "projects/test/fid_upload_001"


def test_delete_file_operation_marks_file_deleted(client, admin_headers):
    project_id = _first_project_id(client, admin_headers)
    create_payload = {
        "operations": [
            {
                "project_id": project_id,
                "external_file_id": "fid_delete_001",
                "file_name": "YGEGZ.026",
                "item_type": "file",
                "file_ext": "026",
                "file_size": 1024,
                "status": "active",
                **_oss_fields("fid_delete_001"),
                "operation_type": "upload",
                "result": "success",
                "extra_data": {},
            }
        ]
    }
    create_response = client.post(
        "/admin/files/operations",
        headers=admin_headers,
        json=create_payload,
    )
    assert create_response.status_code == 201

    delete_payload = {
        "operations": [
            {
                "project_id": project_id,
                "external_file_id": "fid_delete_001",
                "file_name": "YGEGZ.026",
                "item_type": "file",
                "file_ext": "026",
                "file_size": 1024,
                "status": "deleted",
                **_oss_fields("fid_delete_001"),
                "operation_type": "delete",
                "result": "success",
                "extra_data": {"source": "data-drive"},
            }
        ]
    }
    delete_response = client.post(
        "/admin/files/operations",
        headers=admin_headers,
        json=delete_payload,
    )
    assert delete_response.status_code == 201
    item = delete_response.json()["items"][0]
    assert item["operation_type"] == "delete"
    assert item["file"]["status"] == "deleted"


def test_list_file_operations_supports_project_filter(client, admin_headers):
    project_id = _first_project_id(client, admin_headers)
    payload = {
        "operations": [
            {
                "project_id": project_id,
                "external_file_id": "fid_preview_001",
                "file_name": "XGEGZ.026",
                "item_type": "file",
                "file_ext": "026",
                "file_size": 2048,
                "status": "active",
                **_oss_fields("fid_preview_001"),
                "operation_type": "preview",
                "result": "success",
                "extra_data": {"view": "x-parser"},
            }
        ]
    }
    create_response = client.post("/admin/files/operations", headers=admin_headers, json=payload)
    assert create_response.status_code == 201

    list_response = client.get(
        f"/admin/files/operations?projectId={project_id}&operationType=preview",
        headers=admin_headers,
    )
    assert list_response.status_code == 200
    body = list_response.json()
    assert body["total"] >= 1
    assert any(item["file"]["external_file_id"] == "fid_preview_001" for item in body["items"])


def test_list_files_returns_active_project_files(client, admin_headers):
    project_id = _first_project_id(client, admin_headers)
    payload = {
        "operations": [
            {
                "project_id": project_id,
                "external_file_id": "fid_list_001",
                "file_name": "survey.txt",
                "item_type": "file",
                "parent_id": "folder_001",
                "file_ext": "txt",
                "file_size": 512,
                "status": "active",
                **_oss_fields("fid_list_001"),
                "operation_type": "upload",
                "result": "success",
                "extra_data": {"category": "docs", "taskName": "项目资料"},
            }
        ]
    }
    create_response = client.post("/admin/files/operations", headers=admin_headers, json=payload)
    assert create_response.status_code == 201

    list_response = client.get(f"/admin/files?projectId={project_id}", headers=admin_headers)
    assert list_response.status_code == 200
    body = list_response.json()
    assert body["total"] >= 1
    record = next(item for item in body["items"] if item["external_file_id"] == "fid_list_001")
    assert record["file_name"] == "survey.txt"
    assert record["metadata_json"]["parent_id"] == "folder_001"


def test_update_file_record_supports_rename_and_move(client, admin_headers):
    project_id = _first_project_id(client, admin_headers)
    create_response = client.post(
        "/admin/files/operations",
        headers=admin_headers,
        json={
            "operations": [
                {
                    "project_id": project_id,
                    "external_file_id": "fid_move_001",
                    "file_name": "origin.txt",
                    "item_type": "file",
                    "parent_id": "folder_a",
                    "file_ext": "txt",
                    "file_size": 128,
                    "status": "active",
                    **_oss_fields("fid_move_001"),
                    "operation_type": "upload",
                    "result": "success",
                    "extra_data": {"category": "docs"},
                }
            ]
        },
    )
    assert create_response.status_code == 201

    update_response = client.put(
        "/admin/files/fid_move_001",
        headers=admin_headers,
        json={
            "project_id": project_id,
            "file_name": "renamed.txt",
            "item_type": "file",
            "parent_id": "folder_b",
            "file_ext": "txt",
            "file_size": 128,
            "status": "active",
            **_oss_fields("fid_move_001"),
            "extra_data": {"category": "docs"},
        },
    )
    assert update_response.status_code == 200
    body = update_response.json()
    assert body["file_name"] == "renamed.txt"
    assert body["metadata_json"]["parent_id"] == "folder_b"


def test_support_can_update_project_file_record_when_project_has_no_members(
    client,
    admin_headers,
    support_headers,
):
    project_id = _first_project_id(client, admin_headers)
    create_response = client.post(
        "/admin/files/operations",
        headers=admin_headers,
        json={
            "operations": [
                {
                    "project_id": project_id,
                    "external_file_id": "fid_support_delete_001",
                    "file_name": "support-delete.txt",
                    "item_type": "file",
                    "parent_id": "folder_support",
                    "file_ext": "txt",
                    "file_size": 128,
                    "status": "active",
                    **_oss_fields("fid_support_delete_001"),
                    "operation_type": "upload",
                    "result": "success",
                    "extra_data": {"category": "docs"},
                }
            ]
        },
    )
    assert create_response.status_code == 201

    update_response = client.put(
        "/admin/files/fid_support_delete_001",
        headers=support_headers,
        json={
            "project_id": project_id,
            "file_name": "support-delete.txt",
            "item_type": "file",
            "parent_id": "folder_support",
            "file_ext": "txt",
            "file_size": 128,
            "status": "deleted",
            **_oss_fields("fid_support_delete_001"),
            "extra_data": {"category": "docs"},
        },
    )
    assert update_response.status_code == 200
    assert update_response.json()["status"] == "deleted"
