import { defaultCurrentUser, defaultUsers, ensureCurrentUser, ensureUserList } from '../utils/accessControl';
import { ensureAppSettings } from '../utils/appSettings';

export const GEOYUN_APP_STORAGE_KEY = 'geoyun_app_state_v2';

export const normalizeView = (view) => (
  ['dashboard', 'map', 'projects', 'data', 'cloud', 'settings', 'admin-users'].includes(view)
    ? view
    : 'dashboard'
);

export const serializeProjectsForStorage = () => null;

export const loadPersistedAppState = () => {
  try {
    const raw = window.localStorage.getItem(GEOYUN_APP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      projectsList: null,
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
