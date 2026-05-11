import { defaultCurrentUser, defaultUsers, ensureCurrentUser, ensureUserList } from '../utils/accessControl';
import { ensureAppSettings } from '../utils/appSettings';
import { ensureProjectShape } from '../utils/projectModel';

export const GEOYUN_APP_STORAGE_KEY = 'geoyun_app_state_v1';

export const normalizeView = (view) => (
  ['dashboard', 'map', 'projects', 'data', 'cloud', 'settings', 'admin-users'].includes(view)
    ? view
    : 'dashboard'
);

export const serializeProjectsForStorage = (projects) => {
  return (projects || []).map(project => ({
    ...project,
    cloudData: {
      ...(project.cloudData || {}),
      items: (project.cloudData?.items || []).map(item => {
        const { rawFile: _rawFile, ...rest } = item;
        return rest;
      })
    }
  }));
};

export const loadPersistedAppState = () => {
  try {
    const raw = window.localStorage.getItem(GEOYUN_APP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      projectsList: Array.isArray(parsed.projectsList) ? parsed.projectsList.map(ensureProjectShape) : null,
      selectedProjectId: parsed.selectedProjectId || null,
      currentView: normalizeView(parsed.currentView),
      pendingDriveFolderId: parsed.pendingDriveFolderId || null,
      isAuthenticated: Boolean(parsed.isAuthenticated),
      appSettings: ensureAppSettings(parsed.appSettings),
      users: ensureUserList(parsed.users || defaultUsers),
      currentUser: ensureCurrentUser(parsed.currentUser || defaultCurrentUser)
    };
  } catch {
    return null;
  }
};
