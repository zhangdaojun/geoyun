import { useEffect, useMemo, useRef, useState } from 'react';
import { canManageProjectDatabase } from '../utils/accessControl';
import { ensureProjectShape } from '../utils/projectModel';
import { confirmDialog } from '../utils/message';
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

const PROJECT_SYNC_TIMEOUT_MS = 20000;

const withProjectSyncTimeout = (promise, label = '项目同步') => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label}超时，请稍后刷新确认结果。`));
    }, PROJECT_SYNC_TIMEOUT_MS);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    window.clearTimeout(timeoutId);
  });
};

const hydrateAdminProjectDriveItems = async (project) => ensureProjectShape(project);

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
    Array.isArray(persistedState?.projectsList)
      ? persistedState.projectsList
      : []
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
        const saveProjectPromise = shouldUseAdminUpdateApi
          ? updateAdminProjectViaApi(normalizedProject, currentUser)
          : shouldUseAdminCreateApi
            ? (async () => {
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
        const savedProject = await withProjectSyncTimeout(saveProjectPromise, syncMeta.syncTitle || '项目同步');
        const refreshedProject = syncMeta?.skipRefetch
          ? ensureProjectShape(savedProject)
          : await withProjectSyncTimeout(
              refetchProjectDetail(savedProject).catch(() => savedProject),
              '项目详情回刷'
            );
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

  useEffect(() => {
    if (projectSyncStatus?.phase !== 'syncing') return undefined;
    const startedAt = Number(projectSyncStatus.updatedAt || Date.now());
    const delay = Math.max(PROJECT_SYNC_TIMEOUT_MS - (Date.now() - startedAt), 0);
    const timeoutId = window.setTimeout(() => {
      setProjectSyncStatus((current) => {
        if (current?.phase !== 'syncing') return current;
        if (current.updatedAt !== projectSyncStatus.updatedAt) return current;
        return {
          ...current,
          phase: 'error',
          title: `${current.title || '项目同步'}超时`,
          detail: '后台同步时间过长，已停止等待。请刷新页面确认最新结果。',
          updatedAt: Date.now()
        };
      });
    }, delay);
    return () => window.clearTimeout(timeoutId);
  }, [projectSyncStatus]);

  useEffect(() => {
    if (!['success', 'error'].includes(projectSyncStatus?.phase)) return undefined;
    const snapshotUpdatedAt = projectSyncStatus?.updatedAt;
    const timer = window.setTimeout(() => {
      setProjectSyncStatus((current) => (
        current?.updatedAt === snapshotUpdatedAt ? null : current
      ));
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [projectSyncStatus]);

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
