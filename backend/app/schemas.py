from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


class UserBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    account: str
    name: str
    company: str
    phone: str
    email: Optional[str] = None
    backend_role: str
    status: str
    token_version: int
    last_login_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    disabled_at: Optional[datetime] = None


class UserListItem(UserBase):
    login_log_count: int = 0
    admin_operation_count: int = 0


class UserLoginLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    login_type: str
    login_status: str
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    token_version: int
    created_at: datetime


class AdminOperationLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    admin_user_id: int
    target_user_id: int
    action: str
    detail: str
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    created_at: datetime


class UserDetailOut(UserBase):
    recent_login_logs: List[UserLoginLogOut] = Field(default_factory=list)
    recent_admin_operation_logs: List[AdminOperationLogOut] = Field(default_factory=list)


class UserListResponse(BaseModel):
    items: List[UserListItem]
    total: int


class UserDetailResponse(BaseModel):
    user: UserDetailOut


class UserStatusResponse(BaseModel):
    user: UserBase
    message: str


class SurveyPointOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    point_code: str
    instrument: str
    longitude: Optional[float] = None
    latitude: Optional[float] = None
    elevation: Optional[float] = None
    point_status: str
    matched_data_count: int = 0
    has_existing_data: bool = False
    source_coord_file_id: Optional[str] = None
    source_coord_file_name: Optional[str] = None
    matched_data_paths_json: Optional[List[str]] = Field(default_factory=list)
    matched_file_ids_json: Optional[List[int]] = Field(default_factory=list)
    sort_order: int
    created_at: datetime
    updated_at: datetime


class SurveyLineSummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    line_code: str
    instrument: str
    display_name: Optional[str] = None
    sort_order: int
    point_count: int = 0
    matched_point_count: int = 0
    created_at: datetime
    updated_at: datetime


class SurveyLineDetailOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    line_code: str
    instrument: str
    display_name: Optional[str] = None
    sort_order: int
    created_at: datetime
    updated_at: datetime
    survey_points: List[SurveyPointOut] = Field(default_factory=list)


class ProjectListItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    external_id: str
    name: str
    location: Optional[str] = None
    method: Optional[str] = None
    status: str
    manager: Optional[str] = None
    center_latitude: Optional[float] = None
    center_longitude: Optional[float] = None
    line_count: int = 0
    point_count: int = 0
    created_at: datetime
    updated_at: datetime


class ProjectDetailOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    external_id: str
    name: str
    location: Optional[str] = None
    method: Optional[str] = None
    status: str
    manager: Optional[str] = None
    center_latitude: Optional[float] = None
    center_longitude: Optional[float] = None
    created_at: datetime
    updated_at: datetime
    survey_lines: List[SurveyLineDetailOut] = Field(default_factory=list)
    project_members: List["ProjectMemberOut"] = Field(default_factory=list)
    project_files: List["ProjectFileOut"] = Field(default_factory=list)
    activity_logs: List["ProjectActivityLogOut"] = Field(default_factory=list)
    project_invitations: List["ProjectInvitationOut"] = Field(default_factory=list)


class ProjectListResponse(BaseModel):
    items: List[ProjectListItemOut]
    total: int


class ProjectDetailResponse(BaseModel):
    project: ProjectDetailOut


class ProjectMemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: str
    name: str
    account: Optional[str] = None
    project_role: str
    status: str
    invited_at: Optional[str] = None
    invited_by: Optional[str] = None
    joined_at: Optional[str] = None
    sort_order: int
    created_at: datetime
    updated_at: datetime


class ProjectFileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    file_id: str
    parent_id: Optional[str] = None
    item_type: str
    name: str
    date: Optional[str] = None
    size: Optional[str] = None
    ext: Optional[str] = None
    category: Optional[str] = None
    task_name: Optional[str] = None
    status: Optional[str] = None
    persisted_blob_id: Optional[str] = None
    metadata_json: Optional[dict] = None
    sort_order: int
    created_at: datetime
    updated_at: datetime


class ProjectActivityLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    log_id: str
    node_id: Optional[str] = None
    node_name: Optional[str] = None
    level: str
    title: str
    detail: Optional[str] = None
    node_status: Optional[str] = None
    actor_name: Optional[str] = None
    event_time: Optional[str] = None
    sort_order: int
    created_at: datetime


class ProjectInvitationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    invitation_id: str
    contact_type: str
    contact_value: str
    display_name: Optional[str] = None
    project_role: str
    status: str
    recipient_status: Optional[str] = None
    invite_channel: Optional[str] = None
    invite_code: Optional[str] = None
    invite_link: Optional[str] = None
    invited_at: Optional[str] = None
    expires_at: Optional[str] = None
    last_sent_at: Optional[str] = None
    sent_count: int
    invited_by: Optional[str] = None
    invited_user_id: Optional[str] = None
    revoked_at: Optional[str] = None
    note: Optional[str] = None
    invite_logs_json: Optional[list] = None
    sort_order: int
    created_at: datetime
    updated_at: datetime


class SurveyPointWriteIn(BaseModel):
    point_code: str
    instrument: str = "EH4"
    longitude: Optional[float] = None
    latitude: Optional[float] = None
    elevation: Optional[float] = None
    point_status: str = "pending"
    matched_data_count: int = 0
    has_existing_data: bool = False
    source_coord_file_id: Optional[str] = None
    source_coord_file_name: Optional[str] = None
    matched_data_paths_json: Optional[List[str]] = Field(default_factory=list)
    matched_file_ids_json: Optional[List[int]] = Field(default_factory=list)
    sort_order: int = 0


class SurveyLineWriteIn(BaseModel):
    line_code: str
    instrument: str = "EH4"
    display_name: Optional[str] = None
    sort_order: int = 0
    survey_points: List[SurveyPointWriteIn] = Field(default_factory=list)


class ProjectWriteIn(BaseModel):
    external_id: str
    name: str
    location: Optional[str] = None
    method: Optional[str] = None
    status: str = "planning"
    manager: Optional[str] = None
    center_latitude: Optional[float] = None
    center_longitude: Optional[float] = None
    survey_lines: List[SurveyLineWriteIn] = Field(default_factory=list)
    project_members: List["ProjectMemberWriteIn"] = Field(default_factory=list)
    project_files: List["ProjectFileWriteIn"] = Field(default_factory=list)
    activity_logs: List["ProjectActivityLogWriteIn"] = Field(default_factory=list)
    project_invitations: List["ProjectInvitationWriteIn"] = Field(default_factory=list)


class ProjectMemberWriteIn(BaseModel):
    user_id: str
    name: str
    account: Optional[str] = None
    project_role: str = "viewer"
    status: str = "active"
    invited_at: Optional[str] = None
    invited_by: Optional[str] = None
    joined_at: Optional[str] = None
    sort_order: int = 0


class ProjectFileWriteIn(BaseModel):
    file_id: str
    parent_id: Optional[str] = None
    item_type: str = "file"
    name: str
    date: Optional[str] = None
    size: Optional[str] = None
    ext: Optional[str] = None
    category: Optional[str] = None
    task_name: Optional[str] = None
    status: Optional[str] = None
    persisted_blob_id: Optional[str] = None
    metadata_json: Optional[dict] = None
    sort_order: int = 0


class ProjectActivityLogWriteIn(BaseModel):
    log_id: str
    node_id: Optional[str] = None
    node_name: Optional[str] = None
    level: str = "info"
    title: str
    detail: Optional[str] = None
    node_status: Optional[str] = None
    actor_name: Optional[str] = None
    event_time: Optional[str] = None
    sort_order: int = 0


class ProjectInvitationWriteIn(BaseModel):
    invitation_id: str
    contact_type: str = "email"
    contact_value: str
    display_name: Optional[str] = None
    project_role: str = "viewer"
    status: str = "pending"
    recipient_status: Optional[str] = None
    invite_channel: Optional[str] = None
    invite_code: Optional[str] = None
    invite_link: Optional[str] = None
    invited_at: Optional[str] = None
    expires_at: Optional[str] = None
    last_sent_at: Optional[str] = None
    sent_count: int = 1
    invited_by: Optional[str] = None
    invited_user_id: Optional[str] = None
    revoked_at: Optional[str] = None
    note: Optional[str] = None
    invite_logs_json: Optional[list] = None
    sort_order: int = 0


class FileOperationWriteIn(BaseModel):
    project_id: int
    external_file_id: str
    file_name: str
    item_type: str = "file"
    parent_id: Optional[str] = None
    file_ext: Optional[str] = None
    mime_type: Optional[str] = None
    file_size: Union[int, str] = 0
    storage_provider: str = "oss"
    bucket_name: str = "geoyun"
    object_key: Optional[str] = None
    file_url: Optional[str] = None
    access_level: str = "project_shared"
    checksum_md5: Optional[str] = None
    checksum_sha256: Optional[str] = None
    status: str = "active"
    storage_class: Optional[str] = None
    version_no: int = 1
    persisted_blob_id: Optional[str] = None
    operation_type: str
    result: str = "success"
    extra_data: Optional[dict] = None


class FileOperationBatchIn(BaseModel):
    operations: List[FileOperationWriteIn] = Field(default_factory=list)


class FileRecordUpdateIn(BaseModel):
    project_id: int
    file_name: Optional[str] = None
    item_type: str = "file"
    parent_id: Optional[str] = None
    file_ext: Optional[str] = None
    mime_type: Optional[str] = None
    file_size: Union[int, str] = 0
    file_url: Optional[str] = None
    access_level: str = "project_shared"
    status: str = "active"
    storage_provider: str = "oss"
    bucket_name: str = "geoyun"
    object_key: Optional[str] = None
    storage_class: Optional[str] = None
    version_no: int = 1
    persisted_blob_id: Optional[str] = None
    extra_data: Optional[dict] = None


class FolderWriteIn(BaseModel):
    project_id: int
    external_folder_id: str
    parent_external_folder_id: Optional[str] = None
    name: str
    category: Optional[str] = None
    task_name: Optional[str] = None
    survey_method: Optional[str] = None
    instrument_type: Optional[str] = None
    instrument_label: Optional[str] = None
    status: str = "active"
    metadata_json: Optional[dict] = None
    sort_order: int = 0


class FolderRecordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    external_folder_id: str
    project_id: int
    parent_external_folder_id: Optional[str] = None
    name: str
    category: Optional[str] = None
    task_name: Optional[str] = None
    survey_method: Optional[str] = None
    instrument_type: Optional[str] = None
    instrument_label: Optional[str] = None
    status: str
    metadata_json: Optional[dict] = None
    sort_order: int
    created_at: datetime
    updated_at: datetime


class FolderRecordListResponse(BaseModel):
    items: List[FolderRecordOut]
    total: int


class FileRecordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    external_file_id: str
    file_name: str
    file_ext: Optional[str] = None
    mime_type: Optional[str] = None
    file_size: int = 0
    storage_provider: str
    bucket_name: str
    object_key: str
    file_url: Optional[str] = None
    access_level: str
    checksum_md5: Optional[str] = None
    checksum_sha256: Optional[str] = None
    status: str
    owner_type: str
    owner_id: Optional[int] = None
    uploaded_by: Optional[int] = None
    upload_ip: Optional[str] = None
    storage_class: Optional[str] = None
    version_no: int
    deleted_at: Optional[datetime] = None
    metadata_json: Optional[dict] = None
    created_at: datetime
    updated_at: datetime


class FileRecordListResponse(BaseModel):
    items: List[FileRecordOut]
    total: int


class FileOperationLogOut(BaseModel):
    id: int
    operation_type: str
    result: str
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    extra_data: Optional[dict] = None
    created_at: datetime
    operator_id: Optional[int] = None
    file: FileRecordOut


class FileOperationListResponse(BaseModel):
    items: List[FileOperationLogOut]
    total: int


class EMAP1ChannelSourceIn(BaseModel):
    values: List[float] = Field(default_factory=list)
    file_path: Optional[str] = None
    column_index: int = 0
    skip_rows: int = 0
    scale: float = 1.0
    unit: Optional[str] = None


class EMAP1ChannelBundleIn(BaseModel):
    ex: Optional[EMAP1ChannelSourceIn] = None
    ey: Optional[EMAP1ChannelSourceIn] = None
    hx: Optional[EMAP1ChannelSourceIn] = None
    hy: Optional[EMAP1ChannelSourceIn] = None
    rx: Optional[EMAP1ChannelSourceIn] = None
    ry: Optional[EMAP1ChannelSourceIn] = None


class EMAP1CalibrationSourceIn(BaseModel):
    channel_response_path: Optional[str] = None
    sensor_response_path: Optional[str] = None
    channel_response_text: Optional[str] = None
    sensor_response_text: Optional[str] = None
    channel_response_name: Optional[str] = None
    sensor_response_name: Optional[str] = None


class EMAP1CalibrationBundleIn(BaseModel):
    ex: Optional[EMAP1CalibrationSourceIn] = None
    ey: Optional[EMAP1CalibrationSourceIn] = None
    hx: Optional[EMAP1CalibrationSourceIn] = None
    hy: Optional[EMAP1CalibrationSourceIn] = None
    rx: Optional[EMAP1CalibrationSourceIn] = None
    ry: Optional[EMAP1CalibrationSourceIn] = None


class EMAP1ProcessRequest(BaseModel):
    sampling_rate_hz: float
    mode: str = "tensor"
    nfft: int = 4096
    overlap: float = 0.5
    window: str = "hann"
    huber_threshold: float = 1.5
    max_iter: int = 20
    tolerance: float = 1e-4
    dipole_ex_m: float = 1.0
    dipole_ey_m: float = 1.0
    allow_response_extrapolation: bool = False
    use_remote_reference: bool = True
    return_rows: bool = True
    output_csv_path: Optional[str] = None
    channels: EMAP1ChannelBundleIn
    calibration: Optional[EMAP1CalibrationBundleIn] = None


class EMAP1ResultRowOut(BaseModel):
    freq_hz: Optional[float] = None
    zxx_real: Optional[float] = None
    zxx_imag: Optional[float] = None
    zxy_real: Optional[float] = None
    zxy_imag: Optional[float] = None
    zyx_real: Optional[float] = None
    zyx_imag: Optional[float] = None
    zyy_real: Optional[float] = None
    zyy_imag: Optional[float] = None
    rho_xy: Optional[float] = None
    rho_yx: Optional[float] = None
    phase_xy_deg: Optional[float] = None
    phase_yx_deg: Optional[float] = None
    coherency_xy: Optional[float] = None
    coherency_yx: Optional[float] = None


class EMAP1ProcessSummaryOut(BaseModel):
    engine: str = "legacy-birrp"
    mode: str
    sample_count: int
    segment_count: int
    frequency_count: int
    remote_reference_used: bool
    output_csv_path: Optional[str] = None
    calibrated_channels: List[str] = Field(default_factory=list)


class EMAP1ProcessResponse(BaseModel):
    summary: EMAP1ProcessSummaryOut
    rows: List[EMAP1ResultRowOut] = Field(default_factory=list)


class EMAP1BatchInlineGroupIn(BaseModel):
    group_key: str
    channels: EMAP1ChannelBundleIn
    channel_files: Dict[str, str] = Field(default_factory=dict)


class EMAP1BatchProcessRequest(BaseModel):
    input_dir: Optional[str] = None
    output_dir: Optional[str] = None
    recursive: bool = True
    file_glob: str = "*"
    sampling_rate_hz: float
    mode: str = "tensor"
    nfft: int = 4096
    overlap: float = 0.5
    window: str = "hann"
    huber_threshold: float = 1.5
    max_iter: int = 20
    tolerance: float = 1e-4
    dipole_ex_m: float = 1.0
    dipole_ey_m: float = 1.0
    allow_response_extrapolation: bool = False
    use_remote_reference: bool = True
    return_rows: bool = False
    calibration: Optional[EMAP1CalibrationBundleIn] = None
    browser_groups: List[EMAP1BatchInlineGroupIn] = Field(default_factory=list)


class EMAP1SimpegLineRecordIn(BaseModel):
    line_code: Optional[str] = None
    point_code: Optional[str] = None
    station: Optional[str] = None
    distance_m: Optional[float] = None
    longitude: Optional[float] = None
    latitude: Optional[float] = None
    elevation_m: Optional[float] = None
    freq_hz: float
    rho_xy: Optional[float] = None
    phase_xy_deg: Optional[float] = None
    rho_yx: Optional[float] = None
    phase_yx_deg: Optional[float] = None
    zxy_real: Optional[float] = None
    zxy_imag: Optional[float] = None
    zyx_real: Optional[float] = None
    zyx_imag: Optional[float] = None
    std_rho: Optional[float] = None
    std_phase_deg: Optional[float] = None


class EMAP1SimpegLineRequest(BaseModel):
    line_code: Optional[str] = None
    components: List[str] = Field(default_factory=lambda: ["xy", "yx"])
    run_simpeg: bool = True
    background_resistivity_ohm_m: float = 100.0
    default_station_spacing_m: float = 50.0
    records: List[EMAP1SimpegLineRecordIn] = Field(default_factory=list)


class EMAP1SimpegLineResponse(BaseModel):
    export: dict
    simpeg: Optional[dict] = None


class EMAP1BatchProcessItemOut(BaseModel):
    group_key: str
    status: str
    reason: Optional[str] = None
    channel_files: Dict[str, str] = Field(default_factory=dict)
    output_csv_path: Optional[str] = None
    summary: Optional[EMAP1ProcessSummaryOut] = None
    rows: List[EMAP1ResultRowOut] = Field(default_factory=list)


class EMAP1BatchProcessSummaryOut(BaseModel):
    input_dir: str
    output_dir: Optional[str] = None
    recursive: bool
    file_glob: str
    total_groups: int
    processed_count: int
    skipped_count: int
    manifest_path: Optional[str] = None


class EMAP1BatchProcessResponse(BaseModel):
    summary: EMAP1BatchProcessSummaryOut
    items: List[EMAP1BatchProcessItemOut] = Field(default_factory=list)


class EMAP1TaskCreateResponse(BaseModel):
    task_id: str
    status: str = "queued"
    detail: Optional[str] = None


class EMAP1TaskProgress(BaseModel):
    current: int = 0
    total: int = 0
    percent: int = 0
    message: str = ""
    logs: List[str] = Field(default_factory=list)
    queue_position: Optional[int] = None
    queue_total: Optional[int] = None


class EMAP1TaskStatusResponse(BaseModel):
    task_id: str
    status: str
    progress: EMAP1TaskProgress = Field(default_factory=EMAP1TaskProgress)
    error: Optional[str] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None


ProjectDetailOut.model_rebuild()
ProjectDetailResponse.model_rebuild()
ProjectWriteIn.model_rebuild()
