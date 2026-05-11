import { requestAdminApi } from './apiClient';
import { clearToken, setToken } from './tokenStore';

export const sendSmsCode = async ({ phone, purpose }) => {
  return requestAdminApi('/auth/send-code', null, {
    method: 'POST',
    body: JSON.stringify({ phone, purpose }),
  });
};

export const registerWithSms = async ({ account, name, company = '', phone, password, code, email = '' }) => {
  const payload = await requestAdminApi('/auth/register', null, {
    method: 'POST',
    body: JSON.stringify({ account, name, company, phone, password, code, email }),
  });
  if (payload?.token) setToken(payload.token);
  return payload;
};

export const loginWithPassword = async ({ identifier, password }) => {
  const payload = await requestAdminApi('/auth/login/password', null, {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  });
  if (payload?.token) setToken(payload.token);
  return payload;
};

export const loginWithSms = async ({ phone, code }) => {
  const payload = await requestAdminApi('/auth/login/code', null, {
    method: 'POST',
    body: JSON.stringify({ phone, code }),
  });
  if (payload?.token) setToken(payload.token);
  return payload;
};

export const logout = async () => {
  try {
    await requestAdminApi('/auth/logout', null, { method: 'POST' });
  } catch {
    // Ignore logout failure
  } finally {
    clearToken();
  }
};

export const fetchCurrentUser = async () => {
  return requestAdminApi('/auth/me', null, { method: 'GET' });
};
