import React, { useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Clock3, Cpu, Database, FileText, Filter, HardDrive, RadioTower, Search, ShieldCheck } from 'lucide-react';

const statusStyleMap = {
  运行中: { bg: '#eff6ff', text: '#2563eb' },
  等待中: { bg: '#fffbeb', text: '#f59e0b' },
  已完成: { bg: '#ecfdf5', text: '#10b981' },
  异常: { bg: '#fef2f2', text: '#ef4444' }
};

const levelStyleMap = {
  info: { bg: '#eff6ff', text: '#2563eb', label: '信息' },
  success: { bg: '#ecfdf5', text: '#10b981', label: '完成' },
  warning: { bg: '#fffbeb', text: '#f59e0b', label: '预警' },
  error: { bg: '#fef2f2', text: '#ef4444', label: '异常' }
};

const buildNodeData = (project, files = [], tasks = []) => {
  const completedCount = files.filter(file => file.status === '解算完成').length;
  const syncedCount = files.filter(file => ['已同步', '质控完成', '解算完成'].includes(file.status)).length;
  const hasError = files.length > 0 && !files.some(file => ['已同步', '质控完成', '解算完成'].includes(file.status));
  const taskMap = tasks.reduce((acc, task) => {
    acc[task.name] = task;
    return acc;
  }, {});

  return [
    {
      id: 'collector',
      name: '外业采集节点',
      role: '负责测区测线采集与设备同步',
      host: 'collector-node-01',
      status: taskMap['野外采集']?.status === '进行中' ? '运行中' : (taskMap['野外采集']?.status === '已完成' ? '已完成' : '等待中'),
      queue: taskMap['野外采集']?.countText || `${Math.max(0, files.length - syncedCount)} 个待采集文件`,
      icon: RadioTower
    },
    {
      id: 'qc',
      name: '质控节点',
      role: '负责数据完整性、噪声与坏点检查',
      host: 'qc-node-02',
      status: taskMap['数据质控']?.status === '进行中' ? '运行中' : (taskMap['数据质控']?.status === '已完成' ? '已完成' : '等待中'),
      queue: taskMap['数据质控']?.countText || `${syncedCount} 个已同步文件`,
      icon: ShieldCheck
    },
    {
      id: 'solver',
      name: '解算节点',
      role: '负责反演与成果解算',
      host: 'solver-node-03',
      status: taskMap['成果解算']?.status === '进行中' ? '运行中' : (completedCount > 0 ? '已完成' : (hasError ? '异常' : '等待中')),
      queue: taskMap['成果解算']?.countText || `${completedCount} 个解算任务`,
      icon: Cpu
    },
    {
      id: 'storage',
      name: '成果入库节点',
      role: '负责成果归档、压缩与共享',
      host: 'storage-node-01',
      status: taskMap['方案规划']?.status === '已完成' && taskMap['成果解算']?.status === '已完成' ? '已完成' : '运行中',
      queue: `${files.length} 个文件待归档`,
      icon: HardDrive
    }
  ];
};

const buildLogData = (project, files = [], nodes = []) => {
  const baseLogs = [
    {
      id: 'log_1',
      nodeId: 'collector',
      nodeName: '外业采集节点',
      level: 'info',
      time: files[0]?.date || project.lastUpdate,
      title: '采集任务已下发到测区设备',
      detail: `${project.name} 已下发 ${Math.max(files.length, 1)} 个采集任务，等待终端回传。`
    },
    {
      id: 'log_2',
      nodeId: 'qc',
      nodeName: '质控节点',
      level: files.some(file => file.status === '质控完成') ? 'success' : 'warning',
      time: files[1]?.date || project.lastUpdate,
      title: '自动质控执行完成',
      detail: files.some(file => file.status === '质控完成')
        ? '坏点率低于阈值，建议继续进入解算流程。'
        : '仍有文件等待质控结果，请检查采集完成情况。'
    },
    {
      id: 'log_3',
      nodeId: 'solver',
      nodeName: '解算节点',
      level: files.some(file => file.status === '解算完成') ? 'success' : (files.length > 0 ? 'warning' : 'error'),
      time: files[files.length - 1]?.date || project.lastUpdate,
      title: files.some(file => file.status === '解算完成') ? '反演成果已生成' : '解算任务排队中',
      detail: files.some(file => file.status === '解算完成')
        ? '已有成果文件生成，可在测区数据树中继续查看。'
        : '解算节点正在等待更多有效输入数据。'
    },
    {
      id: 'log_4',
      nodeId: 'storage',
      nodeName: '成果入库节点',
      level: files.some(file => file.status === '解算完成') ? 'success' : 'info',
      time: project.lastUpdate,
      title: files.some(file => file.status === '解算完成') ? '成果包已归档' : '云端归档持续同步中',
      detail: `当前项目状态为“${project.status}”，归档与共享策略已启用。`
    }
  ];

  const mergedLogs = [
    ...(project.activityLogs || []),
    ...baseLogs
  ];

  return mergedLogs
    .map(log => ({
      ...log,
      nodeStatus: nodes.find(node => node.id === log.nodeId)?.status || log.nodeStatus || '--'
    }))
    .sort((a, b) => String(b.time || '').localeCompare(String(a.time || ''), 'zh-Hans-CN'));
};

const NodeLogsPanel = ({ project, files = [], tasks = [] }) => {
  const [selectedNodeId, setSelectedNodeId] = useState('all');
  const [selectedLevel, setSelectedLevel] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');

  const nodeItems = useMemo(() => buildNodeData(project, files, tasks), [project, files, tasks]);
  const logItems = useMemo(() => buildLogData(project, files, nodeItems), [project, files, nodeItems]);

  const filteredLogs = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    return logItems.filter(log => {
      if (selectedNodeId !== 'all' && log.nodeId !== selectedNodeId) return false;
      if (selectedLevel !== 'all' && log.level !== selectedLevel) return false;
      if (!keyword) return true;
      return [log.nodeName, log.title, log.detail, log.time].some(value => String(value || '').toLowerCase().includes(keyword));
    });
  }, [logItems, selectedNodeId, selectedLevel, searchTerm]);

  const summary = useMemo(() => ({
    running: nodeItems.filter(node => node.status === '运行中').length,
    warning: logItems.filter(log => log.level === 'warning' || log.level === 'error').length,
    completed: logItems.filter(log => log.level === 'success').length,
    logs: logItems.length
  }), [nodeItems, logItems]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '16px' }}>
        <div className="card glass" style={{ padding: '18px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '44px', height: '44px', borderRadius: '12px', background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Activity size={22} color="#2563eb" />
          </div>
          <div>
            <div style={{ fontSize: '12px', color: '#64748b' }}>运行节点</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>{summary.running}</div>
          </div>
        </div>
        <div className="card glass" style={{ padding: '18px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '44px', height: '44px', borderRadius: '12px', background: '#fff7ed', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <AlertTriangle size={22} color="#ea580c" />
          </div>
          <div>
            <div style={{ fontSize: '12px', color: '#64748b' }}>预警与异常</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>{summary.warning}</div>
          </div>
        </div>
        <div className="card glass" style={{ padding: '18px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '44px', height: '44px', borderRadius: '12px', background: '#ecfdf5', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CheckCircle2 size={22} color="#10b981" />
          </div>
          <div>
            <div style={{ fontSize: '12px', color: '#64748b' }}>完成日志</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>{summary.completed}</div>
          </div>
        </div>
        <div className="card glass" style={{ padding: '18px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '44px', height: '44px', borderRadius: '12px', background: '#f5f3ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Database size={22} color="#7c3aed" />
          </div>
          <div>
            <div style={{ fontSize: '12px', color: '#64748b' }}>日志总数</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>{summary.logs}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: '20px' }}>
        <div className="card glass" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>节点状态总览</div>
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>展示项目执行链路中的关键处理节点</div>
            </div>
            <Cpu size={18} color="#64748b" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {nodeItems.map(node => {
              const Icon = node.icon;
              const style = statusStyleMap[node.status] || statusStyleMap['等待中'];
              return (
                <div key={node.id} style={{ border: '1px solid #e2e8f0', borderRadius: '14px', padding: '16px', background: '#fff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '14px' }}>
                    <div style={{ display: 'flex', gap: '12px', minWidth: 0 }}>
                      <div style={{ width: '42px', height: '42px', borderRadius: '12px', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Icon size={20} color="#3b82f6" />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>{node.name}</div>
                        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px', lineHeight: '1.6' }}>{node.role}</div>
                        <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '6px' }}>节点主机：{node.host}</div>
                      </div>
                    </div>
                    <span style={{ padding: '4px 10px', borderRadius: '999px', fontSize: '11px', fontWeight: 600, background: style.bg, color: style.text }}>{node.status}</span>
                  </div>
                  <div style={{ marginTop: '12px', fontSize: '12px', color: '#64748b' }}>当前队列：{node.queue}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card glass" style={{ padding: '20px', display: 'flex', flexDirection: 'column', minHeight: '560px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>节点日志</div>
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>支持按节点、日志等级与关键字过滤</div>
            </div>
            <FileText size={18} color="#64748b" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#f8fafc', borderRadius: '10px', border: '1px solid #e2e8f0', padding: '9px 12px' }}>
              <Filter size={15} color="#94a3b8" />
              <select value={selectedNodeId} onChange={(e) => setSelectedNodeId(e.target.value)} style={{ border: 'none', outline: 'none', background: 'transparent', width: '100%', fontSize: '13px', color: '#0f172a' }}>
                <option value="all">全部节点</option>
                {nodeItems.map(node => (
                  <option key={node.id} value={node.id}>{node.name}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#f8fafc', borderRadius: '10px', border: '1px solid #e2e8f0', padding: '9px 12px' }}>
              <AlertTriangle size={15} color="#94a3b8" />
              <select value={selectedLevel} onChange={(e) => setSelectedLevel(e.target.value)} style={{ border: 'none', outline: 'none', background: 'transparent', width: '100%', fontSize: '13px', color: '#0f172a' }}>
                <option value="all">全部等级</option>
                <option value="info">信息</option>
                <option value="success">完成</option>
                <option value="warning">预警</option>
                <option value="error">异常</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#f8fafc', borderRadius: '10px', border: '1px solid #e2e8f0', padding: '9px 12px', marginBottom: '16px' }}>
            <Search size={15} color="#94a3b8" />
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="搜索日志标题、详情或时间..."
              style={{ border: 'none', outline: 'none', background: 'transparent', width: '100%', fontSize: '13px', color: '#0f172a' }}
            />
          </div>

          <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {filteredLogs.length > 0 ? filteredLogs.map(log => {
              const style = levelStyleMap[log.level] || levelStyleMap.info;
              return (
                <div key={log.id} style={{ border: '1px solid #e2e8f0', borderRadius: '14px', padding: '14px 16px', background: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>{log.title}</div>
                    <span style={{ padding: '4px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 600, background: style.bg, color: style.text }}>{style.label}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#64748b', lineHeight: '1.7' }}>{log.detail}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginTop: '10px', fontSize: '12px', color: '#94a3b8' }}>
                    <span>{log.nodeName}</span>
                    <span>{log.time}</span>
                  </div>
                </div>
              );
            }) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: '13px' }}>没有匹配的日志记录</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default NodeLogsPanel;
