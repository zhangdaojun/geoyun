import re
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session, joinedload

from ..database import get_db
from ..deps import can_manage_project, get_current_admin_user
from ..models import FileOperationLog, FileRecord, Project, User
from ..services.oss_service import find_object_key_by_name, get_object_size, is_oss_configured
from ..schemas import (
    FileOperationBatchIn,
    FileOperationListResponse,
    FileOperationLogOut,
    FileRecordListResponse,
    FileRecordOut,
    FileRecordUpdateIn,
)

router = APIRouter(prefix="/admin/files", tags=["admin-files"])

_FILE_SIZE_PATTERN = re.compile(r"^\s*(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>b|kb|mb|gb)?\s*$", re.I)


def _parse_file_size(value: object) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return max(int(value), 0)

    text = str(value).strip()
    if not text:
        return 0

    match = _FILE_SIZE_PATTERN.match(text)
    if not match:
        return 0

    size_value = float(match.group("value"))
    unit = (match.group("unit") or "b").lower()
    factor = {
        "b": 1,
        "kb": 1024,
        "mb": 1024 * 1024,
        "gb": 1024 * 1024 * 1024,
    }.get(unit, 1)
    return max(int(size_value * factor), 0)


def _sanitize_ext(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return str(value).strip().lower().lstrip(".") or None


def _require_oss_object_key(object_key: Optional[str]) -> str:
    normalized = str(object_key or "").strip()
    if not normalized:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="OSS object_key is required for file records",
        )
    return normalized


def _serialize_file_operation(log: FileOperationLog) -> FileOperationLogOut:
    return FileOperationLogOut.model_validate(
        {
            "id": log.id,
            "operation_type": log.operation_type,
            "result": log.result,
            "ip_address": log.ip_address,
            "user_agent": log.user_agent,
            "extra_data": log.extra_data,
            "created_at": log.created_at,
            "operator_id": log.operator_id,
            "file": log.file,
        }
    )


def _serialize_file_record(record: FileRecord) -> FileRecordOut:
    return FileRecordOut.model_validate(record)


def _hydrate_oss_file_sizes(db: Session, records: List[FileRecord]) -> None:
    changed = False
    if is_oss_configured():
        project_external_ids = {}
        for record in records:
            if record.owner_type == "project" and record.owner_id not in project_external_ids:
                project = db.query(Project).filter(Project.id == record.owner_id).first()
                project_external_ids[record.owner_id] = project.external_id if project else ""

            if (
                record.storage_provider != "oss"
                and record.owner_type == "project"
                and record.status == "active"
                and record.file_name
                and int(record.file_size or 0) > 0
            ):
                project_external_id = project_external_ids.get(record.owner_id, "")
                matched_object_key = find_object_key_by_name(
                    f"projects/{project_external_id}/",
                    record.file_name,
                    int(record.file_size or 0),
                )
                if matched_object_key:
                    record.storage_provider = "oss"
                    record.bucket_name = "geoyun"
                    record.object_key = matched_object_key
                    metadata_json = dict(record.metadata_json or {})
                    metadata_json.update({
                        "storage_provider": "oss",
                        "object_key": matched_object_key,
                    })
                    record.metadata_json = metadata_json
                    changed = True

            if (
                record.storage_provider == "oss"
                and int(record.file_size or 0) <= 0
                and record.object_key
                and record.status == "active"
            ):
                object_size = get_object_size(record.object_key)
                if object_size > 0:
                    record.file_size = object_size
                    changed = True

    known_sizes = {}
    for record in records:
        if int(record.file_size or 0) <= 0:
            continue
        metadata_json = record.metadata_json or {}
        key = (
            record.owner_type,
            record.owner_id,
            metadata_json.get("parent_id"),
            record.file_name,
            record.file_ext,
        )
        known_sizes[key] = max(known_sizes.get(key, 0), int(record.file_size or 0))

    for record in records:
        if int(record.file_size or 0) > 0:
            continue
        metadata_json = record.metadata_json or {}
        key = (
            record.owner_type,
            record.owner_id,
            metadata_json.get("parent_id"),
            record.file_name,
            record.file_ext,
        )
        matched_size = known_sizes.get(key, 0)
        if matched_size > 0:
            record.file_size = matched_size
            changed = True

    if changed:
        db.commit()


def _get_file_record(
    db: Session,
    *,
    external_file_id: str,
    project_id: Optional[int] = None,
) -> Optional[FileRecord]:
    query = db.query(FileRecord).filter(FileRecord.external_file_id == external_file_id)
    if project_id is not None:
        query = query.filter(FileRecord.owner_type == "project", FileRecord.owner_id == project_id)
    return query.first()


def _get_project_or_404(db: Session, project_id: int) -> Project:
    project = (
        db.query(Project)
        .options(joinedload(Project.project_members))
        .filter(Project.id == project_id)
        .first()
    )
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


def _upsert_file_record(
    db: Session,
    *,
    project: Project,
    payload,
    admin_user: User,
    request: Request,
) -> FileRecord:
    record = (
        db.query(FileRecord)
        .filter(FileRecord.external_file_id == payload.external_file_id)
        .first()
    )
    if record is None:
        record = FileRecord(
            external_file_id=payload.external_file_id,
            project=project,
        )
        db.add(record)

    storage_provider = str(payload.storage_provider or "oss").strip() or "oss"
    object_key = (
        _require_oss_object_key(payload.object_key)
        if storage_provider == "oss"
        else str(payload.object_key or payload.file_url or payload.external_file_id or "").strip()
    )

    metadata_json = {
        "item_type": payload.item_type,
        "parent_id": payload.parent_id,
        "storage_provider": storage_provider,
        "object_key": object_key,
        **(payload.extra_data or {}),
    }

    record.file_name = payload.file_name
    record.file_ext = _sanitize_ext(payload.file_ext)
    record.mime_type = payload.mime_type
    record.file_size = _parse_file_size(payload.file_size)
    record.storage_provider = storage_provider
    record.bucket_name = payload.bucket_name or ("geoyun" if storage_provider == "oss" else storage_provider)
    record.object_key = object_key
    record.file_url = payload.file_url
    record.access_level = payload.access_level or "project_shared"
    record.checksum_md5 = payload.checksum_md5
    record.checksum_sha256 = payload.checksum_sha256
    record.storage_class = payload.storage_class
    record.version_no = max(int(payload.version_no or 1), 1)
    record.metadata_json = metadata_json
    record.owner_type = "project"
    record.owner_id = project.id

    if payload.operation_type == "delete":
        record.status = "deleted"
        record.deleted_at = record.deleted_at or datetime.utcnow()
    else:
        record.status = "active"
        record.deleted_at = None

    if record.uploaded_by is None:
        record.uploaded_by = admin_user.id
    record.upload_ip = request.client.host if request.client else None
    return record


@router.post(
    "/operations",
    response_model=FileOperationListResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_file_operations(
    payload: FileOperationBatchIn,
    request: Request,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin_user),
):
    if not payload.operations:
        return FileOperationListResponse(items=[], total=0)

    created_logs: List[FileOperationLog] = []
    for item in payload.operations:
        project = _get_project_or_404(db, item.project_id)
        if not can_manage_project(project, admin_user):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="当前角色无权维护项目文件",
            )

        record = _upsert_file_record(
            db,
            project=project,
            payload=item,
            admin_user=admin_user,
            request=request,
        )
        db.flush()

        log = FileOperationLog(
            file_id=record.id,
            operator_id=admin_user.id,
            operation_type=item.operation_type,
            result=item.result or "success",
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            extra_data=item.extra_data,
        )
        db.add(log)
        created_logs.append(log)

    db.commit()

    refreshed_logs = (
        db.query(FileOperationLog)
        .options(joinedload(FileOperationLog.file))
        .filter(FileOperationLog.id.in_([log.id for log in created_logs]))
        .order_by(FileOperationLog.created_at.desc(), FileOperationLog.id.desc())
        .all()
    )
    return FileOperationListResponse(
        items=[_serialize_file_operation(log) for log in refreshed_logs],
        total=len(refreshed_logs),
    )


@router.get("/operations", response_model=FileOperationListResponse)
def list_file_operations(
    project_id: Optional[int] = Query(default=None, alias="projectId"),
    external_file_id: Optional[str] = Query(default=None, alias="externalFileId"),
    operation_type: Optional[str] = Query(default=None, alias="operationType"),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_admin_user),
):
    query = (
        db.query(FileOperationLog)
        .join(FileRecord, FileOperationLog.file_id == FileRecord.id)
        .options(joinedload(FileOperationLog.file))
        .order_by(FileOperationLog.created_at.desc(), FileOperationLog.id.desc())
    )

    if project_id is not None:
        query = query.filter(
            FileRecord.owner_type == "project",
            FileRecord.owner_id == project_id,
        )
    if external_file_id:
        query = query.filter(FileRecord.external_file_id == external_file_id)
    if operation_type:
        query = query.filter(FileOperationLog.operation_type == operation_type)

    logs = query.limit(limit).all()
    return FileOperationListResponse(
        items=[_serialize_file_operation(log) for log in logs],
        total=len(logs),
    )


@router.get("", response_model=FileRecordListResponse)
def list_files(
    project_id: Optional[int] = Query(default=None, alias="projectId"),
    status: Optional[str] = Query(default="active"),
    owner_type: Optional[str] = Query(default=None, alias="ownerType"),
    external_file_id: Optional[str] = Query(default=None, alias="externalFileId"),
    limit: int = Query(default=500, ge=1, le=2000),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_admin_user),
):
    query = db.query(FileRecord).order_by(FileRecord.updated_at.desc(), FileRecord.id.desc())

    if project_id is not None:
        query = query.filter(
            FileRecord.owner_type == "project",
            FileRecord.owner_id == project_id,
        )
    if owner_type:
        query = query.filter(FileRecord.owner_type == owner_type)
    if status:
        query = query.filter(FileRecord.status == status)
    if external_file_id:
        query = query.filter(FileRecord.external_file_id == external_file_id)

    records = query.limit(limit).all()
    return FileRecordListResponse(
        items=[_serialize_file_record(record) for record in records],
        total=len(records),
    )


@router.put("/{external_file_id}", response_model=FileRecordOut)
def update_file_record(
    external_file_id: str,
    payload: FileRecordUpdateIn,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin_user),
):
    project = _get_project_or_404(db, payload.project_id)
    if not can_manage_project(project, admin_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前角色无权维护项目文件",
        )
    record = _get_file_record(db, external_file_id=external_file_id, project_id=payload.project_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    next_storage_provider = str(payload.storage_provider or record.storage_provider or "oss").strip() or "oss"
    next_object_key = (
        _require_oss_object_key(payload.object_key or record.object_key)
        if next_storage_provider == "oss"
        else str(payload.object_key or payload.file_url or record.object_key or record.external_file_id or "").strip()
    )
    metadata_json = dict(record.metadata_json or {})
    metadata_json.update(
        {
            "item_type": payload.item_type or metadata_json.get("item_type", "file"),
            "parent_id": payload.parent_id,
            "storage_provider": next_storage_provider,
            "object_key": next_object_key,
            **(payload.extra_data or {}),
        }
    )

    record.file_name = payload.file_name or record.file_name
    record.file_ext = _sanitize_ext(payload.file_ext) or record.file_ext
    record.mime_type = payload.mime_type or record.mime_type
    record.file_size = _parse_file_size(payload.file_size)
    record.file_url = payload.file_url
    record.access_level = payload.access_level or record.access_level
    record.status = payload.status or record.status
    record.version_no = max(int(payload.version_no or record.version_no or 1), 1)
    record.storage_class = payload.storage_class or record.storage_class
    record.storage_provider = next_storage_provider
    record.bucket_name = payload.bucket_name or record.bucket_name or ("geoyun" if next_storage_provider == "oss" else next_storage_provider)
    record.object_key = next_object_key
    record.metadata_json = metadata_json
    if record.status == "deleted":
        record.deleted_at = record.deleted_at or datetime.utcnow()
    else:
        record.deleted_at = None

    db.commit()
    db.refresh(record)
    return _serialize_file_record(record)
