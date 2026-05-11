import { requestAdminApi } from './apiClient';

export const startAdminEmap1Task = async (payload, currentUser) =>
  requestAdminApi('/emap1/process', currentUser, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const startAdminEmap1BatchTask = async (payload, currentUser) =>
  requestAdminApi('/emap1/batch-process', currentUser, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const buildAdminEmap1SimpegLine = async (payload, currentUser) =>
  requestAdminApi('/emap1/simpeg-line', currentUser, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

export const fetchAdminEmap1TaskStatus = async (taskId, currentUser) =>
  requestAdminApi(`/emap1/tasks/${encodeURIComponent(String(taskId))}`, currentUser);

export const fetchAdminEmap1TaskResult = async (taskId, currentUser) =>
  requestAdminApi(`/emap1/tasks/${encodeURIComponent(String(taskId))}/result`, currentUser);

const delay = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

export const waitForAdminEmap1TaskResult = async (
  taskId,
  currentUser,
  {
    intervalMs = 1200,
    onStatus,
  } = {},
) => {
  while (true) {
    const status = await fetchAdminEmap1TaskStatus(taskId, currentUser);
    onStatus?.(status);

    if (status?.status === 'success') {
      return fetchAdminEmap1TaskResult(taskId, currentUser);
    }
    if (status?.status === 'failed' || status?.status === 'revoked') {
      throw new Error(status?.error || 'EMAP1 后台任务执行失败');
    }
    await delay(intervalMs);
  }
};

export const processAdminEmap1 = async (payload, currentUser, options = {}) => {
  const task = await startAdminEmap1Task(payload, currentUser);
  return waitForAdminEmap1TaskResult(task.task_id, currentUser, options);
};

export const processAdminEmap1BatchDirectory = async (payload, currentUser, options = {}) => {
  const task = await startAdminEmap1BatchTask(payload, currentUser);
  return waitForAdminEmap1TaskResult(task.task_id, currentUser, options);
};
