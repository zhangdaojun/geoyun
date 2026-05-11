import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { divIcon } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { CheckCircle2, ClipboardList, Compass, List, MapPinned, RadioTower, Redo2, Save, Settings, ShieldCheck, Trash2, Undo2 } from 'lucide-react';

const defaultCoordParams = {
  coordType: 'lonlat',
  lonlatFormat: 'degree',
  centralMeridian: 102,
  latOrigin: 0,
  falseEasting: 500000,
  falseNorthing: 0,
  scale: 1
};

const DEFAULT_PROJECT_CENTER = [35.86166, 104.195397];

const isFiniteLatLng = (value) => (
  Array.isArray(value)
  && value.length >= 2
  && Number.isFinite(Number(value[0]))
  && Number.isFinite(Number(value[1]))
);

const coerceLatLng = (value, fallback = DEFAULT_PROJECT_CENTER) => (
  isFiniteLatLng(value) ? [Number(value[0]), Number(value[1])] : [...fallback]
);

const defaultPlan = {
  surveyGoal: '',
  surveyScope: '',
  plannedLines: '',
  plannedPoints: '',
  lineSpacing: '',
  pointSpacing: '',
  instrumentModel: '',
  startDate: '',
  endDate: '',
  reviewer: '',
  approvalStatus: '待提交',
  riskControl: '',
  remarks: '',
  completed: false,
  designEntries: [],
  coordParams: defaultCoordParams,
  coordParamsConfigured: false
};

const cardStyle = {
  background: '#f8fafc',
  borderRadius: '12px',
  padding: '16px'
};

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: '10px',
  border: '1px solid #dbe2ea',
  outline: 'none',
  background: '#fff',
  color: '#0f172a',
  fontSize: '13px'
};

const textareaStyle = {
  ...inputStyle,
  minHeight: '96px',
  resize: 'vertical'
};

const getDisabledStyle = (enabled, type = 'button') => enabled ? {} : {
  opacity: 0.6,
  cursor: 'not-allowed',
  ...(type === 'input' ? { background: '#f8fafc' } : {})
};

const normalizeGpsValue = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : value;
};

const buildPlanningMarkerIcon = ({ active, lineActive, draggable }) => divIcon({
  className: '',
  html: `<div style="
    width:${active ? 18 : lineActive ? 16 : 14}px;
    height:${active ? 18 : lineActive ? 16 : 14}px;
    border-radius:999px;
    background:${active ? '#fb923c' : lineActive ? '#fdba74' : '#2563eb'};
    border:${active ? '3px solid #ea580c' : lineActive ? '2px solid #f97316' : '2px solid #ffffff'};
    box-shadow:${draggable ? '0 0 0 4px rgba(59,130,246,0.12)' : '0 2px 8px rgba(15,23,42,0.18)'};
  "></div>`,
  iconSize: [active ? 18 : lineActive ? 16 : 14, active ? 18 : lineActive ? 16 : 14],
  iconAnchor: [active ? 9 : lineActive ? 8 : 7, active ? 9 : lineActive ? 8 : 7]
});

const snapshotPlanState = (value) => JSON.parse(JSON.stringify(value));

const MapDesignerEvents = ({ enabled, onAddPoint }) => {
  useMapEvents({
    click(event) {
      if (!enabled) return;
      onAddPoint?.(event.latlng);
    }
  });
  return null;
};

const PlanningMapAutoFit = ({ positions, activeEntry }) => {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    if (activeEntry && Number.isFinite(Number(activeEntry.gpsLatitude)) && Number.isFinite(Number(activeEntry.gpsLongitude))) {
      map.flyTo([Number(activeEntry.gpsLatitude), Number(activeEntry.gpsLongitude)], Math.max(map.getZoom(), 15), {
        duration: 0.6
      });
      return;
    }
    if (Array.isArray(positions) && positions.length > 1) {
      map.fitBounds(positions, { padding: [24, 24] });
    }
  }, [activeEntry, map, positions]);

  return null;
};

const ProjectPlanningPanel = ({ project, onSave, canEdit = true, selectedDesignEntryId: controlledSelectedDesignEntryId, selectedLineKey: controlledSelectedLineKey = '', onSelectDesignEntry, onSelectLine }) => {
  const initialPlanState = useMemo(() => ({
    ...defaultPlan,
    ...(project.plan || {}),
    coordParams: { ...defaultCoordParams, ...(project.plan?.coordParams || {}) }
  }), [project]);
  const [plan, setPlan] = useState(initialPlanState);
  const [plannerView, setPlannerView] = useState('map');
  const [showCoordSettings, setShowCoordSettings] = useState(false);
  const [mapDrawEnabled, setMapDrawEnabled] = useState(true);
  const [selectedDesignEntryId, setSelectedDesignEntryId] = useState('');
  const [draftLine, setDraftLine] = useState('L-1');
  const [draftPoint, setDraftPoint] = useState('001');
  const [draftInstrument, setDraftInstrument] = useState(project.method || '综合方法');
  const [savedPlanSnapshot, setSavedPlanSnapshot] = useState(() => JSON.stringify(initialPlanState));
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const historyStackRef = useRef([snapshotPlanState(initialPlanState)]);
  const historyIndexRef = useRef(0);

  const syncHistoryState = useCallback(() => {
    setHistoryState({
      canUndo: historyIndexRef.current > 0,
      canRedo: historyIndexRef.current < historyStackRef.current.length - 1
    });
  }, []);

  const resetHistoryState = useCallback((nextPlan) => {
    const snapshot = snapshotPlanState(nextPlan);
    historyStackRef.current = [snapshot];
    historyIndexRef.current = 0;
    syncHistoryState();
  }, [syncHistoryState]);

  const pushPlanHistory = (nextPlan) => {
    const nextSnapshot = snapshotPlanState(nextPlan);
    const truncatedHistory = historyStackRef.current.slice(0, historyIndexRef.current + 1);
    truncatedHistory.push(nextSnapshot);
    historyStackRef.current = truncatedHistory.slice(-50);
    historyIndexRef.current = historyStackRef.current.length - 1;
    syncHistoryState();
  };

  const applyTrackedPlanUpdate = (updater) => {
    setPlan(prev => {
      const nextPlan = typeof updater === 'function' ? updater(prev) : updater;
      if (JSON.stringify(prev) === JSON.stringify(nextPlan)) return prev;
      pushPlanHistory(nextPlan);
      return nextPlan;
    });
  };

  useEffect(() => {
    setPlan(initialPlanState);
    setDraftInstrument(project.method || '综合方法');
    setSavedPlanSnapshot(JSON.stringify(initialPlanState));
    resetHistoryState(initialPlanState);
  }, [initialPlanState, project.method, resetHistoryState]);

  useEffect(() => {
    const lineCount = new Set((plan.designEntries || []).map(entry => String(entry.line || '').trim()).filter(Boolean)).size;
    const pointCount = (plan.designEntries || []).length;
    setPlan(prev => {
      if (String(prev.plannedLines) === String(lineCount || '') && String(prev.plannedPoints) === String(pointCount || '')) return prev;
      return {
        ...prev,
        plannedLines: lineCount ? String(lineCount) : '',
        plannedPoints: pointCount ? String(pointCount) : ''
      };
    });
  }, [plan.designEntries]);

  const designEntries = useMemo(() => plan.designEntries || [], [plan.designEntries]);
  const coordParams = plan.coordParams || defaultCoordParams;

  const mapCenter = useMemo(() => {
    const firstValid = designEntries.find(entry => Number.isFinite(Number(entry.gpsLatitude)) && Number.isFinite(Number(entry.gpsLongitude)));
    if (firstValid) return [Number(firstValid.gpsLatitude), Number(firstValid.gpsLongitude)];
    return coerceLatLng(project.coords, DEFAULT_PROJECT_CENTER);
  }, [designEntries, project.coords]);

  const polylineGroups = useMemo(() => {
    const groups = {};
    designEntries.forEach(entry => {
      if (!Number.isFinite(Number(entry.gpsLatitude)) || !Number.isFinite(Number(entry.gpsLongitude))) return;
      const key = String(entry.line || '').trim() || '未分组';
      if (!groups[key]) groups[key] = [];
      groups[key].push(entry);
    });
    return Object.entries(groups).map(([line, items]) => ({
      line,
      points: items
        .sort((a, b) => String(a.point || '').localeCompare(String(b.point || ''), 'zh-Hans-CN', { numeric: true }))
        .map(item => [Number(item.gpsLatitude), Number(item.gpsLongitude)])
    }));
  }, [designEntries]);

  const designMapPositions = useMemo(() => designEntries
    .filter(entry => Number.isFinite(Number(entry.gpsLatitude)) && Number.isFinite(Number(entry.gpsLongitude)))
    .map(entry => [Number(entry.gpsLatitude), Number(entry.gpsLongitude)]), [designEntries]);

  const activeSelectedDesignEntryId = controlledSelectedDesignEntryId || selectedDesignEntryId;
  const selectedDesignEntry = designEntries.find(entry => entry.id === activeSelectedDesignEntryId) || designEntries[0] || null;
  const activeSelectedLineKey = String(controlledSelectedLineKey || selectedDesignEntry?.line || '').trim();

  const summaryCards = [
    { label: '设计点数', value: designEntries.length || '--', icon: ClipboardList, color: '#2563eb', bg: '#eff6ff' },
    { label: '计划测线', value: plan.plannedLines || '--', icon: RadioTower, color: '#7c3aed', bg: '#f5f3ff' },
    { label: '计划测点', value: plan.plannedPoints || '--', icon: MapPinned, color: '#0f766e', bg: '#ecfeff' },
    { label: '审批状态', value: plan.approvalStatus || '--', icon: ShieldCheck, color: '#ea580c', bg: '#fff7ed' }
  ];

  const isDirty = useMemo(() => JSON.stringify(plan) !== savedPlanSnapshot, [plan, savedPlanSnapshot]);

  const handleFieldChange = (field, value) => {
    applyTrackedPlanUpdate(prev => ({ ...prev, [field]: value }));
  };

  const handleCoordParamChange = (field, value) => {
    applyTrackedPlanUpdate(prev => ({
      ...prev,
      coordParamsConfigured: true,
      coordParams: {
        ...(prev.coordParams || defaultCoordParams),
        [field]: value
      }
    }));
  };

  const appendDesignEntry = (entry) => {
    const nextEntry = { id: `design_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...entry };
    applyTrackedPlanUpdate(prev => ({
      ...prev,
      instrumentModel: prev.instrumentModel || draftInstrument,
      designEntries: [
        ...(prev.designEntries || []),
        nextEntry
      ]
    }));
    setSelectedDesignEntryId(nextEntry.id);
    onSelectDesignEntry?.(nextEntry.id);
    onSelectLine?.(String(nextEntry.line || '').trim());
  };

  const handleMapAddPoint = (latlng) => {
    appendDesignEntry({
      line: draftLine,
      point: draftPoint,
      x: Number(latlng.lng).toFixed(6),
      y: Number(latlng.lat).toFixed(6),
      z: '',
      instrument: draftInstrument,
      gpsLongitude: latlng.lng,
      gpsLatitude: latlng.lat,
      source: '地图设计'
    });
    const numericPoint = Number.parseInt(String(draftPoint).replace(/\D/g, ''), 10);
    if (Number.isFinite(numericPoint)) {
      setDraftPoint(String(numericPoint + 1).padStart(String(draftPoint).length, '0'));
    }
  };

  const handleDesignEntryChange = (id, field, value) => {
    applyTrackedPlanUpdate(prev => ({
      ...prev,
      designEntries: (prev.designEntries || []).map(entry => {
        if (entry.id !== id) return entry;
        if (field === 'gpsLongitude' || field === 'gpsLatitude') {
          const nextGpsValue = normalizeGpsValue(value);
          const nextEntry = {
            ...entry,
            [field]: nextGpsValue
          };
          if (coordParams.coordType === 'lonlat' && coordParams.lonlatFormat === 'degree') {
            if (field === 'gpsLongitude' && Number.isFinite(Number(nextGpsValue))) nextEntry.x = Number(nextGpsValue).toFixed(6);
            if (field === 'gpsLatitude' && Number.isFinite(Number(nextGpsValue))) nextEntry.y = Number(nextGpsValue).toFixed(6);
          }
          return nextEntry;
        }
        return { ...entry, [field]: value };
      })
    }));
    setSelectedDesignEntryId(id);
    onSelectDesignEntry?.(id);
    const matchedEntry = designEntries.find(entry => entry.id === id);
    if (matchedEntry) {
      onSelectLine?.(String(matchedEntry.line || '').trim());
    }
  };

  const handleMarkerDragEnd = (entryId, latlng) => {
    applyTrackedPlanUpdate(prev => ({
      ...prev,
      designEntries: (prev.designEntries || []).map(entry => {
        if (entry.id !== entryId) return entry;
        const nextEntry = {
          ...entry,
          gpsLongitude: Number(latlng.lng.toFixed(6)),
          gpsLatitude: Number(latlng.lat.toFixed(6))
        };
        if (coordParams.coordType === 'lonlat' && coordParams.lonlatFormat === 'degree') {
          nextEntry.x = Number(latlng.lng).toFixed(6);
          nextEntry.y = Number(latlng.lat).toFixed(6);
        }
        return nextEntry;
      })
    }));
    setSelectedDesignEntryId(entryId);
    onSelectDesignEntry?.(entryId);
    const matchedEntry = designEntries.find(entry => entry.id === entryId);
    if (matchedEntry) {
      onSelectLine?.(String(matchedEntry.line || '').trim());
    }
  };

  const handleDeleteDesignEntry = (id) => {
    applyTrackedPlanUpdate(prev => ({
      ...prev,
      designEntries: (prev.designEntries || []).filter(entry => entry.id !== id)
    }));
    setSelectedDesignEntryId(prev => prev === id ? '' : prev);
    if (activeSelectedDesignEntryId === id) {
      onSelectDesignEntry?.('');
    }
  };

  const savePlan = (completed = plan.completed) => {
    if (!canEdit) return;
    const lineCount = new Set((plan.designEntries || []).map(entry => String(entry.line || '').trim()).filter(Boolean)).size;
    const pointCount = (plan.designEntries || []).length;
    const nextPlan = {
      ...plan,
      plannedLines: lineCount ? String(lineCount) : plan.plannedLines,
      plannedPoints: pointCount ? String(pointCount) : plan.plannedPoints,
      completed,
      updatedAt: new Date().toLocaleString()
    };
    onSave?.({
      plan: nextPlan
    });
    setPlan(nextPlan);
    setSavedPlanSnapshot(JSON.stringify(nextPlan));
    resetHistoryState(nextPlan);
  };

  const handleUndo = () => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    setPlan(snapshotPlanState(historyStackRef.current[historyIndexRef.current]));
    syncHistoryState();
  };

  const handleRedo = () => {
    if (historyIndexRef.current >= historyStackRef.current.length - 1) return;
    historyIndexRef.current += 1;
    setPlan(snapshotPlanState(historyStackRef.current[historyIndexRef.current]));
    syncHistoryState();
  };

  useEffect(() => {
    if (!designEntries.length) {
      setSelectedDesignEntryId('');
      onSelectDesignEntry?.('');
      return;
    }
    if (!designEntries.some(entry => entry.id === activeSelectedDesignEntryId)) {
      setSelectedDesignEntryId(designEntries[0].id);
      onSelectDesignEntry?.(designEntries[0].id);
      onSelectLine?.(String(designEntries[0].line || '').trim());
    }
  }, [activeSelectedDesignEntryId, designEntries, onSelectDesignEntry, onSelectLine]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {!canEdit && (
        <div className="card glass" style={{ padding: '14px 16px', border: '1px solid #dbeafe', background: '#eff6ff', color: '#1d4ed8', fontSize: '13px', fontWeight: 600 }}>
          当前项目角色仅可查看方案规划内容，不能新增测点或保存修改。
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '16px' }}>
        {summaryCards.map(card => (
          <div key={card.label} className="card glass" style={{ padding: '18px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '44px', height: '44px', borderRadius: '12px', background: card.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <card.icon size={22} color={card.color} />
            </div>
            <div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>{card.label}</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>{card.value}</div>
            </div>
          </div>
        ))}
      </div>

      <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
            <div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>方案规划表</div>
            </div>
            <Compass size={18} color="#64748b" />
          </div>

          <div className="card glass" style={{ padding: '20px', marginBottom: '18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>测线测点设计</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>{canEdit ? '支持地图点选设计' : '当前为只读查看模式，可浏览已有测线与测点设计'}</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {isDirty && (
                  <span style={{ padding: '4px 8px', borderRadius: '999px', background: '#fff7ed', color: '#ea580c', fontSize: '11px', fontWeight: 700 }}>
                    ?????
                  </span>
                )}
                <button onClick={handleUndo} disabled={!canEdit || !historyState.canUndo} style={{ background: '#fff', color: '#475569', border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', cursor: canEdit && historyState.canUndo ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', gap: '6px', ...getDisabledStyle(canEdit && historyState.canUndo) }}>
                  <Undo2 size={15} />
                </button>
                <button onClick={handleRedo} disabled={!canEdit || !historyState.canRedo} style={{ background: '#fff', color: '#475569', border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', cursor: canEdit && historyState.canRedo ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', gap: '6px', ...getDisabledStyle(canEdit && historyState.canRedo) }}>
                  <Redo2 size={15} />
                </button>
                <button onClick={() => setPlannerView('map')} style={{ background: plannerView === 'map' ? '#2563eb' : '#fff', color: plannerView === 'map' ? '#fff' : '#475569', border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <MapPinned size={15} /> 地图设计
                </button>
                <button onClick={() => setPlannerView('table')} style={{ background: plannerView === 'table' ? '#2563eb' : '#fff', color: plannerView === 'table' ? '#fff' : '#475569', border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <List size={15} /> 点位列表
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '12px', marginBottom: '12px' }}>
              <input value={draftLine} onChange={(e) => setDraftLine(e.target.value)} placeholder="当前测线" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
              <input value={draftPoint} onChange={(e) => setDraftPoint(e.target.value)} placeholder="当前测点" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
              <input value={draftInstrument} onChange={(e) => setDraftInstrument(e.target.value)} placeholder="勘探方法/仪器" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
              <button onClick={() => canEdit && setMapDrawEnabled(v => !v)} disabled={!canEdit} style={{ background: mapDrawEnabled ? '#eff6ff' : '#fff', color: mapDrawEnabled ? '#2563eb' : '#475569', border: '1px solid #bfdbfe', borderRadius: '10px', cursor: 'pointer', fontWeight: 600, ...getDisabledStyle(canEdit) }}>
                {mapDrawEnabled ? '地图点选已开启' : '地图点选已关闭'}
              </button>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
              <button onClick={() => setShowCoordSettings(v => !v)} style={{ background: '#fff', color: '#475569', border: '1px solid #cbd5e1', borderRadius: '10px', padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                <Settings size={16} /> 坐标参数
              </button>
            </div>

            {showCoordSettings && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '12px', marginBottom: '12px', background: '#f8fafc', borderRadius: '12px', padding: '14px' }}>
                <select value={coordParams.coordType} onChange={(e) => handleCoordParamChange('coordType', e.target.value)} style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit}>
                  <option value="lonlat">经纬度</option>
                  <option value="CGCS2000">CGCS2000</option>
                </select>
                <select value={coordParams.lonlatFormat} onChange={(e) => handleCoordParamChange('lonlatFormat', e.target.value)} style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit}>
                  <option value="degree">十进制度</option>
                  <option value="dms">度分秒</option>
                </select>
                <input value={coordParams.centralMeridian} onChange={(e) => handleCoordParamChange('centralMeridian', Number(e.target.value))} placeholder="中央经线" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
                <input value={coordParams.scale} onChange={(e) => handleCoordParamChange('scale', Number(e.target.value))} placeholder="比例因子" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
              </div>
            )}

            {plannerView === 'map' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px' }}>
                  <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '12px' }}>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>当前位置</div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>{selectedDesignEntry ? `${selectedDesignEntry.line || '--'} / ${selectedDesignEntry.point || '--'}` : '--'}</div>
                  </div>
                  <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '12px' }}>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>经度</div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>{selectedDesignEntry ? Number(selectedDesignEntry.gpsLongitude).toFixed(6) : '--'}</div>
                  </div>
                  <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '12px' }}>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>纬度</div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>{selectedDesignEntry ? Number(selectedDesignEntry.gpsLatitude).toFixed(6) : '--'}</div>
                  </div>
                </div>
                <div style={{ height: '360px', borderRadius: '12px', overflow: 'hidden', border: '1px solid #e2e8f0' }}>
                <MapContainer center={mapCenter} zoom={12} style={{ height: '100%', width: '100%' }}>
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  <MapDesignerEvents enabled={canEdit && mapDrawEnabled} onAddPoint={handleMapAddPoint} />
                  <PlanningMapAutoFit positions={designMapPositions} activeEntry={selectedDesignEntry} />
                  {polylineGroups.map(group => (
                    <Polyline
                      key={group.line}
                      positions={group.points}
                      pathOptions={{ color: activeSelectedLineKey && group.line === activeSelectedLineKey ? '#ea580c' : '#2563eb', weight: activeSelectedLineKey && group.line === activeSelectedLineKey ? 4 : 2 }}
                      eventHandlers={{ click: () => onSelectLine?.(group.line) }}
                    />
                  ))}
                  {designEntries.filter(entry => Number.isFinite(Number(entry.gpsLatitude)) && Number.isFinite(Number(entry.gpsLongitude))).map(entry => (
                    <Marker
                      key={entry.id}
                      position={[Number(entry.gpsLatitude), Number(entry.gpsLongitude)]}
                      draggable={canEdit}
                      icon={buildPlanningMarkerIcon({
                        active: entry.id === selectedDesignEntry?.id,
                        lineActive: String(entry.line || '').trim() === activeSelectedLineKey,
                        draggable: canEdit
                      })}
                      eventHandlers={{
                        click: () => {
                          setSelectedDesignEntryId(entry.id);
                          onSelectDesignEntry?.(entry.id);
                          onSelectLine?.(String(entry.line || '').trim());
                          setPlannerView('table');
                        },
                        dragend: (event) => {
                          const latlng = event.target.getLatLng();
                          handleMarkerDragEnd(entry.id, latlng);
                        }
                      }}
                    >
                      <Tooltip direction="top" offset={[0, -6]} opacity={1}>
                        <div style={{ fontSize: '12px', lineHeight: '1.6' }}>
                          测线: {entry.line || '--'}<br/>
                          测点: {entry.point || '--'}<br/>
                          方法: {entry.instrument || '--'}<br/>
                          经度: {Number(entry.gpsLongitude).toFixed(6)}<br/>
                          纬度: {Number(entry.gpsLatitude).toFixed(6)}
                        </div>
                      </Tooltip>
                    </Marker>
                  ))}
                </MapContainer>
              </div>
              </div>
            ) : (
              <div style={{ maxHeight: '360px', overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '12px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead style={{ position: 'sticky', top: 0, background: '#f8fafc' }}>
                    <tr>
                      <th style={{ padding: '12px 14px', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>测线</th>
                      <th style={{ padding: '12px 14px', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>测点</th>
                      <th style={{ padding: '12px 14px', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>方法</th>
                      <th style={{ padding: '12px 14px', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>经度</th>
                      <th style={{ padding: '12px 14px', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>纬度</th>
                      <th style={{ padding: '12px 14px', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>来源</th>
                      <th style={{ padding: '12px 14px', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>定位</th>
                      <th style={{ padding: '12px 14px', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>删除</th>
                    </tr>
                  </thead>
                  <tbody>
                    {designEntries.map(entry => (
                      <tr
                        key={entry.id}
                        onClick={() => {
                          setSelectedDesignEntryId(entry.id);
                          onSelectDesignEntry?.(entry.id);
                          onSelectLine?.(String(entry.line || '').trim());
                        }}
                        style={{ borderBottom: '1px solid #f1f5f9', background: entry.id === selectedDesignEntry?.id ? '#fff7ed' : String(entry.line || '').trim() === activeSelectedLineKey ? '#fffaf5' : '#fff', cursor: 'pointer' }}
                      >
                        <td style={{ padding: '10px 14px' }}><input value={entry.line || ''} onChange={(e) => handleDesignEntryChange(entry.id, 'line', e.target.value)} style={{ ...inputStyle, padding: '6px 8px', ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} /></td>
                        <td style={{ padding: '10px 14px' }}><input value={entry.point || ''} onChange={(e) => handleDesignEntryChange(entry.id, 'point', e.target.value)} style={{ ...inputStyle, padding: '6px 8px', ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} /></td>
                        <td style={{ padding: '10px 14px' }}><input value={entry.instrument || ''} onChange={(e) => handleDesignEntryChange(entry.id, 'instrument', e.target.value)} style={{ ...inputStyle, padding: '6px 8px', ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} /></td>
                        <td style={{ padding: '10px 14px', color: '#0f172a' }}>
                          <input
                            value={entry.gpsLongitude ?? ''}
                            onChange={(e) => handleDesignEntryChange(entry.id, 'gpsLongitude', e.target.value)}
                            style={{ ...inputStyle, padding: '6px 8px', ...getDisabledStyle(canEdit, 'input') }}
                            disabled={!canEdit}
                          />
                        </td>
                        <td style={{ padding: '10px 14px', color: '#0f172a' }}>
                          <input
                            value={entry.gpsLatitude ?? ''}
                            onChange={(e) => handleDesignEntryChange(entry.id, 'gpsLatitude', e.target.value)}
                            style={{ ...inputStyle, padding: '6px 8px', ...getDisabledStyle(canEdit, 'input') }}
                            disabled={!canEdit}
                          />
                        </td>
                        <td style={{ padding: '10px 14px', color: '#64748b' }}>{entry.source || '--'}</td>
                        <td style={{ padding: '10px 14px' }}>
                          <button
                            onClick={() => {
                              setSelectedDesignEntryId(entry.id);
                              onSelectDesignEntry?.(entry.id);
                              onSelectLine?.(String(entry.line || '').trim());
                              setPlannerView('map');
                            }}
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#2563eb', display: 'flex', alignItems: 'center', padding: 0 }}
                          >
                            <MapPinned size={16} />
                          </button>
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <button onClick={() => canEdit && handleDeleteDesignEntry(entry.id)} disabled={!canEdit} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#ef4444', display: 'flex', alignItems: 'center', padding: 0, ...getDisabledStyle(canEdit) }}>
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!designEntries.length && (
                      <tr>
                        <td colSpan={8} style={{ padding: '24px 14px', textAlign: 'center', color: '#94a3b8' }}>请先在地图上点选测点。</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '14px' }}>
            <div style={cardStyle}>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>勘查目标</div>
              <input value={plan.surveyGoal} onChange={(e) => handleFieldChange('surveyGoal', e.target.value)} placeholder="例如：隧道富水异常体精细探测" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
            </div>
            <div style={cardStyle}>
              <input value={plan.surveyScope} onChange={(e) => handleFieldChange('surveyScope', e.target.value)} placeholder="????? DK32+100 ? DK32+860" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
              <input value={plan.surveyScope} onChange={(e) => handleFieldChange('surveyScope', e.target.value)} placeholder="????? DK32+100 ? DK32+860" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
            </div>
            <div style={cardStyle}>
              <input value={plan.plannedLines} onChange={(e) => handleFieldChange('plannedLines', e.target.value)} placeholder="???8" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
              <input value={plan.plannedLines} onChange={(e) => handleFieldChange('plannedLines', e.target.value)} placeholder="???8" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
            </div>
            <div style={cardStyle}>
              <input value={plan.plannedPoints} onChange={(e) => handleFieldChange('plannedPoints', e.target.value)} placeholder="???16" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
              <input value={plan.plannedPoints} onChange={(e) => handleFieldChange('plannedPoints', e.target.value)} placeholder="???16" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
            </div>
            <div style={cardStyle}>
              <input value={plan.lineSpacing} onChange={(e) => handleFieldChange('lineSpacing', e.target.value)} placeholder="???20m" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
              <input value={plan.lineSpacing} onChange={(e) => handleFieldChange('lineSpacing', e.target.value)} placeholder="???20m" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
            </div>
            <div style={cardStyle}>
              <input value={plan.pointSpacing} onChange={(e) => handleFieldChange('pointSpacing', e.target.value)} placeholder="???20m" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
              <input value={plan.pointSpacing} onChange={(e) => handleFieldChange('pointSpacing', e.target.value)} placeholder="???20m" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>仪器配置</div>
              <input value={plan.instrumentModel} onChange={(e) => handleFieldChange('instrumentModel', e.target.value)} placeholder="例如：EH4 + F3 联合布设" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
            </div>
            <div style={cardStyle}>
            <div style={cardStyle}>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>复核人</div>
              <input value={plan.reviewer} onChange={(e) => handleFieldChange('reviewer', e.target.value)} placeholder="例如：李四" style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>开始时间</div>
              <input type="date" value={plan.startDate} onChange={(e) => handleFieldChange('startDate', e.target.value)} style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>结束时间</div>
              <input type="date" value={plan.endDate} onChange={(e) => handleFieldChange('endDate', e.target.value)} style={{ ...inputStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
            </div>
            <div style={{ ...cardStyle, gridColumn: '1 / -1' }}>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>风险控制</div>
              <textarea value={plan.riskControl} onChange={(e) => handleFieldChange('riskControl', e.target.value)} placeholder="填写安全、设备、天气、交通等控制措施" style={{ ...textareaStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
            </div>
            <div style={{ ...cardStyle, gridColumn: '1 / -1' }}>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>补充说明</div>
              <textarea value={plan.remarks} onChange={(e) => handleFieldChange('remarks', e.target.value)} placeholder="补充工作面条件、测线布设依据或特别要求" style={{ ...textareaStyle, ...getDisabledStyle(canEdit, 'input') }} disabled={!canEdit} />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '18px' }}>
            <button onClick={() => savePlan(false)} disabled={!canEdit} style={{ background: '#fff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '10px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, ...getDisabledStyle(canEdit) }}>
              <Save size={16} /> 保存规划
            </button>
            <button onClick={() => savePlan(true)} disabled={!canEdit} style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, ...getDisabledStyle(canEdit) }}>
              <CheckCircle2 size={16} /> 标记规划完成
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

export default ProjectPlanningPanel;
