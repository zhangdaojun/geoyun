from __future__ import annotations

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import relationship

from .database import Base


class TimestampMixin:
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    account = Column(String(64), nullable=False, unique=True, index=True)
    name = Column(String(64), nullable=False)
    company = Column(String(128), nullable=False)
    phone = Column(String(20), nullable=False, unique=True, index=True)
    email = Column(String(128), nullable=True, unique=True)
    backend_role = Column(String(32), nullable=False, default="user")
    status = Column(String(32), nullable=False, default="active", index=True)
    password_hash = Column(String(255), nullable=True)
    token_version = Column(Integer, nullable=False, default=0)
    last_login_at = Column(DateTime, nullable=True)
    disabled_at = Column(DateTime, nullable=True)

    login_logs = relationship("UserLoginLog", back_populates="user", cascade="all, delete-orphan")
    admin_operations = relationship(
        "AdminOperationLog",
        back_populates="admin_user",
        cascade="all, delete-orphan",
        foreign_keys="AdminOperationLog.admin_user_id",
    )
    file_operations = relationship(
        "FileOperationLog",
        back_populates="operator",
        foreign_keys="FileOperationLog.operator_id",
    )


class UserLoginLog(Base):
    __tablename__ = "user_login_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    login_type = Column(String(32), nullable=False)
    login_status = Column(String(32), nullable=False, default="success")
    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(255), nullable=True)
    token_version = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, server_default=func.now(), index=True)

    user = relationship("User", back_populates="login_logs")


class SmsCode(Base):
    __tablename__ = "sms_codes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    phone = Column(String(20), nullable=False, index=True)
    purpose = Column(String(32), nullable=False, index=True)
    code_hash = Column(String(255), nullable=False)
    failed_attempts = Column(Integer, nullable=False, default=0)
    expires_at = Column(DateTime, nullable=False, index=True)
    consumed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now(), index=True)


class AdminOperationLog(Base):
    __tablename__ = "admin_operation_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    admin_user_id = Column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    target_user_id = Column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    action = Column(String(32), nullable=False, index=True)
    detail = Column(Text, nullable=False)
    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(255), nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now(), index=True)

    admin_user = relationship(
        "User",
        foreign_keys=[admin_user_id],
        back_populates="admin_operations",
    )
    target_user = relationship("User", foreign_keys=[target_user_id])


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    external_id = Column(String(64), nullable=False, unique=True, index=True)
    name = Column(String(128), nullable=False, index=True)
    location = Column(String(128), nullable=True)
    method = Column(String(128), nullable=True)
    status = Column(String(32), nullable=False, default="planning", index=True)
    manager = Column(String(64), nullable=True)
    center_latitude = Column(Float, nullable=True)
    center_longitude = Column(Float, nullable=True)

    survey_lines = relationship(
        "SurveyLine",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="SurveyLine.sort_order.asc(), SurveyLine.id.asc()",
    )
    project_members = relationship(
        "ProjectMember",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="ProjectMember.sort_order.asc(), ProjectMember.id.asc()",
    )
    project_files = relationship(
        "ProjectFile",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="ProjectFile.sort_order.asc(), ProjectFile.id.asc()",
    )
    activity_logs = relationship(
        "ProjectActivityLog",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="ProjectActivityLog.sort_order.asc(), ProjectActivityLog.id.asc()",
    )
    project_invitations = relationship(
        "ProjectInvitation",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="ProjectInvitation.sort_order.asc(), ProjectInvitation.id.asc()",
    )
    folder_records = relationship(
        "FolderRecord",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="FolderRecord.sort_order.asc(), FolderRecord.id.asc()",
    )
    file_records = relationship(
        "FileRecord",
        back_populates="project",
        order_by="FileRecord.created_at.desc(), FileRecord.id.desc()",
    )


class SurveyLine(Base, TimestampMixin):
    __tablename__ = "survey_lines"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "line_code",
            "instrument",
            name="uq_survey_lines_project_line_instrument",
        ),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    line_code = Column(String(64), nullable=False, index=True)
    instrument = Column(String(32), nullable=False, default="EH4", index=True)
    display_name = Column(String(128), nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)

    project = relationship("Project", back_populates="survey_lines")
    survey_points = relationship(
        "SurveyPoint",
        back_populates="survey_line",
        cascade="all, delete-orphan",
        order_by="SurveyPoint.sort_order.asc(), SurveyPoint.id.asc()",
    )


class SurveyPoint(Base, TimestampMixin):
    __tablename__ = "survey_points"
    __table_args__ = (
        UniqueConstraint("survey_line_id", "point_code", name="uq_survey_points_line_point"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    survey_line_id = Column(
        ForeignKey("survey_lines.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    point_code = Column(String(64), nullable=False, index=True)
    instrument = Column(String(32), nullable=False, default="EH4", index=True)
    longitude = Column(Float, nullable=True)
    latitude = Column(Float, nullable=True)
    elevation = Column(Float, nullable=True)
    point_status = Column(String(32), nullable=False, default="pending", index=True)
    matched_data_count = Column(Integer, nullable=False, default=0)
    has_existing_data = Column(Boolean, nullable=False, default=False)
    source_coord_file_id = Column(String(128), nullable=True, index=True)
    source_coord_file_name = Column(String(255), nullable=True)
    matched_data_paths_json = Column(JSON, nullable=True)
    matched_file_ids_json = Column(JSON, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)

    survey_line = relationship("SurveyLine", back_populates="survey_points")


class ProjectMember(Base, TimestampMixin):
    __tablename__ = "project_members"
    __table_args__ = (
        UniqueConstraint("project_id", "user_id", name="uq_project_members_project_user"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(64), nullable=False, index=True)
    _name = Column("name", String(64), nullable=True)
    _account = Column("account", String(64), nullable=True)
    project_role = Column(String(32), nullable=False, default="viewer")
    status = Column(String(32), nullable=False, default="active", index=True)
    invited_at = Column(String(64), nullable=True)
    invited_by = Column(String(64), nullable=True)
    joined_at = Column(String(64), nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)

    project = relationship("Project", back_populates="project_members")
    
    user = relationship(
        "User",
        primaryjoin="foreign(ProjectMember.user_id) == cast(User.id, String)",
        uselist=False,
        viewonly=True
    )

    @property
    def name(self) -> str:
        if self.user:
            return self.user.name
        return self._name or ""

    @name.setter
    def name(self, value):
        self._name = value

    @property
    def account(self) -> str:
        if self.user:
            return self.user.account
        return self._account or ""

    @account.setter
    def account(self, value):
        self._account = value


class ProjectFile(Base, TimestampMixin):
    __tablename__ = "project_files"
    __table_args__ = (
        UniqueConstraint("project_id", "file_id", name="uq_project_files_project_file"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    file_id = Column(String(128), nullable=False)
    parent_id = Column(String(128), nullable=True, index=True)
    item_type = Column(String(32), nullable=False, default="file", index=True)
    name = Column(String(255), nullable=False)
    date = Column(String(64), nullable=True)
    size = Column(String(64), nullable=True)
    ext = Column(String(64), nullable=True)
    category = Column(String(64), nullable=True, index=True)
    task_name = Column(String(128), nullable=True)
    status = Column(String(64), nullable=True)
    persisted_blob_id = Column(String(128), nullable=True)
    metadata_json = Column(JSON, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)

    project = relationship("Project", back_populates="project_files")


class ProjectActivityLog(Base):
    __tablename__ = "project_activity_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    log_id = Column(String(128), nullable=False, index=True)
    node_id = Column(String(64), nullable=True)
    node_name = Column(String(128), nullable=True)
    level = Column(String(32), nullable=False, default="info")
    title = Column(String(255), nullable=False)
    detail = Column(Text, nullable=True)
    node_status = Column(String(64), nullable=True)
    actor_name = Column(String(64), nullable=True)
    event_time = Column(String(64), nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, server_default=func.now(), index=True)

    project = relationship("Project", back_populates="activity_logs")


class ProjectInvitation(Base, TimestampMixin):
    __tablename__ = "project_invitations"
    __table_args__ = (
        UniqueConstraint(
            "project_id", "invitation_id", name="uq_project_invitations_project_invite"
        ),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    invitation_id = Column(String(128), nullable=False)
    contact_type = Column(String(32), nullable=False, default="email")
    contact_value = Column(String(128), nullable=False)
    display_name = Column(String(128), nullable=True)
    project_role = Column(String(32), nullable=False, default="viewer")
    status = Column(String(32), nullable=False, default="pending", index=True)
    recipient_status = Column(String(32), nullable=True)
    invite_channel = Column(String(32), nullable=True)
    invite_code = Column(String(64), nullable=True)
    invite_link = Column(String(255), nullable=True)
    invited_at = Column(String(64), nullable=True)
    expires_at = Column(String(64), nullable=True)
    last_sent_at = Column(String(64), nullable=True)
    sent_count = Column(Integer, nullable=False, default=1)
    invited_by = Column(String(64), nullable=True)
    invited_user_id = Column(String(64), nullable=True)
    revoked_at = Column(String(64), nullable=True)
    note = Column(Text, nullable=True)
    invite_logs_json = Column(JSON, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)

    project = relationship("Project", back_populates="project_invitations")


class FolderRecord(Base, TimestampMixin):
    __tablename__ = "folders"
    __table_args__ = (
        UniqueConstraint("project_id", "external_folder_id", name="uq_folders_project_external"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    external_folder_id = Column(String(128), nullable=False, index=True)
    project_id = Column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    parent_external_folder_id = Column(String(128), nullable=True, index=True)
    name = Column(String(255), nullable=False)
    category = Column(String(64), nullable=True, index=True)
    task_name = Column(String(128), nullable=True)
    survey_method = Column(String(128), nullable=True)
    instrument_type = Column(String(64), nullable=True)
    instrument_label = Column(String(128), nullable=True)
    status = Column(String(32), nullable=False, default="active", index=True)
    metadata_json = Column(JSON, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)

    project = relationship("Project", back_populates="folder_records")


class FileRecord(Base, TimestampMixin):
    __tablename__ = "files"

    id = Column(Integer, primary_key=True, autoincrement=True)
    external_file_id = Column(String(128), nullable=False, unique=True, index=True)
    file_name = Column(String(255), nullable=False)
    file_ext = Column(String(20), nullable=True)
    mime_type = Column(String(100), nullable=True)
    file_size = Column(Integer, nullable=False, default=0)
    storage_provider = Column(String(20), nullable=False, default="local")
    bucket_name = Column(String(100), nullable=False, default="geoyun-local-drive")
    object_key = Column(String(500), nullable=False)
    file_url = Column(String(1000), nullable=True)
    access_level = Column(String(20), nullable=False, default="project_shared")
    checksum_md5 = Column(String(64), nullable=True)
    checksum_sha256 = Column(String(128), nullable=True)
    status = Column(String(20), nullable=False, default="active", index=True)
    owner_type = Column(String(50), nullable=False, default="project", index=True)
    owner_id = Column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True)
    uploaded_by = Column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    upload_ip = Column(String(64), nullable=True)
    storage_class = Column(String(50), nullable=True)
    version_no = Column(Integer, nullable=False, default=1)
    deleted_at = Column(DateTime, nullable=True)
    metadata_json = Column(JSON, nullable=True)

    project = relationship("Project", back_populates="file_records")
    uploader = relationship("User", foreign_keys=[uploaded_by])
    operation_logs = relationship(
        "FileOperationLog",
        back_populates="file",
        cascade="all, delete-orphan",
        order_by="FileOperationLog.created_at.desc(), FileOperationLog.id.desc()",
    )


class FileOperationLog(Base):
    __tablename__ = "file_operation_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    file_id = Column(ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True)
    operator_id = Column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    operation_type = Column(String(50), nullable=False, index=True)
    result = Column(String(20), nullable=False, default="success", index=True)
    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(500), nullable=True)
    extra_data = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now(), index=True)

    file = relationship("FileRecord", back_populates="operation_logs")
    operator = relationship("User", back_populates="file_operations", foreign_keys=[operator_id])
