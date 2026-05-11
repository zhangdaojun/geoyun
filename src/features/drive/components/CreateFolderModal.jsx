import React, { useEffect, useState } from 'react';
import { formatInstrumentLabel, normalizeInstrumentType, normalizeSurveyMethod } from '../driveFileRules';
import { msg } from '../../../utils/message';

const surveyMethodOptions = ['大地电磁法', '高密度电法'];
const instrumentOptionsByMethod = {
  '大地电磁法': ['F3', 'EH4', 'EDI', 'EMAP-1'],
  '高密度电法': ['高密度电法']
};

const CreateFolderModal = ({
  isOpen,
  onClose,
  onSubmit,
  canCreateFolder,
  isCurrentFolderInRawTree,
  inheritedFolderRestriction,
  selectedProjectMethod
}) => {
  const [folderName, setFolderName] = useState('');
  const [method, setMethod] = useState('');
  const [instrument, setInstrument] = useState('');

  useEffect(() => {
    if (isOpen) {
      const initialMethod = isCurrentFolderInRawTree
        ? (inheritedFolderRestriction?.surveyMethod || normalizeSurveyMethod(selectedProjectMethod))
        : '';
      setFolderName('');
      setMethod(initialMethod);
      setInstrument(
        isCurrentFolderInRawTree
          ? (inheritedFolderRestriction?.instrumentLabel || instrumentOptionsByMethod[initialMethod]?.[0] || '')
          : ''
      );
    }
  }, [isOpen, isCurrentFolderInRawTree, inheritedFolderRestriction, selectedProjectMethod]);

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canCreateFolder) return;
    if (!folderName.trim()) return;

    const surveyMethod = inheritedFolderRestriction?.surveyMethod || normalizeSurveyMethod(method);
    const instrumentLabel = inheritedFolderRestriction?.instrumentLabel || instrument.trim();
    const instrumentType = inheritedFolderRestriction?.instrumentType || normalizeInstrumentType(instrumentLabel);

    if (isCurrentFolderInRawTree) {
      if (!surveyMethod) {
        msg.warn('请先填写该采集目录对应的勘探方法。');
        return;
      }
      if (!instrumentLabel) {
        msg.warn('请先选择该采集目录绑定的仪器类型。');
        return;
      }
      if (!instrumentType) {
        msg.warn('当前仪器类型暂不支持自动识别上传数据，请选择受支持的仪器类型。');
        return;
      }
    }

    onSubmit({
      name: folderName,
      surveyMethod: surveyMethod || null,
      instrumentLabel: instrumentLabel || null,
      instrumentType: instrumentType || null
    });
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card glass" style={{ width: '400px', padding: '32px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <h3>新建文件夹</h3>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <input 
            autoFocus
            required
            type="text" 
            placeholder="请输入文件夹名称" 
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            style={{ padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)', outline: 'none', background: canCreateFolder ? '#fff' : '#f8fafc' }}
            disabled={!canCreateFolder}
          />
          {isCurrentFolderInRawTree && (
            <>
              <select
                required
                value={inheritedFolderRestriction?.surveyMethod || method}
                onChange={(e) => {
                  const nextMethod = e.target.value;
                  setMethod(nextMethod);
                  const nextOptions = instrumentOptionsByMethod[nextMethod] || [];
                  if (!nextOptions.includes(instrument)) {
                    setInstrument(nextOptions[0] || '');
                  }
                }}
                style={{ padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)', outline: 'none', background: (!canCreateFolder || inheritedFolderRestriction) ? '#f8fafc' : '#fff' }}
                disabled={!canCreateFolder || Boolean(inheritedFolderRestriction)}
              >
                <option value="">请选择勘探方法</option>
                {surveyMethodOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <select
                required
                value={inheritedFolderRestriction?.instrumentLabel || instrument}
                onChange={(e) => setInstrument(e.target.value)}
                style={{ padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)', outline: 'none', background: (!canCreateFolder || inheritedFolderRestriction) ? '#f8fafc' : '#fff' }}
                disabled={!canCreateFolder || Boolean(inheritedFolderRestriction)}
              >
                <option value="">请选择仪器类型</option>
                {(instrumentOptionsByMethod[inheritedFolderRestriction?.surveyMethod || method] || []).map((inst) => (
                  <option key={inst} value={inst}>{inst}</option>
                ))}
              </select>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {inheritedFolderRestriction
                  ? `该目录将继承上级目录的采集约束：${inheritedFolderRestriction.instrumentLabel || formatInstrumentLabel(inheritedFolderRestriction.instrumentType)}。`
                  : '该目录创建后，后续上传会按所选仪器自动校验文件类型，非该仪器数据将被拦截。'}
              </div>
            </>
          )}
          <div style={{ display: 'flex', gap: '12px' }}>
            <button type="button" onClick={onClose} style={{ flex: 1, padding: '10px', background: 'var(--primary-bg)', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}>取消</button>
            <button type="submit" className="btn-primary" disabled={!canCreateFolder} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: '8px', opacity: canCreateFolder ? 1 : 0.55, cursor: canCreateFolder ? 'pointer' : 'not-allowed' }}>创建确认</button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateFolderModal;
