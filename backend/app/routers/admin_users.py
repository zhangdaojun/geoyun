from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_admin_user
from ..models import AdminOperationLog, User, UserLoginLog
from ..schemas import (
    AdminOperationLogOut,
    UserDetailOut,
    UserDetailResponse,
    UserListItem,
    UserListResponse,
    UserLoginLogOut,
    UserStatusResponse,
)

router = APIRouter(prefix="/admin/users", tags=["admin-users"])


def _create_admin_log(
    db: Session,
    *,
    admin_user: User,
    target_user: User,
    action: str,
    detail: str,
    request: Request,
) -> AdminOperationLog:
    log = AdminOperationLog(
        admin_user_id=admin_user.id,
        target_user_id=target_user.id,
        action=action,
        detail=detail,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    db.add(log)
    return log


def _serialize_user_list_item(db: Session, user: User) -> UserListItem:
    login_log_count = db.query(UserLoginLog).filter(UserLoginLog.user_id == user.id).count()
    admin_operation_count = (
        db.query(AdminOperationLog)
        .filter(AdminOperationLog.target_user_id == user.id)
        .count()
    )
    return UserListItem.model_validate(
        {
            **user.__dict__,
            "login_log_count": login_log_count,
            "admin_operation_count": admin_operation_count,
        }
    )


def _serialize_user_detail(db: Session, user: User) -> UserDetailOut:
    recent_login_logs = (
        db.query(UserLoginLog)
        .filter(UserLoginLog.user_id == user.id)
        .order_by(UserLoginLog.created_at.desc(), UserLoginLog.id.desc())
        .limit(20)
        .all()
    )
    recent_admin_logs = (
        db.query(AdminOperationLog)
        .filter(AdminOperationLog.target_user_id == user.id)
        .order_by(AdminOperationLog.created_at.desc(), AdminOperationLog.id.desc())
        .limit(20)
        .all()
    )
    return UserDetailOut.model_validate(
        {
            **user.__dict__,
            "recent_login_logs": [
                UserLoginLogOut.model_validate(log) for log in recent_login_logs
            ],
            "recent_admin_operation_logs": [
                AdminOperationLogOut.model_validate(log) for log in recent_admin_logs
            ],
        }
    )


@router.get("", response_model=UserListResponse)
def list_users(
    keyword: str = Query(default="", alias="q"),
    status_filter: str = Query(default="", alias="status"),
    role_filter: str = Query(default="", alias="backendRole"),
    company_filter: str = Query(default="", alias="company"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_admin_user),
):
    query = db.query(User).order_by(User.created_at.desc(), User.id.desc())

    if keyword:
        like_keyword = f"%{keyword.strip()}%"
        query = query.filter(
            (User.account.like(like_keyword))
            | (User.name.like(like_keyword))
            | (User.phone.like(like_keyword))
            | (User.email.like(like_keyword))
            | (User.company.like(like_keyword))
        )
    if status_filter:
        query = query.filter(User.status == status_filter)
    if role_filter:
        query = query.filter(User.backend_role == role_filter)
    if company_filter:
        query = query.filter(User.company == company_filter)

    users = query.all()
    items = [_serialize_user_list_item(db, user) for user in users]
    return UserListResponse(items=items, total=len(items))


@router.get("/{user_id}", response_model=UserDetailResponse)
def get_user_detail(
    user_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_admin_user),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="用户不存在",
        )
    return UserDetailResponse(user=_serialize_user_detail(db, user))


@router.post("/{user_id}/disable", response_model=UserStatusResponse)
def disable_user(
    user_id: int,
    request: Request,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin_user),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="用户不存在",
        )
    if user.status == "disabled":
        return UserStatusResponse(user=user, message="用户已经是禁用状态。")

    user.status = "disabled"
    user.disabled_at = datetime.utcnow()
    user.token_version += 1
    _create_admin_log(
        db,
        admin_user=admin_user,
        target_user=user,
        action="disable-user",
        detail=f"禁用用户 {user.account}，并使现有 token 失效。",
        request=request,
    )
    db.commit()
    db.refresh(user)
    return UserStatusResponse(user=user, message="用户已禁用。")


@router.post("/{user_id}/enable", response_model=UserStatusResponse)
def enable_user(
    user_id: int,
    request: Request,
    db: Session = Depends(get_db),
    admin_user: User = Depends(get_current_admin_user),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="用户不存在",
        )
    if user.status != "disabled":
        return UserStatusResponse(user=user, message="用户当前无需启用。")

    user.status = "active"
    user.disabled_at = None
    user.token_version += 1
    _create_admin_log(
        db,
        admin_user=admin_user,
        target_user=user,
        action="enable-user",
        detail=f"启用用户 {user.account}，并刷新 token 版本。",
        request=request,
    )
    db.commit()
    db.refresh(user)
    return UserStatusResponse(user=user, message="用户已启用。")
