from __future__ import annotations

from typing import Optional

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from .database import get_db
from .models import Project, User
from .permissions import BACKEND_ADMIN_ACCESS_ROLES, normalize_backend_role
from .security import ALGORITHM, SECRET_KEY

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="admin/auth/login/password", auto_error=False)

def get_current_user(
    request: Request,
    token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    if not token:
        # fallback to cookie
        token = request.cookies.get("access_token")
        if token and token.startswith("Bearer "):
            token = token[7:]
    
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="缺少认证信息",
        )

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id_str: str = payload.get("sub")
        if user_id_str is None:
            raise HTTPException(status_code=401, detail="无效的认证信息")
        user_id = int(user_id_str)
        token_version = int(payload.get("tokenVersion", 0))
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token 已过期")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="无法验证认证信息")
    except ValueError:
        raise HTTPException(status_code=401, detail="无效的用户 ID")

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=401, detail="用户不存在")
    if int(user.token_version or 0) != token_version:
        raise HTTPException(status_code=401, detail="登录状态已失效，请重新登录")
    if user.status == "disabled":
        raise HTTPException(status_code=403, detail="用户账号已被禁用")

    request.state.current_user = user
    return user

def get_current_admin_user(
    current_user: User = Depends(get_current_user),
) -> User:
    if normalize_backend_role(current_user.backend_role) not in BACKEND_ADMIN_ACCESS_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前角色无权访问后台",
        )
    return current_user


def require_project_read(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    if _check_project_permission(project, current_user, min_role="viewer"):
        return project
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权访问该项目")


def require_project_write(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    if _check_project_permission(project, current_user, min_role="operator"):
        return project
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权修改该项目")


def require_project_owner(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    if _check_project_permission(project, current_user, min_role="owner"):
        return project
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="只有项目所有者才能执行此操作",
    )


def can_manage_project(project: Optional[Project], admin_user: Optional[User]) -> bool:
    if not project or not admin_user:
        return False
    return _check_project_permission(project, admin_user, min_role="operator")


def _check_project_permission(project: Project, user: User, min_role: str) -> bool:
    if normalize_backend_role(user.backend_role) in {"super_admin", "admin"}:
        return True

    members = list(project.project_members or [])
    if not members:
        return True  # 允许所有人访问没有成员限制的项目（视业务逻辑而定）

    role_levels = {"viewer": 1, "reviewer": 2, "operator": 3, "manager": 4, "owner": 5}
    required_level = role_levels.get(min_role, 1)

    for member in members:
        if str(member.status or "active").strip().lower() != "active":
            continue

        if str(member.user_id or "").strip() == str(user.id):
            member_role = str(member.project_role or "").strip().lower()
            if role_levels.get(member_role, 0) >= required_level:
                return True

    return False
