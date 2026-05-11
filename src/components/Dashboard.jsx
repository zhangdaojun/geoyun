import React from 'react';
import { HardDrive, Activity, ServerCog, CheckCircle, FileJson, Layers } from 'lucide-react';

const Dashboard = () => {
  const stats = [
    { title: '解算节点状态', value: '4 空闲 / 1 忙碌', icon: ServerCog, color: 'var(--success)' },
    { title: '本周上传数据', value: '864 GB', icon: HardDrive, color: 'var(--brand-primary)' },
    { title: '排队处理任务', value: '3 项', icon: Activity, color: 'var(--warning)' },
    { title: '已完成反演', value: '24 项', icon: CheckCircle, color: 'var(--success)' }
  ];

  const recentTasks = [
    { id: 'T-2023-01', name: '大红山矿区_三维高激化率反演', status: '进行中' },
    { id: 'T-2023-02', name: '黄河大坝_二维隐患探测滤波', status: '已完成' },
    { id: 'T-2023-03', name: '西南铁路_高密度电法地形校正', status: '排队中' },
  ];

  return (
    <div className="dashboard-container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2>工作台概览</h2>
          <p className="text-muted text-sm" style={{ marginTop: '4px' }}>欢迎使用吉云 (GeoYun) 地球物理数据云处理平台，今日算力资源充足。</p>
        </div>
        <button className="btn-primary">上传原始数据</button>
      </div>

      <div className="stats-grid">
        {stats.map((stat, idx) => {
          const Icon = stat.icon;
          return (
            <div key={idx} className="card stat-card glass">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <span className="text-muted text-sm">{stat.title}</span>
                  <span className="stat-value">{stat.value}</span>
                </div>
                <div className="stat-icon" style={{ backgroundColor: `${stat.color}15`, color: stat.color }}>
                  <Icon size={24} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '24px' }}>
        <div className="card glass" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 className="text-sm">近期解算任务队列</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {recentTasks.map(task => (
              <div key={task.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ padding: '8px', background: 'var(--brand-light)', color: 'var(--brand-primary)', borderRadius: '6px' }}>
                    <Layers size={16} />
                  </div>
                  <div>
                    <div className="text-sm" style={{ fontWeight: '500' }}>{task.name}</div>
                    <div className="text-xs text-muted">{task.id}</div>
                  </div>
                </div>
                <div style={{ minWidth: '72px', textAlign: 'right' }}>
                  <span className="text-xs text-muted">{task.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card glass" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 className="text-sm">快速入口</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <button style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', background: 'var(--surface-hover)', borderRadius: '8px', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer' }}>
               <FileJson size={18} className="text-muted" />
               <span className="text-sm">新建三维反演模型</span>
            </button>
            <button style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', background: 'var(--surface-hover)', borderRadius: '8px', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer' }}>
               <HardDrive size={18} className="text-muted" />
               <span className="text-sm">管理测线血缘数据</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
