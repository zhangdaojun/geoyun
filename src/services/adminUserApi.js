import { buildQueryString, requestAdminApi } from './apiClient';

export const fetchAdminUsers = async (params = {}, currentUser) => {
  return requestAdminApi(`/users${buildQueryString(params)}`, currentUser);
};

export const fetchAdminUserDetail = async (userId, currentUser) => {
  return requestAdminApi(`/users/${encodeURIComponent(String(userId))}`, currentUser);
};

export const disableAdminUser = async (userId, currentUser) => {
  return requestAdminApi(`/users/${encodeURIComponent(String(userId))}/disable`, currentUser, {
    method: 'POST'
  });
};

export const enableAdminUser = async (userId, currentUser) => {
  return requestAdminApi(`/users/${encodeURIComponent(String(userId))}/enable`, currentUser, {
    method: 'POST'
  });
};
