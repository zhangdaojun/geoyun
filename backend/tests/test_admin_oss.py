from __future__ import annotations


def test_upload_policy_requires_oss_configuration(client, admin_headers):
    policy_response = client.get(
        "/admin/oss/upload-policy",
        params={"project_id": "PJ-LOCAL", "file_name": "sample.dat"},
        headers=admin_headers,
    )
    assert policy_response.status_code == 503
    assert policy_response.json()["detail"] == "OSS is not configured"


def test_download_url_requires_oss_configuration(client, admin_headers):
    download_url_response = client.get(
        "/admin/oss/download-url",
        params={"object_key": "projects/PJ-LOCAL/sample.dat"},
        headers=admin_headers,
    )
    assert download_url_response.status_code == 503
    assert download_url_response.json()["detail"] == "OSS is not configured"
