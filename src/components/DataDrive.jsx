import React, { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { Folder, UploadCloud, FolderPlus, ChevronRight, XCircle } from 'lucide-react';
import { getOssDownloadUrl } from '../services/ossApi';
import { getToken } from '../services/tokenStore';
import { findFileBlobByName, loadFileBlob } from '../utils/fileBlobStore';
import { resolveDriveFileContent } from '../utils/driveFileContent';
import { updateAdminFileRecord } from '../services/adminFileApi';
import { formatFileSizeBytes } from '../utils/fileUtils';
import {
  deleteAdminFolder,
  updateAdminFolder,
  upsertAdminFolder
} from '../services/adminFolderApi';
import { resolveFolderIdByTaskName, updateProjectWithPlan } from '../utils/projectModel';
import { syncDriveSurveyEntries } from '../utils/fieldSurveyGeneration';
import { msg, confirmDialog, promptDialog } from '../utils/message';
import DriveDirectoryView from '../features/drive/components/DriveDirectoryView';
import DriveParserLauncher from '../features/drive/components/DriveParserLauncher';
import CreateFolderModal from '../features/drive/components/CreateFolderModal';
import ErtInversionModal from '../features/drive/components/ErtInversionModal';
import { formatInstrumentLabel } from '../features/drive/driveFileRules';
import { useDriveBackendSync, parseFileSizeBytes } from '../features/drive/hooks/useDriveBackendSync';
import { useDriveItems } from '../features/drive/hooks/useDriveItems';
import { useDriveParserRoute } from '../features/drive/hooks/useDriveParserRoute';
import { useDriveTreeState } from '../features/drive/hooks/useDriveTreeState';
import { useDriveUploadArchive } from '../features/drive/hooks/useDriveUploadArchive';
import { useDriveSelection } from '../features/drive/hooks/useDriveSelection';
import { triggerAdminAutoMatchViaApi } from '../services/adminProjectApi';

/*
    正在加载解析器...
*/
const DataDrive = ({ selectedProject, onGoToProjects, onUpdateProject, initialFolderId = null, pendingPointRequest = null, appSettings, currentUser, projectSyncStatus = null }) => {
  
  // Modals state
  const [showFolderPrompt, setShowFolderPrompt] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [suppressedDriveItemIds, setSuppressedDriveItemIds] = useState(() => new Set());
  
  const fileInputRef = useRef(null);
  const latestProjectRef = useRef(selectedProject);
  const latestFileSystemRef = useRef([]);
  const lastSurveySyncKeyRef = useRef('');
  const lastAdminMatchKeyRef = useRef('');
  const lastSurveyItemsRef = useRef(null);
  const surveyItemsVersionRef = useRef(0);
  const nextGeneratedIdRef = useRef(1);
  const draggedItemIdRef = useRef(null);
  const uploadAbortControllerRef = useRef(null);

  const localFileSystem = useMemo(() => selectedProject?.cloudData?.items || [], [selectedProject]);
  const canUploadDrive = true;
  const canCreateFolder = true;
  const canDeleteDrive = true;
  const backendProjectId = Number.isFinite(Number(selectedProject?.backendProjectId))
    ? Number(selectedProject?.backendProjectId)
    : null;
  const shouldLogFileOperations = false;
  const shouldUseAdminFolders = false;

  const {
    backendFileItems,
    backendFolderItems,
    backendFeedback,
    setBackendFeedback,
    showBackendSyncFeedback,
    buildFileOperationPayload,
    logFileOperations,
    refreshBackendFolders,
    refreshBackendFiles
  } = useDriveBackendSync({
    shouldUseAdminFolders,
    shouldLogFileOperations,
    backendProjectId,
    currentUser,
    selectedProject
  });

  const {
    normalizedLocalItems,
    fileSystem,
    setFileSystem
  } = useDriveItems({
    localFileSystem,
    backendFolderItems,
    backendFileItems,
    shouldUseAdminFolders,
    shouldLogFileOperations,
    latestProjectRef,
    latestFileSystemRef,
    onUpdateProject,
    currentUser,
    suppressedDriveItemIds
  });

  const {
    breadcrumbs,
    currentFolder,
    currentFolderId,
    currentItems,
    currentTask,
    displayItems,
    navigateToFolder,
    searchTerm,
    setSearchTerm
  } = useDriveTreeState({
    selectedProject,
    fileSystem,
    initialFolderId,
    latestProjectRef,
    onUpdateProject,
    currentUser
  });

  const {
    viewMode,
    setViewMode,
    selectionMode,
    setSelectionMode,
    selectedDriveItemIds,
    toggleDriveItemSelection,
    toggleSelectAllVisibleDriveItems,
    clearDriveSelection
  } = useDriveSelection(displayItems);

  const {
    parserState,
    parserSetters,
    handleSwitchF3Band,
    handleSwitchFile,
    handleSwitchType,
    openDriveItem
  } = useDriveParserRoute({
    fileSystem,
    currentItems,
    displayItems,
    navigateToFolder,
    logFileOperations,
    buildFileOperationPayload,
    selectedProject,
    pendingPointRequest
  });
  const {
    parsingFile,
    parsingMTFile,
    parsingXFile,
    parsingYFile,
    parsingEH4Project,
    parsingF3IndexProject,
    parsingDesignCoordFile
  } = parserState;
  const {
    setParsingFile,
    setParsingMTFile,
    setParsingXFile,
    setParsingYFile,
    setParsingEH4Project,
    setParsingF3IndexProject,
    setParsingDesignCoordFile
  } = parserSetters;
  const visibleProjectSyncStatus = (
    selectedProject?.id
    && projectSyncStatus?.source === 'data-drive'
    && projectSyncStatus?.projectId === selectedProject.id
  ) ? projectSyncStatus : null;
  const projectSyncStatusTheme = visibleProjectSyncStatus?.phase === 'error'
    ? { border: '#fca5a5', background: '#fef2f2', title: '#b91c1c', detail: '#991b1b' }
    : visibleProjectSyncStatus?.phase === 'success'
      ? { border: '#86efac', background: '#f0fdf4', title: '#15803d', detail: '#166534' }
      : { border: '#93c5fd', background: '#eff6ff', title: '#1d4ed8', detail: '#1e40af' };
  const uploadStatusText = {
    preparing: '准备上传',
    policy: '获取上传凭证',
    uploading: '正在上传',
    uploaded: '已上传',
    failed: '上传失败',
    syncing: '同步后台记录',
    stopping: '正在停止',
    stopped: '已停止',
    finished: '上传完成',
    'finished-with-errors': '部分文件未上传'
  };
  const uploadProgressPercent = uploadProgress?.totalBytes > 0
    ? Math.min(100, Math.round(((uploadProgress.uploadedBytes || 0) / uploadProgress.totalBytes) * 100))
    : uploadProgress?.total > 0
      ? Math.min(100, Math.round((((uploadProgress.completed || 0) + ((uploadProgress.currentPercent || 0) / 100)) / uploadProgress.total) * 100))
      : 0;
  const showUploadProgress = Boolean(uploadProgress && uploadProgress.total > 0 && (
    uploadProgress.active ||
    String(uploadProgress.status || '').startsWith('finished') ||
    uploadProgress.status === 'stopped'
  ));

  useEffect(() => {
    setSuppressedDriveItemIds(new Set());
  }, [selectedProject?.id]);

  const stopUpload = () => {
    uploadAbortControllerRef.current?.abort();
    setUploadProgress((prev) => prev
      ? { ...prev, status: 'stopping' }
      : prev);
  };

  const buildFileStorageFields = (item = {}) => {
    const persistedBlobId = item.persistedBlobId || item.persisted_blob_id || null;
    const objectKey = item.object_key || item.objectKey || null;
    const storageProvider = persistedBlobId
      ? (item.storage_provider || item.storageProvider || 'indexeddb')
      : (item.storage_provider || item.storageProvider || (objectKey ? 'oss' : 'indexeddb'));
    return {
      storage_provider: storageProvider,
      storageProvider,
      object_key: objectKey,
      objectKey,
      persisted_blob_id: persistedBlobId,
      persistedBlobId
    };
  };

  useEffect(() => {
    latestProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    latestFileSystemRef.current = fileSystem;
  }, [fileSystem]);

  useEffect(() => {
    if (!uploadProgress || uploadProgress.active) return undefined;
    if (!String(uploadProgress.status || '').startsWith('finished')) return undefined;
    const timer = window.setTimeout(() => setUploadProgress(null), 3200);
    return () => window.clearTimeout(timer);
  }, [uploadProgress]);

  const surveyItemsSignature = useMemo(() => {
    const itemMap = new Map(normalizedLocalItems.map((item) => [String(item?.id || ''), item]));
    const rawFolderIds = new Set(
      normalizedLocalItems
        .filter((item) => item?.type === 'folder')
        .filter((item) => (
          item.category === 'raw'
          || item.taskName === '野外采集'
          || item.name === '02_野外采集'
        ))
        .map((item) => String(item.id))
    );
    const isItemInsideRawTree = (item) => {
      let cursor = item;
      while (cursor) {
        if (rawFolderIds.has(String(cursor.id || ''))) return true;
        cursor = cursor?.parentId ? itemMap.get(String(cursor.parentId)) || null : null;
      }
      return false;
    };
    return normalizedLocalItems
      .filter((item) => item?.type === 'file' && isItemInsideRawTree(item))
      .map((item) => [
        item?.id || '',
        item?.parentId || '',
        item?.name || '',
        item?.size || item?.fileSizeBytes || '',
        item?.storage_provider || item?.storageProvider || '',
        item?.object_key || item?.objectKey || '',
        item?.persisted_blob_id || item?.persistedBlobId || '',
        item?.status || '',
        item?.instrumentType || '',
        item?.instrumentLabel || ''
      ].join('\u001f'))
      .sort()
      .join('\u001e');
  }, [normalizedLocalItems]);

  if (lastSurveyItemsRef.current !== surveyItemsSignature) {
    lastSurveyItemsRef.current = surveyItemsSignature;
    surveyItemsVersionRef.current += 1;
  }

  const surveySyncVersion = surveyItemsVersionRef.current;
  const surveySyncAuthState = getToken() ? 'auth' : 'no-auth';
  const surveySyncKey = `${selectedProject?.id || ''}:${surveySyncVersion}:${surveySyncAuthState}`;

  useEffect(() => {
    const project = latestProjectRef.current;
    if (!project || !onUpdateProject) return;
    if (lastSurveySyncKeyRef.current === surveySyncKey) return;
    lastSurveySyncKeyRef.current = surveySyncKey;
    void (async () => {
      try {
        const result = await syncDriveSurveyEntries(project, normalizedLocalItems);
        const hasAdminToken = Boolean(getToken());
        const nextProject = result?.changed
          ? updateProjectWithPlan(project, {
              designEntries: result.designEntries,
              plannedLines: result.lineCount,
              plannedPoints: result.pointCount
            }, { actor: currentUser })
          : project;

        if (backendProjectId) {
          if (!hasAdminToken) {
            if (result?.changed) {
              latestProjectRef.current = nextProject;
            }
            showBackendSyncFeedback('warning', '测线测点树未同步到后台', '当前缺少登录认证，请重新登录后再同步后台测线测点树。');
            return;
          }
          let syncedProject = nextProject;
          if (result?.changed) {
            latestProjectRef.current = nextProject;
            syncedProject = await onUpdateProject(nextProject, { skipRefetch: true });
          }
          if (lastAdminMatchKeyRef.current !== surveySyncKey) {
            lastAdminMatchKeyRef.current = surveySyncKey;
            await triggerAdminAutoMatchViaApi(backendProjectId, currentUser);
            showBackendSyncFeedback('success', '测线测点已匹配', '后台已根据最新的云盘文件更新了关联状态。');
          }
          if (result?.changed && syncedProject) {
            latestProjectRef.current = syncedProject;
          }
        } else {
          // 如果没有使用后端项目（兼容本地旧逻辑）
          if (!result?.changed) return;
          latestProjectRef.current = nextProject;
          await onUpdateProject(nextProject, { skipRefetch: true });
        }
      } catch (error) {
        console.warn('Failed to sync survey entries from drive items.', error);
        showBackendSyncFeedback('error', '测线匹配失败', error.message || '无法执行后台匹配');
      }
    })();
  }, [surveySyncKey, surveySyncVersion, normalizedLocalItems, onUpdateProject, backendProjectId, currentUser, showBackendSyncFeedback]);

  const rawFolderId =
    resolveFolderIdByTaskName(selectedProject, '野外采集') ||
    fileSystem.find(item => item.type === 'folder' && (item.category === 'raw' || item.taskName === '野外采集' || item.name === '02_野外采集'))?.id ||
    (selectedProject?.id ? `${selectedProject.id}_raw` : null);
  const isFolderWithinRawTree = (folderId) => {
    let cursorId = folderId;
    while (cursorId) {
      if (cursorId === rawFolderId) return true;
      const folder = fileSystem.find(item => item.id === cursorId && item.type === 'folder');
      if (!folder) return false;
      cursorId = folder.parentId;
    }
    return false;
  };
  const resolveInstrumentRestrictedFolder = (folderId) => {
    let cursorId = folderId;
    while (cursorId) {
      const folder = fileSystem.find(item => item.id === cursorId && item.type === 'folder');
      if (!folder) return null;
      if (folder.instrumentType) return folder;
      cursorId = folder.parentId;
    }
    return null;
  };
  const isCurrentFolderInRawTree = currentFolderId ? isFolderWithinRawTree(currentFolderId) : false;
  const inheritedFolderRestriction = isCurrentFolderInRawTree && currentFolderId && currentFolderId !== rawFolderId
    ? resolveInstrumentRestrictedFolder(currentFolderId)
    : null;
  const currentUploadRestrictedFolder = currentFolderId ? resolveInstrumentRestrictedFolder(currentFolderId) : null;
  const resolveUploadTargetFolderId = (fileName = '') => {
    if (currentFolderId) return currentFolderId;
    const lower = String(fileName).toLowerCase();
    const archiveRules = appSettings?.archiveRules || {};
    const hasKeyword = (source) => String(source || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean).some(keyword => lower.includes(keyword));
    if (hasKeyword(archiveRules.designKeywords)) return resolveFolderIdByTaskName(selectedProject, '方案规划');
    if (hasKeyword(archiveRules.resultKeywords)) return resolveFolderIdByTaskName(selectedProject, '成果解释');
    if (hasKeyword(archiveRules.docsKeywords)) return `${selectedProject.id}_docs`;
    if (hasKeyword(archiveRules.qcKeywords)) return resolveFolderIdByTaskName(selectedProject, '数据质控');
    return null;
  };
  const resolveCategoryByFolderId = (folderId) => fileSystem.find(item => item.id === folderId)?.category || null;

  const collectChildItemIds = (rootId) => {
    const ids = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      fileSystem.forEach((item) => {
        if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
          ids.add(item.id);
          changed = true;
        }
      });
    }
    return ids;
  };

  const renameDriveItem = async (e, item) => {
    e.stopPropagation();
    if (!item || item.type === 'mtts-group') return;

    const nextName = await promptDialog('请输入新的名称：', item.name || '');
    if (!nextName) return;
    const normalizedName = nextName.trim();
    if (!normalizedName || normalizedName === item.name) return;

    try {
      await setFileSystem(
        fileSystem.map((entry) => (
          entry.id === item.id
            ? { ...entry, name: normalizedName }
            : entry
        )),
        {
          title: '名称已更新',
          detail: `已将“${item.name}”重命名为“${normalizedName}”。`,
          nodeId: 'storage',
          nodeName: '成果入库节点',
          level: 'info'
        }
      );
    } catch (error) {
      console.warn('Failed to persist drive item rename', error);
      const detail = `项目保存失败，重命名未能同步到后端：${error?.message || '未知错误'}`;
      msg.error(detail);
      showBackendSyncFeedback('error', '项目保存失败', detail);
      return;
    }

    try {
      if (item.type === 'folder' && shouldUseAdminFolders && backendProjectId) {
        await updateAdminFolder(
          item.id,
          {
            project_id: backendProjectId,
            external_folder_id: item.id,
            parent_external_folder_id: item.parentId || null,
            name: normalizedName,
            category: item.category || null,
            task_name: item.taskName || null,
            survey_method: item.surveyMethod || null,
            instrument_type: item.instrumentType || null,
            instrument_label: item.instrumentLabel || null,
            status: 'active',
            metadata_json: {
              source: 'data-drive',
              date: item.date || null
            },
            sort_order: fileSystem.filter((entry) => entry.parentId === item.parentId && entry.type === 'folder').findIndex((entry) => entry.id === item.id)
          },
          currentUser
        );
        await refreshBackendFolders();
        showBackendSyncFeedback('success', '后台目录已同步', `文件夹“${normalizedName}”已同步重命名到后台目录树。`);
        return;
      }

      const itemStorageFields = buildFileStorageFields(item);
      if (item.type === 'file' && shouldLogFileOperations && backendProjectId && itemStorageFields.storage_provider === 'oss' && itemStorageFields.object_key) {
        const storageFields = itemStorageFields;
        await updateAdminFileRecord(
          item.id,
          {
            project_id: backendProjectId,
            file_name: normalizedName,
            item_type: 'file',
            parent_id: item.parentId || null,
            file_ext: item.ext || null,
            mime_type: item.mimeType || null,
            file_size: parseFileSizeBytes(item.fileSizeBytes || item.fileSize || item.size),
            file_url: item.fileUrl || null,
            access_level: 'project_shared',
            status: item.status || 'active',
            storage_class: item.storageClass || 'standard',
            version_no: 1,
            storage_provider: storageFields.storage_provider,
            bucket_name: 'geoyun',
            object_key: storageFields.object_key,
            persisted_blob_id: storageFields.persisted_blob_id,
            extra_data: {
              source: 'data-drive',
              category: item.category || null,
              taskName: item.taskName || null,
              instrumentType: item.instrumentType || null,
              storage_provider: storageFields.storage_provider,
              object_key: storageFields.object_key,
              persisted_blob_id: storageFields.persisted_blob_id
            }
          },
          currentUser
        );
        await refreshBackendFiles();
        showBackendSyncFeedback('success', '后台文件记录已同步', `文件“${normalizedName}”已同步重命名到后台 files 主表。`);
      }
    } catch (error) {
      console.warn('Failed to rename drive item in backend', error);
      showBackendSyncFeedback('warning', '后台同步失败', `“${normalizedName}”已在当前页面重命名，但后台同步失败：${error?.message || '未知错误'}`);
    }
  };

  const isFolderDescendant = (folderId, potentialParentId) => {
    if (!folderId || !potentialParentId) return false;
    let cursor = potentialParentId;
    while (cursor) {
      if (cursor === folderId) return true;
      const nextFolder = fileSystem.find((item) => item.type === 'folder' && item.id === cursor);
      cursor = nextFolder?.parentId || null;
    }
    return false;
  };

  const moveDriveItemToFolder = async (draggedItem, targetFolder) => {
    if (!draggedItem || !targetFolder || draggedItem.id === targetFolder.id) return;
    if (draggedItem.parentId === targetFolder.id) return;
    if (draggedItem.type === 'folder' && isFolderDescendant(draggedItem.id, targetFolder.id)) {
      msg.warn('不能将文件夹移动到它自己的子目录中。');
      return;
    }

    try {
      await setFileSystem(
        fileSystem.map((entry) => (
          entry.id === draggedItem.id
            ? { ...entry, parentId: targetFolder.id }
            : entry
        )),
        {
          title: '目录结构已更新',
          detail: `已将“${draggedItem.name}”移动到“${targetFolder.name}”。`,
          nodeId: 'storage',
          nodeName: '成果入库节点',
          level: 'info'
        }
      );
    } catch (error) {
      console.warn('Failed to persist drive item move', error);
      const detail = `项目保存失败，移动操作未能同步到后端：${error?.message || '未知错误'}`;
      msg.error(detail);
      showBackendSyncFeedback('error', '项目保存失败', detail);
      return;
    }

    try {
      if (draggedItem.type === 'folder' && shouldUseAdminFolders && backendProjectId) {
        await updateAdminFolder(
          draggedItem.id,
          {
            project_id: backendProjectId,
            external_folder_id: draggedItem.id,
            parent_external_folder_id: targetFolder.id,
            name: draggedItem.name,
            category: draggedItem.category || null,
            task_name: draggedItem.taskName || null,
            survey_method: draggedItem.surveyMethod || null,
            instrument_type: draggedItem.instrumentType || null,
            instrument_label: draggedItem.instrumentLabel || null,
            status: 'active',
            metadata_json: {
              source: 'data-drive',
              date: draggedItem.date || null
            },
            sort_order: fileSystem.filter((entry) => entry.parentId === targetFolder.id && entry.type === 'folder').length
          },
          currentUser
        );
        await refreshBackendFolders();
        showBackendSyncFeedback('success', '后台目录已同步', `文件夹“${draggedItem.name}”已同步移动到“${targetFolder.name}”。`);
        return;
      }

      const draggedStorageFields = buildFileStorageFields(draggedItem);
      if (draggedItem.type === 'file' && shouldLogFileOperations && backendProjectId && draggedStorageFields.storage_provider === 'oss' && draggedStorageFields.object_key) {
        const storageFields = draggedStorageFields;
        await updateAdminFileRecord(
          draggedItem.id,
          {
            project_id: backendProjectId,
            file_name: draggedItem.name,
            item_type: 'file',
            parent_id: targetFolder.id,
            file_ext: draggedItem.ext || null,
            mime_type: draggedItem.mimeType || null,
            file_size: parseFileSizeBytes(draggedItem.fileSizeBytes || draggedItem.fileSize || draggedItem.size),
            file_url: draggedItem.fileUrl || null,
            access_level: 'project_shared',
            status: draggedItem.status || 'active',
            storage_class: draggedItem.storageClass || 'standard',
            version_no: 1,
            storage_provider: storageFields.storage_provider,
            bucket_name: 'geoyun',
            object_key: storageFields.object_key,
            persisted_blob_id: storageFields.persisted_blob_id,
            extra_data: {
              source: 'data-drive',
              category: draggedItem.category || null,
              taskName: draggedItem.taskName || null,
              instrumentType: draggedItem.instrumentType || null,
              storage_provider: storageFields.storage_provider,
              object_key: storageFields.object_key,
              persisted_blob_id: storageFields.persisted_blob_id
            }
          },
          currentUser
        );
        await refreshBackendFiles();
        showBackendSyncFeedback('success', '后台文件记录已同步', `文件“${draggedItem.name}”已同步移动到“${targetFolder.name}”。`);
      }
    } catch (error) {
      console.warn('Failed to move drive item in backend', error);
      showBackendSyncFeedback('warning', '后台同步失败', `“${draggedItem.name}”已在当前页面移动，但后台同步失败：${error?.message || '未知错误'}`);
    }
  };

  const startDragDriveItem = (item) => {
    draggedItemIdRef.current = item?.id || null;
  };

  const dropDriveItemOnFolder = async (e, targetFolder) => {
    e.preventDefault();
    e.stopPropagation();
    const draggedItemId = draggedItemIdRef.current;
    draggedItemIdRef.current = null;
    if (!draggedItemId) return;
    const draggedItem = fileSystem.find((entry) => entry.id === draggedItemId);
    if (!draggedItem || draggedItem.type === 'mtts-group') return;
    await moveDriveItemToFolder(draggedItem, targetFolder);
  };

  const deleteDriveItems = async (itemsOrIds = [], options = {}) => {
    if (!canDeleteDrive) return;
    const targetItems = (Array.isArray(itemsOrIds) ? itemsOrIds : [itemsOrIds])
      .map((itemOrId) => (typeof itemOrId === 'object' && itemOrId
        ? itemOrId
        : fileSystem.find((entry) => entry.id === itemOrId) || null))
      .filter(Boolean);
    if (!targetItems.length) return;

    const isBatch = Boolean(options.isBatch || targetItems.length > 1);
    const hasMttsGroup = targetItems.some((item) => item.type === 'mtts-group');
    const confirmed = await confirmDialog(
      options.title || '确认操作',
      options.message || (isBatch
        ? `确定要删除选中的 ${targetItems.length} 个项目吗？文件夹内的子内容也会一并删除，此操作无法撤销。`
        : hasMttsGroup
          ? '确定要删除这个测点组下的全部 MTTS 文件吗？此操作无法撤销。'
          : '确定要删除这个文件或文件夹吗？此操作无法撤销。')
    );
    if (!confirmed) return;

    const deletedIds = new Set();
    targetItems.forEach((targetItem) => {
      if (targetItem.type === 'mtts-group') {
        (targetItem.files || []).forEach((file) => {
          if (file?.id) deletedIds.add(file.id);
        });
        return;
      }
      collectChildItemIds(targetItem.id).forEach((id) => deletedIds.add(id));
    });

    const deletedItems = fileSystem.filter((f) => deletedIds.has(f.id) && f.type === 'file');
    const deletedFolders = fileSystem.filter((f) => deletedIds.has(f.id) && f.type === 'folder');
    const backendFolderDeleteRoots = deletedFolders.filter((folder) => (
      folder.backendFolderId
      && !deletedFolders.some((candidate) => (
        candidate.id !== folder.id && isFolderDescendant(candidate.id, folder.id)
      ))
    ));
    setSuppressedDriveItemIds((prev) => {
      const next = new Set(prev);
      deletedIds.forEach((id) => next.add(String(id)));
      return next;
    });

    let folderSyncSucceeded = false;
    let folderSyncFailed = false;
    if (backendFolderDeleteRoots.length && shouldUseAdminFolders && backendProjectId) {
      const folderResults = await Promise.allSettled(
        backendFolderDeleteRoots.map((folder) => deleteAdminFolder(folder.id, backendProjectId, currentUser))
      );
      folderSyncSucceeded = folderResults.some((result) => result.status === 'fulfilled');
      folderSyncFailed = folderResults.some((result) => result.status === 'rejected');
      if (folderSyncFailed) {
        console.warn('Failed to delete one or more folders from backend', folderResults);
      }
    }

    const syncResult = await logFileOperations(
      deletedItems.map((item) => buildFileOperationPayload(item, 'delete', { source: 'data-drive' }))
    );
    if (shouldLogFileOperations && backendProjectId && deletedItems.length) {
      await Promise.all(
        deletedItems.map((item) => {
          const storageFields = buildFileStorageFields(item);
          if (storageFields.storage_provider !== 'oss' || !storageFields.object_key) return null;
          return updateAdminFileRecord(
            String(item.id || item.name || '').trim(),
            {
              project_id: backendProjectId,
              file_name: item.name || 'unnamed-file',
              item_type: 'file',
              parent_id: item.parentId || null,
              file_ext: item.ext || null,
              mime_type: item.mimeType || null,
              file_size: parseFileSizeBytes(item.fileSizeBytes || item.fileSize || item.size),
              file_url: null,
              access_level: 'project_shared',
              status: 'deleted',
              version_no: 1,
              storage_provider: storageFields.storage_provider,
              bucket_name: 'geoyun',
              object_key: storageFields.object_key,
              persisted_blob_id: storageFields.persisted_blob_id,
              extra_data: {
                projectExternalId: selectedProject?.id || null,
                category: item.category || null,
                taskName: item.taskName || null,
                instrumentType: item.instrumentType || null,
                storage_provider: storageFields.storage_provider,
                object_key: storageFields.object_key,
                persisted_blob_id: storageFields.persisted_blob_id,
                source: 'data-drive'
              }
            },
            currentUser
          ).catch((error) => {
            console.warn('Failed to mark admin file record as deleted', error);
            return null;
          });
        }).filter(Boolean)
      );
    }

    try {
      await setFileSystem(fileSystem.filter((entry) => !deletedIds.has(entry.id)), {
        title: hasMttsGroup ? '测点数据已删除' : '网盘文件已删除',
        detail: isBatch ? `已删除 ${deletedIds.size} 个网盘项目。` : hasMttsGroup ? '已删除该测点组下的全部 MTTS 文件。' : '已删除选中的文件或文件夹。',
        nodeId: 'storage',
        nodeName: '成果入库节点',
        level: 'warning',
        syncSource: 'data-drive',
        syncTitle: hasMttsGroup ? '正在同步测点删除结果' : '正在同步网盘删除结果',
        syncDetail: hasMttsGroup
          ? '正在将测点文件删除结果写入项目数据库，并准备回刷测线测点树。'
          : '正在将网盘删除结果写入项目数据库，并准备回刷测线测点树。',
        syncedTitle: '删除结果已同步',
        syncedDetail: '删除后的网盘数据、项目数据库和测线测点树已经保持一致。',
        errorTitle: '删除结果同步失败'
      });
    } catch (error) {
      console.warn('Failed to persist drive item delete', error);
      setSuppressedDriveItemIds((prev) => {
        const next = new Set(prev);
        deletedIds.forEach((id) => next.delete(String(id)));
        return next;
      });
      const detail = `项目保存失败，删除操作未能同步到后端：${error?.message || '未知错误'}`;
      msg.error(detail);
      showBackendSyncFeedback('error', '项目保存失败', detail);
      return;
    }

    if ((deletedFolders.length && shouldUseAdminFolders && backendProjectId) || (shouldLogFileOperations && backendProjectId && deletedItems.length)) {
      await Promise.all([
        refreshBackendFolders().catch((error) => {
          console.warn('Failed to refresh backend folders after delete', error);
          return [];
        }),
        refreshBackendFiles().catch((error) => {
          console.warn('Failed to refresh backend files after delete', error);
          return [];
        })
      ]);
    }
    if (folderSyncSucceeded) {
      showBackendSyncFeedback('success', '后台目录已同步', `已同步删除 ${deletedFolders.length} 个文件夹及其子内容。`);
    } else if (folderSyncFailed && !syncResult?.ok) {
      showBackendSyncFeedback('warning', '后台同步失败', '文件夹已在当前页面删除，但部分后台目录或文件记录同步失败，请稍后刷新确认。');
    }
    if (syncResult?.ok) {
      showBackendSyncFeedback('success', '后台文件记录已同步', `已将 ${deletedItems.length} 个文件删除动作同步到后台 files/file_operation_logs。`);
    } else if (syncResult && !syncResult.ok) {
      showBackendSyncFeedback('warning', '后台同步失败', `文件已在当前页面删除，但后台 files/file_operation_logs 同步失败：${syncResult.error?.message || '未知错误'}`);
    }
    if (isBatch) clearDriveSelection();
  };

  const removeDriveItem = async (e, itemOrId) => {
    e?.stopPropagation?.();
    await deleteDriveItems([itemOrId]);
  };

  const removeSelectedDriveItems = async () => {
    const selectedItems = displayItems.filter((item) => selectedDriveItemIds.has(item.id));
    await deleteDriveItems(selectedItems, { isBatch: true });
  };

  const triggerBrowserDownload = async (blobOrUrl, fileName = 'download') => {
    const isUrl = typeof blobOrUrl === 'string';
    let url = isUrl ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    
    if (isUrl) {
      try {
        const token = getToken();
        const response = await fetch(url, {
          method: 'GET',
          credentials: url.startsWith('/') ? 'include' : 'omit',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const blob = await response.blob();
        url = URL.createObjectURL(blob);
      } catch (error) {
        console.error('Failed to fetch file for download:', error);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
      }
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 100);
  };

  const sanitizeZipPathSegment = (value, fallback = '未命名') => (
    String(value || fallback).trim().replace(/[<>:"\\|?*]+/g, '_').replace(/^\/+|\/+$/g, '') || fallback
  );

  const resolveDownloadableFiles = (item) => {
    if (!item) return [];
    if (item.type === 'file') return [{ file: item, relativePath: sanitizeZipPathSegment(item.name, item.id || 'file') }];
    if (item.type === 'mtts-group') {
      return (item.files || []).filter((file) => file?.type === 'file').map((file) => ({
        file,
        relativePath: `${sanitizeZipPathSegment(item.pointNo || item.name || 'MTTS')}/${sanitizeZipPathSegment(file.name, file.id || 'file')}`
      }));
    }
    if (item.type !== 'folder') return [];
    const descendantIds = collectChildItemIds(item.id);
    const folderItems = fileSystem.filter((entry) => descendantIds.has(entry.id));
    const folderById = new Map(folderItems.filter((entry) => entry.type === 'folder').map((entry) => [entry.id, entry]));
    const buildRelativePath = (file) => {
      const segments = [sanitizeZipPathSegment(file.name, file.id || 'file')];
      let cursor = folderById.get(file.parentId);
      while (cursor && cursor.id !== item.id) {
        segments.unshift(sanitizeZipPathSegment(cursor.name, cursor.id || 'folder'));
        cursor = folderById.get(cursor.parentId);
      }
      return segments.join('/');
    };
    return folderItems
      .filter((entry) => entry.type === 'file')
      .map((file) => ({ file, relativePath: buildRelativePath(file) }));
  };

  const downloadDriveItem = async (e, item) => {
    e?.stopPropagation?.();
    if (!item) return;

    if (item.type === 'file') {
      const objectKey = item.object_key || item.objectKey;
      const persistedBlobId = item.persistedBlobId || item.persisted_blob_id;
      const storageProvider = item.storage_provider || item.storageProvider;
      const isLocalOnly = storageProvider === 'indexeddb' || Boolean(persistedBlobId);
      const inlineTextContent = typeof item.inlineTextContent === 'string' ? item.inlineTextContent : null;
      if (inlineTextContent !== null) {
        await triggerBrowserDownload(
          new Blob([inlineTextContent], { type: item.inlineMimeType || item.mimeType || 'text/plain;charset=utf-8' }),
          item.name || 'download.txt'
        );
        return;
      }
      const localBlobIds = Array.from(new Set([persistedBlobId, item.id].filter(Boolean).map(String)));
      if (localBlobIds.length || isLocalOnly) {
        try {
          let persistedFile = null;
          for (const localBlobId of localBlobIds) {
            persistedFile = await loadFileBlob(localBlobId);
            if (persistedFile) break;
          }
          if (!persistedFile && item.name) {
            persistedFile = await findFileBlobByName(item.name).catch(() => null);
          }
          if (!persistedFile) {
            if (isLocalOnly) {
              msg.warn('该文件的本地内容未找到，请重新生成。');
              return;
            }
          } else {
            await triggerBrowserDownload(persistedFile, item.name || persistedFile.name);
            return;
          }
        } catch (err) {
          msg.error('读取本地文件失败：' + (err.message || '未知错误'));
          return;
        }
      }

      if ((item.storage_provider === 'oss' || item.storageProvider === 'oss') && objectKey) {
        try {
          const downloadUrl = await getOssDownloadUrl(objectKey);
          await triggerBrowserDownload(downloadUrl, item.name);

          await logFileOperations([
            buildFileOperationPayload(item, 'download', { source: 'data-drive' })
          ]);
        } catch (err) {
          msg.error('获取文件下载链接失败：' + err.message);
          await logFileOperations([
            buildFileOperationPayload(item, 'download', { source: 'data-drive' }, 'failed')
          ]);
        }
        return;
      }

      if (item.fileUrl) {
        await triggerBrowserDownload(item.fileUrl, item.name);
        return;
      }

      msg.warn('该文件没有可用的本地内容或 OSS 对象地址，无法下载。请重新生成或重新上传到 OSS。');
      await logFileOperations([
        buildFileOperationPayload(item, 'download', { source: 'data-drive' }, 'failed')
      ]);
      return;
    }

    const downloadableFiles = resolveDownloadableFiles(item);
    if (!downloadableFiles.length) {
      msg.warn('该文件夹内没有可下载的文件。');
      return;
    }

    const loadingMessage = msg.loading(`正在打包 ${downloadableFiles.length} 个文件...`, 0);
    const zip = new JSZip();
    const failedFiles = [];
    const failedFileIds = new Set();
    try {
      await Promise.all(downloadableFiles.map(async ({ file, relativePath }) => {
        const browserFile = await resolveDriveFileContent(file, file.name || 'file').catch(() => null);
        if (!browserFile) {
          failedFiles.push(file.name || relativePath);
          if (file.id) failedFileIds.add(file.id);
          return;
        }
        zip.file(relativePath, await browserFile.arrayBuffer());
      }));

      const successCount = downloadableFiles.length - failedFiles.length;
      if (!successCount) {
        msg.warn('文件夹内文件都无法读取，未生成压缩包。');
        return;
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const zipName = `${sanitizeZipPathSegment(item.name || item.pointNo || '云盘文件夹')}.zip`;
      await triggerBrowserDownload(zipBlob, zipName);
      if (failedFiles.length) {
        msg.warn(`已下载压缩包，${failedFiles.length} 个文件读取失败。`);
      } else {
        msg.success(`已开始下载：${zipName}`);
      }
      await logFileOperations(
        downloadableFiles
          .filter(({ file }) => !failedFileIds.has(file.id))
          .map(({ file }) => buildFileOperationPayload(file, 'download', { source: 'data-drive-folder' }))
      );
    } catch (err) {
      msg.error('文件夹打包下载失败：' + (err.message || '未知错误'));
    } finally {
      loadingMessage();
    }
  };

  const handleCreateFolder = async ({ name, surveyMethod, instrumentLabel, instrumentType }) => {
    if (!canCreateFolder) return;

    const folder = {
      id: createUniqueFolderId(),
      parentId: currentFolderId,
      type: 'folder',
      name,
      date: new Date().toISOString(),
      size: '--',
      ext: null,
      category: currentFolder?.category || null,
      taskName: currentTask?.name || currentFolder?.taskName || null,
      surveyMethod,
      instrumentLabel,
      instrumentType
    };
    const folderSyncedToBackend = Boolean(shouldUseAdminFolders && backendProjectId);
    setShowFolderPrompt(false);

    const persistFolderLocally = () => setFileSystem([...latestFileSystemRef.current, folder], {
      title: '文件夹已创建',
      detail: `已创建文件夹“${folder.name}”。`,
      nodeId: 'storage',
      nodeName: '成果入库节点',
      level: 'info',
      syncSource: 'data-drive',
      syncTitle: '正在同步新建文件夹',
      syncDetail: folderSyncedToBackend
        ? '正在将后台新建目录写回项目云盘数据，并回刷当前网盘视图。'
        : '正在将新建目录写入项目数据库，并回刷当前网盘视图。',
      syncedTitle: '新建文件夹已同步',
      syncedDetail: folderSyncedToBackend
        ? '新建目录已经同步到后台目录、项目云盘数据和当前目录树。'
        : '新建目录已经同步到网盘数据、项目数据库和当前目录树。',
      errorTitle: '新建文件夹同步失败'
    });

    if (folderSyncedToBackend) {
      try {
        await upsertAdminFolder(
          {
            project_id: backendProjectId,
            external_folder_id: folder.id,
            parent_external_folder_id: folder.parentId || null,
            name: folder.name,
            category: folder.category || null,
            task_name: folder.taskName || null,
            survey_method: folder.surveyMethod || null,
            instrument_type: folder.instrumentType || null,
            instrument_label: folder.instrumentLabel || null,
            status: 'active',
            metadata_json: {
              source: 'data-drive',
              date: folder.date,
            },
            sort_order: fileSystem.filter((item) => item.parentId === folder.parentId && item.type === 'folder').length
          },
          currentUser
        );
      } catch (error) {
        console.warn('Failed to sync folder to backend', error);
        setBackendFeedback({
          level: 'warning',
          title: '后台目录同步失败',
          detail: `文件夹“${folder.name}”未能写入后台目录树：${error?.message || '未知错误'}`
        });
        return;
      }
    }

    try {
      await persistFolderLocally();
      if (folderSyncedToBackend) {
        await refreshBackendFolders();
        setBackendFeedback({
          level: 'success',
          title: '后台目录已同步',
          detail: `文件夹“${folder.name}”已写入后台目录树，并同步回项目云盘数据。`
        });
      }
    } catch (error) {
      console.warn('Failed to persist local folder to project cloud data', error);
      msg.error(`项目保存失败，新建文件夹未能同步到项目云盘数据：${error?.message || '未知错误'}`);
      setBackendFeedback({
        level: 'error',
        title: '项目云盘同步失败',
        detail: folderSyncedToBackend
          ? `文件夹“${folder.name}”已写入后台目录，但项目 cloudData.items 保存失败，请刷新或重试：${error?.message || '未知错误'}`
          : `文件夹“${folder.name}”未能写入项目 cloudData.items：${error?.message || '未知错误'}`
      });
    }
  };

  const openCreateFolderPrompt = () => {
    if (!canCreateFolder) return;
    setShowFolderPrompt(true);
  };

  const closeCreateFolderPrompt = () => {
    setShowFolderPrompt(false);
  };

  const createUniqueFolderId = () => {
    const projectToken = String(selectedProject?.id || 'local').replace(/[^a-z0-9_-]/gi, '_');
    const existingIds = new Set((latestFileSystemRef.current || []).map((item) => String(item?.id || '')));
    let candidate = '';
    do {
      const nextGeneratedId = nextGeneratedIdRef.current;
      nextGeneratedIdRef.current += 1;
      candidate = `fid_${projectToken}_${Date.now()}_${nextGeneratedId}`;
    } while (existingIds.has(candidate));
    return candidate;
  };

  const { handleFilesUpload, triggerUpload } = useDriveUploadArchive({
    appSettings,
    canUploadDrive,
    currentFolder,
    currentFolderId,
    fileInputRef,
    fileSystem,
    formatRestrictedInstrumentLabel: formatInstrumentLabel,
    rawFolderId,
    resolveCategoryByFolderId,
    resolveInstrumentRestrictedFolder,
    resolveUploadTargetFolderId,
    selectedProject,
    setBackendFeedback,
    setFileSystem,
    setUploadProgress,
    uploadAbortControllerRef,
    logFileOperations,
    buildFileOperationPayload,
    navigateToFolder
  });

  if (!selectedProject) {
    return (
      <div className="dashboard-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary)' }}>
        <Folder size={64} style={{ opacity: 0.2, marginBottom: '20px' }} />
        <h2 style={{ color: 'var(--text-primary)', marginBottom: '8px' }}>未选择勘探项目</h2>
        <p style={{ marginBottom: '24px' }}>
          云盘数据依赖具体项目归属，请先进入“项目与任务”中选择一个项目。
        </p>
        <button className="btn-primary" onClick={onGoToProjects}>
          前往项目与任务
        </button>
      </div>
    );
  }

  return (
    <div className="dashboard-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '0 24px 24px 24px', position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', paddingTop: '24px' }}>
        <div>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '4px' }}>云盘数据资产</h2>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
            当前项目：{selectedProject.name} / 勘探方法：{selectedProject.method}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            {breadcrumbs.map((path, idx) => (
              <React.Fragment key={path.id || 'root'}>
                <span 
                  onClick={() => navigateToFolder(path.id)}
                  style={{ 
                    cursor: 'pointer', 
                    color: idx === breadcrumbs.length - 1 ? 'var(--text-primary)' : 'var(--brand-primary)', 
                    fontWeight: idx === breadcrumbs.length - 1 ? 600 : 400 
                  }}
                  onMouseOver={(e) => { if(idx !== breadcrumbs.length - 1) e.target.style.textDecoration = 'underline'; }}
                  onMouseOut={(e) => { e.target.style.textDecoration = 'none'; }}
                >
                  {path.name}
                </span>
                {idx < breadcrumbs.length - 1 && <ChevronRight size={14} />}
              </React.Fragment>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={openCreateFolderPrompt} disabled={!canCreateFolder} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'var(--surface-bg)', border: '1px solid var(--border-color)', padding: '8px 16px', borderRadius: '8px', cursor: canCreateFolder ? 'pointer' : 'not-allowed', color: 'var(--text-primary)', opacity: canCreateFolder ? 1 : 0.55 }}>
            <FolderPlus size={18} className="text-muted" /> 新建文件夹</button>
          
          <input type="file" multiple ref={fileInputRef} style={{ display: 'none' }} onChange={handleFilesUpload} disabled={!canUploadDrive || uploadProgress?.active} />
          
          <button className="btn-primary" onClick={triggerUpload} disabled={!canUploadDrive || uploadProgress?.active} style={{ display: 'flex', alignItems: 'center', gap: '6px', opacity: canUploadDrive && !uploadProgress?.active ? 1 : 0.55, cursor: canUploadDrive && !uploadProgress?.active ? 'pointer' : 'not-allowed' }}>
            <UploadCloud size={18} /> 上传数据资产
          </button>
        </div>
      </div>
      {showUploadProgress && (
        <div
          style={{
            marginBottom: '16px',
            border: '1px solid var(--border-color)',
            background: '#ffffff',
            borderRadius: '8px',
            padding: '12px 16px',
            boxShadow: '0 1px 2px rgba(15, 23, 42, 0.05)'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginBottom: '8px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                {uploadStatusText[uploadProgress.status] || '正在上传'} {uploadProgress.completed || 0}/{uploadProgress.total || 0}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                {uploadProgress.currentFile ? `当前文件：${uploadProgress.currentFile}` : '正在整理上传任务'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'right' }}>
                <div style={{ fontWeight: 700, color: 'var(--brand-primary)' }}>{uploadProgressPercent}%</div>
                <div>{formatFileSizeBytes(uploadProgress.uploadedBytes || 0)} / {formatFileSizeBytes(uploadProgress.totalBytes || 0)}</div>
              </div>
              {uploadProgress.active && uploadProgress.status !== 'stopping' && (
                <button
                  type="button"
                  onClick={stopUpload}
                  title="停止上传"
                  style={{
                    width: '32px',
                    height: '32px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1px solid #fecaca',
                    borderRadius: '8px',
                    background: '#fef2f2',
                    color: '#dc2626',
                    cursor: 'pointer'
                  }}
                >
                  <XCircle size={16} />
                </button>
              )}
            </div>
          </div>
          <div style={{ height: '8px', background: '#e5e7eb', borderRadius: '999px', overflow: 'hidden' }}>
            <div
              style={{
                width: `${uploadProgressPercent}%`,
                height: '100%',
                background: uploadProgress.status === 'stopped'
                  ? '#dc2626'
                  : uploadProgress.status === 'finished-with-errors'
                    ? '#f59e0b'
                    : 'var(--brand-primary)',
                transition: 'width 180ms ease'
              }}
            />
          </div>
          {uploadProgress.failed > 0 && (
            <div style={{ marginTop: '6px', fontSize: '12px', color: '#b45309' }}>
              {uploadProgress.failed} 个文件未上传成功，完成后会显示失败原因。
            </div>
          )}
        </div>
      )}
      <DriveDirectoryView
        backendFeedback={backendFeedback}
        canDeleteDrive={canDeleteDrive}
        currentFolderId={currentFolderId}
        currentUploadRestrictedFolder={currentUploadRestrictedFolder}
        displayItems={displayItems}
        downloadDriveItem={downloadDriveItem}
        dropDriveItemOnFolder={dropDriveItemOnFolder}
        fileSystem={fileSystem}
        formatInstrumentLabel={formatInstrumentLabel}
        navigateToFolder={navigateToFolder}
        openDriveItem={openDriveItem}
        projectSyncStatusTheme={projectSyncStatusTheme}
        removeDriveItem={removeDriveItem}
        removeSelectedDriveItems={removeSelectedDriveItems}
        renameDriveItem={renameDriveItem}
        searchTerm={searchTerm}
        selectedProject={selectedProject}
        selectedDriveItemIds={selectedDriveItemIds}
        selectionMode={selectionMode}
        setSearchTerm={setSearchTerm}
        setSelectionMode={setSelectionMode}
        setViewMode={setViewMode}
        startDragDriveItem={startDragDriveItem}
        toggleDriveItemSelection={toggleDriveItemSelection}
        toggleSelectAllVisibleDriveItems={toggleSelectAllVisibleDriveItems}
        clearDriveSelection={clearDriveSelection}
        viewMode={viewMode}
        visibleProjectSyncStatus={visibleProjectSyncStatus}
      />

      <DriveParserLauncher
        fileSystem={fileSystem}
        setFileSystem={setFileSystem}
        currentUser={currentUser}
        selectedProject={selectedProject}
        parsingFile={parsingFile}
        parsingMTFile={parsingMTFile}
        parsingXFile={parsingXFile}
        parsingYFile={parsingYFile}
        parsingEH4Project={parsingEH4Project}
        parsingF3IndexProject={parsingF3IndexProject}
        parsingDesignCoordFile={parsingDesignCoordFile}
        setParsingFile={setParsingFile}
        setParsingMTFile={setParsingMTFile}
        setParsingXFile={setParsingXFile}
        setParsingYFile={setParsingYFile}
        setParsingEH4Project={setParsingEH4Project}
        setParsingF3IndexProject={setParsingF3IndexProject}
        setParsingDesignCoordFile={setParsingDesignCoordFile}
        handleSwitchType={handleSwitchType}
        handleSwitchF3Band={handleSwitchF3Band}
        handleSwitchFile={handleSwitchFile}
        logFileOperations={logFileOperations}
        buildFileOperationPayload={buildFileOperationPayload}
      />

      <CreateFolderModal
        isOpen={showFolderPrompt}
        onClose={closeCreateFolderPrompt}
        onSubmit={handleCreateFolder}
        canCreateFolder={canCreateFolder}
        isCurrentFolderInRawTree={isCurrentFolderInRawTree}
        inheritedFolderRestriction={inheritedFolderRestriction}
        selectedProjectMethod={selectedProject?.method}
      />
    </div>
  );
};

export default DataDrive;
