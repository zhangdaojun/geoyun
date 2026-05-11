import React, { useMemo, useState } from 'react';
import { updateProjectWithInvitations, updateProjectWithMembers } from '../utils/projectModel';

const resolveRoleLabel = (role = 'viewer') => {
  if (role === 'owner') return '负责人';
  if (role === 'manager') return '管理员';
  if (role === 'operator') return '执行成员';
  if (role === 'reviewer') return '审核成员';
  return '访客';
};

const InviteReceiverModal = ({ currentUser, projectsList, onUpdateProject }) => {
  const [processingId, setProcessingId] = useState(null);
  const [feedback, setFeedback] = useState('');

  const pendingInvitations = useMemo(() => {
    if (!currentUser?.id) return [];
    const pending = [];
    (projectsList || []).forEach((project) => {
      (project.projectInvitations || []).forEach((invitation) => {
        if (invitation.invitedUserId === currentUser.id && invitation.status === 'pending') {
          pending.push({ project, invitation });
        }
      });
    });
    return pending;
  }, [currentUser, projectsList]);

  if (!pendingInvitations.length) return null;

  const handleResponse = async (projectId, invitationId, accept) => {
    setProcessingId(invitationId);
    setFeedback('');
    try {
      const project = (projectsList || []).find((item) => item.id === projectId);
      if (!project || !onUpdateProject) return;

      const nextInvitations = (project.projectInvitations || []).map((invitation) => {
        if (invitation.id !== invitationId) return invitation;
        const log = {
          id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          action: accept ? 'accept' : 'reject',
          actorId: currentUser.id,
          actorName: currentUser.name,
          targetValue: invitation.contactValue,
          timestamp: Date.now(),
          fromStatus: invitation.status,
          toStatus: accept ? 'accepted' : 'rejected',
          note: accept ? 'User accepted invitation' : 'User rejected invitation',
        };
        return {
          ...invitation,
          status: accept ? 'accepted' : 'rejected',
          inviteLogs: [...(invitation.inviteLogs || []), log],
        };
      });

      let nextProject = updateProjectWithInvitations(project, nextInvitations, {
        actor: currentUser,
        logTitle: accept ? '接受项目邀请' : '拒绝项目邀请',
        logDetail: accept ? '受邀用户已加入项目。' : '受邀用户已拒绝本次邀请。',
      });

      if (accept) {
        const invitation = (project.projectInvitations || []).find((item) => item.id === invitationId);
        const nextMembers = [...(nextProject.projectMembers || [])];
        const exists = nextMembers.some((member) => member.userId === currentUser.id);
        if (!exists) {
          nextMembers.push({
            userId: currentUser.id,
            name: currentUser.name,
            account: currentUser.account,
            projectRole: invitation?.projectRole || 'viewer',
            joinedAt: new Date().toLocaleString(),
            status: 'active',
          });
        }
        nextProject = updateProjectWithMembers(nextProject, nextMembers, { actor: currentUser });
      }

      await onUpdateProject(nextProject);
      setFeedback(accept ? '已接受邀请，正在刷新项目成员信息。' : '已拒绝邀请。');
    } catch (error) {
      setFeedback(error?.message || '处理邀请失败，请稍后重试。');
    } finally {
      setProcessingId(null);
    }
  };

  const { project, invitation } = pendingInvitations[0];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: '8px', padding: '24px', width: '400px', maxWidth: '90vw', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)' }}>
        <h3 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: 600, color: '#1e293b' }}>您收到一份项目邀请</h3>
        <div style={{ marginBottom: '24px', lineHeight: '1.6', color: '#475569' }}>
          <p>
            <strong>{invitation.invitedBy || '项目管理员'}</strong>
            {' '}邀请您加入项目 <strong>{project.name}</strong>。
          </p>
          <p style={{ fontSize: '13px', marginTop: '12px', background: '#f8fafc', padding: '8px', borderRadius: '4px' }}>
            分配角色：{resolveRoleLabel(invitation.projectRole)}
            <br />
            邀请时间：{invitation.invitedAt || '--'}
          </p>
          {feedback ? (
            <div style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '6px', background: '#eff6ff', color: '#1d4ed8', fontSize: '13px' }}>
              {feedback}
            </div>
          ) : null}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
          <button
            type="button"
            style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #e2e8f0', background: '#fff', color: '#475569', fontWeight: 500, cursor: processingId === invitation.id ? 'not-allowed' : 'pointer' }}
            onClick={() => handleResponse(project.id, invitation.id, false)}
            disabled={processingId === invitation.id}
          >
            拒绝
          </button>
          <button
            type="button"
            style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', background: '#2563eb', color: '#fff', fontWeight: 500, cursor: processingId === invitation.id ? 'not-allowed' : 'pointer' }}
            onClick={() => handleResponse(project.id, invitation.id, true)}
            disabled={processingId === invitation.id}
          >
            {processingId === invitation.id ? '处理中...' : '同意并加入'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default InviteReceiverModal;
