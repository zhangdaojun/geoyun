export const BACKEND_ROLE_VALUES = ['super_admin', 'admin', 'support', 'user'];
export const BACKEND_ADMIN_ACCESS_ROLES = ['super_admin', 'admin', 'support'];
export const PROJECT_ROLE_VALUES = ['owner', 'manager', 'operator', 'reviewer', 'viewer'];
export const PROJECT_WRITE_ROLES = ['owner', 'manager', 'operator'];

export const BACKEND_ROLE_OPTIONS = [
  { value: 'super_admin', label: 'super_admin（超级管理员）' },
  { value: 'admin', label: 'admin（运营管理员）' },
  { value: 'support', label: 'support（客服/审计）' },
  { value: 'user', label: 'user（普通用户）' }
];

export const BACKEND_ROLE_LABELS = BACKEND_ROLE_OPTIONS.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {});

export const LEGACY_BACKEND_ROLE_MAP = {
  admin: 'super_admin',
  manager: 'admin',
  operator: 'admin',
  reviewer: 'support',
  viewer: 'user',
  platform_admin: 'admin',
  security_auditor: 'support'
};

export const USER_PERMISSION_MATRIX = {
  super_admin: {
    viewBackendUserAdmin: true,
    viewUsers: true,
    createUser: true,
    editUser: true,
    disableUser: true,
    deleteUser: true,
    resetPassword: true,
    changePhone: true,
    viewAuditLogs: true
  },
  admin: {
    viewBackendUserAdmin: true,
    viewUsers: true,
    createUser: true,
    editUser: true,
    disableUser: true,
    deleteUser: false,
    resetPassword: true,
    changePhone: false,
    viewAuditLogs: true
  },
  support: {
    viewBackendUserAdmin: true,
    viewUsers: true,
    createUser: false,
    editUser: false,
    disableUser: false,
    deleteUser: false,
    resetPassword: false,
    changePhone: false,
    viewAuditLogs: true
  },
  user: {
    viewBackendUserAdmin: false,
    viewUsers: false,
    createUser: false,
    editUser: false,
    disableUser: false,
    deleteUser: false,
    resetPassword: false,
    changePhone: false,
    viewAuditLogs: false
  }
};

export const PROJECT_ROLE_PERMISSION_MATRIX = {
  owner: { editTask: true, editPlanning: true, manageProjectDatabase: true },
  manager: { editTask: true, editPlanning: true, manageProjectDatabase: true },
  operator: { editTask: true, editPlanning: true, manageProjectDatabase: true },
  reviewer: { editTask: false, editPlanning: false, manageProjectDatabase: false },
  viewer: { editTask: false, editPlanning: false, manageProjectDatabase: false }
};

export const defaultCurrentUser = {
  id: 'user_admin',
  account: 'admin',
  phone: '13800000000',
  name: '张晨',
  company: '吉云科技',
  backendRole: 'super_admin',
  status: 'active',
  email: 'admin@geoyun.local'
};

export const defaultUsers = [
  defaultCurrentUser,
  {
    id: 'user_ops_admin',
    account: 'ops_admin',
    phone: '13800000001',
    name: '李岩',
    company: '吉云科技',
    backendRole: 'admin',
    status: 'active',
    email: 'ops_admin@geoyun.local'
  },
  {
    id: 'user_support',
    account: 'support',
    phone: '13800000002',
    name: '周宁',
    company: '吉云科技',
    backendRole: 'support',
    status: 'active',
    email: 'support@geoyun.local'
  },
  {
    id: 'user_viewer',
    account: 'viewer',
    phone: '13800000003',
    name: '陈远',
    company: '合作单位',
    backendRole: 'user',
    status: 'active',
    email: 'viewer@geoyun.local'
  }
];

export const normalizeBackendRole = (role) => {
  const raw = String(role || '').trim();
  const nextRole = BACKEND_ROLE_LABELS[raw] ? raw : LEGACY_BACKEND_ROLE_MAP[raw];
  return BACKEND_ROLE_LABELS[nextRole] ? nextRole : 'user';
};

export const ensureCurrentUser = (user) => {
  const nextUser = {
    ...defaultCurrentUser,
    ...(user || {})
  };
  return {
    ...nextUser,
    backendRole: normalizeBackendRole(nextUser.backendRole || nextUser.role),
    status: nextUser.status === 'disabled' ? 'disabled' : 'active'
  };
};

export const ensureUserRecord = (user, index = 0) => {
  const nextUser = ensureCurrentUser(user);
  return {
    ...nextUser,
    id: nextUser.id || `user_${index}_${Math.random().toString(36).slice(2, 8)}`,
    account: nextUser.account || `user${index + 1}`,
    phone: nextUser.phone || '',
    email: nextUser.email || '',
    company: nextUser.company || '',
    backendRole: normalizeBackendRole(nextUser.backendRole),
    lastLoginAt: nextUser.lastLoginAt || '',
    note: nextUser.note || ''
  };
};

export const ensureUserList = (users) => {
  const source = Array.isArray(users) && users.length ? users : defaultUsers;
  const seen = new Set();
  return source
    .map((user, index) => ensureUserRecord(user, index))
    .filter((user) => {
      if (seen.has(user.id)) return false;
      seen.add(user.id);
      return true;
    });
};

export const resolveManagedUser = (users, identifier = '') => {
  const keyword = String(identifier || '').trim().toLowerCase();
  if (!keyword) return null;
  return ensureUserList(users).find((user) => (
    [user.account, user.name, user.phone, user.email].some(
      (value) => String(value || '').toLowerCase() === keyword
    )
  )) || null;
};

export const getUserPermissions = (user) => {
  const backendRole = normalizeBackendRole(user?.backendRole || user?.role);
  return USER_PERMISSION_MATRIX[backendRole] || USER_PERMISSION_MATRIX.user;
};

export const resolveCurrentProjectMember = (project, currentUser) => {
  if (!project?.projectMembers?.length) return null;
  return project.projectMembers.find(member => String(member.userId || '').trim() === String(currentUser?.id || '').trim()) || null;
};

export const resolveCurrentProjectRole = (project, currentUser) => {
  const member = resolveCurrentProjectMember(project, currentUser);
  if (member?.projectRole) return member.projectRole;
  if (!project?.projectMembers?.length) return 'owner';
  return 'viewer';
};

export const getProjectPermissions = (project, currentUser) => {
  const currentProjectRole = resolveCurrentProjectRole(project, currentUser);
  return PROJECT_ROLE_PERMISSION_MATRIX[currentProjectRole] || PROJECT_ROLE_PERMISSION_MATRIX.viewer;
};

export const canManageProjectDatabase = (project, currentUser) => {
  const backendRole = normalizeBackendRole(currentUser?.backendRole || currentUser?.role);
  if (backendRole === 'super_admin' || backendRole === 'admin') {
    return true;
  }
  return Boolean(getProjectPermissions(project, currentUser)?.manageProjectDatabase);
};
