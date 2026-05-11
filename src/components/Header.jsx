import React from 'react';
import { Search, Bell, UserCircle, HardDrive, LogOut } from 'lucide-react';

const searchTypeLabelMap = {
  project: '项目',
  task: '任务',
  folder: '目录',
  file: '文件',
  point: '测点'
};

const Header = ({
  currentUser,
  searchQuery = '',
  searchResults = [],
  onSearchChange,
  onSearchSelect,
  onLogout
}) => {
  return (
    <header className="app-header">
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          backgroundColor: '#f1f5f9',
          borderRadius: '8px',
          padding: '6px 12px',
          width: '320px'
        }}
      >
        <Search size={18} className="text-muted" />
        <input
          type="text"
          placeholder="搜索项目、测线或数据模型..."
          value={searchQuery}
          onChange={(e) => onSearchChange?.(e.target.value)}
          style={{ border: 'none', background: 'transparent', outline: 'none', paddingLeft: '8px', width: '100%', fontSize: '0.875rem' }}
        />
        {searchQuery.trim() && (
          <div
            style={{
              position: 'absolute',
              top: '46px',
              left: 0,
              width: '100%',
              background: '#fff',
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
              boxShadow: '0 16px 32px rgba(15,23,42,0.12)',
              zIndex: 1000,
              maxHeight: '360px',
              overflowY: 'auto'
            }}
          >
            {searchResults.length ? searchResults.map((item) => (
              <button
                key={item.id}
                onClick={() => onSearchSelect?.(item)}
                style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderBottom: '1px solid #f1f5f9', padding: '12px 14px', cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                  <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{item.title}</span>
                  <span style={{ fontSize: '11px', color: '#2563eb', background: '#eff6ff', padding: '2px 8px', borderRadius: '999px', fontWeight: 600 }}>
                    {searchTypeLabelMap[item.type] || '结果'}
                  </span>
                </div>
                <div className="text-xs text-muted" style={{ marginTop: '4px' }}>{item.subtitle}</div>
              </button>
            )) : (
              <div style={{ padding: '16px', textAlign: 'center' }} className="text-xs text-muted">没有匹配的搜索结果</div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingRight: '16px', borderRight: '1px solid var(--border-color)' }}>
          <HardDrive size={18} className="text-muted" />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="text-xs text-muted">云盘空间 (2.5TB / 10TB)</span>
            <div style={{ width: '120px', height: '4px', background: 'var(--border-color)', borderRadius: '2px', marginTop: '2px' }}>
              <div style={{ width: '25%', height: '100%', background: 'var(--brand-primary)', borderRadius: '2px' }} />
            </div>
          </div>
        </div>

        <button style={{ background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'relative' }}>
            <Bell size={20} className="text-muted" />
            <span style={{ position: 'absolute', top: 0, right: 0, width: '8px', height: '8px', borderRadius: '50%', background: 'var(--danger)', border: '2px solid white' }} />
          </div>
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
          <UserCircle size={28} className="text-muted" />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="text-sm" style={{ fontWeight: 600 }}>{currentUser?.name || '演示用户'}</span>
            <span className="text-xs text-muted">{currentUser?.account || currentUser?.phone || '已登录用户'}</span>
          </div>
          <button
            onClick={onLogout}
            style={{ background: '#fff', color: '#ef4444', border: '1px solid #fecaca', borderRadius: '8px', padding: '6px 10px', cursor: 'pointer', fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <LogOut size={14} /> 退出
          </button>
        </div>
      </div>
    </header>
  );
};

export default Header;
