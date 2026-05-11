import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, status

from ..config import get_settings
from ..deps import get_current_admin_user
from ..models import User
from ..services.oss_service import (
    generate_download_url,
    generate_post_policy,
    is_oss_configured,
)

router = APIRouter(prefix="/admin/oss", tags=["oss"])
settings = get_settings()


@router.get("/upload-policy", response_model=Dict[str, Any])
def get_upload_policy(
    project_id: str,
    file_name: str,
    _: User = Depends(get_current_admin_user),
):
    unique_id = uuid.uuid4().hex
    object_key = f"projects/{project_id}/{unique_id}/{file_name}"

    if not is_oss_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OSS is not configured",
        )

    policy_data = generate_post_policy(object_key=object_key, expire_minutes=15)
    policy_data["provider"] = "oss"
    policy_data["object_key"] = object_key
    return policy_data


@router.get("/download-url", response_model=Dict[str, str])
def get_download_url(
    object_key: str,
    _: User = Depends(get_current_admin_user),
):
    if not is_oss_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OSS is not configured",
        )

    return {"url": generate_download_url(object_key, expire_minutes=60), "provider": "oss"}
