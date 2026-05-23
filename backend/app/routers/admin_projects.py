from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..deps import _check_project_permission, can_manage_project, get_current_admin_user
from ..models import (
    Project,
    ProjectActivityLog,
    ProjectFile,
    ProjectInvitation,
    ProjectMember,
    SurveyLine,
    SurveyPoint,
    User,
)
from ..schemas import (
    ProjectActivityLogOut,
    ProjectDetailOut,
    ProjectDetailResponse,
    ProjectFileOut,
    ProjectInvitationOut,
    ProjectListItemOut,
    ProjectListResponse,
    ProjectMemberOut,
    ProjectWriteIn,
    SurveyLineDetailOut,
    SurveyPointOut,
)
from ..services.auto_match import auto_match_project_files

router = APIRouter(prefix="/admin/projects", tags=["admin-projects"])


def _serialize_project_list_item(project: Project) -> ProjectListItemOut:
    point_count = sum(len(line.survey_points) for line in project.survey_lines)
    return ProjectListItemOut.model_validate(
        {
            **project.__dict__,
            "line_count": len(project.survey_lines),
            "point_count": point_count,
        }
    )


def _serialize_survey_line_detail(line: SurveyLine) -> SurveyLineDetailOut:
    return SurveyLineDetailOut.model_validate(
        {
            **line.__dict__,
            "survey_points": [SurveyPointOut.model_validate(point) for point in line.survey_points],
        }
    )


def _upsert_project_graph(project: Project, payload: ProjectWriteIn) -> Project:
    project.external_id = payload.external_id
    project.name = payload.name
    project.location = payload.location
    project.method = payload.method
    project.status = payload.status
    project.manager = payload.manager
    project.center_latitude = payload.center_latitude
    project.center_longitude = payload.center_longitude

    for line_item in payload.survey_lines:
        line = SurveyLine(
            line_code=line_item.line_code,
            instrument=line_item.instrument,
            display_name=line_item.display_name,
            sort_order=line_item.sort_order,
        )
        for point_item in line_item.survey_points:
            line.survey_points.append(
                SurveyPoint(
                    point_code=point_item.point_code,
                    instrument=point_item.instrument,
                    longitude=point_item.longitude,
                    latitude=point_item.latitude,
                    elevation=point_item.elevation,
                    point_status=point_item.point_status,
                    matched_data_count=point_item.matched_data_count,
                    has_existing_data=point_item.has_existing_data,
                    source_coord_file_id=point_item.source_coord_file_id,
                    source_coord_file_name=point_item.source_coord_file_name,
                    matched_data_paths_json=point_item.matched_data_paths_json,
                    sort_order=point_item.sort_order,
                )
        )
        project.survey_lines.append(line)

    for member_item in payload.project_members:
        project.project_members.append(
            ProjectMember(
                user_id=member_item.user_id,
                name=member_item.name,
                account=member_item.account,
                project_role=member_item.project_role,
                status=member_item.status,
                invited_at=member_item.invited_at,
                invited_by=member_item.invited_by,
                joined_at=member_item.joined_at,
                sort_order=member_item.sort_order,
            )
        )

    for file_item in payload.project_files:
        project.project_files.append(
            ProjectFile(
                file_id=file_item.file_id,
                parent_id=file_item.parent_id,
                item_type=file_item.item_type,
                name=file_item.name,
                date=file_item.date,
                size=file_item.size,
                ext=file_item.ext,
                category=file_item.category,
                task_name=file_item.task_name,
                status=file_item.status,
                persisted_blob_id=None,
                metadata_json=file_item.metadata_json,
                sort_order=file_item.sort_order,
            )
        )

    for log_item in payload.activity_logs:
        project.activity_logs.append(
            ProjectActivityLog(
                log_id=log_item.log_id,
                node_id=log_item.node_id,
                node_name=log_item.node_name,
                level=log_item.level,
                title=log_item.title,
                detail=log_item.detail,
                node_status=log_item.node_status,
                actor_name=log_item.actor_name,
                event_time=log_item.event_time,
                sort_order=log_item.sort_order,
            )
        )

    for invitation_item in payload.project_invitations:
        project.project_invitations.append(
            ProjectInvitation(
                invitation_id=invitation_item.invitation_id,
                contact_type=invitation_item.contact_type,
                contact_value=invitation_item.contact_value,
                display_name=invitation_item.display_name,
                project_role=invitation_item.project_role,
                status=invitation_item.status,
                recipient_status=invitation_item.recipient_status,
                invite_channel=invitation_item.invite_channel,
                invite_code=invitation_item.invite_code,
                invite_link=invitation_item.invite_link,
                invited_at=invitation_item.invited_at,
                expires_at=invitation_item.expires_at,
                last_sent_at=invitation_item.last_sent_at,
                sent_count=invitation_item.sent_count,
                invited_by=invitation_item.invited_by,
                invited_user_id=invitation_item.invited_user_id,
                revoked_at=invitation_item.revoked_at,
                note=invitation_item.note,
                invite_logs_json=invitation_item.invite_logs_json,
                sort_order=invitation_item.sort_order,
            )
        )

    return project


@router.get("", response_model=ProjectListResponse)
def list_projects(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_admin_user),
):
    projects = (
        db.query(Project)
        .options(
            selectinload(Project.survey_lines).selectinload(SurveyLine.survey_points),
            selectinload(Project.project_members),
            selectinload(Project.project_files),
            selectinload(Project.activity_logs),
            selectinload(Project.project_invitations),
        )
        .order_by(Project.created_at.desc(), Project.id.desc())
        .all()
    )
    items = [_serialize_project_list_item(project) for project in projects]
    return ProjectListResponse(items=items, total=len(items))


@router.get("/{project_id}", response_model=ProjectDetailResponse)
def get_project_detail(
    project_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_admin_user),
):
    project = (
        db.query(Project)
        .options(
            selectinload(Project.survey_lines).selectinload(SurveyLine.survey_points),
            selectinload(Project.project_members),
            selectinload(Project.project_files),
            selectinload(Project.activity_logs),
            selectinload(Project.project_invitations),
        )
        .filter(Project.id == project_id)
        .first()
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")

    return ProjectDetailResponse(
        project=ProjectDetailOut.model_validate(
            {
                **project.__dict__,
                "survey_lines": [
                    _serialize_survey_line_detail(line) for line in project.survey_lines
                ],
                "project_members": [
                    ProjectMemberOut.model_validate(member) for member in project.project_members
                ],
                "project_files": [
                    ProjectFileOut.model_validate(file_item) for file_item in project.project_files
                ],
                "activity_logs": [
                    ProjectActivityLogOut.model_validate(log_item)
                    for log_item in project.activity_logs
                ],
                "project_invitations": [
                    ProjectInvitationOut.model_validate(invitation)
                    for invitation in project.project_invitations
                ],
            }
        )
    )


@router.post("", response_model=ProjectDetailResponse, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectWriteIn,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin_user),
):
    if admin_user.backend_role not in {"super_admin", "admin"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="当前角色无权创建项目")

    exists = db.query(Project).filter(Project.external_id == payload.external_id).first()
    if exists:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目编号已存在")

    project = _upsert_project_graph(Project(), payload)
    db.add(project)
    db.commit()
    db.refresh(project)
    return get_project_detail(project.id, db, admin_user)


@router.put("/{project_id}", response_model=ProjectDetailResponse)
def update_project(
    project_id: int,
    payload: ProjectWriteIn,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin_user),
):
    project = (
        db.query(Project)
        .options(
            selectinload(Project.survey_lines).selectinload(SurveyLine.survey_points),
            selectinload(Project.project_members),
            selectinload(Project.project_files),
            selectinload(Project.activity_logs),
            selectinload(Project.project_invitations),
        )
        .filter(Project.id == project_id)
        .first()
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    if not can_manage_project(project, admin_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="当前角色无权修改项目")

    duplicate = (
        db.query(Project)
        .filter(Project.external_id == payload.external_id, Project.id != project_id)
        .first()
    )
    if duplicate:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目编号已存在")

    project.survey_lines.clear()
    project.project_members.clear()
    project.project_files.clear()
    project.activity_logs.clear()
    project.project_invitations.clear()
    db.flush()
    _upsert_project_graph(project, payload)
    db.add(project)
    db.commit()
    db.refresh(project)
    return get_project_detail(project.id, db, admin_user)


@router.post("/{project_id}/auto-match", status_code=status.HTTP_200_OK)
def trigger_auto_match(
    project_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin_user),
):
    project = (
        db.query(Project)
        .options(
            selectinload(Project.survey_lines).selectinload(SurveyLine.survey_points),
        )
        .filter(Project.id == project_id)
        .first()
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    if not can_manage_project(project, admin_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="当前角色无权执行匹配")

    result = auto_match_project_files(db, project)
    return result

@router.delete("/{project_id}")
def delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    if not _check_project_permission(project, admin_user, min_role="owner"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="当前角色无权删除项目")

    db.delete(project)
    db.commit()
    return {"ok": True, "project_id": project_id}
