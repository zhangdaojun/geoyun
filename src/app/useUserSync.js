import { useState } from 'react';
import { defaultUsers, ensureUserList } from '../utils/accessControl';

export const useUserSync = (persistedState) => {
  const [users, setUsers] = useState(() => ensureUserList(persistedState?.users || defaultUsers));
  return { users, setUsers };
};
