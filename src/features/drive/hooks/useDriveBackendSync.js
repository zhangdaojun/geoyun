import { useEffect, useState } from 'react';
import { fetchAdminFiles, recordAdminFileOperations } from '../../../services/adminFileApi';
import { fetchAdminFolders } from '../../../services/adminFolderApi';

export const parseFileSizeBytes = (value) => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(Math.floor(value), 0);

  const text = String(value || '').trim();
  if (!text) return 0;

  const match = text.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
  if (!match) return 0;

  const numeric = Number(match[1] || 0);
  const unit = String(match[2] || 'B').toUpperCase();
  const factor = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024
  }[unit] || 1;
  return Math.max(Math.round(numeric * factor), 0);
};

export const useDriveBackendSync = ({
  shouldUseAdminFolders,
  shouldLogFileOperations,
  backendProjectId,
  currentUser,
  selectedProject
}) => {
  const [backendFileItems, setBackendFileItems] = useState([]);
  const [backendFolderItems, setBackendFolderItems] = useState([]);
  const [backendFeedback, setBackendFeedback] = useState(null);

  const showBackendSyncFeedback = (level, title, detail) => {
    setBackendFeedback({ level, title, detail });
  };

  const buildFileOperationPayload = (item, operationType, extraData = {}, result = 'success') => {
    if (!item || item.type !== 'file' || !backendProjectId) return null;

    const extension = item.ext || (() => {
      const parts = String(item.name || '').split('.');
      return parts.length > 1 ? parts[parts.length - 1] : null;
    })();

    const storageProvider = item.storage_provider || item.storageProvider || 'oss';
    const objectKey = item.object_key || item.objectKey || item.localPath || item.fileUrl || null;
    if (storageProvider === 'oss' && !objectKey) return null;
    if (storageProvider !== 'oss' && !objectKey && !item.fileUrl) return null;

    return {
      project_id: backendProjectId,
      external_file_id: String(item.id || item.name || '').trim(),
      file_name: item.name || 'unnamed-file',
      item_type: item.type || 'file',
      parent_id: item.parentId || null,
      file_ext: extension || null,
      mime_type: item.mimeType || null,
      file_size: parseFileSizeBytes(item.fileSizeBytes || item.fileSize || item.size),
      storage_provider: storageProvider,
      bucket_name: storageProvider === 'oss' ? 'geoyun' : 'local-archive',
      object_key: objectKey,
      file_url: item.fileUrl || null,
      access_level: 'project_shared',
      status: operationType === 'delete' ? 'deleted' : 'active',
      storage_class: 'standard',
      version_no: 1,
      persisted_blob_id: null,
      operation_type: operationType,
      result,
      extra_data: {
        projectExternalId: selectedProject?.id || null,
        category: item.category || null,
        taskName: item.taskName || null,
        instrumentType: item.instrumentType || null,
        object_key: objectKey,
        storage_provider: storageProvider,
        fileUrl: item.fileUrl || null,
        localPath: item.localPath || null,
        ...extraData
      }
    };
  };

  const refreshBackendFolders = async () => {
    if (!shouldUseAdminFolders || !backendProjectId) return [];
    const payload = await fetchAdminFolders({ projectId: backendProjectId, status: 'active' }, currentUser);
    setBackendFolderItems(payload.items || []);
    return payload.items || [];
  };

  const refreshBackendFiles = async () => {
    if (!shouldLogFileOperations || !backendProjectId) return [];
    const payload = await fetchAdminFiles({ projectId: backendProjectId, status: 'active' }, currentUser);
    setBackendFileItems(payload.items || []);
    return payload.items || [];
  };

  const logFileOperations = async (operations = [], options = {}) => {
    if (!shouldLogFileOperations || !backendProjectId) return;
    const normalized = operations.filter(Boolean);
    if (!normalized.length) return;
    const shouldRefreshAfterWrite = Boolean(options.refreshAfterWrite);

    try {
      const batchSize = 50;
      for (let start = 0; start < normalized.length; start += batchSize) {
        const batch = normalized.slice(start, start + batchSize);
        await recordAdminFileOperations(batch, currentUser);
      }
      if (shouldRefreshAfterWrite) {
        await refreshBackendFiles();
      }
      return { ok: true, total: normalized.length };
    } catch (error) {
      console.warn('Failed to record file operations', error);
      return { ok: false, total: normalized.length, error };
    }
  };

  useEffect(() => {
    if (!backendFeedback) return undefined;
    const timer = window.setTimeout(() => setBackendFeedback(null), 4000);
    return () => window.clearTimeout(timer);
  }, [backendFeedback]);

  useEffect(() => {
    if (!shouldUseAdminFolders || !backendProjectId) {
      const timer = window.setTimeout(() => {
        setBackendFolderItems([]);
      }, 0);
      return () => window.clearTimeout(timer);
    }

    let cancelled = false;

    const syncBackendFolders = async () => {
      try {
        const payload = await fetchAdminFolders({ projectId: backendProjectId, status: 'active' }, currentUser);
        if (!cancelled) {
          setBackendFolderItems(payload.items || []);
        }
      } catch (error) {
        if (!cancelled) {
          setBackendFolderItems([]);
          console.warn('Failed to fetch admin folder list', error);
        }
      }
    };

    void syncBackendFolders();
    return () => {
      cancelled = true;
    };
  }, [shouldUseAdminFolders, backendProjectId, currentUser, selectedProject?.id]);

  useEffect(() => {
    if (!shouldLogFileOperations || !backendProjectId) {
      const timer = window.setTimeout(() => {
        setBackendFileItems([]);
      }, 0);
      return () => window.clearTimeout(timer);
    }

    let cancelled = false;

    const syncBackendFiles = async () => {
      try {
        const payload = await fetchAdminFiles({ projectId: backendProjectId, status: 'active' }, currentUser);
        if (!cancelled) {
          setBackendFileItems(payload.items || []);
        }
      } catch (error) {
        if (!cancelled) {
          setBackendFileItems([]);
          console.warn('Failed to fetch admin file list', error);
        }
      }
    };

    void syncBackendFiles();
    return () => {
      cancelled = true;
    };
  }, [shouldLogFileOperations, backendProjectId, currentUser, selectedProject?.id]);

  return {
    backendFileItems,
    backendFolderItems,
    backendFeedback,
    setBackendFileItems,
    setBackendFolderItems,
    setBackendFeedback,
    showBackendSyncFeedback,
    buildFileOperationPayload,
    logFileOperations,
    refreshBackendFolders,
    refreshBackendFiles
  };
};
