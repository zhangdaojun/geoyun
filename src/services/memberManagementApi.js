const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

export const MEMBER_SEARCH_PAGE_SIZE = 6;
export const INVITE_TTL_DAYS = 7;

const normalizeKeyword = (value) => String(value || '').trim().toLowerCase();

const buildInvitationId = () => `invite_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const buildInviteCode = () => Math.random().toString(36).slice(2, 10).toUpperCase();

export const maskContactValue = (value = '', type = 'email') => {
  if (!value) return '--';
  if (type === 'phone') {
    return `${value.slice(0, 3)}****${value.slice(-4)}`;
  }
  const [name, domain] = String(value).split('@');
  if (!domain) return value;
  return `${name.slice(0, Math.min(2, name.length))}***@${domain}`;
};

export const parseBulkInviteInput = (rawText = '') => {
  return Array.from(new Set(
    String(rawText || '')
      .split(/[\n,，;；\s]+/)
      .map(item => String(item || '').trim())
      .filter(Boolean)
  )).map((value) => {
    if (EMAIL_PATTERN.test(value)) return { value, type: 'email', valid: true };
    if (PHONE_PATTERN.test(value)) return { value, type: 'phone', valid: true };
    return { value, type: 'unknown', valid: false };
  });
};

export const resolveInvitationStatus = (invitation, users = [], now = Date.now()) => {
  const expiresAt = invitation?.expiresAt ? new Date(invitation.expiresAt).getTime() : 0;
  const matchedUser = (users || []).find(user =>
    [user.email, user.phone].some(value => String(value || '').toLowerCase() === String(invitation?.contactValue || '').toLowerCase())
  );
  
  let currentStatus = invitation?.status || 'pending';
  // Map old 'sent' to 'pending'
  if (currentStatus === 'sent') currentStatus = 'pending';
  
  if (currentStatus === 'revoked' || currentStatus === 'accepted' || currentStatus === 'rejected') {
    return {
      status: currentStatus,
      invitedUserId: invitation?.invitedUserId || matchedUser?.id || '',
      recipientStatus: matchedUser ? 'registered' : (invitation?.recipientStatus || 'unregistered')
    };
  }
  if (expiresAt && expiresAt < now) {
    return {
      status: 'expired',
      invitedUserId: invitation?.invitedUserId || matchedUser?.id || '',
      recipientStatus: matchedUser ? 'registered' : (invitation?.recipientStatus || 'unregistered')
    };
  }
  // If registered but pending
  return {
    status: currentStatus,
    invitedUserId: invitation?.invitedUserId || matchedUser?.id || '',
    recipientStatus: invitation?.recipientStatus || (matchedUser ? 'registered' : 'unregistered')
  };
};

export const normalizeProjectInvitations = (invitations = [], users = [], now = Date.now()) => {
  return (Array.isArray(invitations) ? invitations : []).map((invitation) => {
    const resolved = resolveInvitationStatus(invitation, users, now);
    return {
      id: invitation?.id || buildInvitationId(),
      projectId: invitation?.projectId || '',
      contactType: invitation?.contactType === 'phone' ? 'phone' : 'email',
      contactValue: invitation?.contactValue || '',
      displayName: invitation?.displayName || '',
      projectRole: invitation?.projectRole === 'visitor' ? 'viewer' : (invitation?.projectRole || 'viewer'),
      status: resolved.status,
      recipientStatus: resolved.recipientStatus,
      inviteChannel: invitation?.inviteChannel === 'sms' ? 'sms' : invitation?.inviteChannel === 'code' ? 'code' : invitation?.inviteChannel === 'internal' ? 'internal' : 'email',
      inviteCode: invitation?.inviteCode || buildInviteCode(),
      inviteLink: invitation?.inviteLink || '',
      invitedAt: invitation?.invitedAt || new Date(now).toLocaleString(),
      expiresAt: invitation?.expiresAt || new Date(now + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      lastSentAt: invitation?.lastSentAt || new Date(now).toLocaleString(),
      sentCount: Number(invitation?.sentCount) > 0 ? Number(invitation.sentCount) : 1,
      invitedBy: invitation?.invitedBy || '',
      invitedUserId: resolved.invitedUserId,
      revokedAt: invitation?.revokedAt || '',
      note: invitation?.note || '',
      inviteLogs: Array.isArray(invitation?.inviteLogs) ? invitation.inviteLogs : []
    };
  });
};

export const searchRegisteredUsers = async ({
  users = [],
  keyword = '',
  page = 1,
  pageSize = MEMBER_SEARCH_PAGE_SIZE,
  excludeUserIds = [],
  now = Date.now()
}) => {
  const trimmedKeyword = normalizeKeyword(keyword);
  if (trimmedKeyword.length < 2) {
    return {
      items: [],
      total: 0,
      page: 1,
      pageSize,
      hasMore: false,
      requiresKeyword: true,
      requestedAt: now
    };
  }

  const excluded = new Set(excludeUserIds);
  const matched = (users || [])
    .filter(user => user.status === 'active' && !excluded.has(user.id))
    .filter(user => [user.name, user.email, user.phone, user.account].some(value => normalizeKeyword(value).includes(trimmedKeyword)))
    .map(user => ({
      id: user.id,
      name: user.name,
      account: user.account,
      email: user.email,
      phone: user.phone,
      maskedEmail: maskContactValue(user.email, 'email'),
      maskedPhone: maskContactValue(user.phone, 'phone'),
      status: user.status
    }));

  const startIndex = Math.max(0, (page - 1) * pageSize);
  const items = matched.slice(startIndex, startIndex + pageSize);
  return {
    items,
    total: matched.length,
    page,
    pageSize,
    hasMore: startIndex + pageSize < matched.length,
    requiresKeyword: false,
    requestedAt: now
  };
};

export const createInvitationRecords = (params = {}) => {
  if ('role' in params || 'remark' in params) {
    return { code: 400, message: '非法字段' };
  }

  const {
    contacts = [],
    project,
    users = [],
    actor,
    channel = 'email',
    existingInvitations = [],
    existingMembers = [],
    now = Date.now()
  } = params;

  const role = 'viewer';

  const memberLookup = new Set((existingMembers || []).map(member => String(member.userId || '').toLowerCase()));
  
  // Track all invites across all projects to enforce rate limiting
  const rateLimitMap = new Map();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  
  // Build a map of phone numbers -> count of invites sent in last 24h
  (existingInvitations || []).forEach(invitation => {
    const val = String(invitation.contactValue || '').toLowerCase();
    const logs = invitation.inviteLogs || [];
    const recentSends = logs.filter(log => 
      log.action === 'send' && (now - log.timestamp) < ONE_DAY_MS
    ).length;
    // fallback for old records
    const count = recentSends > 0 ? recentSends : (
      ((now - new Date(invitation.lastSentAt || 0).getTime()) < ONE_DAY_MS) ? (invitation.sentCount || 1) : 0
    );
    rateLimitMap.set(val, (rateLimitMap.get(val) || 0) + count);
  });

  const invitationLookup = new Set((existingInvitations || []).filter(invitation => invitation?.status !== 'revoked').map(invitation => String(invitation.contactValue || '').toLowerCase()));

  const created = [];
  const duplicates = [];
  const invalid = [];
  const notifiedRegistered = [];
  const rateLimited = [];

  contacts.forEach((contact) => {
    if (!contact?.valid) {
      invalid.push({ value: contact?.value || '', reason: 'invalid' });
      return;
    }
    const normalizedValue = String(contact.value || '').toLowerCase();
    
    // Check rate limit: max 3 invites per 24h
    if (contact.type === 'phone') {
      const currentSends = rateLimitMap.get(normalizedValue) || 0;
      if (currentSends >= 3) {
        rateLimited.push({ value: contact.value, reason: 'rate_limited' });
        return;
      }
      rateLimitMap.set(normalizedValue, currentSends + 1);
    }

    const matchedUser = (users || []).find(user =>
      [user.email, user.phone].some(value => String(value || '').toLowerCase() === normalizedValue)
    );
    if (matchedUser) {
      if (memberLookup.has(String(matchedUser.id || '').toLowerCase())) {
        duplicates.push({ value: contact.value, reason: 'member_exists' });
        return;
      }
    }
    if (invitationLookup.has(normalizedValue) || (matchedUser && (existingInvitations || []).some(invitation => invitation?.invitedUserId === matchedUser.id && invitation?.status !== 'revoked'))) {
      duplicates.push({ value: contact.value, reason: 'invite_exists' });
      return;
    }
    const inviteCode = buildInviteCode();
    if (matchedUser) {
      notifiedRegistered.push({ value: contact.value, userId: matchedUser.id, reason: 'registered_user' });
    }
    
    const initialLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action: 'send',
      actorId: actor?.id || '',
      actorName: actor?.name || '',
      targetValue: contact.value,
      timestamp: now,
      fromStatus: '',
      toStatus: 'pending',
      note: 'Initial invitation sent'
    };

    created.push({
      id: buildInvitationId(),
      projectId: project?.id || '',
      contactType: contact.type,
      contactValue: contact.value,
      displayName: '',
      projectRole: role,
      status: 'pending',
      recipientStatus: matchedUser ? 'registered' : 'unregistered',
      inviteChannel: matchedUser ? 'internal' : channel,
      inviteCode,
      inviteLink: `geoyun://invite/${project?.id || 'project'}/${inviteCode}`,
      invitedAt: new Date(now).toLocaleString(),
      expiresAt: new Date(now + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      lastSentAt: new Date(now).toLocaleString(),
      sentCount: 1,
      invitedBy: actor?.name || '',
      invitedUserId: matchedUser?.id || '',
      revokedAt: '',
      note: '',
      inviteLogs: [initialLog]
    });
    invitationLookup.add(normalizedValue);
  });

  return { created, duplicates, invalid, notifiedRegistered, rateLimited };
};

export const resendInvitationRecord = ({
  invitations = [],
  invitationId,
  users = [],
  actor,
  now = Date.now()
}) => {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const normalizedInvitations = normalizeProjectInvitations(invitations, users, now);
  
  let error = null;
  const nextInvitations = normalizedInvitations.map((invitation) => {
    if (invitation.id !== invitationId) return invitation;
    
    // check rate limit for phone
    if (invitation.contactType === 'phone') {
      const logs = invitation.inviteLogs || [];
      const recentSends = logs.filter(log => 
        log.action === 'send' && (now - log.timestamp) < ONE_DAY_MS
      ).length;
      const count = recentSends > 0 ? recentSends : (
        ((now - new Date(invitation.lastSentAt || 0).getTime()) < ONE_DAY_MS) ? (invitation.sentCount || 1) : 0
      );
      if (count >= 3) {
        error = 'rate_limited';
        return invitation;
      }
    }

    const inviteCode = buildInviteCode();
    
    const sendLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action: 'send',
      actorId: actor?.id || '',
      actorName: actor?.name || '',
      targetValue: invitation.contactValue,
      timestamp: now,
      fromStatus: invitation.status,
      toStatus: 'pending',
      note: 'Resend invitation'
    };

    return {
      ...invitation,
      status: 'pending',
      inviteCode,
      inviteLink: `geoyun://invite/${invitation.projectId || 'project'}/${inviteCode}`,
      lastSentAt: new Date(now).toLocaleString(),
      expiresAt: new Date(now + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      sentCount: (Number(invitation.sentCount) || 0) + 1,
      revokedAt: '',
      inviteLogs: [...(invitation.inviteLogs || []), sendLog]
    };
  });
  return { nextInvitations, error };
};

export const revokeInvitationRecord = ({
  invitations = [],
  invitationId,
  users = [],
  actor,
  now = Date.now()
}) => {
  const normalizedInvitations = normalizeProjectInvitations(invitations, users, now);
  return normalizedInvitations.map((invitation) => {
    if (invitation.id !== invitationId) return invitation;
    const revokeLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action: 'revoke',
      actorId: actor?.id || '',
      actorName: actor?.name || '',
      targetValue: invitation.contactValue,
      timestamp: now,
      fromStatus: invitation.status,
      toStatus: 'revoked',
      note: 'Invitation revoked'
    };
    return {
      ...invitation,
      status: 'revoked',
      revokedAt: new Date(now).toLocaleString(),
      inviteLogs: [...(invitation.inviteLogs || []), revokeLog]
    };
  });
};

export const verifyInvitationCode = ({ projects = [], inviteCode = '', users = [], now = Date.now() }) => {
  const targetCode = String(inviteCode || '').trim().toUpperCase();
  if (!targetCode) return { valid: false, reason: 'empty_code' };
  for (const project of projects || []) {
    const invitations = normalizeProjectInvitations(project?.projectInvitations || [], users, now);
    const matched = invitations.find(item => String(item.inviteCode || '').toUpperCase() === targetCode);
    if (!matched) continue;
    if (matched.status === 'revoked') return { valid: false, reason: 'revoked', projectId: project.id, invitation: matched };
    if (matched.status === 'expired') return { valid: false, reason: 'expired', projectId: project.id, invitation: matched };
    if (matched.status === 'accepted') return { valid: false, reason: 'accepted', projectId: project.id, invitation: matched };
    if (matched.status === 'rejected') return { valid: false, reason: 'rejected', projectId: project.id, invitation: matched };
    return { valid: true, reason: 'ok', projectId: project.id, invitation: matched };
  }
  return { valid: false, reason: 'not_found' };
};
