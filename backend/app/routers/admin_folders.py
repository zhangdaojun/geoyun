from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import can_manage_project, get_current_admin_user
from ..models import FileOperationLog, FileRecord, FolderRecord, Project, User
from ..schemas import FolderRecordListResponse, FolderRecordOut, FolderWriteIn

router = APIRouter(prefix="/admin/folders", tags=["admin-folders"])


def _serialize_folder_record(record: FolderRecord) -> FolderRecordOut:
    return FolderRecordOut.model_validate(record)


@router.get("", response_model=FolderRecordListResponse)
def list_folders(
    project_id: Optional[int] = Query(default=None, alias="projectId"),
    status_filter: Optional[str] = Query(default="active", alias="status"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_admin_user),
):
    query = db.query(FolderRecord).order_by(FolderRecord.sort_order.asc(), FolderRecord.id.asc())
    if project_id is not None:
        query = query.filter(FolderRecord.project_id == project_id)
    if status_filter:
        query = query.filter(FolderRecord.status == status_filter)

    records = query.all()
    return FolderRecordListResponse(
        items=[_serialize_folder_record(record) for record in records],
        total=len(records),
    )


@router.post("", response_model=FolderRecordOut, status_code=status.HTTP_201_CREATED)
def upsert_folder(
    payload: FolderWriteIn,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin_user),
):
    project = db.query(Project).filter(Project.id == payload.project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if not can_manage_project(project, admin_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前角色无权维护项目目录",
        )

    record = (
        db.query(FolderRecord)
        .filter(
            FolderRecord.project_id == payload.project_id,
            FolderRecord.external_folder_id == payload.external_folder_id,
        )
        .first()
    )
    if record is None:
        record = FolderRecord(
            project_id=payload.project_id,
            external_folder_id=payload.external_folder_id,
        )
        db.add(record)

    record.parent_external_folder_id = payload.parent_external_folder_id
    record.name = payload.name
    record.category = payload.category
    record.task_name = payload.task_name
    record.survey_method = payload.survey_method
    record.instrument_type = payload.instrument_type
    record.instrument_label = payload.instrument_label
    record.status = payload.status or "active"
    record.metadata_json = payload.metadata_json
    record.sort_order = payload.sort_order

    db.commit()
    db.refresh(record)
    return _serialize_folder_record(record)


@router.put("/{external_folder_id}", response_model=FolderRecordOut)
def update_folder(
    external_folder_id: str,
    payload: FolderWriteIn,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin_user),
):
    project = db.query(Project).filter(Project.id == payload.project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if not can_manage_project(project, admin_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前角色无权维护项目目录",
        )

    record = (
        db.query(FolderRecord)
        .filter(
            FolderRecord.project_id == payload.project_id,
            FolderRecord.external_folder_id == external_folder_id,
        )
        .first()
    )
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")

    record.parent_external_folder_id = payload.parent_external_folder_id
    record.name = payload.name
    record.category = payload.category
    record.task_name = payload.task_name
    record.survey_method = payload.survey_method
    record.instrument_type = payload.instrument_type
    record.instrument_label = payload.instrument_label
    record.status = payload.status or "active"
    record.metadata_json = payload.metadata_json
    record.sort_order = payload.sort_order

    db.commit()
    db.refresh(record)
    return _serialize_folder_record(record)


@router.delete("/{external_folder_id}")
def delete_folder(
    external_folder_id: str,
    project_id: int = Query(alias="projectId"),
    request: Request = None,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    if not can_manage_project(project, admin_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前角色无权维护项目目录",
        )

    folders = (
        db.query(FolderRecord)
        .filter(FolderRecord.project_id == project_id)
        .order_by(FolderRecord.sort_order.asc(), FolderRecord.id.asc())
        .all()
    )
    record = next((item for item in folders if item.external_folder_id == external_folder_id), None)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")

    folder_ids_to_delete = set()
    queue = [external_folder_id]
    while queue:
        current_id = queue.pop(0)
        if current_id in folder_ids_to_delete:
            continue
        folder_ids_to_delete.add(current_id)
        queue.extend(
            item.external_folder_id
            for item in folders
            if (
                item.parent_external_folder_id == current_id
                and item.external_folder_id not in folder_ids_to_delete
            )
        )

    project_files = (
        db.query(FileRecord)
        .filter(FileRecord.owner_type == "project", FileRecord.owner_id == project_id)
        .all()
    )
    for file_record in project_files:
        parent_id = (file_record.metadata_json or {}).get("parent_id")
        if parent_id in folder_ids_to_delete:
            file_record.status = "deleted"
            file_record.deleted_at = file_record.deleted_at or datetime.utcnow()
            db.add(
                FileOperationLog(
                    file_id=file_record.id,
                    operator_id=admin_user.id,
                    operation_type="delete",
                    result="success",
                    ip_address=request.client.host if request and request.client else None,
                    user_agent=request.headers.get("user-agent") if request else None,
                    extra_data={
                        "source": "admin-folder-delete",
                        "external_folder_id": external_folder_id,
                        "deleted_folder_ids": sorted(folder_ids_to_delete),
                    },
                )
            )

    for folder in folders:
        if folder.external_folder_id in folder_ids_to_delete:
            db.delete(folder)

    db.commit()
    return {"ok": True, "deleted_folder_ids": sorted(folder_ids_to_delete)}
