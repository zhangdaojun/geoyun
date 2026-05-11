from __future__ import annotations

import random
import re
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..models import SmsCode, User, UserLoginLog
from ..security import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    create_access_token,
    get_password_hash,
    verify_password,
)
from .admin_users import _serialize_user_detail

router = APIRouter(prefix="/admin/auth", tags=["auth"])

SMS_TTL_SECONDS = 300
SMS_RESEND_SECONDS = 60
SMS_MAX_FAILED_ATTEMPTS = 5
VALID_SMS_PURPOSES = {"login", "register"}


class LoginPasswordReq(BaseModel):
    identifier: str
    password: str


class LoginSmsReq(BaseModel):
    phone: str
    code: str


class RegisterReq(BaseModel):
    account: str
    name: str = ""
    company: str
    phone: str
    password: str
    code: str
    email: Optional[str] = ""


class SendCodeReq(BaseModel):
    phone: str
    purpose: str = "login"


def _normalize_phone(phone: str) -> str:
    return re.sub(r"\D", "", str(phone or ""))


def _validate_phone(phone: str) -> None:
    if not re.fullmatch(r"1[3-9]\d{9}", phone):
        raise HTTPException(status_code=400, detail="请输入正确的 11 位手机号")


def _normalize_purpose(purpose: str) -> str:
    normalized = str(purpose or "login").strip().lower()
    if normalized not in VALID_SMS_PURPOSES:
        raise HTTPException(status_code=400, detail="验证码用途无效")
    return normalized


def _latest_sms_code(db: Session, phone: str, purpose: str) -> SmsCode | None:
    return (
        db.query(SmsCode)
        .filter(SmsCode.phone == phone, SmsCode.purpose == purpose)
        .order_by(SmsCode.created_at.desc(), SmsCode.id.desc())
        .first()
    )


def _consume_sms_code(db: Session, phone: str, purpose: str, code: str) -> None:
    now = datetime.utcnow()
    sms_code = _latest_sms_code(db, phone, purpose)
    if not sms_code or sms_code.consumed_at is not None or sms_code.expires_at <= now:
        raise HTTPException(status_code=401, detail="验证码无效或已过期")
    if sms_code.failed_attempts >= SMS_MAX_FAILED_ATTEMPTS:
        raise HTTPException(status_code=401, detail="验证码错误次数过多，请重新获取")
    if not verify_password(str(code or ""), sms_code.code_hash):
        sms_code.failed_attempts += 1
        db.commit()
        raise HTTPException(status_code=401, detail="验证码错误")

    sms_code.consumed_at = now


def _create_login_log(db: Session, *, request: Request, user: User, login_type: str) -> None:
    now = datetime.utcnow()
    user.last_login_at = now
    db.add(
        UserLoginLog(
            user_id=user.id,
            login_type=login_type,
            login_status="success",
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            token_version=user.token_version,
        )
    )


def _issue_login_response(db: Session, response: Response, user: User) -> dict:
    access_token = create_access_token(
        subject=str(user.id),
        role=user.backend_role,
        token_version=user.token_version,
    )
    response.set_cookie(
        key="access_token",
        value=f"Bearer {access_token}",
        httponly=True,
        samesite="lax",
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )
    db.commit()
    db.refresh(user)
    return {
        "token": access_token,
        "user": _serialize_user_detail(db, user).model_dump(),
    }


@router.post("/login/password")
def login_password(
    req: LoginPasswordReq,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    identifier = str(req.identifier or "").strip()
    user = (
        db.query(User)
        .filter(
            (User.account == identifier)
            | (User.phone == identifier)
            | (User.email == identifier)
        )
        .first()
    )
    if not user:
        raise HTTPException(status_code=404, detail="未找到匹配账号")
    if user.status == "disabled":
        raise HTTPException(status_code=401, detail="该账号已停用")
    if not user.password_hash or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="密码错误")

    _create_login_log(db, request=request, user=user, login_type="password")
    return _issue_login_response(db, response, user)


@router.post("/send-code")
def send_code(req: SendCodeReq, db: Session = Depends(get_db)):
    settings = get_settings()
    phone = _normalize_phone(req.phone)
    purpose = _normalize_purpose(req.purpose)
    _validate_phone(phone)

    existing_user = db.query(User).filter(User.phone == phone).first()
    if purpose == "register" and existing_user:
        raise HTTPException(status_code=409, detail="该手机号已注册")
    if purpose == "login" and not existing_user:
        raise HTTPException(status_code=404, detail="该手机号尚未注册")

    now = datetime.utcnow()
    latest = _latest_sms_code(db, phone, purpose)
    if latest and latest.consumed_at is None:
        elapsed = (now - latest.created_at).total_seconds()
        if elapsed < SMS_RESEND_SECONDS:
            retry_after = int(SMS_RESEND_SECONDS - elapsed) + 1
            raise HTTPException(status_code=409, detail=f"{retry_after} 秒后再获取验证码")

    code = f"{random.randint(100000, 999999)}"
    db.add(
        SmsCode(
            phone=phone,
            purpose=purpose,
            code_hash=get_password_hash(code),
            expires_at=now + timedelta(seconds=SMS_TTL_SECONDS),
        )
    )
    db.commit()

    payload = {
        "ok": True,
        "phone": phone[:3] + "****" + phone[-4:],
        "expiresIn": SMS_TTL_SECONDS,
        "resendIn": SMS_RESEND_SECONDS,
        "message": "验证码已发送",
    }
    if settings.expose_sms_debug_code:
        payload["debugCode"] = code
    return payload


@router.post("/login/code")
def login_code(
    req: LoginSmsReq,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    phone = _normalize_phone(req.phone)
    _validate_phone(phone)
    user = db.query(User).filter(User.phone == phone).first()
    if not user:
        raise HTTPException(status_code=404, detail="该手机号尚未注册")
    if user.status == "disabled":
        raise HTTPException(status_code=401, detail="该账号已停用")

    _consume_sms_code(db, phone, "login", req.code)
    _create_login_log(db, request=request, user=user, login_type="sms")
    return _issue_login_response(db, response, user)


@router.post("/register")
def register(
    req: RegisterReq,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    account = str(req.account or "").strip()
    name = str(req.name or account).strip()
    company = str(req.company or "").strip()
    phone = _normalize_phone(req.phone)
    email = str(req.email or "").strip()

    _validate_phone(phone)
    if not account:
        raise HTTPException(status_code=400, detail="登录账号不能为空")
    if not company:
        raise HTTPException(status_code=400, detail="公司名称为必填项")
    if len(str(req.password or "")) < 6:
        raise HTTPException(status_code=400, detail="密码长度不能少于 6 位")
    if email and "@" not in email:
        raise HTTPException(status_code=400, detail="邮箱格式不正确")
    if db.query(User).filter(User.phone == phone).first():
        raise HTTPException(status_code=409, detail="该手机号已注册")
    if db.query(User).filter(User.account.ilike(account)).first():
        raise HTTPException(status_code=409, detail="账号已存在")
    if email and db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=409, detail="邮箱已被使用")

    _consume_sms_code(db, phone, "register", req.code)

    user = User(
        account=account,
        name=name or account,
        company=company,
        phone=phone,
        email=email or None,
        password_hash=get_password_hash(req.password),
        backend_role="user",
        status="active",
        token_version=0,
    )
    db.add(user)
    db.flush()

    _create_login_log(db, request=request, user=user, login_type="register")
    return _issue_login_response(db, response, user)


@router.get("/me")
def get_me(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return {"user": _serialize_user_detail(db, current_user).model_dump()}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie("access_token")
    return {"ok": True}
