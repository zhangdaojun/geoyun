from __future__ import annotations


def _first_project_id(client, admin_headers):
    response = client.get("/admin/projects", headers=admin_headers)
    assert response.status_code == 200
    return response.json()["items"][0]["id"]


def test_upsert_folder_and_list_project_folders(client, admin_headers):
    project_id = _first_project_id(client, admin_headers)
    create_response = client.post(
        "/admin/folders",
        headers=admin_headers,
        json={
            "project_id": project_id,
            "external_folder_id": "folder_raw_001",
            "parent_external_folder_id": None,
            "name": "02_野外采集",
            "category": "raw",
            "task_name": "野外采集",
            "survey_method": "大地电磁法",
            "instrument_type": "EH4",
            "instrument_label": "EH4",
            "status": "active",
            "metadata_json": {"source": "data-drive"},
            "sort_order": 1,
        },
    )
    assert create_response.status_code == 201
    folder = create_response.json()
    assert folder["name"] == "02_野外采集"
    assert folder["category"] == "raw"

    list_response = client.get(f"/admin/folders?projectId={project_id}", headers=admin_headers)
    assert list_response.status_code == 200
    body = list_response.json()
    assert body["total"] >= 1
    assert any(item["external_folder_id"] == "folder_raw_001" for item in body["items"])


def test_update_folder_supports_rename_and_move(client, admin_headers):
    project_id = _first_project_id(client, admin_headers)
    client.post(
        "/admin/folders",
        headers=admin_headers,
        json={
            "project_id": project_id,
            "external_folder_id": "folder_edit_001",
            "name": "原始目录",
            "status": "active",
        },
    )

    update_response = client.put(
        "/admin/folders/folder_edit_001",
        headers=admin_headers,
        json={
            "project_id": project_id,
            "external_folder_id": "folder_edit_001",
            "parent_external_folder_id": "folder_parent_001",
            "name": "重命名目录",
            "status": "active",
        },
    )
    assert update_response.status_code == 200
    body = update_response.json()
    assert body["name"] == "重命名目录"
    assert body["parent_external_folder_id"] == "folder_parent_001"


def test_delete_folder_removes_subtree(client, admin_headers):
    project_id = _first_project_id(client, admin_headers)
    client.post(
        "/admin/folders",
        headers=admin_headers,
        json={
            "project_id": project_id,
            "external_folder_id": "folder_root_001",
            "name": "根目录",
            "status": "active",
        },
    )
    client.post(
        "/admin/folders",
        headers=admin_headers,
        json={
            "project_id": project_id,
            "external_folder_id": "folder_child_001",
            "parent_external_folder_id": "folder_root_001",
            "name": "子目录",
            "status": "active",
        },
    )

    delete_response = client.delete(
        f"/admin/folders/folder_root_001?projectId={project_id}",
        headers=admin_headers,
    )
    assert delete_response.status_code == 200
    deleted_ids = delete_response.json()["deleted_folder_ids"]
    assert "folder_root_001" in deleted_ids
    assert "folder_child_001" in deleted_ids
