import React, { useRef } from 'react';
import { UploadCloud, X } from 'lucide-react';

const overviewCoordInputStyle = {
  padding: '12px',
  borderRadius: '8px',
  border: '1px solid var(--border-color)',
  outline: 'none',
  background: '#fff',
  width: '100%',
  boxSizing: 'border-box'
};

const CoordinateImportModal = ({
  isOpen,
  onClose,
  onImport,
  file,
  onFileChange,
  params,
  onParamChange,
  isBusy
}) => {
  const fileInputRef = useRef(null);

  if (!isOpen) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div className="card glass" style={{ width: 'min(720px, 100%)', padding: '24px', display: 'grid', gap: '18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#0f172a' }}>导入坐标</div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '6px', lineHeight: 1.7 }}>
              Excel 将按测线号和测点号匹配当前项目已有测点，只更新匹配点位的坐标。
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            style={{ width: '34px', height: '34px', borderRadius: '10px', border: '1px solid #dbe2ea', background: '#fff', color: '#475569', cursor: isBusy ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'grid', gap: '12px' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            style={{ display: 'none' }}
            onChange={onFileChange}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isBusy}
            style={{ border: '1px dashed #93c5fd', background: '#eff6ff', color: '#1d4ed8', borderRadius: '12px', padding: '14px 16px', cursor: isBusy ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', textAlign: 'left' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
              <UploadCloud size={18} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 800 }}>{file?.name || '选择 Excel 坐标文件'}</span>
                <span style={{ display: 'block', fontSize: '12px', color: '#475569', marginTop: '3px' }}>支持表头识别；无表头时默认列顺序为：测线、测点、X/经度、Y/纬度、高程、仪器。</span>
              </span>
            </span>
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' }}>
          <label style={{ display: 'grid', gap: '6px' }}>
            <span style={{ fontSize: '12px', color: '#475569', fontWeight: 700 }}>坐标系统</span>
            <select
              value={params.coordType}
              onChange={(e) => onParamChange('coordType', e.target.value)}
              disabled={isBusy}
              style={overviewCoordInputStyle}
            >
              <option value="lonlat">经纬度坐标</option>
              <option value="CGCS2000">CGCS2000 投影坐标</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: '6px' }}>
            <span style={{ fontSize: '12px', color: '#475569', fontWeight: 700 }}>坐标格式</span>
            <select
              value={params.lonlatFormat}
              onChange={(e) => onParamChange('lonlatFormat', e.target.value)}
              disabled={isBusy || params.coordType === 'CGCS2000'}
              style={{ ...overviewCoordInputStyle, background: params.coordType === 'CGCS2000' ? '#f8fafc' : '#fff' }}
            >
              <option value="degree">十进制度</option>
              <option value="degree_minute">度分格式</option>
              <option value="dms">度分秒格式</option>
            </select>
          </label>
        </div>

        {params.coordType === 'CGCS2000' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px', padding: '14px', borderRadius: '12px', background: '#f8fafc', border: '1px solid #e2e8f0' }}>
            <label style={{ display: 'grid', gap: '6px' }}>
              <span style={{ fontSize: '12px', color: '#475569' }}>中央经线</span>
              <input type="number" value={params.centralMeridian} onChange={(e) => onParamChange('centralMeridian', Number(e.target.value))} style={overviewCoordInputStyle} />
            </label>
            <label style={{ display: 'grid', gap: '6px' }}>
              <span style={{ fontSize: '12px', color: '#475569' }}>纬度原点</span>
              <input type="number" value={params.latOrigin} onChange={(e) => onParamChange('latOrigin', Number(e.target.value))} style={overviewCoordInputStyle} />
            </label>
            <label style={{ display: 'grid', gap: '6px' }}>
              <span style={{ fontSize: '12px', color: '#475569' }}>比例因子</span>
              <input type="number" step="0.000001" value={params.scale} onChange={(e) => onParamChange('scale', Number(e.target.value))} style={overviewCoordInputStyle} />
            </label>
            <label style={{ display: 'grid', gap: '6px' }}>
              <span style={{ fontSize: '12px', color: '#475569' }}>东偏移</span>
              <input type="number" value={params.falseEasting} onChange={(e) => onParamChange('falseEasting', Number(e.target.value))} style={overviewCoordInputStyle} />
            </label>
            <label style={{ display: 'grid', gap: '6px' }}>
              <span style={{ fontSize: '12px', color: '#475569' }}>北偏移</span>
              <input type="number" value={params.falseNorthing} onChange={(e) => onParamChange('falseNorthing', Number(e.target.value))} style={overviewCoordInputStyle} />
            </label>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '12px' }}>
          <button type="button" onClick={onClose} disabled={isBusy} style={{ border: '1px solid #e2e8f0', background: '#fff', color: '#475569', borderRadius: '10px', padding: '10px 16px', cursor: isBusy ? 'not-allowed' : 'pointer', fontWeight: 800 }}>
            取消
          </button>
          <button type="button" onClick={onImport} disabled={isBusy || !file} style={{ border: 'none', background: '#2563eb', color: '#fff', borderRadius: '10px', padding: '10px 16px', cursor: isBusy || !file ? 'not-allowed' : 'pointer', fontWeight: 800, opacity: isBusy || !file ? 0.55 : 1 }}>
            {isBusy ? '正在导入...' : '确认导入'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CoordinateImportModal;