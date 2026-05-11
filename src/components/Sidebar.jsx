import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CloudFog,
  FileText,
  Folder,
  FolderKanban,
  GitBranch,
  MapPin,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  Users
} from 'lucide-react';
import { getUserPermissions } from '../utils/accessControl';
import { parseMTTSDisplayMeta } from '../features/drive/driveFileRules';

const getInstrumentLabel = (value = '', fallback = '') => {
  const text = String(value || fallback || '').trim();
  return text || '未标注仪器';
};

const getProjectMethodLabel = (project = {}) => {
  const text = String(project?.plan?.instrumentModel || project?.method || '').trim();
  return text || '未标注方法';
};

const buildCloudItemPath = (item, items = []) => {
  const itemMap = new Map((items || []).map((entry) => [entry.id, entry]));
  const segments = [];
  let cursor = item;
  while (cursor) {
    if (cursor.name) segments.unshift(String(cursor.name).trim());
    if (!cursor.parentId) break;
    cursor = itemMap.get(cursor.parentId) || null;
  }
  return segments.filter(Boolean).join('/');
};

const parseLineCodeFromFolderName = (name = '') => {
  const match = String(name || '').trim().match(/(?:测线|line|survey\s*line)\s*([a-z0-9_.-]+)/i);
  return match ? match[1] : '';
};

const resolveCloudItemLineCode = (item, items = []) => {
  const itemMap = new Map((items || []).map((entry) => [entry.id, entry]));
  let cursor = itemMap.get(item?.parentId) || null;
  while (cursor) {
    const line = parseLineCodeFromFolderName(cursor.name);
    if (line) return line;
    cursor = itemMap.get(cursor.parentId) || null;
  }
  return '0';
};

const normalizeSidebarInstrumentType = (value = '') => {
  const text = String(value || '').trim().toLowerCase();
  if (text.includes('emap')) return 'emap1';
  if (text.includes('eh4')) return 'eh4';
  if (text.includes('f3')) return 'f3';
  if (text.includes('edi')) return 'edi';
  if (text.includes('高密度') || text.includes('电法') || text.includes('ert')) return 'ert';
  return text;
};

const normalizeSidebarEntry = (entry = {}) => {
  if (normalizeSidebarInstrumentType(entry.instrument) !== 'emap1') return entry;
  const point = String(entry.point || '').trim();
  if (!/^-?\d+(?:\.\d+)?\s*[-_~]\s*-?\d+(?:\.\d+)?$/.test(point)) return entry;
  return { ...entry, line: '0' };
};

const buildEmapEntriesFromCloudItems = (project = {}) => {
  const items = project?.cloudData?.items || [];
  const grouped = new Map();
  items
    .filter((item) => item?.type === 'file')
    .forEach((item) => {
      const meta = parseMTTSDisplayMeta(item.name || '');
      if (!meta?.pointNo) return;
      const line = resolveCloudItemLineCode(item, items);
      const key = `${line}__${meta.pointNo}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          id: `cloud_emap1_${project.id}_${line}_${meta.pointNo}`,
          line,
          point: meta.pointNo,
          instrument: 'EMAP-1',
          matchedDataPaths: []
        });
      }
      const entry = grouped.get(key);
      const path = buildCloudItemPath(item, items);
      if (path && !entry.matchedDataPaths.includes(path)) entry.matchedDataPaths.push(path);
    });

  return Array.from(grouped.values()).map((entry) => ({
    ...entry,
    matchedDataCount: entry.matchedDataPaths.length,
    hasExistingData: entry.matchedDataPaths.length > 0
  }));
};

const getPointPathCategory = (instrumentName = '', path = '') => {
  const instrument = String(instrumentName || '').trim().toLowerCase();
  const fileName = String(path || '').split('/').pop() || '';
  const lowerName = fileName.toLowerCase();

  if (instrument.includes('f3')) {
    if (/\.r$/i.test(lowerName)) return 'z';
    if (/\.psd$/i.test(lowerName)) return 'x';
    if (/\.(fh|fm|fl)$/i.test(lowerName)) return 'y';
    return '';
  }

  if (instrument.includes('edi')) {
    return /\.edi$/i.test(lowerName) ? 'z' : '';
  }

  if (instrument.includes('emap')) {
    return /\.mtts$/i.test(lowerName) ? 'y' : '';
  }

  if (/^z/i.test(fileName)) return 'z';
  if (/^x/i.test(fileName)) return 'x';
  if (/^y/i.test(fileName)) return 'y';
  return '';
};

const buildPointHoverText = (node) => {
  if (node.type !== 'point' && node.type !== 'array') return undefined;
  if (!node.hasExistingData || !node.matchedDataPaths?.length) {
    return '未匹配到数据文件';
  }
  if (node.type === 'array') {
    return [`已匹配 ${node.matchedDataCount || 0} 个高密度电法数据文件`, ...node.matchedDataPaths.map((path) => `- ${path}`)].join('\n');
  }

  const groupedPaths = {
    x: [],
    y: [],
    z: []
  };

  node.matchedDataPaths.forEach((path) => {
    const category = getPointPathCategory(node.instrumentName, path);
    if (category && groupedPaths[category]) {
      groupedPaths[category].push(path);
    }
  });

  const lines = [`已匹配 ${node.matchedDataCount || 0} 个数据文件`];
  [['x', 'X'], ['y', 'Y'], ['z', 'Z']].forEach(([key, label]) => {
    if (!groupedPaths[key].length) return;
    lines.push(`${label} 文件:`);
    groupedPaths[key].forEach((path) => lines.push(`- ${path}`));
  });

  return lines.join('\n');
};

const buildProjectTree = (projects = []) => {
  return projects.map((project) => {
    const designEntries = (project?.plan?.designEntries || []).map(normalizeSidebarEntry);
    const existingEntryKeys = new Set(designEntries.map((entry) => `${String(entry.line || '').trim()}__${getInstrumentLabel(entry.instrument, '').toLowerCase()}__${String(entry.point || '').trim()}`));
    buildEmapEntriesFromCloudItems(project).forEach((entry) => {
      const key = `${String(entry.line || '').trim()}__${getInstrumentLabel(entry.instrument, '').toLowerCase()}__${String(entry.point || '').trim()}`;
      if (!existingEntryKeys.has(key)) designEntries.push(entry);
    });
    const projectMethodLabel = getProjectMethodLabel(project);
    const groupedLines = designEntries.reduce((acc, entry) => {
      const lineKey = String(entry.line || '未命名测线').trim();
      const instrumentName = getInstrumentLabel(entry.instrument, projectMethodLabel);
      const groupKey = `${lineKey}__${instrumentName}`;
      if (!acc[groupKey]) {
        acc[groupKey] = {
          lineKey,
          instrumentName,
          entries: []
        };
      }
      acc[groupKey].entries.push(entry);
      return acc;
    }, {});

    const lines = Object.values(groupedLines)
      .sort((a, b) => {
        const lineCompare = String(a.lineKey || '').localeCompare(String(b.lineKey || ''), 'zh-Hans-CN', { numeric: true });
        if (lineCompare !== 0) return lineCompare;
        return String(a.instrumentName || '').localeCompare(String(b.instrumentName || ''), 'zh-Hans-CN', { numeric: true });
      })
      .map(({ lineKey, instrumentName, entries }) => ({
        id: `${project.id}_line_${lineKey}_${instrumentName}`,
        projectId: project.id,
        name: `${lineKey} · ${instrumentName}`,
        type: 'line',
        lineKey,
        instrumentName,
        children: entries
          .sort((a, b) => String(a.point || '').localeCompare(String(b.point || ''), 'zh-Hans-CN', { numeric: true }))
          .map((entry, index) => ({
            id: entry.id || `${project.id}_point_${lineKey}_${instrumentName}_${index + 1}`,
            projectId: project.id,
            name: String(entry.point || `${index + 1}`),
            type: entry.entryKind === 'array' || normalizeSidebarInstrumentType(entry.instrument) === 'ert' ? 'array' : 'point',
            parentLineKey: lineKey,
            instrumentName,
            hasExistingData: Boolean(entry.hasExistingData || Number(entry.matchedDataCount || 0) > 0),
            matchedDataCount: Number(entry.matchedDataCount || 0),
            matchedDataPaths: Array.isArray(entry.matchedDataPaths) ? entry.matchedDataPaths : []
          }))
      }));

    return {
      id: project.id,
      projectId: project.id,
      name: project.name,
      type: 'project',
      children: lines
    };
  });
};

const TreeRow = ({ node, level, expandedKeys, onToggle, onSelect, selectedProjectId }) => {
  const hasChildren = Boolean(node.children?.length);
  const isExpanded = expandedKeys.has(node.id);
  const isProject = node.type === 'project';
  const isSelected = isProject && selectedProjectId === node.id;
  const Icon = node.type === 'project' ? FolderKanban : node.type === 'line' ? GitBranch : node.type === 'array' ? FileText : MapPin;
  const isPoint = node.type === 'point';
  const isArray = node.type === 'array';
  const isMatchedDataNode = !(isPoint || isArray) || Boolean(node.hasExistingData);
  const rowColor = isSelected ? '#2563eb' : !isMatchedDataNode ? '#94a3b8' : '#475569';
  const iconColor = !isMatchedDataNode ? '#94a3b8' : rowColor;
  const statusTitle = (isPoint || isArray) ? buildPointHoverText(node) : undefined;

  return (
    <>
      <button
        onClick={() => onSelect(node)}
        title={statusTitle}
        style={{
          width: '100%',
          border: 'none',
          background: isSelected ? '#eff6ff' : 'transparent',
          color: rowColor,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 10px',
          paddingLeft: `${10 + level * 18}px`,
          borderRadius: '8px',
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        {hasChildren ? (
          <span
            onClick={(event) => {
              event.stopPropagation();
              onToggle(node.id);
            }}
            style={{ display: 'flex', alignItems: 'center', color: '#94a3b8', cursor: 'pointer' }}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        ) : (
          <span style={{ width: '14px' }} />
        )}
        <Icon size={14} color={iconColor} />
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: '13px',
            fontWeight: isProject ? 600 : 500,
            color: rowColor
          }}
        >
          {node.type === 'line'
            ? `测线 ${node.name}`
            : node.type === 'array'
              ? `排列 ${node.name}`
            : node.type === 'point'
              ? `测点 ${node.name}`
              : node.name}
        </span>
      </button>
      {hasChildren && isExpanded && node.children.map((child) => (
        <TreeRow
          key={child.id}
          node={child}
          level={level + 1}
          expandedKeys={expandedKeys}
          onToggle={onToggle}
          onSelect={onSelect}
          selectedProjectId={selectedProjectId}
        />
      ))}
    </>
  );
};

const Sidebar = ({
  currentView,
  navigate,
  projects = [],
  selectedProject,
  currentUser,
  currentDriveFolderId,
  setSelectedProject,
  setPendingDriveFolderId,
  setPendingDrivePointRequest,
  setPendingProjectSelection,
  onCreateProject,
  onDeleteProject,
  onReloadProject
}) => {
  const projectTree = useMemo(() => buildProjectTree(projects), [projects]);
  const permissions = useMemo(() => getUserPermissions(currentUser), [currentUser]);
  const [expandedKeys, setExpandedKeys] = useState(() => new Set(projectTree.map((item) => item.id)));
  const [isProjectTreeOpen, setIsProjectTreeOpen] = useState(true);

  const currentProjectCloudItems = useMemo(() => {
    return (selectedProject?.cloudData?.items || [])
      .filter((item) => item.parentId == null)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN', { numeric: true });
      });
  }, [selectedProject]);

  const handleToggle = (id) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelect = (node) => {
    const projectId = node.projectId || (node.type === 'project'
      ? node.id
      : String(node.id).split('_line_')[0].split('_point_')[0]);
    const targetProject = projects.find((item) => item.id === projectId) || null;

    if (targetProject) {
      if (node.type === 'point' || node.type === 'array') {
        setPendingDriveFolderId?.(null);
        setPendingDrivePointRequest?.({
          projectId: targetProject.id,
          lineKey: String(node.parentLineKey || '').trim(),
          instrumentName: String(node.instrumentName || '').trim(),
          pointId: node.id,
          pointName: String(node.name || '').trim(),
          entryKind: node.type === 'array' ? 'array' : 'point',
          matchedDataPaths: Array.isArray(node.matchedDataPaths) ? node.matchedDataPaths : [],
          stamp: `${Date.now()}_${Math.random().toString(36).slice(2)}`
        });
        setPendingProjectSelection?.({
          projectId: targetProject.id,
          activeTab: 'overview',
          lineKey: String(node.parentLineKey || '').trim(),
          pointId: node.id,
          openParser: true,
          source: 'sidebar-tree'
        });
        setSelectedProject?.(targetProject);
        if (navigate) navigate(`/projects/${targetProject.id}/data`);
        return;
      } else if (node.type === 'line') {
        setPendingDrivePointRequest?.(null);
        setPendingDriveFolderId?.(null);
        setPendingProjectSelection?.({
          projectId: targetProject.id,
          activeTab: 'overview',
          lineKey: String(node.lineKey || node.name || '').trim(),
          instrumentName: String(node.instrumentName || '').trim(),
          pointId: '',
          openLineProfile: true,
          source: 'sidebar-tree'
        });
        setSelectedProject?.(targetProject);
        if (navigate) {
          const params = new URLSearchParams({
            openLineProfile: '1',
            line: String(node.lineKey || node.name || '').trim(),
            instrument: String(node.instrumentName || '').trim()
          });
          navigate(`/projects/${targetProject.id}?${params.toString()}`);
          return;
        }
      } else {
        setPendingDrivePointRequest?.(null);
        setPendingDriveFolderId?.(null);
        setPendingProjectSelection?.({
          projectId: targetProject.id,
          activeTab: 'overview',
          lineKey: '',
          pointId: '',
          source: 'sidebar-tree'
        });
        setSelectedProject?.(targetProject);
      }
      if (navigate) navigate(`/projects/${targetProject.id}`);
    }
  };

  const handleOpenDriveItem = (item) => {
    if (!selectedProject) return;
    setPendingDrivePointRequest?.(null);
    setPendingProjectSelection?.(null);
    setPendingDriveFolderId?.(item.type === 'folder' ? item.id : (item.parentId || null));
    if (navigate) navigate(`/projects/${selectedProject.id}/data`);
  };

  return (
    <aside className="app-sidebar">
      <div className="sidebar-logo">
        <CloudFog size={28} />
        <span>GeoYun 吉云</span>
      </div>

      <nav className="sidebar-nav" style={{ overflowY: 'auto', minHeight: 0 }}>
        <button
          className={`nav-item ${currentView === 'map' ? 'active' : ''}`}
          onClick={() => {
            setSelectedProject?.(null);
            setPendingDriveFolderId?.(null);
            setPendingDrivePointRequest?.(null);
            setPendingProjectSelection?.(null);
            if (navigate) navigate('/map');
          }}
          style={{ background: 'transparent', width: '100%', border: 'none', justifyContent: 'flex-start', cursor: 'pointer', marginBottom: '8px' }}
        >
          <FolderKanban size={20} />
          项目总览
        </button>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 8px 10px', gap: '8px' }}>
          <button
            type="button"
            onClick={() => setIsProjectTreeOpen((prev) => !prev)}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: '#64748b'
            }}
          >
            <span className="text-xs text-muted" style={{ fontWeight: 600 }}>项目列表</span>
            {isProjectTreeOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => onReloadProject?.(selectedProject)}
              title={selectedProject ? `重新加载项目：${selectedProject.name}` : '先选择要重新加载的项目'}
              disabled={!selectedProject}
              style={{
                width: '28px',
                height: '28px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '8px',
                border: '1px solid #bfdbfe',
                background: selectedProject ? '#eff6ff' : '#f8fafc',
                color: selectedProject ? '#2563eb' : '#cbd5e1',
                cursor: selectedProject ? 'pointer' : 'not-allowed'
              }}
            >
              <RefreshCw size={14} />
            </button>
            <button
              type="button"
              onClick={() => onDeleteProject?.(selectedProject)}
              title={selectedProject ? `删除项目：${selectedProject.name}` : '先选择要删除的项目'}
              disabled={!selectedProject}
              style={{
                width: '28px',
                height: '28px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '8px',
                border: '1px solid #fecaca',
                background: selectedProject ? '#fef2f2' : '#f8fafc',
                color: selectedProject ? '#dc2626' : '#cbd5e1',
                cursor: selectedProject ? 'pointer' : 'not-allowed'
              }}
            >
              <Trash2 size={14} />
            </button>
            <button
              type="button"
              onClick={() => onCreateProject?.()}
              title="新建项目"
              style={{
                width: '28px',
                height: '28px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '8px',
                border: '1px solid #bfdbfe',
                background: '#eff6ff',
                color: '#2563eb',
                cursor: 'pointer'
              }}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        {isProjectTreeOpen && (
          <div style={{ display: 'grid', gap: '4px' }}>
            {projectTree.length ? projectTree.map((node) => (
              <TreeRow
                key={node.id}
                node={node}
                level={0}
                expandedKeys={expandedKeys}
                onToggle={handleToggle}
                onSelect={handleSelect}
                selectedProjectId={selectedProject?.id || ''}
              />
            )) : (
              <div style={{ padding: '12px 10px', fontSize: '12px', color: '#94a3b8' }}>暂无项目</div>
            )}
          </div>
        )}

        <div className="text-xs text-muted" style={{ padding: '16px 8px 10px', fontWeight: 600 }}>
          当前项目的云盘数据
        </div>
        <div style={{ display: 'grid', gap: '4px' }}>
          {selectedProject ? (
            <>
              <div style={{ padding: '6px 10px 10px', fontSize: '12px', color: '#94a3b8' }}>
                {selectedProject.name}
              </div>
              {currentProjectCloudItems.length ? currentProjectCloudItems.map((item) => {
                const Icon = item.type === 'folder' ? Folder : FileText;
                const isDriveItemActive = currentView === 'data' && currentDriveFolderId === item.id;
                return (
                  <button
                    key={item.id}
                    className={`nav-item ${isDriveItemActive ? 'active' : ''}`}
                    onClick={() => handleOpenDriveItem(item)}
                    style={{ background: 'transparent', width: '100%', border: 'none', justifyContent: 'flex-start', cursor: 'pointer' }}
                    title={item.name}
                  >
                    <Icon size={18} />
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name}
                    </span>
                  </button>
                );
              }) : (
                <div style={{ padding: '12px 10px', fontSize: '12px', color: '#94a3b8' }}>当前项目暂无云盘数据</div>
              )}
            </>
          ) : (
            <div style={{ padding: '12px 10px', fontSize: '12px', color: '#94a3b8', lineHeight: 1.6 }}>
              先进入项目管理选择一个项目，再查看当前项目的云盘数据。
            </div>
          )}
        </div>
      </nav>

      <div style={{ marginTop: 'auto', padding: '16px' }}>
        {permissions.viewBackendUserAdmin && (
          <button
            className={`nav-item ${currentView === 'admin-users' ? 'active' : ''}`}
            onClick={() => { if (navigate) navigate('/admin-users'); }}
            style={{ background: 'transparent', width: '100%', border: 'none', justifyContent: 'flex-start', cursor: 'pointer', marginBottom: '8px' }}
          >
            <Users size={20} />
            后台用户管理
          </button>
        )}
        <button
          className={`nav-item ${currentView === 'settings' ? 'active' : ''}`}
          onClick={() => { if (navigate) navigate('/settings'); }}
          style={{ background: 'transparent', width: '100%', border: 'none', justifyContent: 'flex-start', cursor: 'pointer' }}
        >
          <Settings size={20} />
          系统设置
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
