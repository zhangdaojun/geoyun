import { canUseAdminProjectsApi } from './adminProjectApi';
import { buildQueryString, requestAdminApi } from './apiClient';

export const canUseAdminFoldersApi = (currentUser, project) =>
  canUseAdminProjectsApi(currentUser) &&
  Boolean(project?.backendProjectId) &&
  project?.dataSource === 'fastapi-admin';

const formatRecordDate = (value) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toISOString();
};

export const adaptAdminFolderRecordToDriveItem = (record = {}) => ({
  ...(record.metadata_json || {}),
  id: record.external_folder_id || `db_folder_${record.id}`,
  backendFolderId: record.id,
  parentId: record.parent_external_folder_id || null,
  type: 'folder',
  name: record.name || '未命名文件夹',
  date: formatRecordDate(record.updated_at || record.created_at),
  size: '--',
  ext: null,
  category: record.category || null,
  taskName: record.task_name || null,
  surveyMethod: record.survey_method || null,
  instrumentType: record.instrument_type || null,
  instrumentLabel: record.instrument_label || null,
  status: record.status || 'active'
});

export const fetchAdminFolders = async (params = {}, currentUser) => {
  const payload = await requestAdminApi(`/folders${buildQueryString(params)}`, currentUser);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return {
    items: items.map(adaptAdminFolderRecordToDriveItem),
    total: Number(payload?.total || items.length || 0)
  };
};

export const upsertAdminFolder = async (folder, currentUser) => {
  return requestAdminApi('/folders', currentUser, {
    method: 'POST',
    body: JSON.stringify(folder)
  });
};

export const updateAdminFolder = async (externalFolderId, folder, currentUser) => {
  const payload = await requestAdminApi(`/folders/${encodeURIComponent(String(externalFolderId))}`, currentUser, {
    method: 'PUT',
    body: JSON.stringify(folder)
  });
  return adaptAdminFolderRecordToDriveItem(payload);
};

export const deleteAdminFolder = async (externalFolderId, projectId, currentUser) => {
  const searchParams = new URLSearchParams({ projectId: String(projectId) });
  return requestAdminApi(`/folders/${encodeURIComponent(String(externalFolderId))}?${searchParams.toString()}`, currentUser, {
    method: 'DELETE'
  });
};
