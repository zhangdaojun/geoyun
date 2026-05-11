import { useEffect, useMemo, useRef, useState } from 'react';
import { projectsData } from '../mockData';
import { canManageProjectDatabase } from '../utils/accessControl';
import { ensureProjectShape } from '../utils/projectModel';
import { confirmDialog } from '../utils/message';
import { canLogAdminFileOperations, fetchAdminFiles } from '../services/adminFileApi';
import { canUseAdminFoldersApi, fetchAdminFolders } from '../services/adminFolderApi';
import {
  canEditAdminProjectsApi,
  canUseAdminProjectsApi,
  createAdminProjectViaApi,
  deleteAdminProjectViaApi,
  fetchAdminProjectDetailFromApi,
  fetchAdminProjectsFromApi,
  findAdminProjectByExternalId,
  updateAdminProjectViaApi
} from '../services/adminProjectApi';

const mergeDriveItems = (localItems = [], folderItems = [], fileItems = []) => {
  const normalizedLocalItems = Array.isArray(localItems) ? localItems : [];
  const remoteFolderByExternalId = new Map(
    (Array.isArray(folderItems) ? folderItems : [])
      .filter((item) => item?.id)
      .map((item) => [String(item.id), item])
  );
  const remoteFileByExternalId = new Map(
    (Array.isArray(fileItems) ? fileItems : [])
      .filter((item) => item?.id)
      .map((item) => [String(item.id), item])
  );

  const mergeDriveFileItem = (localItem = {}, remoteItem = {}) => {
    const merged = {
      ...localItem,
      ...remoteItem
    };
    const localPersistedBlobId = localItem.persistedBlobId || localItem.persisted_blob_id;
    const remotePersistedBlobId = remoteItem.persistedBlobId || remoteItem.persisted_blob_id;
    if (!remotePersistedBlobId && localPersistedBlobId) {
      merged.persistedBlobId = localPersistedBlobId;
      merged.persisted_blob_id = localPersistedBlobId;
    }

    const localObjectKey = localItem.object_key || localItem.objectKey;
    const remoteObjectKey = remoteItem.object_key || remoteItem.objectKey;
    if (!remoteObjectKey && localObjectKey) {
      merged.object_key = localObjectKey;
      merged.objectKey = localObjectKey;
    }

    const remoteStorageProvider = remoteItem.storage_provider || remoteItem.storageProvider;
    if (localPersistedBlobId && remoteStorageProvider === 'oss' && !remoteObjectKey) {
      merged.storage_provider = localItem.storage_provider || localItem.storageProvider || 'indexeddb';
      merged.storageProvider = merged.storage_provider;
    }

    return merged;
  };

  const mergedItems = normalizedLocalItems.map((item) => {
    if (item?.type === 'folder') {
      const matchedFolderItem = remoteFolderByExternalId.get(String(item.id));
      if (!matchedFolderItem) return item;
      remoteFolderByExternalId.delete(String(item.id));
      return {
        ...item,
        ...matchedFolderItem
      };
    }

    if (item?.type !== 'file') return item;

    const candidateIds = [item.id]
      .filter(Boolean)
      .map((value) => String(value));
    const matchedRemoteItem = candidateIds
      .map((candidateId) => remoteFileByExternalId.get(candidateId))
      .find(Boolean);

    if (!matchedRemoteItem) return item;

    remoteFileByExternalId.delete(String(matchedRemoteItem.id));
    return mergeDriveFileItem(item, matchedRemoteItem);
  });

  remoteFolderByExternalId.forEach((item) => mergedItems.push(item));
  remoteFileByExternalId.forEach((item) => mergedItems.push(item));
  return mergedItems;
};

const hydrateAdminProjectDriveItems = async (project, currentUser) => {
  if (!project?.backendProjectId || !canUseAdminProjectsApi(currentUser)) {
    return ensureProjectShape(project);
  }

  const shouldLoadFolders = canUseAdminFoldersApi(currentUser, project);
  const shouldLoadFiles = canLogAdminFileOperations(currentUser, project);
  if (!shouldLoadFolders && !shouldLoadFiles) {
    return ensureProjectShape(project);
  }

  const [folderResult, fileResult] = await Promise.allSettled([
    shouldLoadFolders
      ? fetchAdminFolders({ projectId: project.backendProjectId, status: 'active' }, currentUser)
      : Promise.resolve({ items: [] }),
    shouldLoadFiles
      ? fetchAdminFiles({ projectId: project.backendProjectId, status: 'active' }, currentUser)
      : Promise.resolve({ items: [] })
  ]);

  const folderItems = folderResult.status === 'fulfilled' ? (folderResult.value?.items || []) : [];
  const fileItems = fileResult.status === 'fulfilled' ? (fileResult.value?.items || []) : [];

  return ensureProjectShape({
    ...project,
    cloudData: {
      ...(project.cloudData || {}),
      projectId: project.id,
      items: mergeDriveItems(project?.cloudData?.items || [], folderItems, fileItems)
    }
  });
};

export const useProjectSync = ({
  persistedState,
  currentUser,
  selectedProject,
  setSelectedProject,
  navigate,
  setPendingDriveFolderId,
  setPendingProjectSelection
}) => {
  const [projectsList, setProjectsList] = useState(() => (
    persistedState?.projectsList || projectsData.map(ensureProjectShape)
  ));
  const [projectSyncStatus, setProjectSyncStatus] = useState(null);
  const projectUpdateQueueRef = useRef(Promise.resolve());
  const projectsListRef = useRef(projectsList);
  const selectedProjectRef = useRef(selectedProject);

  useEffect(() => {
    projectsListRef.current = projectsList;
  }, [projectsList]);

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  const effectiveSelectedProject = useMemo(() => {
    if (!selectedProject) return null;
    return projectsList.find(project => project.id === selectedProject.id) || null;
  }, [projectsList, selectedProject]);

  const refetchProjectDetail = async (project) => {
    if (!project?.id) return null;
    if (project?.dataSource === 'fastapi-admin' && project?.backendProjectId && canUseAdminProjectsApi(currentUser)) {
      const adminProject = await fetchAdminProjectDetailFromApi(project.backendProjectId, currentUser);
      return hydrateAdminProjectDriveItems(adminProject, currentUser);
    }
    return null;
  };

  const handleProjectCreate = async (projectPayload) => {
    if (!canEditAdminProjectsApi(currentUser)) {
      throw new Error('当前账号无权创建项目');
    }
    const createdProject = await createAdminProjectViaApi(projectPayload, currentUser);
    const refreshedProject = await refetchProjectDetail(createdProject).catch(() => createdProject);
    setProjectsList(prev => [refreshedProject, ...prev.filter(project => project.id !== refreshedProject.id)]);
    setSelectedProject(refreshedProject);
    return refreshedProject;
  };

  const handleProjectUpdate = async (nextProject, syncMeta = {}) => {
    const queuedUpdate = projectUpdateQueueRef.current
      .catch(() => null)
      .then(async () => {
        const currentSelectedProject = selectedProjectRef.current;
        const currentProjectSnapshot = projectsListRef.current.find(
          (project) => project.id === nextProject?.id
        ) || currentSelectedProject;
        if (syncMeta?.syncSource) {
          setProjectSyncStatus({
            phase: 'syncing',
            source: syncMeta.syncSource,
            projectId: nextProject?.id || currentProjectSnapshot?.id || '',
            title: syncMeta.syncTitle || '正在同步项目详情',
            detail: syncMeta.syncDetail || '正在将最新改动写入项目数据库并回刷当前详情。',
            updatedAt: Date.now()
          });
        }
        const resolvedBackendProjectId = nextProject?.backendProjectId || currentProjectSnapshot?.backendProjectId || null;
        const resolvedDataSource = nextProject?.dataSource || currentProjectSnapshot?.dataSource || '';
        const normalizedProject = ensureProjectShape({
          ...(currentProjectSnapshot || {}),
          ...(nextProject || {}),
          ...(resolvedBackendProjectId ? { backendProjectId: resolvedBackendProjectId } : {}),
          ...(resolvedDataSource ? { dataSource: resolvedDataSource } : {})
        });
        const canUseProjectAdminApi = canManageProjectDatabase(normalizedProject, currentUser);
        const shouldUseAdminUpdateApi = canUseProjectAdminApi
          && resolvedDataSource === 'fastapi-admin'
          && resolvedBackendProjectId;
        const shouldUseAdminCreateApi = canUseProjectAdminApi
          && (!resolvedBackendProjectId || resolvedDataSource !== 'fastapi-admin');
        const savedProject = shouldUseAdminUpdateApi
          ? await updateAdminProjectViaApi(normalizedProject, currentUser)
          : shouldUseAdminCreateApi
            ? await (async () => {
                const existingAdminProject = await findAdminProjectByExternalId(normalizedProject.id, currentUser);
                if (existingAdminProject?.backendProjectId) {
                  return updateAdminProjectViaApi(
                    ensureProjectShape({
                      ...existingAdminProject,
                      ...normalizedProject,
                      backendProjectId: existingAdminProject.backendProjectId,
                      dataSource: 'fastapi-admin'
                    }),
                    currentUser
                  );
                }
                return createAdminProjectViaApi(normalizedProject, currentUser);
              })()
            : (() => {
                throw new Error('当前账号无权同步项目到 FastAPI 后端');
              })();
        const refreshedProject = await refetchProjectDetail(savedProject).catch(() => savedProject);
        setProjectsList((prev) => {
          const normalizedSavedProject = ensureProjectShape(refreshedProject);
          const exists = prev.some((project) => project.id === normalizedSavedProject.id);
          if (!exists) return [normalizedSavedProject, ...prev];
          return prev.map((project) => (
            project.id === normalizedSavedProject.id ? normalizedSavedProject : project
          ));
        });
        setSelectedProject(refreshedProject);
        if (syncMeta?.syncSource) {
          setProjectSyncStatus({
            phase: 'success',
            source: syncMeta.syncSource,
            projectId: refreshedProject?.id || nextProject?.id || '',
            title: syncMeta.syncedTitle || '项目详情已同步',
            detail: syncMeta.syncedDetail || '当前页面已回刷为最新项目详情。',
            updatedAt: Date.now()
          });
        }
        return refreshedProject;
      });

    projectUpdateQueueRef.current = queuedUpdate.catch(() => null);
    queuedUpdate.catch((error) => {
      if (syncMeta?.syncSource) {
        setProjectSyncStatus({
          phase: 'error',
          source: syncMeta.syncSource,
          projectId: nextProject?.id || '',
          title: syncMeta.errorTitle || '项目同步失败',
          detail: syncMeta.errorDetail || error?.message || '项目更新失败，请稍后重试。',
          updatedAt: Date.now()
        });
      }
    });
    return queuedUpdate;
  };

  const handleDeleteProjectApi = async (projectToDelete) => {
    if (!projectToDelete?.id) return;
    const confirmed = await confirmDialog(
      '删除项目',
      `确定要删除项目“${projectToDelete.name || projectToDelete.id}”吗？删除后无法恢复。`
    );
    if (!confirmed) return;

    const shouldUseAdminApi = canEditAdminProjectsApi(currentUser)
      && projectToDelete?.dataSource === 'fastapi-admin'
      && projectToDelete?.backendProjectId;

    if (!shouldUseAdminApi) {
      throw new Error('当前项目未连接 FastAPI 管理后端，无法删除');
    }
    await deleteAdminProjectViaApi(projectToDelete, currentUser);
    setProjectsList((prev) => prev.filter(project => project.id !== projectToDelete.id));
    if (selectedProject?.id === projectToDelete.id) {
      setSelectedProject(null);
      setPendingDriveFolderId(null);
      setPendingProjectSelection(null);
      if (navigate) navigate('/projects');
    }
  };

  const handleReloadProject = async (projectToReload) => {
    if (!projectToReload?.id) return null;

    let nextProject = null;
    const shouldUseAdminApi = canUseAdminProjectsApi(currentUser)
      && projectToReload?.dataSource === 'fastapi-admin'
      && projectToReload?.backendProjectId;

    if (shouldUseAdminApi) {
      nextProject = await fetchAdminProjectDetailFromApi(projectToReload.backendProjectId, currentUser);
    }

    if (!nextProject) {
      throw new Error(`未找到项目“${projectToReload.name || projectToReload.id}”的最新数据。`);
    }

    setProjectsList((prev) => {
      const exists = prev.some((project) => project.id === nextProject.id);
      if (!exists) return [nextProject, ...prev];
      return prev.map((project) => (project.id === nextProject.id ? ensureProjectShape(nextProject) : project));
    });

    if (selectedProject?.id === nextProject.id) {
      setSelectedProject(nextProject);
    }

    return nextProject;
  };

  useEffect(() => {
    let cancelled = false;

    const syncProjectsFromApi = async () => {
      try {
        if (!canUseAdminProjectsApi(currentUser)) {
          return;
        }
        const nextProjects = await fetchAdminProjectsFromApi(currentUser);
        if (cancelled) return;
        setProjectsList(nextProjects);
        if (selectedProject?.id) {
          const matched = nextProjects.find((project) => project.id === selectedProject.id) || null;
          setSelectedProject(matched);
        }
      } catch (error) {
        console.warn('Failed to sync projects from FastAPI admin API.', error);
      }
    };

    syncProjectsFromApi();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser.account, currentUser.backendRole]);

  return {
    projectsList,
    setProjectsList,
    effectiveSelectedProject,
    projectSyncStatus,
    handleProjectCreate,
    handleProjectUpdate,
    handleDeleteProjectApi,
    handleReloadProject
  };
};
