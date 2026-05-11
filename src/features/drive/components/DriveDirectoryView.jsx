import React from 'react';
import {
  Activity,
  ArrowLeft,
  CheckSquare,
  Download,
  FileCode,
  FileJson,
  FileText,
  Folder,
  Grid,
  HardDrive,
  Image as ImageIcon,
  List,
  MoreVertical,
  Search,
  Square,
  Trash2
} from 'lucide-react';

const getFileIcon = (ext) => {
  switch (ext) {
    case 'dat': return <HardDrive size={24} color="#3b82f6" />;
    case 'mt': return <Activity size={24} color="#f59e0b" />;
    case 'image': return <ImageIcon size={24} color="#10b981" />;
    case 'code': return <FileCode size={24} color="#f59e0b" />;
    case 'doc': return <FileText size={24} color="#ef4444" />;
    default: return <FileJson size={24} color="#64748b" />;
  }
};

const actionButtonStyle = {
  width: '24px',
  height: '24px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  outline: 'none',
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center'
};

const formatDriveDateTime = (value) => {
  if (!value) return '';
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return `${text} 00:00:00`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (number) => String(number).padStart(2, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  ].join(' ');
};

const DriveItemActions = ({ item, canDeleteDrive, onRename, onDelete, onDownload, compact = false }) => (
  <div
    onClick={(event) => event.stopPropagation()}
    onMouseDown={(event) => event.stopPropagation()}
    style={{ display: 'flex', gap: compact ? '12px' : '6px', justifyContent: compact ? 'flex-end' : undefined }}
  >
    {item.type !== 'mtts-group' && (
      <button type="button" onClick={(event) => { event.stopPropagation(); void onRename(event, item); }} style={actionButtonStyle} title="重命名">
        <MoreVertical size={16} className="text-muted" />
      </button>
    )}
    <button type="button" onClick={(event) => { event.stopPropagation(); void onDownload(event, item); }} style={actionButtonStyle} title={item.type === 'folder' ? '下载文件夹' : '下载'}>
      <Download size={16} className="text-muted" />
    </button>
    <button type="button" onClick={(event) => { event.stopPropagation(); void onDelete(event, item); }} disabled={!canDeleteDrive} style={{ ...actionButtonStyle, cursor: canDeleteDrive ? 'pointer' : 'not-allowed', opacity: canDeleteDrive ? 1 : 0.45 }} title={item.type === 'mtts-group' ? '删除该测点组文件' : '删除'}>
      <Trash2 size={16} className="text-muted" style={{ transition: 'color 0.2s' }} />
    </button>
  </div>
);

const MttsFileButtons = ({ item, openDriveItem, dense = false }) => (
  <div style={{ width: dense ? undefined : '100%', display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: dense ? undefined : 'center' }}>
    {item.files.map((file) => (
      <button
        key={file.id}
        onClick={(event) => {
          event.stopPropagation();
          openDriveItem(file);
        }}
        style={{
          border: '1px solid var(--border-color)',
          background: '#fff7ed',
          color: '#9a3412',
          borderRadius: '999px',
          padding: dense ? '2px 8px' : '4px 8px',
          fontSize: '11px',
          cursor: 'pointer'
        }}
        title={file.name}
      >
        {`${file.mttsMeta?.channel || '--'} 路 ${file.mttsMeta?.sampleRateTag || '--'}`}
      </button>
    ))}
  </div>
);

const FeedbackCard = ({ feedback }) => {
  if (!feedback) return null;
  const isWarning = feedback.level === 'warning';
  return (
    <div
      className="card glass"
      style={{
        padding: '14px 16px',
        marginBottom: '20px',
        borderColor: isWarning ? '#f59e0b' : '#10b981',
        background: isWarning ? '#fffbeb' : '#ecfdf5'
      }}
    >
      <div style={{ fontSize: '14px', fontWeight: 600, color: isWarning ? '#b45309' : '#047857' }}>
        {feedback.title}
      </div>
      <div style={{ fontSize: '13px', color: isWarning ? '#92400e' : '#065f46', marginTop: '4px' }}>
        {feedback.detail}
      </div>
    </div>
  );
};

export const DriveDirectoryView = ({
  backendFeedback,
  canDeleteDrive,
  currentFolderId,
  currentUploadRestrictedFolder,
  displayItems,
  downloadDriveItem,
  dropDriveItemOnFolder,
  fileSystem,
  formatInstrumentLabel,
  navigateToFolder,
  openDriveItem,
  projectSyncStatusTheme,
  removeDriveItem,
  removeSelectedDriveItems,
  renameDriveItem,
  searchTerm,
  selectedProject,
  selectedDriveItemIds,
  selectionMode,
  setSelectionMode,
  setSearchTerm,
  setViewMode,
  startDragDriveItem,
  toggleDriveItemSelection,
  toggleSelectAllVisibleDriveItems,
  clearDriveSelection,
  viewMode,
  visibleProjectSyncStatus
}) => {
  const selectedCount = selectedDriveItemIds?.size || 0;
  const visibleSelectableCount = displayItems.length;
  const allVisibleSelected = visibleSelectableCount > 0 && displayItems.every((item) => selectedDriveItemIds?.has(item.id));

  return (
  <>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {currentFolderId && (
          <button
            onClick={() => {
              const curr = fileSystem.find(f => f.id === currentFolderId);
              navigateToFolder(curr ? curr.parentId : null);
            }}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '8px', cursor: 'pointer', color: 'var(--text-primary)' }}
          >
            <ArrowLeft size={16} /> 返回上级
          </button>
        )}

        <div style={{ display: 'flex', alignItems: 'center', backgroundColor: 'var(--surface-bg)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '6px 12px', width: '300px' }}>
          <Search size={16} className="text-muted" />
          <input
            type="text"
            placeholder="搜索当前目录内容..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            style={{ border: 'none', background: 'transparent', outline: 'none', paddingLeft: '8px', width: '100%', fontSize: '0.875rem' }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <button
          onClick={() => {
            if (selectionMode) clearDriveSelection();
            else setSelectionMode(true);
          }}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', padding: '7px 12px', border: '1px solid var(--border-color)', background: selectionMode ? 'var(--primary-bg)' : 'var(--surface-bg)', color: selectionMode ? 'var(--brand-primary)' : 'var(--text-primary)', borderRadius: '8px', fontWeight: 600, fontSize: '13px' }}
        >
          {selectionMode ? <CheckSquare size={16} /> : <Square size={16} />} 多选
        </button>
        {selectionMode && (
          <>
            <button
              onClick={toggleSelectAllVisibleDriveItems}
              disabled={!visibleSelectableCount}
              style={{ cursor: visibleSelectableCount ? 'pointer' : 'not-allowed', padding: '7px 12px', border: '1px solid var(--border-color)', background: 'var(--surface-bg)', color: 'var(--text-primary)', borderRadius: '8px', fontWeight: 600, fontSize: '13px', opacity: visibleSelectableCount ? 1 : 0.45 }}
            >
              {allVisibleSelected ? '取消全选' : '全选'}
            </button>
            <button
              onClick={() => { void removeSelectedDriveItems(); }}
              disabled={!selectedCount || !canDeleteDrive}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: selectedCount && canDeleteDrive ? 'pointer' : 'not-allowed', padding: '7px 12px', border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', borderRadius: '8px', fontWeight: 600, fontSize: '13px', opacity: selectedCount && canDeleteDrive ? 1 : 0.45 }}
            >
              <Trash2 size={16} /> 删除选中{selectedCount ? ` (${selectedCount})` : ''}
            </button>
          </>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--surface-bg)', border: '1px solid var(--border-color)', padding: '4px', borderRadius: '8px' }}>
          <button
            onClick={() => setViewMode('grid')}
            style={{ cursor: 'pointer', padding: '6px', border: 'none', background: viewMode === 'grid' ? 'var(--primary-bg)' : 'transparent', color: viewMode === 'grid' ? 'var(--brand-primary)' : 'var(--text-secondary)', borderRadius: '4px' }}
          >
            <Grid size={18} />
          </button>
          <button
            onClick={() => setViewMode('list')}
            style={{ cursor: 'pointer', padding: '6px', border: 'none', background: viewMode === 'list' ? 'var(--primary-bg)' : 'transparent', color: viewMode === 'list' ? 'var(--brand-primary)' : 'var(--text-secondary)', borderRadius: '4px' }}
          >
            <List size={18} />
          </button>
        </div>
      </div>
    </div>

    {currentUploadRestrictedFolder && (
      <div className="card glass" style={{ padding: '14px 16px', marginBottom: '20px', display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center' }}>
        <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 600 }}>当前目录上传限制：</span>
        <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>{currentUploadRestrictedFolder.instrumentLabel || formatInstrumentLabel(currentUploadRestrictedFolder.instrumentType)}</span>
        <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>勘探方法：{currentUploadRestrictedFolder.surveyMethod || selectedProject?.method || '--'}</span>
      </div>
    )}

    <FeedbackCard feedback={backendFeedback} />

    {visibleProjectSyncStatus && (
      <div
        className="card glass"
        style={{
          padding: '14px 16px',
          marginBottom: '20px',
          borderColor: projectSyncStatusTheme.border,
          background: projectSyncStatusTheme.background
        }}
      >
        <div style={{ fontSize: '14px', fontWeight: 600, color: projectSyncStatusTheme.title }}>
          {visibleProjectSyncStatus.title}
        </div>
        <div style={{ fontSize: '13px', color: projectSyncStatusTheme.detail, marginTop: '4px' }}>
          {visibleProjectSyncStatus.detail}
        </div>
      </div>
    )}

    <div className="card glass" style={{ flex: 1, padding: viewMode === 'grid' ? '24px' : '0', overflowY: 'auto' }}>
      {displayItems.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary)' }}>
          <Folder size={64} style={{ opacity: 0.1, marginBottom: '16px' }} />
          <p>此空间暂时没有内容，请上传文件或新建文件夹。</p>
        </div>
      ) : viewMode === 'grid' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '20px' }}>
          {displayItems.map((item) => {
            const isSelected = Boolean(selectedDriveItemIds?.has(item.id));
            return (
            <div
              key={item.id}
              onClick={(event) => {
                if (selectionMode) {
                  toggleDriveItemSelection(event, item);
                  return;
                }
                openDriveItem(item);
              }}
              draggable={!selectionMode && item.type !== 'mtts-group'}
              onDragStart={() => startDragDriveItem(item)}
              onDragOver={item.type === 'folder' ? (event) => event.preventDefault() : undefined}
              onDrop={item.type === 'folder' ? (event) => { void dropDriveItemOnFolder(event, item); } : undefined}
              style={{
                padding: '16px',
                border: `1px solid ${isSelected ? 'var(--brand-primary)' : 'var(--border-color)'}`,
                borderRadius: '12px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '12px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                background: isSelected ? 'var(--primary-bg)' : 'var(--surface-bg)',
                position: 'relative'
              }}
              onMouseOver={(event) => { event.currentTarget.style.borderColor = 'var(--brand-primary)'; event.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
              onMouseOut={(event) => { event.currentTarget.style.borderColor = isSelected ? 'var(--brand-primary)' : 'var(--border-color)'; event.currentTarget.style.boxShadow = 'none'; }}
            >
              {selectionMode && (
                <button
                  onClick={(event) => toggleDriveItemSelection(event, item)}
                  style={{ position: 'absolute', left: '8px', top: '8px', width: '28px', height: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: isSelected ? 'var(--brand-primary)' : '#fff', color: isSelected ? '#fff' : 'var(--text-secondary)', border: `1px solid ${isSelected ? 'var(--brand-primary)' : 'var(--border-color)'}`, borderRadius: '8px', cursor: 'pointer' }}
                  title={isSelected ? '取消选择' : '选择'}
                >
                  {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                </button>
              )}
              <div style={{ position: 'absolute', right: '8px', top: '8px' }}>
                {!selectionMode && <DriveItemActions item={item} canDeleteDrive={canDeleteDrive} onRename={renameDriveItem} onDelete={removeDriveItem} onDownload={downloadDriveItem} />}
              </div>
              {item.type === 'folder' ? (
                <Folder size={48} color="#64748b" fill="#f1f5f9" strokeWidth={1} style={{ marginBottom: '8px' }} />
              ) : item.type === 'mtts-group' ? (
                <Activity size={48} color="#f59e0b" style={{ marginBottom: '8px' }} />
              ) : (
                <div style={{ marginBottom: '8px', height: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {getFileIcon(item.ext)}
                </div>
              )}
              <span className="text-sm" style={{ fontWeight: 500, textAlign: 'center', wordBreak: 'break-all', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {item.type === 'mtts-group' ? `${item.pointNo} 测点` : item.name}
              </span>
              <span className="text-xs text-muted">{item.type === 'folder' ? formatDriveDateTime(item.date) : item.size}</span>
              {item.type === 'folder' && item.instrumentLabel && (
                <span className="text-xs text-muted" style={{ textAlign: 'center' }}>
                  {item.instrumentLabel}
                </span>
              )}
              {item.type === 'mtts-group' && <MttsFileButtons item={item} openDriveItem={openDriveItem} />}
            </div>
            );
          })}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)', background: 'var(--primary-bg)' }}>
              {selectionMode && (
                <th style={{ padding: '16px', width: '48px' }}>
                  <button
                    onClick={toggleSelectAllVisibleDriveItems}
                    style={{ width: '28px', height: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: allVisibleSelected ? 'var(--brand-primary)' : '#fff', color: allVisibleSelected ? '#fff' : 'var(--text-secondary)', border: `1px solid ${allVisibleSelected ? 'var(--brand-primary)' : 'var(--border-color)'}`, borderRadius: '8px', cursor: 'pointer' }}
                    title={allVisibleSelected ? '取消全选' : '全选'}
                  >
                    {allVisibleSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                  </button>
                </th>
              )}
              <th style={{ padding: '16px', fontWeight: 500, fontSize: '0.875rem' }}>文件名 / 文件夹</th>
              <th style={{ padding: '16px', fontWeight: 500, fontSize: '0.875rem' }}>修改日期</th>
              <th style={{ padding: '16px', fontWeight: 500, fontSize: '0.875rem' }}>大小</th>
              <th style={{ padding: '16px', fontWeight: 500, fontSize: '0.875rem', width: '100px', textAlign: 'right' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {displayItems.map((item) => {
              const isSelected = Boolean(selectedDriveItemIds?.has(item.id));
              return (
              <tr
                key={item.id}
                onClick={(event) => {
                  if (selectionMode) {
                    toggleDriveItemSelection(event, item);
                    return;
                  }
                  openDriveItem(item);
                }}
                draggable={!selectionMode && item.type !== 'mtts-group'}
                onDragStart={() => startDragDriveItem(item)}
                onDragOver={item.type === 'folder' ? (event) => event.preventDefault() : undefined}
                onDrop={item.type === 'folder' ? (event) => { void dropDriveItemOnFolder(event, item); } : undefined}
                style={{ borderBottom: '1px solid var(--border-color)', cursor: 'pointer', background: isSelected ? 'var(--primary-bg)' : 'transparent' }}
                onMouseOver={(event) => { event.currentTarget.style.background = isSelected ? 'var(--primary-bg)' : 'var(--surface-hover)'; }}
                onMouseOut={(event) => { event.currentTarget.style.background = isSelected ? 'var(--primary-bg)' : 'transparent'; }}
              >
                {selectionMode && (
                  <td style={{ padding: '16px', width: '48px' }}>
                    <button
                      onClick={(event) => toggleDriveItemSelection(event, item)}
                      style={{ width: '28px', height: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: isSelected ? 'var(--brand-primary)' : '#fff', color: isSelected ? '#fff' : 'var(--text-secondary)', border: `1px solid ${isSelected ? 'var(--brand-primary)' : 'var(--border-color)'}`, borderRadius: '8px', cursor: 'pointer' }}
                      title={isSelected ? '取消选择' : '选择'}
                    >
                      {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                    </button>
                  </td>
                )}
                <td style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '12px', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                  {item.type === 'folder' ? <Folder size={20} color="#64748b" fill="#f1f5f9" /> : item.type === 'mtts-group' ? <Activity size={20} color="#f59e0b" /> : getFileIcon(item.ext)}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span>{item.type === 'mtts-group' ? `${item.pointNo} 测点` : item.name}</span>
                    {item.type === 'folder' && item.instrumentLabel && (
                      <span style={{ fontSize: '12px', color: '#94a3b8' }}>
                        限制仪器：{item.instrumentLabel}
                      </span>
                    )}
                    {item.type === 'mtts-group' && <MttsFileButtons item={item} openDriveItem={openDriveItem} dense />}
                  </div>
                </td>
                <td style={{ padding: '16px', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{formatDriveDateTime(item.date)}</td>
                <td style={{ padding: '16px', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{item.size}</td>
                <td style={{ padding: '16px', textAlign: 'right' }}>
                  {!selectionMode && <DriveItemActions item={item} canDeleteDrive={canDeleteDrive} onRename={renameDriveItem} onDelete={removeDriveItem} onDownload={downloadDriveItem} compact />}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  </>
  );
};

export default DriveDirectoryView;
