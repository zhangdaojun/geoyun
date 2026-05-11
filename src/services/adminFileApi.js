import { canUseAdminProjectsApi } from './adminProjectApi';
import { buildQueryString, requestAdminApi } from './apiClient';

export const canLogAdminFileOperations = (currentUser, project) =>
  canUseAdminProjectsApi(currentUser) &&
  Boolean(project?.backendProjectId) &&
  project?.dataSource === 'fastapi-admin';

export const recordAdminFileOperations = async (operations = [], currentUser) => {
  const normalizedOperations = (operations || []).filter((item) => item && item.project_id && item.external_file_id);
  if (!normalizedOperations.length) {
    return { items: [], total: 0 };
  }
  return requestAdminApi('/files/operations', currentUser, {
    method: 'POST',
    body: JSON.stringify({ operations: normalizedOperations })
  });
};

const formatFileSizeLabel = (fileSize = 0) => {
  const size = Number(fileSize || 0);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(2)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatRecordDate = (value) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toISOString();
};

export const adaptAdminFileRecordToDriveItem = (record = {}) => {
  const metadata = record.metadata_json || {};
  return {
    id: record.external_file_id || `db_file_${record.id}`,
    backendFileId: record.id,
    parentId: metadata.parent_id || null,
    type: metadata.item_type || 'file',
    name: record.file_name || 'unnamed-file',
    date: formatRecordDate(record.updated_at || record.created_at),
    size: formatFileSizeLabel(record.file_size),
    fileSizeBytes: Number(record.file_size || 0),
    ext: record.file_ext || null,
    category: metadata.category || null,
    taskName: metadata.taskName || null,
    instrumentType: metadata.instrumentType || null,
    status: record.status || 'active',
    fileUrl: record.file_url || null,
    mimeType: record.mime_type || null,
    storage_provider: record.storage_provider || 'oss',
    object_key: record.object_key || null,
    persisted_blob_id: record.persisted_blob_id || metadata.persisted_blob_id || null,
    persistedBlobId: record.persisted_blob_id || metadata.persistedBlobId || metadata.persisted_blob_id || null,
    storageProvider: record.storage_provider || 'oss',
    objectKey: record.object_key || null
  };
};

export const fetchAdminFiles = async (params = {}, currentUser) => {
  const payload = await requestAdminApi(`/files${buildQueryString(params)}`, currentUser);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return {
    items: items.map(adaptAdminFileRecordToDriveItem),
    total: Number(payload?.total || items.length || 0)
  };
};

export const updateAdminFileRecord = async (externalFileId, payload, currentUser) => {
  const record = await requestAdminApi(`/files/${encodeURIComponent(String(externalFileId))}`, currentUser, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  return adaptAdminFileRecordToDriveItem(record);
};

export const fetchAdminFileOperations = async (params = {}, currentUser) => {
  return requestAdminApi(`/files/operations${buildQueryString(params)}`, currentUser);
};
