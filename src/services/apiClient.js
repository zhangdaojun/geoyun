import { clearToken, getToken } from './tokenStore';

export const ADMIN_API_BASE = import.meta.env.VITE_ADMIN_API_BASE_URL || '/admin';

export const buildQueryString = (params = {}) => {
  const searchParams = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      searchParams.set(key, String(value).trim());
    }
  });
  const query = searchParams.toString();
  return query ? `?${query}` : '';
};

const requestJson = async (baseUrl, path, options = {}) => {
  const token = getToken();
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    credentials: options.credentials || (baseUrl.startsWith('/') ? 'include' : 'omit'),
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      clearToken();
      // Optional: trigger an event to logout
    }
    throw new Error(payload?.detail || payload?.error || `Request failed: ${response.status}`);
  }
  return payload;
};

export const requestAdminApi = (path, currentUser, options = {}) => requestJson(ADMIN_API_BASE, path, options);
