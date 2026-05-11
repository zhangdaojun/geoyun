import { useEffect, useRef } from 'react';
import { GEOYUN_APP_STORAGE_KEY, serializeProjectsForStorage } from './appStorage';

export const useAppPersistence = ({
  appSettings,
  currentUser,
  currentView,
  isAuthenticated,
  pendingDriveFolderId,
  projectsList,
  selectedProject,
  users
}) => {
  const persistTimerRef = useRef(null);

  useEffect(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      try {
        window.localStorage.setItem(GEOYUN_APP_STORAGE_KEY, JSON.stringify({
          currentView,
          selectedProjectId: selectedProject?.id || null,
          pendingDriveFolderId,
          projectsList: serializeProjectsForStorage(projectsList),
          appSettings,
          users,
          currentUser
        }));
      } catch {
        // Ignore persistence failures and continue with in-memory state.
      }
    }, 500);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [appSettings, currentUser, currentView, isAuthenticated, pendingDriveFolderId, projectsList, selectedProject, users]);
};
