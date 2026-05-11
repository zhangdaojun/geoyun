import { ensureProjectShape } from '../utils/projectModel';
import { requestAdminApi } from './apiClient';

const PROJECT_STATUS_LABELS = {
  planning: '规划中',
  active: '执行中',
  archived: '已完成'
};

const FRONTEND_TO_BACKEND_STATUS = {
  规划中: 'planning',
  待开始: 'planning',
  进行中: 'active',
  执行中: 'active',
  采集中: 'active',
  解算完成: 'archived',
  已完成: 'archived'
};

const normalizeProjectStatus = (status = '') => {
  const key = String(status || '').trim().toLowerCase();
  return PROJECT_STATUS_LABELS[key] || String(status || '').trim() || '规划中';
};

const normalizeStatusForBackend = (status = '') => {
  const text = String(status || '').trim();
  return FRONTEND_TO_BACKEND_STATUS[text] || text.toLowerCase() || 'planning';
};

const buildLineDisplayName = (lineCode = '', instrument = '') => {
  const normalizedLine = String(lineCode || '').trim() || '未命名测线';
  const normalizedInstrument = String(instrument || '').trim();
  return normalizedInstrument ? `测线 ${normalizedLine} · ${normalizedInstrument}` : `测线 ${normalizedLine}`;
};

const adaptSurveyPointToDesignEntry = (line = {}, point = {}) => ({
  id: `admin_point_${point.id}`,
  backendPointId: point.id,
  line: String(line.line_code || '').trim(),
  point: String(point.point_code || '').trim(),
  x: point.longitude ?? '',
  y: point.latitude ?? '',
  z: point.elevation ?? '',
  instrument: point.instrument || line.instrument || '',
  gpsLongitude: point.longitude,
  gpsLatitude: point.latitude,
  source: '数据库项目',
  pointStatus: point.point_status || 'pending',
  matchedDataCount: Number(point.matched_data_count || 0),
  hasExistingData: Boolean(point.has_existing_data),
  sourceCoordFileId: point.source_coord_file_id || '',
  sourceCoordFileName: point.source_coord_file_name || '',
  matchedDataPaths: Array.isArray(point.matched_data_paths_json) ? point.matched_data_paths_json.filter(Boolean) : [],
  matchedFileIds: Array.isArray(point.matched_file_ids_json) ? point.matched_file_ids_json : []
});

const adaptProjectMember = (member = {}) => ({
  id: member.id ? `db_member_${member.id}` : `member_${member.user_id || member.account || Date.now()}`,
  userId: member.user_id || '',
  name: member.name || '',
  account: member.account || '',
  projectRole: member.project_role || 'viewer',
  status: member.status || 'active',
  invitedAt: member.invited_at || '',
  invitedBy: member.invited_by || '',
  joinedAt: member.joined_at || ''
});

const adaptProjectFile = (fileItem = {}) => ({
  id: fileItem.file_id || `db_file_${fileItem.id}`,
  parentId: fileItem.parent_id || null,
  type: fileItem.item_type || 'file',
  name: fileItem.name || '未命名文件',
  date: fileItem.date || '',
  size: fileItem.size || '',
  ext: fileItem.ext || null,
  category: fileItem.category || null,
  taskName: fileItem.task_name || '',
  status: fileItem.status || '',
  ...(fileItem.metadata_json || {})
});

const adaptProjectLog = (logItem = {}) => ({
  id: logItem.log_id || `db_log_${logItem.id}`,
  nodeId: logItem.node_id || '',
  nodeName: logItem.node_name || '',
  level: logItem.level || 'info',
  time: logItem.event_time || '',
  title: logItem.title || '',
  detail: logItem.detail || '',
  nodeStatus: logItem.node_status || '',
  actorName: logItem.actor_name || ''
});

const adaptProjectInvitation = (invitation = {}) => ({
  id: invitation.invitation_id || `db_invite_${invitation.id}`,
  contactType: invitation.contact_type || 'email',
  contactValue: invitation.contact_value || '',
  displayName: invitation.display_name || '',
  projectRole: invitation.project_role || 'viewer',
  status: invitation.status || 'pending',
  recipientStatus: invitation.recipient_status || '',
  inviteChannel: invitation.invite_channel || '',
  inviteCode: invitation.invite_code || '',
  inviteLink: invitation.invite_link || '',
  invitedAt: invitation.invited_at || '',
  expiresAt: invitation.expires_at || '',
  lastSentAt: invitation.last_sent_at || '',
  sentCount: Number(invitation.sent_count || 1),
  invitedBy: invitation.invited_by || '',
  invitedUserId: invitation.invited_user_id || '',
  revokedAt: invitation.revoked_at || '',
  note: invitation.note || '',
  inviteLogs: Array.isArray(invitation.invite_logs_json) ? invitation.invite_logs_json : []
});

const adaptAdminProjectToFrontend = (project = {}) => {
  const designEntries = (project.survey_lines || []).flatMap((line) =>
    (line.survey_points || []).map((point) => adaptSurveyPointToDesignEntry(line, point))
  );

  return ensureProjectShape({
    id: project.external_id || `ADMIN-${project.id}`,
    backendProjectId: project.id,
    dataSource: 'fastapi-admin',
    name: project.name || '未命名项目',
    location: project.location || '',
    method: project.method || '',
    status: normalizeProjectStatus(project.status),
    manager: project.manager || '',
    coords:
      Number.isFinite(Number(project.center_latitude)) && Number.isFinite(Number(project.center_longitude))
        ? [Number(project.center_latitude), Number(project.center_longitude)]
        : undefined,
    createdAt: project.created_at || new Date().toLocaleString(),
    lastUpdate: project.updated_at || project.created_at || '',
    plan: {
      instrumentModel: project.method || '',
      designEntries
    },
    projectMembers: (project.project_members || []).map(adaptProjectMember),
    projectInvitations: (project.project_invitations || []).map(adaptProjectInvitation),
    cloudData: {
      projectId: project.external_id || `ADMIN-${project.id}`,
      items: (project.project_files || []).map(adaptProjectFile)
    },
    tasks: [],
    activityLogs: (project.activity_logs || []).map(adaptProjectLog)
  });
};

const buildSurveyLinesFromDesignEntries = (designEntries = []) => {
  const grouped = new Map();

  (designEntries || []).forEach((entry, index) => {
    const lineCode = String(entry?.line || '').trim() || '未命名测线';
    const instrument = String(entry?.instrument || '').trim() || 'EH4';
    const key = `${lineCode}__${instrument}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        line_code: lineCode,
        instrument,
        display_name: buildLineDisplayName(lineCode, instrument),
        sort_order: grouped.size,
        survey_points: []
      });
    }

    const line = grouped.get(key);
    line.survey_points.push({
      point_code: String(entry?.point || '').trim() || `${index + 1}`,
      instrument,
      longitude: Number.isFinite(Number(entry?.gpsLongitude)) ? Number(entry.gpsLongitude) : null,
      latitude: Number.isFinite(Number(entry?.gpsLatitude)) ? Number(entry.gpsLatitude) : null,
      elevation: Number.isFinite(Number(entry?.z)) ? Number(entry.z) : null,
      point_status: entry?.pointStatus || (entry?.hasExistingData ? 'matched' : 'pending'),
      matched_data_count: Number(entry?.matchedDataCount || 0),
      has_existing_data: Boolean(entry?.hasExistingData),
      source_coord_file_id: entry?.sourceCoordFileId || entry?.sourceFileId || null,
      source_coord_file_name: entry?.sourceCoordFileName || entry?.sourceFileName || null,
      matched_data_paths_json: Array.isArray(entry?.matchedDataPaths) ? entry.matchedDataPaths.filter(Boolean) : [],
      matched_file_ids_json: Array.isArray(entry?.matchedFileIds) ? entry.matchedFileIds.filter(Boolean) : [],
      sort_order: line.survey_points.length
    });
  });

  return Array.from(grouped.values()).map((line) => ({
    ...line,
    survey_points: [...line.survey_points].sort((a, b) =>
      String(a.point_code || '').localeCompare(String(b.point_code || ''), 'zh-Hans-CN', { numeric: true })
    )
  }));
};

const buildAdminProjectPayload = (project = {}) => {
  const coords = Array.isArray(project?.coords) ? project.coords : [];
  const projectMembers = (project?.projectMembers || []).map((member, index) => ({
    user_id: String(member?.userId || '').trim() || `external_${index}`,
    name: String(member?.name || '').trim() || '未命名成员',
    account: String(member?.account || '').trim() || null,
    project_role: String(member?.projectRole || 'viewer').trim() || 'viewer',
    status: String(member?.status || 'active').trim() || 'active',
    invited_at: member?.invitedAt || null,
    invited_by: member?.invitedBy || null,
    joined_at: member?.joinedAt || null,
    sort_order: index
  }));
  const projectFiles = (project?.cloudData?.items || []).map((item, index) => {
    const {
      id,
      parentId,
      type,
      name,
      date,
      size,
      ext,
      category,
      taskName,
      status,
      rawFile: _rawFile,
      content: _content,
      ...rest
    } = item || {};
    delete rest[`persisted${'BlobId'}`];
    return {
      file_id: String(id || `file_${index}`).trim(),
      parent_id: parentId || null,
      item_type: type || 'file',
      name: String(name || '').trim() || `未命名文件_${index + 1}`,
      date: date || null,
      size: size || null,
      ext: ext || null,
      category: category || null,
      task_name: taskName || null,
      status: status || null,
      metadata_json: rest,
      sort_order: index
    };
  });
  const activityLogs = (project?.activityLogs || []).map((log, index) => ({
    log_id: String(log?.id || `log_${index}`).trim(),
    node_id: log?.nodeId || null,
    node_name: log?.nodeName || null,
    level: log?.level || 'info',
    title: String(log?.title || '').trim() || '项目日志',
    detail: log?.detail || null,
    node_status: log?.nodeStatus || null,
    actor_name: log?.actorName || null,
    event_time: log?.time || null,
    sort_order: index
  }));
  const projectInvitations = (project?.projectInvitations || []).map((invitation, index) => ({
    invitation_id: String(invitation?.id || `invite_${index}`).trim(),
    contact_type: invitation?.contactType || 'email',
    contact_value: String(invitation?.contactValue || '').trim(),
    display_name: invitation?.displayName || null,
    project_role: String(invitation?.projectRole || 'viewer').trim() || 'viewer',
    status: invitation?.status || 'pending',
    recipient_status: invitation?.recipientStatus || null,
    invite_channel: invitation?.inviteChannel || null,
    invite_code: invitation?.inviteCode || null,
    invite_link: invitation?.inviteLink || null,
    invited_at: invitation?.invitedAt || null,
    expires_at: invitation?.expiresAt || null,
    last_sent_at: invitation?.lastSentAt || null,
    sent_count: Number(invitation?.sentCount || 1),
    invited_by: invitation?.invitedBy || null,
    invited_user_id: invitation?.invitedUserId || null,
    revoked_at: invitation?.revokedAt || null,
    note: invitation?.note || null,
    invite_logs_json: Array.isArray(invitation?.inviteLogs) ? invitation.inviteLogs : [],
    sort_order: index
  }));
  return {
    external_id: String(project?.id || '').trim(),
    name: String(project?.name || '').trim() || '未命名项目',
    location: String(project?.location || '').trim() || '',
    method: String(project?.plan?.instrumentModel || project?.method || '').trim() || '',
    status: normalizeStatusForBackend(project?.status),
    manager: String(project?.manager || '').trim() || '',
    center_latitude: Number.isFinite(Number(coords[0])) ? Number(coords[0]) : null,
    center_longitude: Number.isFinite(Number(coords[1])) ? Number(coords[1]) : null,
    survey_lines: buildSurveyLinesFromDesignEntries(project?.plan?.designEntries || []),
    project_members: projectMembers,
    project_files: projectFiles,
    activity_logs: activityLogs,
    project_invitations: projectInvitations
  };
};

export const canUseAdminProjectsApi = (currentUser) => {
  const role = String(currentUser?.backendRole || '').trim();
  return ['super_admin', 'admin', 'support'].includes(role);
};

export const canEditAdminProjectsApi = (currentUser) => {
  const role = String(currentUser?.backendRole || '').trim();
  return ['super_admin', 'admin'].includes(role);
};

export const fetchAdminProjectsFromApi = async (currentUser) => {
  const payload = await requestAdminApi('/projects', currentUser);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const details = await Promise.all(
    items.map(async (item) => {
      const detailPayload = await requestAdminApi(`/projects/${encodeURIComponent(String(item.id))}`, currentUser);
      return adaptAdminProjectToFrontend(detailPayload.project || {});
    })
  );
  return details;
};

export const fetchAdminProjectDetailFromApi = async (backendProjectId, currentUser) => {
  if (!backendProjectId) {
    throw new Error('缺少数据库项目编号，无法重新加载项目。');
  }
  const detailPayload = await requestAdminApi(`/projects/${encodeURIComponent(String(backendProjectId))}`, currentUser);
  return adaptAdminProjectToFrontend(detailPayload.project || {});
};

export const findAdminProjectByExternalId = async (externalId, currentUser) => {
  const normalizedExternalId = String(externalId || '').trim();
  if (!normalizedExternalId) return null;
  const payload = await requestAdminApi('/projects', currentUser);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const matched = items.find((item) => String(item?.external_id || '').trim() === normalizedExternalId);
  if (!matched?.id) return null;
  const detailPayload = await requestAdminApi(`/projects/${encodeURIComponent(String(matched.id))}`, currentUser);
  return adaptAdminProjectToFrontend(detailPayload.project || {});
};

export const createAdminProjectViaApi = async (project, currentUser) => {
  const payload = await requestAdminApi('/projects', currentUser, {
    method: 'POST',
    body: JSON.stringify(buildAdminProjectPayload(project))
  });
  return adaptAdminProjectToFrontend(payload.project || {});
};

export const updateAdminProjectViaApi = async (project, currentUser) => {
  const backendProjectId = project?.backendProjectId;
  if (!backendProjectId) {
    throw new Error('缺少数据库项目编号，无法保存到后台。');
  }

  const payload = await requestAdminApi(`/projects/${encodeURIComponent(String(backendProjectId))}`, currentUser, {
    method: 'PUT',
    body: JSON.stringify(buildAdminProjectPayload(project))
  });
  return adaptAdminProjectToFrontend(payload.project || {});
};

export const deleteAdminProjectViaApi = async (project, currentUser) => {
  const backendProjectId = project?.backendProjectId;
  if (!backendProjectId) {
    throw new Error('缺少数据库项目编号，无法从后台删除。');
  }

  return requestAdminApi(`/projects/${encodeURIComponent(String(backendProjectId))}`, currentUser, {
    method: 'DELETE'
  });
};

export const triggerAdminAutoMatchViaApi = async (backendProjectId, currentUser) => {
  if (!backendProjectId) {
    throw new Error('缺少数据库项目编号，无法执行匹配。');
  }
  return requestAdminApi(`/projects/${encodeURIComponent(String(backendProjectId))}/auto-match`, currentUser, {
    method: 'POST'
  });
};
