import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startAdminEmap1Task,
  waitForAdminEmap1TaskResult,
} from './adminEmap1Api';

const jsonResponse = (payload, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => payload,
});

describe('adminEmap1Api task flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts an EMAP1 task and polls until the result is available', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task-1', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({
        task_id: 'task-1',
        status: 'running',
        progress: { current: 0, total: 1, percent: 0, message: 'running' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        task_id: 'task-1',
        status: 'success',
        progress: { current: 1, total: 1, percent: 100, message: 'done' },
      }))
      .mockResolvedValueOnce(jsonResponse({ summary: { engine: 'aurora-python' }, rows: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const task = await startAdminEmap1Task({ channels: {} }, null);
    const statuses = [];
    const result = await waitForAdminEmap1TaskResult(task.task_id, null, {
      intervalMs: 0,
      onStatus: (status) => statuses.push(status.status),
    });

    expect(task.task_id).toBe('task-1');
    expect(statuses).toEqual(['running', 'success']);
    expect(result.summary.engine).toBe('aurora-python');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

