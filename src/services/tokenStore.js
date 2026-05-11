const TOKEN_KEY = 'geoyun_auth_token';

export const getToken = () => {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
};

export const setToken = (token) => {
  try {
    if (token) {
      window.localStorage.setItem(TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
};

export const clearToken = () => {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore storage failures.
  }
};
