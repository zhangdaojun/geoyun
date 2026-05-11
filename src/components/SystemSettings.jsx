import React, { useEffect, useState } from 'react';
import { Database, Save, Search, ShieldCheck } from 'lucide-react';
import { ensureAppSettings } from '../utils/appSettings';

const cardStyle = {
  background: '#fff',
  border: '1px solid var(--border-color)',
  borderRadius: '16px',
  padding: '20px'
};

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: '10px',
  border: '1px solid #dbe2ea',
  background: '#fff',
  outline: 'none',
  color: '#0f172a',
  fontSize: '13px'
};

const SystemSettings = ({ settings, onSave }) => {
  const [draft, setDraft] = useState(() => ensureAppSettings(settings));
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setDraft(ensureAppSettings(settings));
  }, [settings]);

  const handleNestedChange = (group, field, value) => {
    setDraft((prev) => ({
      ...prev,
      [group]: {
        ...prev[group],
        [field]: value
      }
    }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave?.({
        settings: draft,
        users: [],
        silent: false,
        preserveUsers: true
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="dashboard-container" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div
        className="card glass"
        style={{ padding: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>
            系统设置
          </div>
          <div className="text-sm text-muted" style={{ marginTop: '6px' }}>
            这里维护全局归档规则、搜索范围和备份策略。
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={isSaving}
          style={{
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '10px 16px',
            cursor: isSaving ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontWeight: 600,
            opacity: isSaving ? 0.7 : 1
          }}
        >
          <Save size={16} /> {isSaving ? '保存中...' : '保存设置'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: '20px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <Database size={18} color="#2563eb" />
              <span style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>自动归档规则</span>
            </div>
            <div style={{ display: 'grid', gap: '12px' }}>
              {[
                ['designKeywords', '方案设计关键词'],
                ['rawKeywords', '野外采集关键词'],
                ['qcKeywords', '质控关键词'],
                ['resultKeywords', '成果关键词'],
                ['docsKeywords', '资料关键词']
              ].map(([field, label]) => (
                <div key={field}>
                  <div className="text-xs text-muted" style={{ marginBottom: '6px' }}>{label}</div>
                  <input
                    value={draft.archiveRules[field]}
                    onChange={(e) => handleNestedChange('archiveRules', field, e.target.value)}
                    style={inputStyle}
                  />
                </div>
              ))}
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <Search size={18} color="#2563eb" />
              <span style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>搜索范围</span>
            </div>
            <div style={{ display: 'grid', gap: '10px' }}>
              {[
                ['project', '项目'],
                ['task', '任务'],
                ['cloud', '云盘目录与文件'],
                ['point', '规划测点']
              ].map(([field, label]) => (
                <label
                  key={field}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#0f172a', fontSize: '13px', fontWeight: 600 }}
                >
                  <input
                    type="checkbox"
                    checked={Boolean(draft.searchScopes[field])}
                    onChange={(e) => handleNestedChange('searchScopes', field, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <ShieldCheck size={18} color="#2563eb" />
              <span style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>备份策略</span>
            </div>
            <div style={{ display: 'grid', gap: '12px' }}>
              <div>
                <div className="text-xs text-muted" style={{ marginBottom: '6px' }}>默认备份类型</div>
                <select
                  value={draft.backupPolicy.defaultMode}
                  onChange={(e) => handleNestedChange('backupPolicy', 'defaultMode', e.target.value)}
                  style={inputStyle}
                >
                  <option value="full">完整备份</option>
                  <option value="state">结构备份</option>
                </select>
              </div>
              <div>
                <div className="text-xs text-muted" style={{ marginBottom: '6px' }}>保留历史数量</div>
                <input
                  value={draft.backupPolicy.keepHistoryCount}
                  onChange={(e) => handleNestedChange('backupPolicy', 'keepHistoryCount', Number(e.target.value) || 1)}
                  style={inputStyle}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SystemSettings;
