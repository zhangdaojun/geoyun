import { useCallback, useEffect, useState } from 'react';
import { clearToken } from '../services/tokenStore';
import { fetchCurrentUser, logout as apiLogout } from '../services/authApi';
import {
  defaultCurrentUser,
  ensureCurrentUser,
  ensureUserList,
  getUserPermissions,
  resolveManagedUser
} from '../utils/accessControl';

export const useSessionState = ({
  persistedState,
  users,
  setUsers,
  currentView,
  navigate,
  setSelectedProject,
  setPendingDriveFolderId,
  setGlobalSearchTerm
}) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [currentUser, setCurrentUser] = useState(() => (
    ensureCurrentUser(persistedState?.currentUser || defaultCurrentUser)
  ));

  useEffect(() => {
    let mounted = true;
    const initSession = async () => {
      try {
        const res = await fetchCurrentUser();
        if (mounted && res?.user) {
          setCurrentUser(ensureCurrentUser(res.user));
          setIsAuthenticated(true);
        }
      } catch {
        if (mounted) {
          setIsAuthenticated(false);
          clearToken();
        }
      } finally {
        if (mounted) setIsInitializing(false);
      }
    };
    initSession();
    return () => { mounted = false; };
  }, []);

  const resetSessionNavigation = useCallback(() => {
    if (navigate) navigate('/');
    setSelectedProject(null);
    setPendingDriveFolderId(null);
    setGlobalSearchTerm('');
  }, [navigate, setGlobalSearchTerm, setPendingDriveFolderId, setSelectedProject]);

  const handleLogin = async (user) => {
    const nextUser = ensureCurrentUser(user);
    setUsers(prev => {
      const exists = prev.some((item) => item.id === nextUser.id);
      const nextList = exists
        ? prev.map(item => item.id === nextUser.id ? { ...item, ...nextUser, lastLoginAt: nextUser.lastLoginAt || new Date().toLocaleString() } : item)
        : [...prev, nextUser];
      return ensureUserList(nextList);
    });
    setCurrentUser(nextUser);
    setIsAuthenticated(true);
    return nextUser;
  };

  const handleLogout = async () => {
    await apiLogout();
    setIsAuthenticated(false);
    resetSessionNavigation();
    setCurrentUser(defaultCurrentUser);
  };

  useEffect(() => {
    const permissions = getUserPermissions(currentUser);
    if (currentView === 'admin-users' && !permissions.viewBackendUserAdmin) {
      if (navigate) navigate('/');
    }
  }, [currentUser, currentView, navigate]);

  useEffect(() => {
    if (!isAuthenticated || isInitializing) return;
    const matchedUser = resolveManagedUser(users, currentUser.account || currentUser.name);
    if (!matchedUser) return;
    if (matchedUser.status === 'disabled') {
      const timeoutId = window.setTimeout(() => {
        setIsAuthenticated(false);
        resetSessionNavigation();
        setCurrentUser(defaultCurrentUser);
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
    if (
      matchedUser.name !== currentUser.name
      || matchedUser.status !== currentUser.status
      || matchedUser.account !== currentUser.account
      || matchedUser.phone !== currentUser.phone
      || matchedUser.email !== currentUser.email
      || matchedUser.backendRole !== currentUser.backendRole
    ) {
      const timeoutId = window.setTimeout(() => {
        setCurrentUser(ensureCurrentUser(matchedUser));
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [
    currentUser,
    isAuthenticated,
    isInitializing,
    resetSessionNavigation,
    users
  ]);

  return {
    isAuthenticated,
    setIsAuthenticated,
    isInitializing,
    currentUser,
    setCurrentUser,
    handleLogin,
    handleLogout
  };
};
