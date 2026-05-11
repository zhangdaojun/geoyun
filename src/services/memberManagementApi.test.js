import { describe, expect, it } from 'vitest';
import {
  createInvitationRecords,
  parseBulkInviteInput,
  revokeInvitationRecord,
  resendInvitationRecord,
  searchRegisteredUsers,
  verifyInvitationCode
} from './memberManagementApi';

const mockUsers = [
  { id: 'u1', name: '张晨', account: 'zhangchen', email: 'zhang@example.com', phone: '13800000001', status: 'active' },
  { id: 'u2', name: '李岩', account: 'liyan', email: 'li@example.com', phone: '13800000002', status: 'active' },
  { id: 'u3', name: '禁用用户', account: 'disabled', email: 'disabled@example.com', phone: '13800000003', status: 'disabled' }
];

describe('memberManagementApi', () => {
  it('解析批量邀请输入并识别无效项', () => {
    const parsed = parseBulkInviteInput('zhang@example.com\n13800000009,invalid-contact');
    expect(parsed).toHaveLength(3);
    expect(parsed[0].valid).toBe(true);
    expect(parsed[1].type).toBe('phone');
    expect(parsed[2].valid).toBe(false);
  });

  it('仅在关键词足够时返回分页搜索结果', async () => {
    const empty = await searchRegisteredUsers({ users: mockUsers, keyword: 'z' });
    expect(empty.requiresKeyword).toBe(true);
    const found = await searchRegisteredUsers({ users: mockUsers, keyword: '张晨', excludeUserIds: [] });
    expect(found.items).toHaveLength(1);
    expect(found.items[0].email).toBe('zhang@example.com');
  });

  it('统一邀请时为已注册与未注册用户都生成邀请记录', () => {
    const result = createInvitationRecords({
      contacts: parseBulkInviteInput('new@example.com\n13800000002\nbad-value\nnew@example.com'),
      project: { id: 'p1' },
      users: mockUsers,
      actor: { name: '项目创建者' },
      channel: 'email',
      existingInvitations: [{ id: 'i1', contactValue: 'old@example.com' }],
      existingMembers: [{ userId: 'u1' }]
    });

    expect(result.created).toHaveLength(2);
    expect(result.invalid).toHaveLength(1);
    expect(result.notifiedRegistered).toHaveLength(1);
    expect(result.created.find(item => item.contactValue === '13800000002').recipientStatus).toBe('registered');
    expect(result.created[0].inviteCode).toBeTruthy();
    expect(result.created[0].projectRole).toBe('viewer');
  });

  it('异常邀请：携带 role 或 remark 字段应返回 400 错误', () => {
    const resultWithRole = createInvitationRecords({
      contacts: parseBulkInviteInput('new@example.com'),
      role: 'admin'
    });
    expect(resultWithRole.code).toBe(400);
    expect(resultWithRole.message).toBe('非法字段');

    const resultWithRemark = createInvitationRecords({
      contacts: parseBulkInviteInput('new@example.com'),
      remark: 'test'
    });
    expect(resultWithRemark.code).toBe(400);
    expect(resultWithRemark.message).toBe('非法字段');
  });

  it('防刷机制：手机号24小时内最多接受3次邀请', () => {
    const now = Date.now();
    const existingInvitations = [
      { 
        id: 'inv_1', 
        contactValue: '13811112222', 
        contactType: 'phone',
        status: 'pending',
        inviteLogs: [
          { action: 'send', timestamp: now - 1000 },
          { action: 'send', timestamp: now - 500 },
          { action: 'send', timestamp: now - 100 }
        ]
      }
    ];

    const result = createInvitationRecords({
      contacts: parseBulkInviteInput('13811112222'),
      project: { id: 'p1' },
      users: mockUsers,
      actor: { name: '项目创建者' },
      existingInvitations,
      now
    });

    expect(result.created).toHaveLength(0);
    expect(result.rateLimited).toHaveLength(1);
    expect(result.rateLimited[0].value).toBe('13811112222');

    // Resend should also fail
    const { error } = resendInvitationRecord({
      invitations: existingInvitations,
      invitationId: 'inv_1',
      users: mockUsers,
      actor: { name: '项目创建者' },
      now
    });
    expect(error).toBe('rate_limited');
  });

  it('验证邀请码有效性与过期状态', () => {
    const validProject = {
      id: 'p1',
      projectInvitations: [
        {
          id: 'invite_1',
          contactType: 'email',
          contactValue: 'new@example.com',
          projectRole: 'viewer',
          status: 'pending',
          inviteCode: 'ABC12345',
          expiresAt: '2099-01-01T00:00:00.000Z'
        }
      ]
    };
    const expiredProject = {
      id: 'p2',
      projectInvitations: [
        {
          id: 'invite_2',
          contactType: 'email',
          contactValue: 'expired@example.com',
          projectRole: 'viewer',
          status: 'expired',
          inviteCode: 'EXPIRED1',
          expiresAt: '2000-01-01T00:00:00.000Z'
        }
      ]
    };

    expect(verifyInvitationCode({ projects: [validProject], inviteCode: 'ABC12345', users: [] }).valid).toBe(true);
    expect(verifyInvitationCode({ projects: [expiredProject], inviteCode: 'EXPIRED1', users: [] }).reason).toBe('expired');
  });

  it('支持撤销邀请并阻止邀请码继续使用', () => {
    const revoked = revokeInvitationRecord({
      invitations: [{
        id: 'invite_3',
        projectId: 'p3',
        contactType: 'email',
        contactValue: 'revoke@example.com',
        projectRole: 'viewer',
        status: 'pending',
        inviteCode: 'REVOKE01',
        expiresAt: '2099-01-01T00:00:00.000Z'
      }],
      invitationId: 'invite_3'
    });

    expect(revoked[0].status).toBe('revoked');
    expect(revoked[0].inviteLogs[0].action).toBe('revoke');
    expect(verifyInvitationCode({
      projects: [{ id: 'p3', projectInvitations: revoked }],
      inviteCode: 'REVOKE01',
      users: []
    }).reason).toBe('revoked');
  });
});
