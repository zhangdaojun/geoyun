import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FolderKanban, Plus, Search, Filter, MoreHorizontal, MapPin, Activity, Calendar, Clock, ChevronLeft, FileText, Database, Layers, CheckCircle, X, BarChart3, HardDrive, RadioTower, ShieldCheck, Users, UserPlus, Settings2, Trash2, Sparkles, Crown, CircleHelp, Pencil, Phone, Maximize2, Minimize2, UploadCloud, Eye, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { lazy, Suspense, useCallback } from 'react';
import NodeLogsPanel from './NodeLogsPanel';
import ProjectPlanningPanel from './ProjectPlanningPanel';
import ReactECharts from './LazyECharts';
import { deriveProjectFiles, deriveProjectTasks, ensureProjectShape, updateProjectWithCloudItems, updateProjectWithInvitations, updateProjectWithMembers, updateProjectWithPlan } from '../utils/projectModel';
import { createInvitationRecords, parseBulkInviteInput, resendInvitationRecord, revokeInvitationRecord } from '../services/memberManagementApi';
import { resolveDriveFileContent } from '../utils/driveFileContent';
import { saveFileBlob } from '../utils/fileBlobStore';
import { createInterpolatedFieldImage } from '../utils/interpolatedFieldImage';
import { PROJECT_ROLE_PERMISSION_MATRIX, canManageProjectDatabase, resolveCurrentProjectMember, resolveCurrentProjectRole } from '../utils/accessControl';
import { processAdminEmap1 } from '../services/adminEmap1Api';
import { msg } from '../utils/message';
import { loadEh4Io } from '../utils/lazyModules';
import { loadProj4, loadXlsx } from '../utils/lazyModules';
import { parseLonLat } from '../utils/coordUtils';
import CoordinateImportModal from '../features/projects/components/CoordinateImportModal';
import {
  EMAP1_AURORA_DEFAULT_CALIBRATION,
  autoMatchEmap1Calibration,
  defaultEmap1AuroraSettings,
  getEmap1CalibrationCandidateId,
  isEmap1CalibrationFile
} from '../features/projects/domain/emap1Calibration';
import {
  buildRes2dinvConcatenateCommand,
  buildStitchedRes2dinvDat,
  parseRes2dinvSource,
  parseRes2dinvArrangementLength
} from '../utils/res2dinvStitch';

const DEFAULT_PROJECT_CENTER = [35.86166, 104.195397];
const SurveyDataTree = lazy(() => import('./SurveyDataTree'));
const createProjectId = () => `project_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const isFiniteLatLng = (value) => (
  Array.isArray(value)
  && value.length >= 2
  && Number.isFinite(Number(value[0]))
  && Number.isFinite(Number(value[1]))
);

const coerceLatLng = (value, fallback = DEFAULT_PROJECT_CENTER) => (
  isFiniteLatLng(value) ? [Number(value[0]), Number(value[1])] : [...fallback]
);

const formatOverviewNumber = (value, decimals = 6) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '--';
  return numericValue.toFixed(decimals);
};

const formatLengthMeters = (value) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '--';
  return `${Number.isInteger(numericValue) ? numericValue : numericValue.toFixed(2)} m`;
};

const getDisplayFileName = (value) => {
  const filePath = String(value || '').trim();
  if (!filePath) return '';
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
};

const normalizeDriveFileName = (value) => getDisplayFileName(value).trim().toLowerCase();

const isRes2dinvStitchDatItem = (item = {}) => (
  item?.type === 'file'
  && String(item?.generatedBy || '').trim() === 'res2dinv-stitch-dat'
);

const getF3MatchedFileSerial = (value) => {
  const name = getDisplayFileName(value);
  const match = name.match(/^.+\.(\d+)\.(r|psd|fh|fm|fl)$/i);
  return match ? Number(match[1]) : Number.NaN;
};

const getF3MatchedFileOrder = (value) => {
  const name = getDisplayFileName(value).toLowerCase();
  if (name.endsWith('.r')) return 0;
  if (name.endsWith('.psd')) return 1;
  if (name.endsWith('.fh')) return 2;
  if (name.endsWith('.fm')) return 3;
  if (name.endsWith('.fl')) return 4;
  return 9;
};

const normalizeF3MatchedPathsBySerial = (entries = []) => {
  const nextEntries = entries.map((entry) => ({ ...entry }));
  const lineGroups = new Map();
  nextEntries.forEach((entry, index) => {
    if (normalizeOverviewInstrumentType(entry.instrument) !== 'f3') return;
    const lineKey = String(entry.line || '').trim();
    if (!lineKey) return;
    if (!lineGroups.has(lineKey)) lineGroups.set(lineKey, []);
    lineGroups.get(lineKey).push({ entry, index });
  });

  lineGroups.forEach((group) => {
    const sortedGroup = [...group].sort((a, b) => String(a.entry.point || '').localeCompare(String(b.entry.point || ''), 'zh-Hans-CN', { numeric: true }));
    const serialPathMap = new Map();
    group.forEach(({ entry }) => {
      (entry.matchedDataPaths || []).forEach((path) => {
        const serial = getF3MatchedFileSerial(path);
        if (!Number.isFinite(serial)) return;
        if (!serialPathMap.has(serial)) serialPathMap.set(serial, new Map());
        serialPathMap.get(serial).set(String(path), path);
      });
    });
    const serials = Array.from(serialPathMap.keys()).sort((a, b) => a - b);
    sortedGroup.forEach(({ entry, index }, ordinal) => {
      const serial = serials[ordinal];
      if (!Number.isFinite(serial)) {
        nextEntries[index] = {
          ...entry,
          matchedDataPaths: [],
          matchedDataCount: 0,
          hasExistingData: false,
          pointStatus: 'pending'
        };
        return;
      }
      const nextPaths = Array.from(serialPathMap.get(serial)?.values() || [])
        .sort((a, b) => {
          const orderCompare = getF3MatchedFileOrder(a) - getF3MatchedFileOrder(b);
          if (orderCompare !== 0) return orderCompare;
          return getDisplayFileName(a).localeCompare(getDisplayFileName(b), 'zh-Hans-CN', { numeric: true });
        });
      nextEntries[index] = {
        ...entry,
        matchedDataPaths: nextPaths,
        matchedDataCount: nextPaths.length,
        hasExistingData: nextPaths.length > 0,
        pointStatus: nextPaths.length > 0 ? 'matched' : 'pending'
      };
    });
  });

  return nextEntries;
};

const overviewCoordInputStyle = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: '10px',
  border: '1px solid #dbe2ea',
  outline: 'none',
  background: '#fff',
  color: '#0f172a',
  fontSize: '13px'
};

const projectRoleMetaMap = {
  owner: { label: '负责人' },
  manager: { label: '项目经理' },
  operator: { label: '作业人员' },
  reviewer: { label: '审核人员' },
  viewer: { label: '只读成员' }
};

const projectRoleThemeMap = {
  owner: { color: '#9333ea', bg: '#f3e8ff', border: '#e9d5ff', icon: Crown },
  manager: { color: '#2563eb', bg: '#dbeafe', border: '#bfdbfe', icon: Settings2 },
  operator: { color: '#0f766e', bg: '#ccfbf1', border: '#99f6e4', icon: Sparkles },
  reviewer: { color: '#ea580c', bg: '#ffedd5', border: '#fed7aa', icon: ShieldCheck },
  viewer: { color: '#475569', bg: '#e2e8f0', border: '#cbd5e1', icon: Users }
};

const projectRoleCapabilityMap = {
  owner: ['member-management', 'task-edit', 'planning'],
  manager: ['task-edit', 'planning', 'project-collab'],
  operator: ['task-edit', 'planning', 'data-execution'],
  reviewer: ['view-task', 'view-planning', 'review-tracking'],
  viewer: ['view-project', 'view-data', 'read-only']
};

const projectRoleDescriptions = {
  owner: '管理成员、编辑项目、维护数据和方案。',
  manager: '编辑项目任务、方案和项目数据。',
  operator: '执行作业、维护方案和项目数据。',
  reviewer: '查看项目内容并参与审核。',
  viewer: '仅查看项目、数据和成果。'
};

const invitationStatusMeta = {
  pending: { label: '待处理', color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
  accepted: { label: '已接受', color: '#047857', bg: '#ecfdf5', border: '#a7f3d0' },
  rejected: { label: '已拒绝', color: '#b45309', bg: '#fffbeb', border: '#fde68a' },
  expired: { label: '已过期', color: '#64748b', bg: '#f8fafc', border: '#e2e8f0' },
  revoked: { label: '已撤销', color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' },
  sent: { label: '待处理', color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' }
};

const getSpatialEntries = (project) => {
  return (project?.plan?.designEntries || [])
    .map(entry => ({
      ...entry,
      id: entry.id || `${entry.line || '--'}_${entry.point || '--'}`,
      lat: Number(entry.gpsLatitude),
      lng: Number(entry.gpsLongitude)
    }))
    .filter(entry => Number.isFinite(entry.lat) && Number.isFinite(entry.lng));
};

const parseFileSizeToMb = (sizeValue) => {
  if (typeof sizeValue === 'number' && Number.isFinite(sizeValue)) return sizeValue;
  const text = String(sizeValue || '').trim();
  if (!text) return 0;
  const match = text.match(/([\d.]+)\s*(kb|mb|gb|b)?/i);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = String(match[2] || 'mb').toLowerCase();
  if (unit === 'gb') return value * 1024;
  if (unit === 'kb') return value / 1024;
  if (unit === 'b') return value / (1024 * 1024);
  return value;
};

const buildProjectItemPath = (item, items = []) => {
  if (!item) return '';
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

const sanitizeDriveFileName = (value, fallback = 'file.txt') => {
  const normalized = String(value || '').trim().replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, '_');
  return normalized || fallback;
};

const formatTextSizeBytes = (value) => {
  const bytes = Number(value) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
};

const normalizeOverviewInstrumentType = (instrument = '') => {
  const value = String(instrument || '').trim().toLowerCase();
  if (!value) return '';
  if (value.includes('f3')) return 'f3';
  if (value.includes('emap')) return 'emap';
  if (value.includes('eh4') || value.includes('mt')) return 'eh4';
  if (value.includes('edi')) return 'edi';
  if (value.includes('高密度') || value.includes('电法') || value.includes('ert')) return 'ert';
  return value;
};

const isGeneratedRes2dinvStitchEntry = (entry = {}) => {
  const point = String(entry?.point || '').trim().toLowerCase();
  const sourceName = String(entry?.sourceFileName || entry?.sourceCoordFileName || '').trim().toLowerCase();
  const matchedPaths = Array.isArray(entry?.matchedDataPaths) ? entry.matchedDataPaths : [];
  return [point, sourceName, ...matchedPaths.map((path) => String(path || '').toLowerCase())]
    .some((value) => value.includes('拼接') || value.includes('res2dinv_'));
};

const getOverviewInstrumentPalette = (instrument = '') => {
  const instrumentType = normalizeOverviewInstrumentType(instrument);
  if (instrumentType === 'f3') {
    return {
      stroke: '#0f766e',
      fill: '#14b8a6',
      lightFill: '#99f6e4'
    };
  }
  if (instrumentType === 'edi') {
    return {
      stroke: '#7c3aed',
      fill: '#8b5cf6',
      lightFill: '#ddd6fe'
    };
  }
  if (instrumentType === 'emap') {
    return {
      stroke: '#dc2626',
      fill: '#ef4444',
      lightFill: '#fecaca'
    };
  }
  return {
    stroke: '#2563eb',
    fill: '#60a5fa',
    lightFill: '#bfdbfe'
  };
};

const parseOverviewMttsPointNo = (name = '') => {
  const normalizedName = String(name || '').trim();
  if (!/\.mtts$/i.test(normalizedName)) return '';
  const baseName = normalizedName.replace(/\.[^.]+$/, '');
  const parts = baseName.split('_');
  return String(parts[0] || baseName).trim();
};

const parseOverviewMttsMeta = (name = '') => {
  const normalizedName = String(name || '').trim();
  if (!/\.mtts$/i.test(normalizedName)) return null;
  const baseName = normalizedName.replace(/\.[^.]+$/, '');
  const parts = baseName.split('_');
  const pointNo = String(parts[0] || baseName).trim();
  const channel = String(parts.length >= 3 ? parts[parts.length - 2] : '').trim().toLowerCase();
  const sampleRateTag = String(parts.length >= 2 ? parts[parts.length - 1] : '').trim().toUpperCase();
  return {
    pointNo,
    channel,
    sampleRateTag
  };
};

const defaultCoordinateImportParams = {
  coordType: 'lonlat',
  lonlatFormat: 'degree',
  centralMeridian: 102,
  latOrigin: 0,
  falseEasting: 500000,
  falseNorthing: 0,
  scale: 1
};

const normalizeCoordinateImportKey = (value = '') => String(value ?? '').trim().toLowerCase();

const buildCoordinateMatchKey = (line, point) => `${normalizeCoordinateImportKey(line)}__${normalizeCoordinateImportKey(point)}`;

const getCoordinateHeaderIndex = (headers = [], aliases = []) => {
  const normalizedAliases = aliases.map(normalizeCoordinateImportKey);
  return headers.findIndex((header) => {
    const normalized = normalizeCoordinateImportKey(header);
    if (!normalized) return false;
    return normalizedAliases.some((alias) => normalized === alias || normalized.includes(alias));
  });
};

const looksLikeCoordinateHeader = (row = []) => {
  const headers = row.map(normalizeCoordinateImportKey);
  return headers.some((item) => ['测线', '线号', 'line', 'surveyline'].includes(item))
    && headers.some((item) => ['测点', '点号', 'point', 'station'].includes(item));
};

const getCoordinateCell = (row = [], index) => (Number.isInteger(index) && index >= 0 ? row[index] : '');

const parseCoordinateImportRows = (rows = []) => {
  const usefulRows = rows.filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim()));
  if (!usefulRows.length) return [];

  const firstRow = usefulRows[0] || [];
  const hasHeader = looksLikeCoordinateHeader(firstRow);
  const headers = hasHeader ? firstRow : [];
  const indices = hasHeader
    ? {
        line: getCoordinateHeaderIndex(headers, ['测线', '线号', 'line', 'surveyline', 'line no']),
        point: getCoordinateHeaderIndex(headers, ['测点', '点号', 'point', 'station', 'station no']),
        x: getCoordinateHeaderIndex(headers, ['x', '经度', 'longitude', 'lon', 'easting']),
        y: getCoordinateHeaderIndex(headers, ['y', '纬度', 'latitude', 'lat', 'northing']),
        z: getCoordinateHeaderIndex(headers, ['z', '高程', 'elevation', 'height']),
        instrument: getCoordinateHeaderIndex(headers, ['仪器', '方法', 'instrument', 'method'])
      }
    : { line: 0, point: 1, x: 2, y: 3, z: 4, instrument: 5 };

  if (indices.line < 0 || indices.point < 0 || indices.x < 0 || indices.y < 0) return [];

  return usefulRows.slice(hasHeader ? 1 : 0)
    .map((row) => ({
      line: String(getCoordinateCell(row, indices.line) ?? '').trim(),
      point: String(getCoordinateCell(row, indices.point) ?? '').trim(),
      x: getCoordinateCell(row, indices.x),
      y: getCoordinateCell(row, indices.y),
      z: getCoordinateCell(row, indices.z),
      instrument: String(getCoordinateCell(row, indices.instrument) ?? '').trim()
    }))
    .filter((row) => row.line && row.point && String(row.x ?? '').trim() && String(row.y ?? '').trim());
};

const buildSpatialLineGroups = (entries) => {
  return Object.values(entries.reduce((acc, entry) => {
    const lineKey = String(entry.line || '--').trim();
    const instrumentKey = normalizeOverviewInstrumentType(entry.instrument) || 'unknown';
    const groupKey = `${lineKey}__${instrumentKey}`;
    if (!acc[groupKey]) acc[groupKey] = [];
    acc[groupKey].push(entry);
    return acc;
  }, {}))
    .map(lineEntries => lineEntries.sort((a, b) => String(a.point || '').localeCompare(String(b.point || ''), 'zh-Hans-CN', { numeric: true })))
    .filter(lineEntries => lineEntries.length > 1);
};

const buildLineProfileChartOption = (entries = [], instrumentName = '') => {
  const validEntries = (entries || []).filter((entry) => (
    Number.isFinite(Number(entry.lat))
    && Number.isFinite(Number(entry.lng))
    && Number.isFinite(Number(entry.z))
  ));
  if (!validEntries.length) return null;

  const first = validEntries[0];
  const last = validEntries[validEntries.length - 1];
  const baseLat = Number(first.lat);
  const baseLng = Number(first.lng);
  const meanLatRad = (baseLat * Math.PI) / 180;
  const metersPerLng = 111320 * Math.cos(meanLatRad);
  const metersPerLat = 110540;

  const toLocalXY = (entry) => {
    const dx = (Number(entry.lng) - baseLng) * metersPerLng;
    const dy = (Number(entry.lat) - baseLat) * metersPerLat;
    return { dx, dy };
  };

  const firstLocal = toLocalXY(first);
  const lastLocal = toLocalXY(last);
  const axisDx = lastLocal.dx - firstLocal.dx;
  const axisDy = lastLocal.dy - firstLocal.dy;
  const rawAxisLength = Math.hypot(axisDx, axisDy);
  const useSequenceDistance = rawAxisLength < 0.01;
  const axisLength = useSequenceDistance ? 1 : rawAxisLength;
  const ux = axisDx / axisLength;
  const uy = axisDy / axisLength;

  const points = validEntries.map((entry, index) => {
    const { dx, dy } = toLocalXY(entry);
    const along = useSequenceDistance ? index : dx * ux + dy * uy;
    const elevation = Number(entry.z);
    return {
      entry,
      along: Number(along.toFixed(2)),
      elevation: Number(elevation.toFixed(2))
    };
  }).sort((a, b) => a.along - b.along);

  return {
    animation: false,
    title: {
      text: `二维剖面${instrumentName ? ` · ${instrumentName}` : ''}`,
      left: 16,
      top: 12,
      textStyle: {
        fontSize: 15,
        fontWeight: 700,
        color: '#0f172a'
      }
    },
    grid: {
      top: 56,
      left: 60,
      right: 24,
      bottom: 48
    },
    tooltip: {
      trigger: 'item',
      formatter: (params) => {
        const point = points[params.dataIndex];
        return [
          `测点: ${point.entry.point || '--'}`,
          `沿线距离: ${point.along} m`,
          `高程: ${point.elevation} m`,
          `状态: ${point.entry.hasExistingData ? `已匹配 ${point.entry.matchedDataCount}` : '未匹配'}`
        ].join('<br/>');
      }
    },
    legend: {
      top: 14,
      right: 16,
      textStyle: { color: '#475569' }
    },
    xAxis: {
      type: 'value',
      name: '沿线距离 (m)',
      nameLocation: 'middle',
      nameGap: 30,
      axisLine: { lineStyle: { color: '#94a3b8' } },
      axisLabel: { color: '#475569' },
      splitLine: { lineStyle: { color: '#e2e8f0', type: 'dashed' } }
    },
    yAxis: {
      type: 'value',
      name: '高程 (m)',
      nameLocation: 'middle',
      nameGap: 42,
      axisLine: { lineStyle: { color: '#94a3b8' } },
      axisLabel: { color: '#475569' },
      splitLine: { lineStyle: { color: '#e2e8f0', type: 'dashed' } }
    },
    series: [
      {
        name: '测线',
        type: 'line',
        symbol: 'none',
        lineStyle: {
          color: '#60a5fa',
          width: 2.5
        },
        data: points.map((point) => [point.along, point.elevation])
      },
      {
        name: '已匹配',
        type: 'scatter',
        symbolSize: 10,
        itemStyle: { color: '#2563eb' },
        data: points
          .filter((point) => point.entry.hasExistingData)
          .map((point) => ({
            value: [point.along, point.elevation],
            name: point.entry.point || '--'
          })),
        label: {
          show: true,
          position: 'top',
          color: '#1e3a8a',
          fontSize: 11,
          formatter: (params) => params.name
        }
      },
      {
        name: '未匹配',
        type: 'scatter',
        symbolSize: 9,
        itemStyle: { color: '#94a3b8' },
        data: points
          .filter((point) => !point.entry.hasExistingData)
          .map((point) => ({
            value: [point.along, point.elevation],
            name: point.entry.point || '--'
          })),
        label: {
          show: true,
          position: 'bottom',
          color: '#64748b',
          fontSize: 11,
          formatter: (params) => params.name
        }
      }
    ]
  };
};

const parseRes2dinvPreviewPoints = (text = '') => {
  const parsed = parseRes2dinvSource(text);
  const lines = parsed?.dataLines?.length
    ? parsed.dataLines
    : String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  return lines
    .map((line) => String(line || '').trim().split(/[,\t ]+/).map(Number))
    .filter((parts) => parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite))
    .map((parts, index) => ({
      x: parts[0],
      z: parts[1],
      rho: parts[2],
      index
    }));
};

const getRes2dinvPreviewMetrics = (text = '') => {
  const points = parseRes2dinvPreviewPoints(text);
  if (!points.length) return null;
  const xValues = points.map((point) => point.x).filter(Number.isFinite);
  const arrangementLength = parseRes2dinvArrangementLength(text);
  if (!xValues.length) {
    return {
      dataPointCount: points.length,
      profileLength: Number.isFinite(arrangementLength) ? arrangementLength : null
    };
  }
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const fallbackLength = Number((maxX - minX).toFixed(2));
  return {
    dataPointCount: points.length,
    minX,
    maxX,
    profileLength: Number.isFinite(arrangementLength)
      ? Number(arrangementLength.toFixed(2))
      : fallbackLength
  };
};

const getRes2dinvStitchRowsProfileLength = (rows = []) => {
  const extents = rows
    .map((row) => {
      const start = Number(row?.xLocation);
      const end = Number(row?.endX);
      const length = Number(row?.length);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        return [Math.min(start, end), Math.max(start, end)];
      }
      if (Number.isFinite(start) && Number.isFinite(length) && length > 0) {
        return [start, start + length];
      }
      return null;
    })
    .filter(Boolean);
  if (!extents.length) return null;
  const minX = Math.min(...extents.map(([start]) => start));
  const maxX = Math.max(...extents.map(([, end]) => end));
  const length = maxX - minX;
  return Number.isFinite(length) && length > 0 ? Number(length.toFixed(2)) : null;
};

const interpolateTopographyOffset = (x, terrainLineData = []) => {
  const targetX = Number(x);
  if (!Number.isFinite(targetX) || !terrainLineData.length) return 0;
  const points = terrainLineData
    .map((point) => [Number(point[0]), Number(point[1])])
    .filter(([px, py]) => Number.isFinite(px) && Number.isFinite(py))
    .sort((a, b) => a[0] - b[0]);
  if (!points.length) return 0;
  if (targetX <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (targetX >= last[0]) return last[1];
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1];
    const next = points[index];
    if (targetX <= next[0]) {
      const ratio = (targetX - prev[0]) / Math.max(next[0] - prev[0], 1e-9);
      return prev[1] + (next[1] - prev[1]) * ratio;
    }
  }
  return 0;
};


const resolveGridEdgePx = (value, total, fallback = 0) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (text.endsWith('%')) {
    const ratio = Number.parseFloat(text);
    return Number.isFinite(ratio) ? (total * ratio) / 100 : fallback;
  }
  const numeric = Number.parseFloat(text);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const squareRes2dinvOption = (option, containerPx) => {
  const meta = option?.__res2dinvSquareLayout;
  if (!meta) return option;
  const stripMeta = (nextOption) => {
    if (!nextOption?.__res2dinvSquareLayout) return nextOption;
    const cleanOption = { ...nextOption };
    delete cleanOption.__res2dinvSquareLayout;
    return cleanOption;
  };
  if (!containerPx?.width || !containerPx?.height) return stripMeta(option);
  const grid = Array.isArray(option.grid) ? { ...(option.grid[0] || {}) } : { ...(option.grid || {}) };
  const xAxis = Array.isArray(option.xAxis) ? { ...(option.xAxis[0] || {}) } : { ...(option.xAxis || {}) };
  const yAxis = Array.isArray(option.yAxis) ? { ...(option.yAxis[0] || {}) } : { ...(option.yAxis || {}) };
  const left = resolveGridEdgePx(grid.left, containerPx.width, 60);
  const right = resolveGridEdgePx(grid.right, containerPx.width, 76);
  const top = resolveGridEdgePx(grid.top, containerPx.height, 68);
  const baseBottom = resolveGridEdgePx(grid.bottom, containerPx.height, 50);
  const plotWidth = Math.max(containerPx.width - left - right, 1);
  const availableHeight = Math.max(containerPx.height - top - baseBottom, 1);
  const xRange = Math.max(Number(meta.xMax) - Number(meta.xMin), 1);
  const yRange = Math.max(Number(meta.yMax) - Number(meta.yMin), 1);
  const pxPerUnit = plotWidth / xRange;
  const requiredPlotHeight = yRange * pxPerUnit;
  const nextGrid = { ...grid };
  const nextYAxis = { ...yAxis };

  if (requiredPlotHeight <= availableHeight) {
    nextGrid.bottom = Math.max(baseBottom, containerPx.height - top - requiredPlotHeight);
    nextYAxis.min = meta.yMin;
    nextYAxis.max = meta.yMax;
  } else {
    nextGrid.bottom = baseBottom;
    nextYAxis.min = meta.yMin;
    nextYAxis.max = meta.yMin + (availableHeight / pxPerUnit);
  }

  const nextOption = {
    ...option,
    grid: Array.isArray(option.grid) ? [nextGrid] : nextGrid,
    xAxis: Array.isArray(option.xAxis) ? [{ ...xAxis, min: meta.xMin, max: meta.xMax }] : { ...xAxis, min: meta.xMin, max: meta.xMax },
    yAxis: Array.isArray(option.yAxis) ? [nextYAxis] : nextYAxis
  };
  return stripMeta(nextOption);
};

const ResponsiveLineProfileChart = ({ option, style, onChartReady, ...props }) => {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const [chartReadyTick, setChartReadyTick] = useState(0);
  const [containerPx, setContainerPx] = useState(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setContainerPx((prev) => {
        const next = {
          width: Math.max(Math.round(rect.width), 1),
          height: Math.max(Math.round(rect.height), 1)
        };
        return prev?.width === next.width && prev?.height === next.height ? prev : next;
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const sizedOption = useMemo(() => squareRes2dinvOption(option, containerPx), [containerPx, option]);
  const handleChartReady = useCallback((instance) => {
    chartInstanceRef.current = instance;
    setChartReadyTick((value) => value + 1);
    onChartReady?.(instance);
  }, [onChartReady]);

  useEffect(() => {
    const meta = option?.__res2dinvSquareLayout;
    const instance = chartInstanceRef.current || chartRef.current?.getEchartsInstance?.();
    if (!meta || !instance || !containerPx?.width || !containerPx?.height) return undefined;

    const grid = Array.isArray(option.grid) ? (option.grid[0] || {}) : (option.grid || {});
    const left = resolveGridEdgePx(grid.left, containerPx.width, 60);
    const right = resolveGridEdgePx(grid.right, containerPx.width, 76);
    const top = resolveGridEdgePx(grid.top, containerPx.height, 68);
    const baseBottom = resolveGridEdgePx(grid.bottom, containerPx.height, 50);
    const fullXRange = Math.max(Number(meta.xMax) - Number(meta.xMin), 1);
    const fullYRange = Math.max(Number(meta.yMax) - Number(meta.yMin), 1);

    const syncFrameWithZoom = () => {
      const opt = instance.getOption?.();
      if (!opt) return;
      const dzArr = opt.dataZoom || [];
      const xDz = dzArr.find((dz) => dz.id === 'res2dinv-x-zoom' || dz.xAxisIndex === 0);
      const yDz = dzArr.find((dz) => dz.id === 'res2dinv-y-zoom' || dz.yAxisIndex === 0);
      if (!xDz || !yDz) return;

      const xStart = Number.isFinite(xDz.start) ? xDz.start : 0;
      const xEnd = Number.isFinite(xDz.end) ? xDz.end : 100;
      const yStart = Number.isFinite(yDz.start) ? yDz.start : 0;
      const yEnd = Number.isFinite(yDz.end) ? yDz.end : 100;
      const xPct = Math.max((xEnd - xStart) / 100, 0.0001);
      const plotWidth = Math.max(containerPx.width - left - right, 1);
      const maxPlotHeight = Math.max(containerPx.height - top - baseBottom, 1);
      const pxPerUnit = plotWidth / Math.max(fullXRange * xPct, 1);
      const fullRangePlotHeight = fullYRange * pxPerUnit;
      const targetPlotHeight = Math.max(Math.min(fullRangePlotHeight, maxPlotHeight), 1);
      const nextBottom = Math.max(baseBottom, containerPx.height - top - targetPlotHeight);
      const targetYRange = fullRangePlotHeight <= maxPlotHeight
        ? fullYRange
        : Math.min(fullYRange, maxPlotHeight / pxPerUnit);
      const targetYPct = Math.max(Math.min((targetYRange / fullYRange) * 100, 100), 0.0001);
      const yCenter = Number.isFinite(yStart) && Number.isFinite(yEnd) ? (yStart + yEnd) / 2 : targetYPct / 2;
      let nextYStart = yCenter - targetYPct / 2;
      let nextYEnd = yCenter + targetYPct / 2;
      if (nextYStart < 0) {
        nextYEnd -= nextYStart;
        nextYStart = 0;
      }
      if (nextYEnd > 100) {
        nextYStart -= nextYEnd - 100;
        nextYEnd = 100;
      }
      nextYStart = Math.max(0, nextYStart);
      nextYEnd = Math.min(100, nextYEnd);

      const currentGrid = Array.isArray(opt.grid) ? opt.grid[0] : opt.grid;
      const currentBottom = Number(currentGrid?.bottom ?? baseBottom);
      if (
        Math.abs(currentBottom - nextBottom) < 1
        && Math.abs((yEnd - yStart) - targetYPct) < 0.05
        && Math.abs(yStart - nextYStart) < 0.05
      ) return;

      instance.setOption({
        grid: { left, right, top, bottom: nextBottom },
        dataZoom: [
          { id: 'res2dinv-y-zoom', start: nextYStart, end: nextYEnd }
        ]
      }, { notMerge: false, silent: true });
    };

    instance.on('datazoom', syncFrameWithZoom);
    syncFrameWithZoom();
    const frameId = window.requestAnimationFrame(syncFrameWithZoom);
    const timerId = window.setTimeout(syncFrameWithZoom, 120);
    return () => {
      instance.off('datazoom', syncFrameWithZoom);
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timerId);
    };
  }, [chartReadyTick, containerPx, option]);

  return (
    <div ref={containerRef} style={style}>
      <ReactECharts ref={chartRef} option={sizedOption} onChartReady={handleChartReady} style={{ height: '100%', width: '100%' }} {...props} />
    </div>
  );
};

const buildRes2dinvDataChartOption = ({ text = '', title = '', subtitle = '' } = {}) => {
  const points = parseRes2dinvPreviewPoints(text);
  if (!points.length) return null;
  const parsedSource = parseRes2dinvSource(text);

  const rhoValues = points.map((point) => point.rho).filter(Number.isFinite);
  if (!rhoValues.length) return null;
  const sortedRho = [...rhoValues].sort((a, b) => a - b);
  const minVal = sortedRho[0];
  const maxVal = sortedRho[Math.min(sortedRho.length - 1, Math.floor(sortedRho.length * 0.95))] || sortedRho[sortedRho.length - 1];
  const uniqueZ = [...new Set(points.map((point) => point.z))].sort((a, b) => a - b);
  const xValues = points.map((point) => point.x);
  const uniqueX = [...new Set(xValues)].sort((a, b) => a - b);
  const xStepsForCell = [];
  for (let index = 1; index < uniqueX.length; index += 1) {
    const step = uniqueX[index] - uniqueX[index - 1];
    if (Number.isFinite(step) && step > 0) xStepsForCell.push(step);
  }
  const sortedXStepsForCell = [...xStepsForCell].sort((a, b) => a - b);
  const inferredCellSpacing = sortedXStepsForCell.length
    ? sortedXStepsForCell[Math.floor(sortedXStepsForCell.length / 2)]
    : 10;
  const fileCellSpacing = Number(parsedSource?.unitSpacing);
  const uniformCellSize = Number.isFinite(fileCellSpacing) && fileCellSpacing > 0
    ? fileCellSpacing
    : inferredCellSpacing;
  const halfCellWidth = uniformCellSize / 2;
  const zBounds = {};
  uniqueZ.forEach((z, index) => {
    void index;
    const top = z - uniformCellSize / 2;
    const bottom = z + uniformCellSize / 2;
    zBounds[z] = { top, bottom };
  });

  const allTopZ = Object.values(zBounds).map((bound) => bound.top);
  const allBottomZ = Object.values(zBounds).map((bound) => bound.bottom);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  let yMin = Math.min(...allTopZ);
  let yMax = Math.max(...allBottomZ);
  const topoPoints = parsedSource?.topographyBlock?.points?.length
    ? parsedSource.topographyBlock.points
        .map((point) => ({ x: Number(point.x), elevation: Number(point.elevation ?? point.z) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.elevation))
        .sort((a, b) => a.x - b.x)
    : [];
  const firstTopoIndex = Math.max(0, Math.min((parsedSource?.topographyBlock?.firstElectrodePointIndex || 1) - 1, Math.max(topoPoints.length - 1, 0)));
  const topoReferenceElevation = topoPoints.length ? topoPoints[firstTopoIndex].elevation : null;
  const terrainLineData = topoReferenceElevation !== null
    ? topoPoints.map((point) => [point.x, topoReferenceElevation - point.elevation])
    : [];
  if (terrainLineData.length) {
    const topoYValues = terrainLineData.map((point) => point[1]).filter(Number.isFinite);
    if (topoYValues.length) {
      const rowHeight = uniqueZ.length > 1 ? uniqueZ[1] - uniqueZ[0] : 1;
      yMin = Math.min(yMin, Math.min(...topoYValues) - rowHeight * 0.5);
      yMax = Math.max(yMax, Math.max(...allBottomZ) + Math.max(...topoYValues) + rowHeight * 0.5);
    }
  }
  const rowGroups = points.reduce((groups, point) => {
    const key = String(point.z);
    if (!groups[key]) groups[key] = [];
    groups[key].push(point);
    return groups;
  }, {});
  const boxedData = [];
  const boundaryRows = [];
  Object.keys(rowGroups).sort((a, b) => Number(a) - Number(b)).forEach((zKey) => {
    const row = rowGroups[zKey].sort((a, b) => a.x - b.x);
    const boundaryRow = [];
    row.forEach((point) => {
      const leftX = point.x - halfCellWidth;
      const rightX = point.x + halfCellWidth;
      const zb = zBounds[point.z];
      const centerTopo = interpolateTopographyOffset(point.x, terrainLineData);
      const topY = zb.top + centerTopo;
      const bottomY = zb.bottom + centerTopo;
      const centerY = point.z + centerTopo;
      boxedData.push([leftX, rightX, topY, bottomY, point.rho, point.x, point.z + centerTopo, point.index]);
      boundaryRow.push({ x: point.x, leftX, rightX, topY, bottomY, centerY });
    });
    if (boundaryRow.length) boundaryRows.push(boundaryRow);
  });
  const boundaryPolygon = [];
  if (boundaryRows.length) {
    const topRow = boundaryRows[0];
    const bottomRow = boundaryRows[boundaryRows.length - 1];
    boundaryPolygon.push({ x: topRow[0].leftX, y: topRow[0].topY });
    topRow.forEach((cell) => boundaryPolygon.push({ x: cell.x, y: cell.topY }));
    boundaryPolygon.push({ x: topRow[topRow.length - 1].rightX, y: topRow[topRow.length - 1].topY });
    boundaryRows.forEach((row) => {
      const cell = row[row.length - 1];
      boundaryPolygon.push({ x: cell.rightX, y: (cell.topY + cell.bottomY) / 2 });
    });
    boundaryPolygon.push({ x: bottomRow[bottomRow.length - 1].rightX, y: bottomRow[bottomRow.length - 1].centerY });
    [...bottomRow].reverse().forEach((cell) => boundaryPolygon.push({ x: cell.x, y: cell.centerY }));
    boundaryPolygon.push({ x: bottomRow[0].leftX, y: bottomRow[0].centerY });
    [...boundaryRows].reverse().forEach((row) => {
      const cell = row[0];
      boundaryPolygon.push({ x: cell.leftX, y: (cell.topY + cell.bottomY) / 2 });
    });
  }
  const palette = ['#0017c8', '#0066ff', '#00d9ff', '#22e35b', '#f7f85b', '#ff7a1a', '#a30000'];
  const pointLayerData = boxedData.map((item) => ({
    value: [item[5], item[6], item[4], item[7]]
  }));
  const interpolatedField = createInterpolatedFieldImage({
    points: pointLayerData.map((point) => ({
      x: point.value[0],
      y: point.value[1],
      rho: point.value[2]
    })),
    boundaryPolygon,
    minVal,
    maxVal,
    colors: palette
  });
  return {
    __res2dinvSquareLayout: { xMin, xMax, yMin, yMax },
    animation: false,
    title: {
      text: title || '高密度电法数据剖面',
      subtext: subtitle,
      left: 16,
      top: 10,
      textStyle: { fontSize: 15, fontWeight: 700, color: '#0f172a' },
      subtextStyle: { color: '#64748b' }
    },
    grid: { top: 68, left: 60, right: 76, bottom: 50 },
    tooltip: {
      trigger: 'item',
      formatter: (params) => (
        `X (点位): ${params.value[5]} m<br/>Z (深度): ${params.value[6]} m<br/>视电阻率: ${Number(params.value[4]).toFixed(1)} Ω·m`
      )
    },
    dataZoom: [
      {
        id: 'res2dinv-x-zoom',
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
        throttle: 40
      },
      {
        id: 'res2dinv-y-zoom',
        type: 'inside',
        yAxisIndex: 0,
        filterMode: 'none',
        zoomOnMouseWheel: false,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
        throttle: 40
      }
    ],
    xAxis: {
      type: 'value',
      min: xMin,
      max: xMax,
      name: '测量距离 X (m)',
      nameLocation: 'middle',
      nameGap: 30,
      splitLine: { lineStyle: { color: '#dbeafe', type: 'dashed' } },
      axisLabel: { color: '#475569' }
    },
    yAxis: {
      type: 'value',
      inverse: true,
      min: yMin,
      max: yMax,
      name: '贯穿深度 Z (m)',
      nameLocation: 'middle',
      nameGap: 42,
      splitLine: { lineStyle: { color: '#e2e8f0', type: 'dashed' } },
      axisLabel: { color: '#475569' }
    },
    visualMap: {
      min: minVal,
      max: maxVal,
      dimension: 4,
      orient: 'vertical',
      right: 10,
      top: 'middle',
      itemHeight: 220,
      text: ['高阻体', '低阻区'],
      calculable: true,
      seriesIndex: 1,
      inRange: { color: palette }
    },
    series: [{
      name: '视电阻率',
      type: 'custom',
      silent: true,
      tooltip: { show: false },
      renderItem: (_params, api) => {
        if (!interpolatedField) return null;
        const { bounds } = interpolatedField;
        const tl = api.coord([bounds.xMin, bounds.yMin]);
        const br = api.coord([bounds.xMax, bounds.yMax]);
        const x = Math.min(tl[0], br[0]);
        const y = Math.min(tl[1], br[1]);
        return {
          type: 'image',
          style: {
            image: interpolatedField.image,
            x,
            y,
            width: Math.abs(br[0] - tl[0]),
            height: Math.abs(br[1] - tl[1])
          }
        };
      },
      data: [[0]],
      z: 2
    }, {
      name: 'legacy-block-source',
      type: 'scatter',
      symbolSize: 0,
      silent: true,
      tooltip: { show: false },
      renderItem: (_params, api) => {
        const tl = api.coord([api.value(0), api.value(2)]);
        const br = api.coord([api.value(1), api.value(3)]);
        const x = Math.min(tl[0], br[0]);
        const y = Math.min(tl[1], br[1]);
        return {
          type: 'rect',
          shape: {
            x: Math.floor(x),
            y: Math.floor(y),
            width: Math.ceil(Math.abs(br[0] - tl[0])),
            height: Math.ceil(Math.abs(br[1] - tl[1]))
          },
          style: api.style()
        };
      },
      encode: { x: 5, y: 6, tooltip: [5, 6, 4] },
      data: boxedData
    }, {
      name: '测点',
      type: 'scatter',
      data: pointLayerData,
      symbolSize: 2.2,
      itemStyle: {
        color: 'rgba(15, 23, 42, 0.52)',
        borderColor: 'rgba(255, 255, 255, 0.55)',
        borderWidth: 0.4
      },
      encode: { x: 0, y: 1, tooltip: [0, 1, 2] },
      tooltip: {
        formatter: (params) => (
          `X (点位): ${params.value[0]} m<br/>Z (深度): ${params.value[1]} m<br/>视电阻率: ${Number(params.value[2]).toFixed(1)} Ω·m`
        )
      },
      z: 14
    }, {
      name: '测点选择区域',
      type: 'scatter',
      data: pointLayerData,
      symbolSize: 14,
      cursor: 'pointer',
      itemStyle: {
        color: 'rgba(37, 99, 235, 0)',
        borderColor: 'rgba(37, 99, 235, 0)',
        borderWidth: 0
      },
      emphasis: { disabled: true },
      encode: { x: 0, y: 1, tooltip: [0, 1, 2] },
      tooltip: {
        formatter: (params) => (
          `X (点位): ${params.value[0]} m<br/>Z (深度): ${params.value[1]} m<br/>视电阻率: ${Number(params.value[2]).toFixed(1)} Ω·m`
        )
      },
      z: 16
    }, ...(terrainLineData.length ? [{
      name: '地形线',
      type: 'line',
      data: terrainLineData,
      symbol: 'circle',
      symbolSize: 3,
      tooltip: {
        formatter: (params) => {
          const point = topoPoints[params.dataIndex];
          return `地形 X: ${point?.x ?? '--'} m<br/>高程: ${Number(point?.elevation).toFixed(2)} m`;
        }
      },
      lineStyle: { color: '#111827', width: 2, type: 'solid' },
      itemStyle: { color: '#111827' },
      z: 12
    }] : [])]
  };
};

const ProjectSpatialMap = ({ project, entries, selectedEntryId, selectedLineKey = '', onSelectEntry, onSelectLine, height = '260px' }) => {
  const lineGroups = useMemo(() => buildSpatialLineGroups(entries), [entries]);
  const safeAreaCoords = useMemo(() => (
    Array.isArray(project?.areaCoords)
      ? project.areaCoords.filter(item => isFiniteLatLng(item)).map(item => [Number(item[0]), Number(item[1])])
      : []
  ), [project]);
  const plotPoints = useMemo(() => {
    const points = [];
    if (safeAreaCoords.length) points.push(...safeAreaCoords);
    points.push(...entries.map(entry => [entry.lat, entry.lng]));
    if (isFiniteLatLng(project?.coords)) points.push(coerceLatLng(project.coords));
    return points.filter(item => Array.isArray(item) && Number.isFinite(item[0]) && Number.isFinite(item[1]));
  }, [entries, project, safeAreaCoords]);
  const plotBounds = useMemo(() => {
    const sourcePoints = plotPoints.length ? plotPoints : [DEFAULT_PROJECT_CENTER];
    const lats = sourcePoints.map((item) => Number(item[0]));
    const lngs = sourcePoints.map((item) => Number(item[1]));
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const latPad = Math.max((maxLat - minLat) * 0.12, 0.002);
    const lngPad = Math.max((maxLng - minLng) * 0.12, 0.002);
    return {
      minLat: minLat - latPad,
      maxLat: maxLat + latPad,
      minLng: minLng - lngPad,
      maxLng: maxLng + lngPad
    };
  }, [plotPoints]);
  const toSvgPoint = (latLng) => {
    const width = 1000;
    const heightValue = 520;
    const xRatio = (Number(latLng[1]) - plotBounds.minLng) / Math.max(plotBounds.maxLng - plotBounds.minLng, 0.000001);
    const yRatio = (plotBounds.maxLat - Number(latLng[0])) / Math.max(plotBounds.maxLat - plotBounds.minLat, 0.000001);
    return [
      Math.min(Math.max(xRatio * width, 16), width - 16),
      Math.min(Math.max(yRatio * heightValue, 16), heightValue - 16)
    ];
  };
  const areaPath = safeAreaCoords.map((item) => toSvgPoint(item).join(',')).join(' ');

  return (
    <div style={{ height, minHeight: '420px', borderRadius: '14px', overflow: 'hidden', border: '1px solid #dbeafe', background: 'linear-gradient(180deg, #eff6ff 0%, #f8fafc 100%)' }}>
      <svg viewBox="0 0 1000 520" role="img" aria-label="项目测线空间概览" style={{ width: '100%', height: '100%', display: 'block' }}>
        <defs>
          <pattern id="project-map-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#dbeafe" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="1000" height="520" fill="url(#project-map-grid)" />
        {safeAreaCoords.length >= 3 && (
          <polygon points={areaPath} fill="#bfdbfe" fillOpacity="0.35" stroke="#2563eb" strokeWidth="2" />
        )}
        {lineGroups.map(lineEntries => {
          const lineKey = String(lineEntries[0]?.line || '').trim();
          const isLineActive = selectedLineKey && lineKey === String(selectedLineKey).trim();
          const palette = getOverviewInstrumentPalette(lineEntries[0]?.instrument);
          const linePoints = lineEntries.map(item => toSvgPoint([item.lat, item.lng]).join(',')).join(' ');
          return (
          <polyline
            key={`${lineEntries[0].line || '--'}_${normalizeOverviewInstrumentType(lineEntries[0]?.instrument) || 'unknown'}_${lineEntries[0].id}`}
            points={linePoints}
            fill="none"
            stroke={isLineActive ? '#ea580c' : palette.stroke}
            strokeWidth={isLineActive ? 5 : 3}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.95"
            style={{ cursor: 'pointer' }}
            onClick={() => onSelectLine?.(lineKey)}
          />
        )})}
        {entries.map(entry => {
          const isActive = entry.id === selectedEntryId;
          const isInSelectedLine = selectedLineKey && String(entry.line || '').trim() === String(selectedLineKey).trim();
          const palette = getOverviewInstrumentPalette(entry.instrument);
          const baseStroke = entry.hasExistingData ? palette.stroke : '#94a3b8';
          const baseFill = entry.hasExistingData ? palette.fill : palette.lightFill;
          const strokeColor = isActive ? '#ea580c' : isInSelectedLine ? '#f97316' : baseStroke;
          const fillColor = isActive ? '#fb923c' : baseFill;
          const strokeWeight = isActive ? 3 : isInSelectedLine ? 3 : 2;
          const [cx, cy] = toSvgPoint([entry.lat, entry.lng]);
          return (
            <circle
              key={entry.id}
              cx={cx}
              cy={cy}
              r={isActive ? 8 : isInSelectedLine ? 7 : 6}
              fill={fillColor}
              fillOpacity="0.95"
              stroke={strokeColor}
              strokeWidth={strokeWeight}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelectEntry?.(entry.id)}
            >
              <title>
                {`${entry.line || '--'} / ${entry.point || '--'} / ${entry.instrument || '未标注方法'}${entry.hasExistingData ? `\n已匹配 ${entry.matchedDataCount} 个文件` : '\n未匹配到数据文件'}`}
              </title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
};

const ProjectDetail = ({ project, onBack, onUpdateProject, currentUser, users = [], pendingSelection, clearPendingSelection }) => {
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedSpatialEntryId, setSelectedSpatialEntryId] = useState('');
  const [selectedSpatialLineKey, setSelectedSpatialLineKey] = useState('');
  const [selectedDataEntryId, setSelectedDataEntryId] = useState('');
  const [selectedDataLineKey, setSelectedDataLineKey] = useState('');
  const [dataAutoOpenRequest, setDataAutoOpenRequest] = useState(null);
  const autoOpenStampRef = useRef(1);
  const [showMemberSettings, setShowMemberSettings] = useState(false);
  const [showInvitePanel, setShowInvitePanel] = useState(true);
  const [showPermissionHelp, setShowPermissionHelp] = useState(false);
  const [memberSearchTerm, setMemberSearchTerm] = useState('');
  const [memberRoleFilter, setMemberRoleFilter] = useState('all');
  const [editingMemberUserId, setEditingMemberUserId] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const coordinateImportInputRef = useRef(null);
  const [showCoordinateImportDialog, setShowCoordinateImportDialog] = useState(false);
  const [showCoordinateTableDialog, setShowCoordinateTableDialog] = useState(false);
  const [coordinateSort, setCoordinateSort] = useState({ key: 'line', direction: 'asc' });
  const [coordinateImportFile, setCoordinateImportFile] = useState(null);
  const [coordinateImportBusy, setCoordinateImportBusy] = useState(false);
  const [coordinateImportParams, setCoordinateImportParams] = useState(() => ({
    ...defaultCoordinateImportParams,
    ...(project?.plan?.coordParams || {})
  }));

  const [externalInviteChannel, setExternalInviteChannel] = useState('sms');
  const [memberFeedback, setMemberFeedback] = useState({ type: '', text: '' });
  const [lineProfileModal, setLineProfileModal] = useState({ open: false, lineKey: '', instrumentName: '' });
  const [lineProfileMaximized, setLineProfileMaximized] = useState(false);
  const [lineProfileChartModalOpen, setLineProfileChartModalOpen] = useState(false);
  const [lineProfileChartMaximized, setLineProfileChartMaximized] = useState(false);
  const [lineProfileStitchDialogOpen, setLineProfileStitchDialogOpen] = useState(false);
  const [lineProfileDataChartState, setLineProfileDataChartState] = useState({ loading: false, option: null, metrics: null });
  const [showLineProfileInversionSettings, setShowLineProfileInversionSettings] = useState(false);
  const [lineProfileRightPanelWidth, setLineProfileRightPanelWidth] = useState(380);
  const [lineProfileStitchSelection, setLineProfileStitchSelection] = useState({});
  const [lineProfileStitchParams, setLineProfileStitchParams] = useState({});
  const [lineProfileArrangementLengths, setLineProfileArrangementLengths] = useState({});
  const [lineProfileCommandSaving, setLineProfileCommandSaving] = useState(false);
  const [lineProfileSavedCommandItem, setLineProfileSavedCommandItem] = useState(null);
  const [lineProfileInversionSettings, setLineProfileInversionSettings] = useState({
    mode: 'occam',
    cellWidth: 10,
    maxDepth: 800,
    iterations: 8,
    regularization: 0.2
  });
  const [emap1AuroraSettings, setEmap1AuroraSettings] = useState(defaultEmap1AuroraSettings);
  const [emap1AuroraCalibration, setEmap1AuroraCalibration] = useState(EMAP1_AURORA_DEFAULT_CALIBRATION);
  const [emap1AuroraState, setEmap1AuroraState] = useState({
    loading: false,
    error: '',
    summary: null,
    items: []
  });
  const projectFiles = useMemo(() => deriveProjectFiles(project), [project]);
  const projectCloudItems = useMemo(() => project?.cloudData?.items || [], [project?.cloudData?.items]);
  const projectFilesByPath = useMemo(() => {
    const map = new Map();
    (projectFiles || []).forEach((file) => {
      const path = buildProjectItemPath(file, projectCloudItems);
      if (path) map.set(path, file);
      if (file?.name) map.set(String(file.name), file);
    });
    return map;
  }, [projectCloudItems, projectFiles]);
  const emap1CalibrationCandidates = useMemo(() => (
    projectFiles.filter((item) => item?.type === 'file' && isEmap1CalibrationFile(item?.name))
  ), [projectFiles]);
  const suggestedEmap1Calibration = useMemo(
    () => autoMatchEmap1Calibration(emap1CalibrationCandidates),
    [emap1CalibrationCandidates]
  );
  const projectTasks = useMemo(() => deriveProjectTasks(project), [project]);
  const spatialEntries = useMemo(() => getSpatialEntries(project), [project]);
  const spatialEntriesWithData = useMemo(() => (
    normalizeF3MatchedPathsBySerial(spatialEntries.map((entry) => {
      const matchedDataPaths = Array.isArray(entry?.matchedDataPaths)
        ? entry.matchedDataPaths.filter(Boolean)
        : [];
      const matchedDataCount = Number(entry?.matchedDataCount || matchedDataPaths.length || 0);
      const hasExistingData = Boolean(entry?.hasExistingData || matchedDataCount > 0 || matchedDataPaths.length > 0);
      return {
        ...entry,
        matchedDataPaths,
        matchedDataCount,
        hasExistingData
      };
    }))
  ), [spatialEntries]);
  const coordinateTableRows = useMemo(() => {
    const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    const getSortValue = (entry) => {
      if (coordinateSort.key === 'instrument') return entry.instrument || project?.plan?.instrumentModel || project?.method || '';
      if (coordinateSort.key === 'lng') return Number(entry.lng);
      if (coordinateSort.key === 'lat') return Number(entry.lat);
      if (coordinateSort.key === 'z') return Number(entry.z);
      if (coordinateSort.key === 'source') return entry.coordSource || entry.source || '项目数据';
      if (coordinateSort.key === 'files') return (entry.matchedDataPaths || []).map(getDisplayFileName).join(' ');
      return entry[coordinateSort.key] || '';
    };
    const compareValues = (a, b) => {
      const aValue = getSortValue(a);
      const bValue = getSortValue(b);
      const aNumber = typeof aValue === 'number' ? aValue : Number.NaN;
      const bNumber = typeof bValue === 'number' ? bValue : Number.NaN;
      if (Number.isFinite(aNumber) || Number.isFinite(bNumber)) {
        if (!Number.isFinite(aNumber)) return 1;
        if (!Number.isFinite(bNumber)) return -1;
        return aNumber - bNumber;
      }
      return collator.compare(String(aValue || ''), String(bValue || ''));
    };
    return [...spatialEntriesWithData].sort((a, b) => {
      const primaryCompare = compareValues(a, b);
      if (primaryCompare !== 0) return coordinateSort.direction === 'asc' ? primaryCompare : -primaryCompare;
      const lineCompare = collator.compare(String(a.line || ''), String(b.line || ''));
      if (lineCompare !== 0) return lineCompare;
      return collator.compare(String(a.point || ''), String(b.point || ''));
    });
  }, [coordinateSort.direction, coordinateSort.key, project?.method, project?.plan?.instrumentModel, spatialEntriesWithData]);
  const selectedSpatialEntry = spatialEntriesWithData.find(entry => entry.id === selectedSpatialEntryId) || spatialEntriesWithData[0] || null;
  const firstSpatialEntryId = spatialEntries[0]?.id || '';
  const activeLineProfileSourceEntries = useMemo(() => {
    const targetLineKey = String(lineProfileModal.lineKey || '').trim();
    const targetInstrumentType = normalizeOverviewInstrumentType(lineProfileModal.instrumentName);
    if (!targetLineKey) return [];
    return spatialEntriesWithData
      .filter((entry) => {
        const sameLine = String(entry.line || '').trim() === targetLineKey;
        if (!sameLine) return false;
        if (normalizeOverviewInstrumentType(entry.instrument) === 'ert' && isGeneratedRes2dinvStitchEntry(entry)) return false;
        if (!targetInstrumentType) return true;
        return normalizeOverviewInstrumentType(entry.instrument) === targetInstrumentType;
      })
      .sort((a, b) => String(a.point || '').localeCompare(String(b.point || ''), 'zh-Hans-CN', { numeric: true }));
  }, [lineProfileModal.instrumentName, lineProfileModal.lineKey, spatialEntriesWithData]);
  const activeLineProfileInstrumentType = useMemo(() => {
    const firstEntry = activeLineProfileSourceEntries[0] || null;
    return normalizeOverviewInstrumentType(lineProfileModal.instrumentName || firstEntry?.instrument || project?.plan?.instrumentModel || project?.method);
  }, [activeLineProfileSourceEntries, lineProfileModal.instrumentName, project?.method, project?.plan?.instrumentModel]);
  const isActiveLineProfileErt = activeLineProfileInstrumentType === 'ert';
  const activeLineProfileStitchKey = useMemo(() => [
    String(lineProfileModal.lineKey || '').trim(),
    activeLineProfileInstrumentType
  ].join('__'), [activeLineProfileInstrumentType, lineProfileModal.lineKey]);
  const activeLineProfileArrayOptions = useMemo(() => (
    activeLineProfileSourceEntries.map((entry, index) => ({
      id: entry.id,
      label: String(entry.point || `排列 ${index + 1}`).trim(),
      entry
    }))
  ), [activeLineProfileSourceEntries]);
  const selectedLineProfileArrayIdSet = useMemo(() => {
    const validIds = new Set(activeLineProfileArrayOptions.map((item) => item.id));
    const storedIds = Array.isArray(lineProfileStitchSelection[activeLineProfileStitchKey])
      ? lineProfileStitchSelection[activeLineProfileStitchKey].filter((id) => validIds.has(id))
      : [];
    const selectedIds = storedIds.length
      ? [
          ...storedIds,
          ...activeLineProfileArrayOptions.map((item) => item.id).filter((id) => !storedIds.includes(id))
        ]
      : activeLineProfileArrayOptions.map((item) => item.id);
    return new Set(selectedIds);
  }, [activeLineProfileArrayOptions, activeLineProfileStitchKey, lineProfileStitchSelection]);
  const activeLineProfileOrderedArrayOptions = useMemo(() => {
    const validOptions = new Map(activeLineProfileArrayOptions.map((item) => [item.id, item]));
    const storedIds = Array.isArray(lineProfileStitchSelection[activeLineProfileStitchKey])
      ? lineProfileStitchSelection[activeLineProfileStitchKey].filter((id) => validOptions.has(id))
      : [];
    const orderedIds = storedIds.length
      ? [...storedIds, ...activeLineProfileArrayOptions.map((item) => item.id).filter((id) => !storedIds.includes(id))]
      : activeLineProfileArrayOptions.map((item) => item.id);
    return orderedIds.map((id) => validOptions.get(id)).filter(Boolean);
  }, [activeLineProfileArrayOptions, activeLineProfileStitchKey, lineProfileStitchSelection]);
  const activeLineProfileEntries = activeLineProfileSourceEntries;
  const activeLineProfileCanStitch = isActiveLineProfileErt && activeLineProfileArrayOptions.length > 1;
  const activeLineProfileStitchConfig = lineProfileStitchParams[activeLineProfileStitchKey] || {};
  const activeLineProfileStitchOutputPath = getDisplayFileName(activeLineProfileStitchConfig.outputPath) || `${lineProfileModal.lineKey || 'line'}_拼接.DAT`;
  const activeLineProfileStitchOverlapMode = activeLineProfileStitchConfig.overlapMode || 'previous';
  const activeLineProfileArrangementLengthMap = useMemo(
    () => lineProfileArrangementLengths[activeLineProfileStitchKey] || {},
    [activeLineProfileStitchKey, lineProfileArrangementLengths]
  );
  const activeLineProfileLatestStitchedItem = useMemo(() => {
    const outputName = normalizeDriveFileName(activeLineProfileStitchOutputPath);
    if (!outputName) return null;
    const matchesOutputName = (item) => {
      const itemName = normalizeDriveFileName(item?.name);
      const itemOutputName = normalizeDriveFileName(item?.outputPath);
      return itemName === outputName || itemOutputName === outputName;
    };
    if (isRes2dinvStitchDatItem(lineProfileSavedCommandItem) && matchesOutputName(lineProfileSavedCommandItem)) {
      return lineProfileSavedCommandItem;
    }
    const matchingItems = (projectCloudItems || [])
      .filter(isRes2dinvStitchDatItem)
      .filter(matchesOutputName);
    return matchingItems.length ? matchingItems[matchingItems.length - 1] : null;
  }, [activeLineProfileStitchOutputPath, lineProfileSavedCommandItem, projectCloudItems]);
  const activeLineProfileStitchRows = useMemo(() => {
    let cumulativeX = 0;
    const previousRows = Array.isArray(activeLineProfileLatestStitchedItem?.stitchRows)
      ? activeLineProfileLatestStitchedItem.stitchRows
      : [];
    const previousRowsByEntryId = new Map(previousRows
      .filter((row) => row?.entryId)
      .map((row) => [row.entryId, row]));
    const hasCurrentRowParams = Boolean(activeLineProfileStitchConfig.items);
    return activeLineProfileOrderedArrayOptions
      .filter(({ entry }) => selectedLineProfileArrayIdSet.has(entry.id))
      .map(({ entry }) => {
      const stored = hasCurrentRowParams
        ? (activeLineProfileStitchConfig.items?.[entry.id] || {})
        : (previousRowsByEntryId.get(entry.id) || {});
      const matchedDataPath = (entry.matchedDataPaths || []).filter(Boolean)[0] || '';
      if (stored.xLocation !== undefined && stored.xLocation !== '') {
        const manualX = Number(stored.xLocation);
        if (Number.isFinite(manualX)) cumulativeX = manualX;
      }
      const length = Number(activeLineProfileArrangementLengthMap[entry.id]);
      const row = {
        entry,
        dataPath: stored.dataPath || matchedDataPath,
        xLocation: Number(cumulativeX.toFixed(2)),
        endX: Number.isFinite(length) && length > 0 ? Number((cumulativeX + length).toFixed(2)) : null,
        length: Number.isFinite(length) && length > 0 ? length : null,
        lineSign: stored.lineSign ?? '0'
      };
      if (Number.isFinite(length) && length > 0) cumulativeX += length;
      return row;
      });
  }, [activeLineProfileArrangementLengthMap, activeLineProfileLatestStitchedItem, activeLineProfileOrderedArrayOptions, activeLineProfileStitchConfig.items, selectedLineProfileArrayIdSet]);
  const activeLineProfileStitchCommand = useMemo(() => buildRes2dinvConcatenateCommand({
    rows: activeLineProfileStitchRows,
    outputPath: activeLineProfileStitchOutputPath
  }), [activeLineProfileStitchOutputPath, activeLineProfileStitchRows]);
  const activeLineProfileStitchReady = isActiveLineProfileErt
    && activeLineProfileStitchRows.length > 1
    && activeLineProfileStitchRows.every((row) => row.dataPath)
    && activeLineProfileStitchRows.every((row) => Number.isFinite(Number(row.length)) && Number(row.length) > 0);
  const activeLineProfileMeta = useMemo(() => {
    const firstEntry = activeLineProfileEntries[0] || null;
    const matchedCount = activeLineProfileEntries.filter((entry) => entry.hasExistingData).length;
    return {
      pointCount: activeLineProfileEntries.length,
      matchedCount,
      instrumentName: lineProfileModal.instrumentName || firstEntry?.instrument || project?.plan?.instrumentModel || project?.method || '未标注方法',
      startPoint: activeLineProfileEntries[0]?.point || '--',
      endPoint: activeLineProfileEntries[activeLineProfileEntries.length - 1]?.point || '--',
      sourcePointCount: activeLineProfileSourceEntries.length
    };
  }, [activeLineProfileEntries, activeLineProfileSourceEntries.length, lineProfileModal.instrumentName, project?.method, project?.plan?.instrumentModel]);
  const activeLineProfileFallbackChartOption = useMemo(() => (
    buildLineProfileChartOption(activeLineProfileEntries, activeLineProfileMeta.instrumentName)
  ), [activeLineProfileEntries, activeLineProfileMeta.instrumentName]);
  const activeLineProfileChartOption = lineProfileDataChartState.option || activeLineProfileFallbackChartOption;
  const activeLineProfileSubtitleText = useMemo(() => {
    const base = `测线 ${lineProfileModal.lineKey || '--'} · ${activeLineProfileMeta.instrumentName}`;
    if (!isActiveLineProfileErt) return base;
    const details = [];
    const profileLength = Number(lineProfileDataChartState.metrics?.profileLength);
    const dataPointCount = Number(lineProfileDataChartState.metrics?.dataPointCount);
    if (Number.isFinite(profileLength)) {
      details.push(`剖面长度 ${formatLengthMeters(profileLength)}`);
    } else if (lineProfileDataChartState.loading) {
      details.push('剖面长度 解析中...');
    }
    if (Number.isFinite(dataPointCount)) {
      details.push(`数据点数 ${dataPointCount.toLocaleString()} 点`);
    } else if (lineProfileDataChartState.loading) {
      details.push('数据点数 解析中...');
    }
    return details.length ? `${base} · ${details.join(' · ')}` : base;
  }, [
    activeLineProfileMeta.instrumentName,
    isActiveLineProfileErt,
    lineProfileDataChartState.loading,
    lineProfileDataChartState.metrics?.dataPointCount,
    lineProfileDataChartState.metrics?.profileLength,
    lineProfileModal.lineKey
  ]);
  useEffect(() => {
    let cancelled = false;
    if (!lineProfileModal.open || !isActiveLineProfileErt) {
      setLineProfileDataChartState({ loading: false, option: null, metrics: null });
      return () => { cancelled = true; };
    }

    const loadLineProfileDataChart = async () => {
      setLineProfileDataChartState((prev) => ({ ...prev, loading: true, metrics: null }));
      try {
        if (activeLineProfileLatestStitchedItem) {
          const latestFile = await resolveDriveFileContent(
            activeLineProfileLatestStitchedItem,
            activeLineProfileLatestStitchedItem?.name || activeLineProfileStitchOutputPath || 'stitched.dat'
          );
          if (latestFile) {
            const previewText = await latestFile.text();
            const parsedMetrics = getRes2dinvPreviewMetrics(previewText);
            const stitchRowsProfileLength = getRes2dinvStitchRowsProfileLength(activeLineProfileStitchRows);
            const metrics = stitchRowsProfileLength
              ? { ...parsedMetrics, profileLength: stitchRowsProfileLength }
              : parsedMetrics;
            const option = buildRes2dinvDataChartOption({
              text: previewText,
              title: `二维剖面图 · ${activeLineProfileMeta.instrumentName}`,
              subtitle: `最新拼接数据 · ${activeLineProfileLatestStitchedItem.name || activeLineProfileStitchOutputPath || 'DAT'}`
            });
            if (option) {
              if (!cancelled) setLineProfileDataChartState({ loading: false, option, metrics });
              return;
            }
          }
        }

        const rows = activeLineProfileStitchRows.filter((row) => row?.dataPath);
        if (!rows.length) {
          setLineProfileDataChartState({ loading: false, option: null, metrics: null });
          return;
        }
        const rowsWithFiles = rows.map((row) => ({
          ...row,
          fileItem: projectFilesByPath.get(row.dataPath) || projectFilesByPath.get(getDisplayFileName(row.dataPath))
        }));
        if (rowsWithFiles.some((row) => !row.fileItem)) {
          throw new Error('未找到排列数据文件。');
        }

        let previewText = '';
        let subtitle = '';
        if (rowsWithFiles.length === 1) {
          const row = rowsWithFiles[0];
          const file = await resolveDriveFileContent(row.fileItem, row.fileItem?.name || row.dataPath || 'source.dat');
          if (!file) throw new Error('无法读取排列数据文件。');
          previewText = await file.text();
          subtitle = `单排列数据 · ${row.fileItem?.name || getDisplayFileName(row.dataPath) || 'DAT'}`;
        } else {
          if (!rowsWithFiles.every((row) => Number.isFinite(Number(row.length)) && Number(row.length) > 0)) {
            setLineProfileDataChartState({ loading: false, option: null, metrics: null });
            return;
          }
          const sources = await Promise.all(rowsWithFiles.map(async (row) => {
            const file = await resolveDriveFileContent(row.fileItem, row.fileItem?.name || row.dataPath || 'source.dat');
            if (!file) throw new Error(`无法读取排列数据文件：${row.dataPath || row.fileItem?.name || '--'}`);
            return { row, text: await file.text() };
          }));
          previewText = buildStitchedRes2dinvDat({
            sources,
            rows: rowsWithFiles,
            outputName: activeLineProfileStitchOutputPath,
            overlapMode: activeLineProfileStitchOverlapMode
          });
          subtitle = `合成数据 · ${rowsWithFiles.length} 个排列`;
        }

        const parsedMetrics = getRes2dinvPreviewMetrics(previewText);
        const stitchRowsProfileLength = getRes2dinvStitchRowsProfileLength(rowsWithFiles);
        const metrics = stitchRowsProfileLength
          ? { ...parsedMetrics, profileLength: stitchRowsProfileLength }
          : parsedMetrics;
        const option = buildRes2dinvDataChartOption({
          text: previewText,
          title: `二维剖面图 · ${activeLineProfileMeta.instrumentName}`,
          subtitle
        });
        if (!option) throw new Error('未解析出可显示的高密度数据。');
        if (!cancelled) setLineProfileDataChartState({ loading: false, option, metrics });
      } catch (error) {
        console.warn('Failed to build ERT line profile preview chart.', error);
        if (!cancelled) setLineProfileDataChartState({ loading: false, option: null, metrics: null });
      }
    };

    void loadLineProfileDataChart();
    return () => { cancelled = true; };
  }, [activeLineProfileLatestStitchedItem, activeLineProfileMeta.instrumentName, activeLineProfileStitchOutputPath, activeLineProfileStitchOverlapMode, activeLineProfileStitchRows, isActiveLineProfileErt, lineProfileModal.open, projectFilesByPath]);

  const isActiveLineProfileEmap1 = useMemo(
    () => normalizeOverviewInstrumentType(activeLineProfileMeta.instrumentName) === 'emap',
    [activeLineProfileMeta.instrumentName]
  );
  const emap1LineRequiredChannels = useMemo(() => {
    const requestedMode = String(emap1AuroraSettings.mode || 'scalar_xy').trim().toLowerCase();
    if (requestedMode === 'scalar_yx') return ['ey', 'hx'];
    if (requestedMode === 'scalar_both' || requestedMode === 'tensor') return ['ex', 'ey', 'hx', 'hy'];
    return ['ex', 'hy'];
  }, [emap1AuroraSettings.mode]);
  const showLineExCalibration = emap1LineRequiredChannels.includes('ex');
  const showLineEyCalibration = emap1LineRequiredChannels.includes('ey');
  const showLineHxCalibration = emap1LineRequiredChannels.includes('hx');
  const showLineHyCalibration = emap1LineRequiredChannels.includes('hy');
  const matchedSpatialEntryCount = useMemo(() => spatialEntriesWithData.filter((entry) => entry.hasExistingData).length, [spatialEntriesWithData]);
  useEffect(() => {
    setEmap1AuroraCalibration((prev) => {
      const next = {
        exChannelResponseId: prev.exChannelResponseId || suggestedEmap1Calibration.exChannelResponseId || '',
        exSensorResponseId: prev.exSensorResponseId || suggestedEmap1Calibration.exSensorResponseId || '',
        eyChannelResponseId: prev.eyChannelResponseId || suggestedEmap1Calibration.eyChannelResponseId || '',
        eySensorResponseId: prev.eySensorResponseId || suggestedEmap1Calibration.eySensorResponseId || '',
        hxChannelResponseId: prev.hxChannelResponseId || suggestedEmap1Calibration.hxChannelResponseId || '',
        hxSensorResponseId: prev.hxSensorResponseId || suggestedEmap1Calibration.hxSensorResponseId || '',
        hyChannelResponseId: prev.hyChannelResponseId || suggestedEmap1Calibration.hyChannelResponseId || '',
        hySensorResponseId: prev.hySensorResponseId || suggestedEmap1Calibration.hySensorResponseId || ''
      };
      return Object.keys(next).every((key) => next[key] === prev[key]) ? prev : next;
    });
  }, [suggestedEmap1Calibration]);

  useEffect(() => {
    setCoordinateImportParams({
      ...defaultCoordinateImportParams,
      ...(project?.plan?.coordParams || {})
    });
    setCoordinateImportFile(null);
    if (coordinateImportInputRef.current) coordinateImportInputRef.current.value = '';
  }, [project?.id, project?.plan?.coordParams]);

  const overviewMetrics = useMemo(() => {
    const totalSize = projectFiles.reduce((sum, file) => sum + parseFileSizeToMb(file.size), 0).toFixed(1);
    const syncedCount = projectFiles.length;
    const areaCount = Array.isArray(project?.areaCoords) && project.areaCoords.length >= 3 ? 1 : 0;
    const importedLineCount = new Set(
      (spatialEntries || []).map((entry) => `${String(entry.line || '').trim()}__${normalizeOverviewInstrumentType(entry.instrument)}`)
    ).size;
    const lineCount = importedLineCount || Number(project.plan?.plannedLines) || 0;
    const pointCount = spatialEntries.length || Number(project.plan?.plannedPoints) || 0;
    return {
      totalSize,
      syncedCount,
      areaCount,
      lineCount,
      pointCount
    };
  }, [projectFiles, project?.areaCoords, project?.plan, spatialEntries]);

  const overviewCards = [
    { label: '测线数量', value: `${overviewMetrics.lineCount} 条`, icon: RadioTower, color: '#7c3aed', bg: '#f5f3ff' },
    { label: '测点数量', value: `${overviewMetrics.pointCount} 个`, icon: Database, color: '#0f766e', bg: '#ecfeff' },
    { label: '数据总量', value: `${overviewMetrics.totalSize} MB`, icon: HardDrive, color: '#ea580c', bg: '#fff7ed' },
    { label: '同步文件', value: `${overviewMetrics.syncedCount} 个`, icon: ShieldCheck, color: '#2563eb', bg: '#eff6ff' }
  ];



  const currentProjectRole = resolveCurrentProjectRole(project, currentUser);
  const currentProjectMember = resolveCurrentProjectMember(project, currentUser);
  const canManageMembers = currentProjectRole === 'owner';
  const canEditTask = Boolean(PROJECT_ROLE_PERMISSION_MATRIX[currentProjectRole]?.editTask);
  const canEditPlanning = Boolean(PROJECT_ROLE_PERMISSION_MATRIX[currentProjectRole]?.editPlanning);
  const activeMembers = useMemo(() => {
    const explicitMembers = (project.projectMembers || []).filter(member => member.status !== 'pending');
    const shouldSurfaceCurrentUser =
      !currentProjectMember &&
      currentUser?.id &&
      (
        !project?.projectMembers?.length ||
        canManageProjectDatabase(project, currentUser)
      );

    if (!shouldSurfaceCurrentUser) {
      return explicitMembers;
    }

    return [
      {
        id: `implicit_member_${currentUser.id}`,
        userId: currentUser.id,
        name: currentUser.name || currentUser.account || currentUser.id,
        account: currentUser.account || '',
        email: currentUser.email || '',
        projectRole: currentProjectRole || 'viewer',
        status: 'active',
        joinedAt: '',
        invitedAt: '',
        invitedBy: '',
        implicitAccess: true
      },
      ...explicitMembers
    ];
  }, [currentProjectMember, currentProjectRole, currentUser, project]);
  const activeOwnerCount = activeMembers.filter(member => member.projectRole === 'owner').length;
  const projectInvitations = useMemo(() => project.projectInvitations || [], [project.projectInvitations]);
  const filteredMembers = useMemo(() => activeMembers.filter((member) => {
    const matchesSearch = !memberSearchTerm.trim() || [member.name, member.account, member.email, member.phone, member.userId].some(value => String(value || '').toLowerCase().includes(memberSearchTerm.trim().toLowerCase()));
    const matchesRole = memberRoleFilter === 'all' || member.projectRole === memberRoleFilter;
    return matchesSearch && matchesRole;
  }), [activeMembers, memberRoleFilter, memberSearchTerm]);
  const memberRoleStats = useMemo(() => Object.keys(projectRoleMetaMap).map((roleKey) => ({
    roleKey,
    count: activeMembers.filter(member => member.projectRole === roleKey).length
  })), [activeMembers]);

  const invitationStats = useMemo(() => ({
    pending: projectInvitations.filter(item => item.status === 'pending' || item.status === 'sent').length,
    accepted: projectInvitations.filter(item => item.status === 'accepted').length,
    rejected: projectInvitations.filter(item => item.status === 'rejected').length,
    expired: projectInvitations.filter(item => item.status === 'expired').length,
    revoked: projectInvitations.filter(item => item.status === 'revoked').length
  }), [projectInvitations]);

  const persistProjectUpdate = useCallback(async (nextProject, { onError } = {}) => {
    if (!onUpdateProject) return null;
    try {
      return await onUpdateProject(nextProject);
    } catch (error) {
      if (typeof onError === 'function') {
        onError(error);
      } else {
        console.warn('Project update failed inside ProjectDetail.', error);
      }
      return null;
    }
  }, [onUpdateProject]);

  const updateCoordinateImportParam = (field, value) => {
    setCoordinateImportParams((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const handleCoordinateImportFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    if (!file) return;
    if (!/\.(xlsx|xls)$/i.test(file.name || '')) {
      msg.warn('请选择 Excel 坐标文件（.xlsx 或 .xls）。');
      event.target.value = '';
      return;
    }
    setCoordinateImportFile(file);
  };

  const closeCoordinateImportDialog = () => {
    if (coordinateImportBusy) return;
    setShowCoordinateImportDialog(false);
    setCoordinateImportFile(null);
    if (coordinateImportInputRef.current) coordinateImportInputRef.current.value = '';
  };

  const handleCoordinateSort = (key) => {
    setCoordinateSort((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const handleImportCoordinates = async () => {
    if (!canEditPlanning || !onUpdateProject) {
      msg.warn('当前账号没有导入坐标的权限。');
      return;
    }
    if (!coordinateImportFile) {
      msg.warn('请先选择要导入的 Excel 坐标文件。');
      return;
    }

    const currentEntries = Array.isArray(project?.plan?.designEntries) ? project.plan.designEntries : [];
    if (!currentEntries.length) {
      msg.warn('当前项目还没有可匹配的测线测点，请先生成或导入测点列表。');
      return;
    }

    setCoordinateImportBusy(true);
    try {
      const XLSX = await loadXlsx();
      const buffer = await coordinateImportFile.arrayBuffer();
      const workbook = XLSX.read(buffer);
      const sheetName = workbook.SheetNames?.[0];
      const worksheet = sheetName ? workbook.Sheets[sheetName] : null;
      const rawRows = worksheet ? XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' }) : [];
      const importedRows = parseCoordinateImportRows(rawRows);
      if (!importedRows.length) {
        msg.warn('未识别到有效坐标行。Excel 至少需要包含：测线、测点、X/经度、Y/纬度。');
        return;
      }

      let projectToWgs84 = null;
      if (coordinateImportParams.coordType === 'CGCS2000') {
        const proj4 = await loadProj4();
        const sourceProjection = `+proj=tmerc +lat_0=${Number(coordinateImportParams.latOrigin) || 0} +lon_0=${Number(coordinateImportParams.centralMeridian) || 102} +k=${Number(coordinateImportParams.scale) || 1} +x_0=${Number(coordinateImportParams.falseEasting) || 500000} +y_0=${Number(coordinateImportParams.falseNorthing) || 0} +ellps=GRS80 +units=m +no_defs`;
        projectToWgs84 = (x, y) => proj4(sourceProjection, 'WGS84', [Number(x), Number(y)]);
      }

      const coordinateRowsByKey = new Map();
      let invalidCoordinateCount = 0;
      importedRows.forEach((row) => {
        let lon = Number.NaN;
        let lat = Number.NaN;
        if (coordinateImportParams.coordType === 'CGCS2000') {
          if (Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y))) {
            const [nextLon, nextLat] = projectToWgs84(Number(row.x), Number(row.y));
            lon = nextLon;
            lat = nextLat;
          }
        } else {
          lon = parseLonLat(row.x, coordinateImportParams.lonlatFormat);
          lat = parseLonLat(row.y, coordinateImportParams.lonlatFormat);
        }

        if (!Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat))) {
          invalidCoordinateCount += 1;
          return;
        }

        coordinateRowsByKey.set(buildCoordinateMatchKey(row.line, row.point), {
          ...row,
          lon: Number(lon),
          lat: Number(lat),
          z: String(row.z ?? '').trim()
        });
      });

      let matchedCount = 0;
      const nextEntries = currentEntries.map((entry) => {
        const matched = coordinateRowsByKey.get(buildCoordinateMatchKey(entry.line, entry.point));
        if (!matched) return entry;
        matchedCount += 1;
        const nextEntry = {
          ...entry,
          x: String(matched.x ?? '').trim(),
          y: String(matched.y ?? '').trim(),
          gpsLongitude: Number(matched.lon.toFixed(6)),
          gpsLatitude: Number(matched.lat.toFixed(6)),
          coordSource: '导入坐标',
          source: entry.source || '导入坐标'
        };
        if (matched.z !== '') nextEntry.z = Number.isFinite(Number(matched.z)) ? Number(matched.z) : matched.z;
        if (matched.instrument && !nextEntry.instrument) nextEntry.instrument = matched.instrument;
        return nextEntry;
      });

      if (!matchedCount) {
        msg.warn('Excel 中的测线/测点号没有匹配到当前项目测点。');
        return;
      }

      const nextProject = updateProjectWithPlan(project, {
        designEntries: nextEntries,
        coordParamsConfigured: true,
        coordParams: coordinateImportParams
      }, { actor: currentUser });
      const savedProject = await persistProjectUpdate(nextProject, {
        onError: (error) => msg.warn(`导入坐标失败：${error?.message || '未知错误'}`)
      });
      if (!savedProject) return;

      setSelectedSpatialEntryId('');
      setSelectedSpatialLineKey('');
      setShowCoordinateImportDialog(false);
      setCoordinateImportFile(null);
      if (coordinateImportInputRef.current) coordinateImportInputRef.current.value = '';
      msg.success(`已按测线/测点号更新 ${matchedCount} 个测点坐标${invalidCoordinateCount ? `，跳过 ${invalidCoordinateCount} 行无效坐标` : ''}。`);
    } catch (error) {
      console.warn('Failed to import coordinates from Excel.', error);
      msg.warn(`导入坐标失败：${error?.message || '请检查 Excel 文件格式和坐标参数'}`);
    } finally {
      setCoordinateImportBusy(false);
    }
  };

  useEffect(() => {
    if (editingMemberUserId && !activeMembers.some(member => member.userId === editingMemberUserId)) {
      setEditingMemberUserId('');
    }
  }, [activeMembers, editingMemberUserId]);

  useEffect(() => {
    const pendingLineProfileOpen = pendingSelection
      && pendingSelection.projectId === project?.id
      && pendingSelection.openLineProfile
      && String(pendingSelection.lineKey || '').trim();
    if (pendingLineProfileOpen) return undefined;

    setLineProfileModal((prev) => (
      prev.open || prev.lineKey || prev.instrumentName
        ? { open: false, lineKey: '', instrumentName: '' }
        : prev
    ));
    setLineProfileMaximized((prev) => (prev ? false : prev));
    setLineProfileChartModalOpen((prev) => (prev ? false : prev));
    setLineProfileChartMaximized((prev) => (prev ? false : prev));
    setShowLineProfileInversionSettings((prev) => (prev ? false : prev));
    setEmap1AuroraState((prev) => (
      prev.loading || prev.error || prev.summary || prev.items.length
        ? { loading: false, error: '', summary: null, items: [] }
        : prev
    ));
  }, [project?.id]);

  useEffect(() => {
    setEmap1AuroraState({ loading: false, error: '', summary: null, items: [] });
  }, [lineProfileModal.lineKey, lineProfileModal.instrumentName]);

  useEffect(() => {
    setSelectedSpatialEntryId((prev) => (prev === firstSpatialEntryId ? prev : firstSpatialEntryId));
    setSelectedSpatialLineKey((prev) => (prev ? '' : prev));
    setSelectedDataEntryId((prev) => (prev ? '' : prev));
    setSelectedDataLineKey((prev) => (prev ? '' : prev));
  }, [firstSpatialEntryId, project?.id]);

  useEffect(() => {
    if (!pendingSelection || pendingSelection.projectId !== project?.id) return;

    const nextTab = pendingSelection.activeTab || 'overview';
    const nextPointId = pendingSelection.pointId || '';
    const nextLineKey = String(pendingSelection.lineKey || '').trim();
    const nextInstrumentName = String(pendingSelection.instrumentName || '').trim();
    const fromSidebarTree = pendingSelection.source === 'sidebar-tree';
    const shouldOpenParser = Boolean(pendingSelection.openParser && nextPointId);
    const shouldOpenLineProfile = Boolean(pendingSelection.openLineProfile && nextLineKey);

    if (fromSidebarTree) {
      if (shouldOpenParser) {
        setActiveTab('data');
      } else if (!shouldOpenLineProfile) {
        setActiveTab('overview');
      }
      if (nextLineKey) {
        setSelectedDataLineKey(nextLineKey);
      } else {
        setSelectedDataLineKey('');
      }
      if (nextPointId) {
        setSelectedDataEntryId(nextPointId);
      } else {
        setSelectedDataEntryId('');
      }
      if (nextLineKey) {
        setSelectedSpatialLineKey(nextLineKey);
      }
      if (nextPointId) {
        setSelectedSpatialEntryId(nextPointId);
      } else if (nextLineKey) {
        const firstEntry = spatialEntries.find(entry => String(entry.line || '').trim() === nextLineKey);
        if (firstEntry) setSelectedSpatialEntryId(firstEntry.id);
      }
      if (shouldOpenParser) {
        setDataAutoOpenRequest({
          pointId: nextPointId,
          stamp: `${project?.id || 'project'}:${nextPointId}:${autoOpenStampRef.current++}`
        });
      }
      if (shouldOpenLineProfile) {
        setLineProfileModal((prev) => {
          if (
            prev.open &&
            String(prev.lineKey || '').trim() === nextLineKey &&
            String(prev.instrumentName || '').trim() === nextInstrumentName
          ) {
            return prev;
          }
          return {
            open: true,
            lineKey: nextLineKey,
            instrumentName: nextInstrumentName
          };
        });
      }
      clearPendingSelection?.();
      return;
    }

    setActiveTab(nextTab);
    if (nextTab === 'data') {
      if (nextLineKey) {
        setSelectedDataLineKey(nextLineKey);
      }
      if (nextPointId) {
        setSelectedDataEntryId(nextPointId);
      } else if (nextLineKey) {
        const firstEntry = spatialEntries.find(entry => String(entry.line || '').trim() === nextLineKey);
        if (firstEntry) setSelectedDataEntryId(firstEntry.id);
      }
      if (shouldOpenParser) {
        setDataAutoOpenRequest({
          pointId: nextPointId,
          stamp: `${project?.id || 'project'}:${nextPointId}:${autoOpenStampRef.current++}`
        });
      }
    } else {
      if (nextLineKey) {
        setSelectedSpatialLineKey(nextLineKey);
      }
      if (nextPointId) {
        setSelectedSpatialEntryId(nextPointId);
      } else if (nextLineKey) {
        const firstEntry = spatialEntries.find(entry => String(entry.line || '').trim() === nextLineKey);
        if (firstEntry) setSelectedSpatialEntryId(firstEntry.id);
      }
    }
    clearPendingSelection?.();
  }, [clearPendingSelection, pendingSelection, project?.id, spatialEntries]);

  const handleSelectSpatialEntry = (entryId) => {
    const matchedEntry = spatialEntries.find(entry => entry.id === entryId);
    setSelectedSpatialEntryId(entryId);
    if (matchedEntry) {
      setSelectedSpatialLineKey(String(matchedEntry.line || '').trim());
    }
  };

  const handleOpenSpatialEntryData = (entryId) => {
    const matchedEntry = spatialEntries.find(entry => entry.id === entryId);
    handleSelectSpatialEntry(entryId);
    handleSelectDataEntry(entryId);
    if (matchedEntry) {
      setSelectedDataLineKey(String(matchedEntry.line || '').trim());
    }
    setActiveTab('data');
    setDataAutoOpenRequest({
      pointId: entryId,
      stamp: `${project?.id || 'project'}:${entryId}:${autoOpenStampRef.current++}`
    });
  };

  const handleSelectSpatialLine = (lineKey) => {
    const normalizedLineKey = String(lineKey || '').trim();
    setSelectedSpatialLineKey(normalizedLineKey);
    const firstEntry = spatialEntries.find(entry => String(entry.line || '').trim() === normalizedLineKey);
    if (firstEntry) {
      setSelectedSpatialEntryId(firstEntry.id);
    }
  };

  const handleSelectDataEntry = (entryId) => {
    const matchedEntry = spatialEntries.find(entry => entry.id === entryId);
    setSelectedDataEntryId(entryId);
    if (matchedEntry) {
      setSelectedDataLineKey(String(matchedEntry.line || '').trim());
    }
  };

  const handleSelectDataLine = (lineKey) => {
    const normalizedLineKey = String(lineKey || '').trim();
    setSelectedDataLineKey(normalizedLineKey);
    const firstEntry = spatialEntries.find(entry => String(entry.line || '').trim() === normalizedLineKey);
    if (firstEntry) {
      setSelectedDataEntryId(firstEntry.id);
    }
  };

  const handleLocateFromTree = (entryId, targetTab = 'overview') => {
    handleSelectSpatialEntry(entryId);
    setActiveTab(targetTab);
  };

  const handleLocateLineFromTree = (lineKey, targetTab = 'overview') => {
    handleSelectSpatialLine(lineKey);
    setActiveTab(targetTab);
  };

  const handleOpenLineProfile = ({ lineKey, instrumentName = '' } = {}) => {
    const normalizedLineKey = String(lineKey || '').trim();
    if (!normalizedLineKey) return;
    handleSelectSpatialLine(normalizedLineKey);
    setSelectedDataLineKey(normalizedLineKey);
    setLineProfileModal({
      open: true,
      lineKey: normalizedLineKey,
      instrumentName: String(instrumentName || '').trim()
    });
  };

  const updateLineProfileStitchSelection = useCallback((ids = []) => {
    setLineProfileStitchSelection((prev) => ({
      ...prev,
      [activeLineProfileStitchKey]: ids
    }));
  }, [activeLineProfileStitchKey]);

  const toggleLineProfileArraySelection = useCallback((entryId) => {
    setLineProfileStitchSelection((prev) => {
      const validIds = activeLineProfileArrayOptions.map((item) => item.id);
      const currentIds = Array.isArray(prev[activeLineProfileStitchKey])
        ? prev[activeLineProfileStitchKey].filter((id) => validIds.includes(id))
        : validIds;
      const nextIds = currentIds.includes(entryId)
        ? currentIds.filter((id) => id !== entryId)
        : [...currentIds, entryId];
      return {
        ...prev,
        [activeLineProfileStitchKey]: nextIds
      };
    });
  }, [activeLineProfileArrayOptions, activeLineProfileStitchKey]);

  const moveLineProfileArrayOrder = useCallback((entryId, direction) => {
    setLineProfileStitchSelection((prev) => {
      const validIds = activeLineProfileArrayOptions.map((item) => item.id);
      const currentIds = Array.isArray(prev[activeLineProfileStitchKey])
        ? [
            ...prev[activeLineProfileStitchKey].filter((id) => validIds.includes(id)),
            ...validIds.filter((id) => !prev[activeLineProfileStitchKey].includes(id))
          ]
        : validIds;
      const fromIndex = currentIds.indexOf(entryId);
      const toIndex = fromIndex + direction;
      if (fromIndex < 0 || toIndex < 0 || toIndex >= currentIds.length) return prev;
      const nextIds = [...currentIds];
      const [movedId] = nextIds.splice(fromIndex, 1);
      nextIds.splice(toIndex, 0, movedId);
      return {
        ...prev,
        [activeLineProfileStitchKey]: nextIds
      };
    });
  }, [activeLineProfileArrayOptions, activeLineProfileStitchKey]);

  const updateLineProfileStitchOutputPath = useCallback((outputPath) => {
    setLineProfileStitchParams((prev) => ({
      ...prev,
      [activeLineProfileStitchKey]: {
        ...(prev[activeLineProfileStitchKey] || {}),
        outputPath
      }
    }));
  }, [activeLineProfileStitchKey]);

  const updateLineProfileStitchOverlapMode = useCallback((overlapMode) => {
    setLineProfileStitchParams((prev) => ({
      ...prev,
      [activeLineProfileStitchKey]: {
        ...(prev[activeLineProfileStitchKey] || {}),
        overlapMode
      }
    }));
  }, [activeLineProfileStitchKey]);

  const updateLineProfileStitchRow = useCallback((entryId, key, value) => {
    setLineProfileStitchParams((prev) => {
      const currentConfig = prev[activeLineProfileStitchKey] || {};
      const currentItems = currentConfig.items || {};
      return {
        ...prev,
        [activeLineProfileStitchKey]: {
          ...currentConfig,
          items: {
            ...currentItems,
            [entryId]: {
              ...(currentItems[entryId] || {}),
              [key]: value
            }
          }
        }
      };
    });
  }, [activeLineProfileStitchKey]);

  const handleGenerateLineProfileStitchCommand = useCallback(async () => {
    if (!activeLineProfileStitchReady || lineProfileCommandSaving) return;
    const rowsWithFiles = activeLineProfileStitchRows.map((row) => ({
      ...row,
      fileItem: projectFilesByPath.get(row.dataPath) || projectFilesByPath.get(getDisplayFileName(row.dataPath))
    }));
    const missingFile = rowsWithFiles.find((row) => !row.fileItem);
    if (missingFile) {
      msg.error(`未找到源数据文件：${missingFile.dataPath || '--'}`);
      return;
    }
    const firstDataFile = rowsWithFiles.find((row) => row.fileItem)?.fileItem;
    const fallbackFolder = projectCloudItems.find((item) => item.type === 'folder' && (item.category === 'processed' || item.category === 'raw'));
    const parentId = firstDataFile?.parentId || fallbackFolder?.id || null;
    const outputFileName = getDisplayFileName(activeLineProfileStitchOutputPath) || `${lineProfileModal.lineKey || 'line'}_拼接.DAT`;
    const fileName = sanitizeDriveFileName(/\.(dat)$/i.test(outputFileName) ? outputFileName : `${outputFileName}.DAT`, 'RES2DINV_拼接.DAT');
    const commandText = buildRes2dinvConcatenateCommand({
      rows: rowsWithFiles,
      outputPath: fileName
    });
    const commandBaseName = fileName.replace(/\.[^.]+$/, '') || 'RES2DINV_拼接';
    const commandFileName = sanitizeDriveFileName(`${commandBaseName}_CONCATENATE.txt`, 'CONCATENATE.txt');
    const fileId = (projectCloudItems || []).find((item) => (
      item?.type === 'file'
      && (item.parentId || null) === (parentId || null)
      && String(item.name || '').trim().toLowerCase() === fileName.toLowerCase()
    ))?.id || `fid_res2dinv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const commandFileId = (projectCloudItems || []).find((item) => (
      item?.type === 'file'
      && (item.parentId || null) === (parentId || null)
      && String(item.name || '').trim().toLowerCase() === commandFileName.toLowerCase()
    ))?.id || `fid_res2dinv_cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const nowDate = new Date().toISOString().split('T')[0];

    setLineProfileCommandSaving(true);
    try {
      if (!commandText) {
        throw new Error('无法生成 RES2DINV 拼接命令文件。');
      }
      const sources = await Promise.all(rowsWithFiles.map(async (row) => {
        const file = await resolveDriveFileContent(row.fileItem, row.fileItem?.name || row.dataPath || 'source.dat');
        if (!file) throw new Error(`无法读取源数据文件：${row.dataPath || row.fileItem?.name || '--'}`);
        return {
          row,
          text: await file.text()
        };
      }));
      const stitchedDatText = buildStitchedRes2dinvDat({
        sources,
        rows: rowsWithFiles,
        outputName: fileName,
        overlapMode: activeLineProfileStitchOverlapMode
      });
      const stitchRows = rowsWithFiles.map((row) => ({
        entryId: row.entry?.id || '',
        dataPath: row.dataPath || '',
        xLocation: Number.isFinite(Number(row.xLocation)) ? Number(row.xLocation) : '',
        endX: Number.isFinite(Number(row.endX)) ? Number(row.endX) : '',
        length: Number.isFinite(Number(row.length)) ? Number(row.length) : '',
        lineSign: row.lineSign ?? '0'
      }));
      const blob = new Blob([stitchedDatText], { type: 'text/plain;charset=utf-8' });
      const commandBlob = new Blob([commandText], { type: 'text/plain;charset=utf-8' });
      const stitchedItem = {
      id: fileId,
      parentId,
      type: 'file',
      name: fileName,
      date: nowDate,
      size: formatTextSizeBytes(blob.size),
      fileSizeBytes: blob.size,
      ext: 'code',
      category: firstDataFile?.category || fallbackFolder?.category || 'processed',
      taskName: firstDataFile?.taskName || fallbackFolder?.taskName || null,
      instrumentType: 'ert',
      instrumentLabel: '高密度电法',
      status: '已生成',
      storage_provider: 'indexeddb',
      storageProvider: 'indexeddb',
      persisted_blob_id: fileId,
      persistedBlobId: fileId,
      inlineTextContent: stitchedDatText,
      inlineMimeType: 'text/plain;charset=utf-8',
      generatedBy: 'res2dinv-stitch-dat',
      outputPath: fileName,
      overlapMode: activeLineProfileStitchOverlapMode,
      stitchKey: activeLineProfileStitchKey,
      stitchRows
      };
      const commandItem = {
      id: commandFileId,
      parentId,
      type: 'file',
      name: commandFileName,
      date: nowDate,
      size: formatTextSizeBytes(commandBlob.size),
      fileSizeBytes: commandBlob.size,
      ext: 'code',
      category: firstDataFile?.category || fallbackFolder?.category || 'processed',
      taskName: firstDataFile?.taskName || fallbackFolder?.taskName || null,
      instrumentType: 'ert',
      instrumentLabel: '高密度电法',
      status: '已生成',
      storage_provider: 'indexeddb',
      storageProvider: 'indexeddb',
      persisted_blob_id: commandFileId,
      persistedBlobId: commandFileId,
      inlineTextContent: commandText,
      inlineMimeType: 'text/plain;charset=utf-8',
      generatedBy: 'res2dinv-stitch-command',
      outputPath: commandFileName,
      relatedOutputFileId: fileId,
      relatedOutputFileName: fileName,
      stitchKey: activeLineProfileStitchKey,
      stitchRows
      };

      try {
        await Promise.all([
          saveFileBlob({
            id: fileId,
            name: fileName,
            type: 'text/plain;charset=utf-8',
            blob
          }),
          saveFileBlob({
            id: commandFileId,
            name: commandFileName,
            type: 'text/plain;charset=utf-8',
            blob: commandBlob
          })
        ]);
      } catch (saveError) {
        console.warn('saveFileBlob failed for stitched RES2DINV files.', saveError);
      }
      const generatedItemsById = new Map([
        [fileId, stitchedItem],
        [commandFileId, commandItem]
      ]);
      const nextItems = (projectCloudItems || []).map((item) => {
        const generatedItem = generatedItemsById.get(item.id);
        if (!generatedItem) return item;
        generatedItemsById.delete(item.id);
        return { ...item, ...generatedItem };
      });
      nextItems.push(...generatedItemsById.values());
      const nextProject = updateProjectWithCloudItems(project, nextItems, {
        log: true,
        title: 'RES2DINV 拼接文件已生成',
        detail: `已在云盘保存“${fileName}”和“${commandFileName}”。`,
        nodeId: 'storage',
        nodeName: '成果入库节点',
        level: 'info',
        actor: currentUser
      });
      const savedProject = await persistProjectUpdate(nextProject, {
        onError: (error) => msg.error(`拼接文件保存失败：${error?.message || '未知错误'}`)
      });
      if (!savedProject) return;
      setLineProfileStitchParams((prev) => ({
        ...prev,
        [activeLineProfileStitchKey]: {
          ...(prev[activeLineProfileStitchKey] || {}),
          outputPath: fileName,
          overlapMode: activeLineProfileStitchOverlapMode,
          items: stitchRows.reduce((acc, row) => {
            if (!row.entryId) return acc;
            acc[row.entryId] = {
              ...(prev[activeLineProfileStitchKey]?.items?.[row.entryId] || {}),
              dataPath: row.dataPath,
              xLocation: row.xLocation,
              lineSign: row.lineSign
            };
            return acc;
          }, {})
        }
      }));
      setLineProfileSavedCommandItem(stitchedItem);
      msg.success(`拼接 DAT 和命令文件已保存到项目云盘：${fileName}、${commandFileName}`);
    } catch (error) {
      console.warn('Failed to save stitched RES2DINV DAT to drive.', error);
      msg.error(`拼接文件保存失败：${error?.message || '未知错误'}`);
    } finally {
      setLineProfileCommandSaving(false);
    }
  }, [activeLineProfileStitchKey, activeLineProfileStitchOutputPath, activeLineProfileStitchOverlapMode, activeLineProfileStitchReady, activeLineProfileStitchRows, currentUser, lineProfileCommandSaving, lineProfileModal.lineKey, persistProjectUpdate, project, projectCloudItems, projectFilesByPath]);

  useEffect(() => {
    setLineProfileSavedCommandItem(null);
  }, [activeLineProfileStitchCommand, activeLineProfileStitchOverlapMode]);

  useEffect(() => {
    if ((!lineProfileModal.open && !lineProfileStitchDialogOpen) || !activeLineProfileCanStitch) return undefined;
    let cancelled = false;
    const loadArrangementLengths = async () => {
      const nextLengths = {};
      await Promise.all(activeLineProfileArrayOptions.map(async ({ entry }) => {
        const dataPath = (entry.matchedDataPaths || []).filter(Boolean)[0] || '';
        const file = projectFilesByPath.get(dataPath);
        if (!file) return;
        const rawFile = await resolveDriveFileContent(file, file?.name || 'data.dat').catch(() => null);
        if (!(rawFile instanceof File)) return;
        const text = await rawFile.text().catch(() => '');
        const length = parseRes2dinvArrangementLength(text);
        if (Number.isFinite(length) && length > 0) {
          nextLengths[entry.id] = length;
        }
      }));
      if (!cancelled) {
        setLineProfileArrangementLengths((prev) => ({
          ...prev,
          [activeLineProfileStitchKey]: nextLengths
        }));
      }
    };
    loadArrangementLengths();
    return () => {
      cancelled = true;
    };
  }, [activeLineProfileArrayOptions, activeLineProfileCanStitch, activeLineProfileStitchKey, lineProfileModal.open, lineProfileStitchDialogOpen, projectFilesByPath]);

  const resolveEmap1PointFileItems = useCallback((entry) => {
    const storedPaths = Array.isArray(entry?.matchedDataPaths) ? entry.matchedDataPaths.filter(Boolean) : [];
    const storedFiles = storedPaths
      .map((path) => projectFilesByPath.get(path))
      .filter((file) => file?.type === 'file' && /\.mtts$/i.test(String(file?.name || '').trim()));
    if (storedFiles.length) return storedFiles;
    return (projectFiles || []).filter((file) => (
      file?.type === 'file'
      && /\.mtts$/i.test(String(file?.name || '').trim())
      && parseOverviewMttsPointNo(file.name) === String(entry?.point || '').trim()
    ));
  }, [projectFiles, projectFilesByPath]);

  const resolveAdminTextFile = useCallback(async (file) => {
    const rawFile = await resolveDriveFileContent(file, file?.name || 'data.txt').catch(() => null);
    if (!(rawFile instanceof File)) return '';
    return rawFile.text();
  }, []);

  const buildSelectedEmap1Calibration = useCallback(async () => {
    const candidateMap = new Map(
      emap1CalibrationCandidates.map((item) => [String(getEmap1CalibrationCandidateId(item)), item])
    );

    const buildSource = async (channelResponseId, sensorResponseId) => {
      const channelFile = candidateMap.get(String(channelResponseId || ''));
      const sensorFile = candidateMap.get(String(sensorResponseId || ''));
      if (!channelFile || !sensorFile) return null;
      const [channelText, sensorText] = await Promise.all([
        resolveAdminTextFile(channelFile),
        resolveAdminTextFile(sensorFile)
      ]);
      if (!channelText || !sensorText) return null;
      return {
        channel_response_text: channelText,
        sensor_response_text: sensorText,
        channel_response_name: channelFile.name,
        sensor_response_name: sensorFile.name
      };
    };

    const ex = emap1LineRequiredChannels.includes('ex')
      ? await buildSource(
        emap1AuroraCalibration.exChannelResponseId,
        emap1AuroraCalibration.exSensorResponseId
      )
      : null;
    const ey = emap1LineRequiredChannels.includes('ey')
      ? await buildSource(
        emap1AuroraCalibration.eyChannelResponseId,
        emap1AuroraCalibration.eySensorResponseId
      )
      : null;
    const hx = emap1LineRequiredChannels.includes('hx')
      ? await buildSource(
        emap1AuroraCalibration.hxChannelResponseId,
        emap1AuroraCalibration.hxSensorResponseId
      )
      : null;
    const hy = emap1LineRequiredChannels.includes('hy')
      ? await buildSource(
        emap1AuroraCalibration.hyChannelResponseId,
        emap1AuroraCalibration.hySensorResponseId
      )
      : null;

    const calibration = {
      ...(ex ? { ex } : {}),
      ...(ey ? { ey } : {}),
      ...(hx ? { hx } : {}),
      ...(hy ? { hy } : {})
    };
    return Object.keys(calibration).length ? calibration : undefined;
  }, [emap1AuroraCalibration, emap1CalibrationCandidates, emap1LineRequiredChannels, resolveAdminTextFile]);

  const handleAutoMatchEmap1Calibration = useCallback(() => {
    setEmap1AuroraCalibration(autoMatchEmap1Calibration(emap1CalibrationCandidates));
  }, [emap1CalibrationCandidates]);

  const buildEmap1AuroraPayloadForEntry = useCallback(async (entry) => {
    const pointFiles = resolveEmap1PointFileItems(entry);
    if (!pointFiles.length) {
      throw new Error('未找到可用的 MTTS 数据文件');
    }

    const groupedByTag = new Map();
    for (const file of pointFiles) {
      const meta = parseOverviewMttsMeta(file.name);
      if (!meta?.channel) continue;
      const tagKey = meta.sampleRateTag || '--';
      if (!groupedByTag.has(tagKey)) {
        groupedByTag.set(tagKey, {
          sampleRateTag: tagKey,
          files: {}
        });
      }
      const group = groupedByTag.get(tagKey);
      group.files[meta.channel] = file;
    }

    const requestedMode = String(emap1AuroraSettings.mode || 'scalar_xy').trim().toLowerCase();
    const requiredChannels = requestedMode === 'scalar_yx'
      ? ['ey', 'hx']
      : requestedMode === 'scalar_both' || requestedMode === 'tensor'
        ? ['ex', 'ey', 'hx', 'hy']
        : ['ex', 'hy'];

    const preferredGroups = Array.from(groupedByTag.values()).sort((a, b) => {
      const preference = String(emap1AuroraSettings.sampleRatePreference || 'auto').toUpperCase();
      const scoreTag = (tag) => {
        if (preference === 'HIGH' || preference === '38400H') {
          if (tag === '38400H') return 10;
        }
        if (preference === 'LOW' || preference === '1200L') {
          if (tag === '1200L') return 10;
        }
        if (tag === '38400H') return 6;
        if (tag === '1200L') return 5;
        return 0;
      };
      return scoreTag(b.sampleRateTag) - scoreTag(a.sampleRateTag);
    });

    let selectedGroup = null;
    for (const group of preferredGroups) {
      if (requiredChannels.every((channelName) => group.files[channelName])) {
        selectedGroup = group;
        break;
      }
    }
    if (!selectedGroup) {
      throw new Error(`所选点缺少计算所需通道：${requiredChannels.join(', ').toUpperCase()}`);
    }

    const channelSeries = {};
    const channelMeta = {};
    let baseLength = 0;
    let samplingRateHz = 0;
    const { parseMTTSFile } = await loadEh4Io();
    for (const channelName of requiredChannels) {
      const file = selectedGroup.files[channelName];
      const rawFile = await resolveDriveFileContent(file, file?.name || 'data.bin').catch(() => null);
      if (!(rawFile instanceof File)) {
        throw new Error(`无法读取 ${file?.name || channelName} 文件内容`);
      }
      const blocks = parseMTTSFile(await rawFile.arrayBuffer(), rawFile.name);
      const block = Array.isArray(blocks) ? blocks[0] : null;
      const values = Array.isArray(block?.data?.[0]) ? block.data[0].map(Number) : [];
      if (!values.length) {
        throw new Error(`${rawFile.name} 未解析出有效样本`);
      }
      channelSeries[channelName] = values;
      channelMeta[channelName] = {
        dipoleLength: Number(block?.header?.dipoleLength || 0)
      };
      baseLength = baseLength || values.length;
      samplingRateHz = samplingRateHz || Number(block?.header?.sampleRate || 0);
    }

    const zeroSeries = new Array(baseLength).fill(0);
    const channels = {
      ex: { values: channelSeries.ex || zeroSeries, unit: 'mV' },
      ey: { values: channelSeries.ey || zeroSeries, unit: 'mV' },
      hx: { values: channelSeries.hx || zeroSeries },
      hy: { values: channelSeries.hy || zeroSeries }
    };

    const resolvedDipoleExM = Number(channelMeta.ex?.dipoleLength || 0)
      || Number(emap1AuroraSettings.dipoleExM || 1);
    const resolvedDipoleEyM = Number(channelMeta.ey?.dipoleLength || 0)
      || Number(emap1AuroraSettings.dipoleEyM || 1);

    const calibration = await buildSelectedEmap1Calibration();

    return {
      sampling_rate_hz: samplingRateHz,
      mode: requestedMode,
      nfft: Number(emap1AuroraSettings.nfft || 4096),
      overlap: Number(emap1AuroraSettings.overlap || 0.5),
      window: emap1AuroraSettings.window || 'hann',
      huber_threshold: Number(emap1AuroraSettings.huberThreshold || 1.5),
      max_iter: Number(emap1AuroraSettings.maxIter || 20),
      tolerance: Number(emap1AuroraSettings.tolerance || 1e-4),
      dipole_ex_m: resolvedDipoleExM,
      dipole_ey_m: resolvedDipoleEyM,
      use_remote_reference: false,
      return_rows: true,
      ...(calibration ? { calibration } : {}),
      channels,
      _meta: {
        sampleRateTag: selectedGroup.sampleRateTag,
        requiredChannels,
        dipoleExM: resolvedDipoleExM,
        dipoleEyM: resolvedDipoleEyM,
        calibratedChannels: Object.keys(calibration || {}).map((name) => name.toUpperCase())
      }
    };
  }, [buildSelectedEmap1Calibration, emap1AuroraSettings, resolveEmap1PointFileItems]);

  const handleRunEmap1Aurora = useCallback(async () => {
    if (!isActiveLineProfileEmap1) return;
    setEmap1AuroraState({
      loading: true,
      error: '',
      summary: null,
      items: []
    });

    const results = [];
    for (const entry of activeLineProfileEntries) {
      try {
        const payload = await buildEmap1AuroraPayloadForEntry(entry);
        const response = await processAdminEmap1(payload, currentUser);
        const rows = Array.isArray(response?.rows) ? response.rows : [];
        const targetFrequencyHz = Number(emap1AuroraSettings.targetFrequencyHz || 10);
        const targetRow = rows.length
          ? rows.reduce((best, row) => {
            if (!best) return row;
            return Math.abs(Number(row?.freq_hz || 0) - targetFrequencyHz) < Math.abs(Number(best?.freq_hz || 0) - targetFrequencyHz) ? row : best;
          }, null)
          : null;
        const targetValue = payload.mode === 'scalar_yx'
          ? Number(targetRow?.rho_yx)
          : payload.mode === 'scalar_both'
            ? Number.isFinite(Number(targetRow?.rho_xy)) && Number.isFinite(Number(targetRow?.rho_yx))
              ? (Number(targetRow.rho_xy) + Number(targetRow.rho_yx)) / 2
              : Number(targetRow?.rho_xy || targetRow?.rho_yx)
            : Number(targetRow?.rho_xy);

        results.push({
          pointId: entry.id,
          point: entry.point,
          status: 'processed',
          sampleRateTag: payload._meta.sampleRateTag,
          frequencyCount: Number(response?.summary?.frequency_count || rows.length || 0),
          targetFrequencyHz: Number(targetRow?.freq_hz || targetFrequencyHz),
          targetValue: Number.isFinite(targetValue) ? targetValue : null,
          mode: payload.mode,
          message: ''
        });
      } catch (error) {
        results.push({
          pointId: entry.id,
          point: entry.point,
          status: 'failed',
          sampleRateTag: '',
          frequencyCount: 0,
          targetFrequencyHz: Number(emap1AuroraSettings.targetFrequencyHz || 10),
          targetValue: null,
          mode: String(emap1AuroraSettings.mode || 'scalar_xy'),
          message: error instanceof Error ? error.message : 'Aurora 计算失败'
        });
      }
    }

    const processedCount = results.filter((item) => item.status === 'processed').length;
    const failedCount = results.length - processedCount;
    setEmap1AuroraState({
      loading: false,
      error: '',
      summary: {
        total: results.length,
        processedCount,
        failedCount
      },
      items: results
    });
  }, [activeLineProfileEntries, buildEmap1AuroraPayloadForEntry, currentUser, emap1AuroraSettings.mode, emap1AuroraSettings.targetFrequencyHz, isActiveLineProfileEmap1]);

  const pushFeedback = (type, text) => setMemberFeedback({ type, text });

  const handleCreateInvitations = (event) => {
    event.preventDefault();
    if (!canManageMembers) return;
    const contacts = parseBulkInviteInput(inviteInput);
    if (!contacts.length) {
      pushFeedback('warning', '请先输入至少一个邀请对象，再创建项目协作邀请。');
      return;
    }
    const result = createInvitationRecords({
      contacts,
      project,
      users,
      actor: currentUser,
      channel: externalInviteChannel,
      existingInvitations: projectInvitations,
      existingMembers: activeMembers
    });
    if (result.code === 400) {
      pushFeedback('error', result.message || '创建邀请失败，请检查输入内容后重试。');
      return;
    }
    const nextInvitations = [...projectInvitations, ...result.created];
    if (result.created.length) {
      void persistProjectUpdate(updateProjectWithInvitations(project, nextInvitations, {
        actor: currentUser,
        logTitle: '创建项目邀请',
        logDetail: `新增 ${result.created.length} 条项目协作邀请。`
      }), {
        onError: (error) => pushFeedback('error', error?.message || '创建邀请后保存失败。')
      });
      setInviteInput('');
    }
    const messages = [];
    if (result.created.length) messages.push(`已创建 ${result.created.length} 条邀请。`);
    if (result.duplicates?.length) messages.push(`${result.duplicates.length} 个对象已存在邀请，已跳过。`);
    if (result.invalid?.length) messages.push(`${result.invalid.length} 个联系方式格式无效。`);
    if (result.rateLimited?.length) messages.push(`${result.rateLimited.length} 个手机号发送过于频繁。`);
    if (result.notifiedRegistered?.length) messages.push(`${result.notifiedRegistered.length} 个已注册用户将收到站内邀请。`);
    pushFeedback(result.created.length ? 'success' : 'warning', messages.join(' ') || '没有新增邀请。');
  };


  const handleResendInvitation = (invitationId) => {
    if (!canManageMembers) return;
    const { nextInvitations, error } = resendInvitationRecord({
      invitations: projectInvitations,
      invitationId,
      users,
      actor: currentUser
    });
    if (error === 'rate_limited') {
      pushFeedback('error', '发送过于频繁，请稍后再试。');
      return;
    }
    if (error === 'not_found') {
      pushFeedback('warning', '未找到对应邀请记录。');
      return;
    }
    void persistProjectUpdate(updateProjectWithInvitations(project, nextInvitations, {
      actor: currentUser,
      logTitle: '重发项目邀请',
      logDetail: '重新发送了 1 条项目协作邀请。'
    }), {
      onError: (error) => pushFeedback('error', error?.message || '重发邀请后保存失败。')
    });
    pushFeedback('success', '邀请已重新发送。');
  };

  const handleMemberRoleChange = (userId, nextRole) => {
    if (!canManageMembers) return;
    const target = activeMembers.find(member => member.userId === userId);
    if (!target || target.implicitAccess) return;
    if (target.projectRole === 'owner' && nextRole !== 'owner' && activeOwnerCount <= 1) {
      pushFeedback('warning', '至少需要保留一位项目负责人。');
      return;
    }
    const nextMembers = (project.projectMembers || []).map(member => member.userId === userId ? { ...member, projectRole: nextRole } : member);
    void persistProjectUpdate(updateProjectWithMembers(project, nextMembers, { actor: currentUser }), {
      onError: (error) => pushFeedback('error', error?.message || '更新成员角色失败。')
    });
    setEditingMemberUserId('');
    pushFeedback('success', '成员角色已更新。');
  };

  const handleMemberRemove = (userId) => {
    if (!canManageMembers) return;
    const target = activeMembers.find(member => member.userId === userId);
    if (!target || target.implicitAccess) return;
    if (target?.projectRole === 'owner' && activeOwnerCount <= 1) {
      pushFeedback('warning', '至少需要保留一位项目负责人。');
      return;
    }
    const nextMembers = (project.projectMembers || []).filter(member => member.userId !== userId);
    void persistProjectUpdate(updateProjectWithMembers(project, nextMembers, { actor: currentUser }), {
      onError: (error) => pushFeedback('error', error?.message || '移除项目成员失败。')
    });
    pushFeedback('success', '成员已移除。');
  };

  const handleRevokeInvitation = (invitationId) => {
    if (!canManageMembers) return;
    const nextInvitations = revokeInvitationRecord({
      invitations: projectInvitations,
      invitationId,
      users,
      actor: currentUser
    });
    void persistProjectUpdate(updateProjectWithInvitations(project, nextInvitations, {
      actor: currentUser,
      logTitle: '撤销项目邀请',
      logDetail: '撤销 1 条项目协作邀请。'
    }), {
      onError: (error) => pushFeedback('error', error?.message || '撤销邀请后保存失败。')
    });
    pushFeedback('success', '邀请已撤销。');
  };

  return (
    <div className="dashboard-container" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
        <button 
          onClick={onBack}
          style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--surface-bg)', border: '1px solid var(--border-color)', padding: '6px 12px', borderRadius: '8px', cursor: 'pointer', color: 'var(--text-primary)' }}
        >
          <ChevronLeft size={18} /> 返回项目
        </button>
        <h2 style={{ margin: 0 }}>{project.name} <span className="text-muted text-sm font-normal">({project.id})</span></h2>
        <span style={{ padding: '4px 8px', backgroundColor: '#eef2ff', color: '#4f46e5', borderRadius: '4px', fontSize: '0.75rem', fontWeight: '600' }}>
          {project.status}
        </span>
      </div>

      {(!canEditTask || !canEditPlanning) && (
        <div className="card glass" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', padding: '14px 18px', marginBottom: '20px', border: '1px solid #fde68a', background: '#fffbeb' }}>
          <div style={{ fontSize: '13px', color: '#92400e', fontWeight: 600 }}>
            当前账号缺少部分编辑权限，项目概览中的坐标参数与成员协作功能可能受限。
          </div>
          <div style={{ fontSize: '12px', color: '#b45309' }}>
            请联系项目负责人或系统管理员获取更高权限。
          </div>
        </div>
      )}
      <div className="card glass" style={{ display: 'flex', gap: '32px', padding: '20px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span className="text-xs text-muted">负责人</span>
          <span className="text-sm font-medium">{project.manager}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span className="text-xs text-muted">勘探方法</span>
          <span className="text-sm font-medium">{project.method}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span className="text-xs text-muted">测区位置</span>
          <span className="text-sm font-medium">{project.location}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
          <span className="text-xs text-muted">最近更新</span>
          <span className="text-sm font-medium">{project.lastUpdate}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
          <button
            onClick={() => setShowMemberSettings(true)}
            style={{ border: '1px solid #bfdbfe', background: '#eff6ff', color: '#2563eb', borderRadius: '10px', padding: '10px 14px', cursor: 'pointer', fontWeight: 700 }}
          >
            成员与权限设置
          </button>
        </div>
      </div>



      <div style={{ flex: 1, overflowY: 'auto' }}>
        {(
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 'calc(100vh - 320px)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '12px' }}>
              {overviewCards.map(card => (
                <div key={card.label} className="card glass" style={{ padding: '10px 14px', minHeight: '58px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ width: '34px', height: '34px', borderRadius: '10px', background: card.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <card.icon size={18} color={card.color} />
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{card.label}</div>
                    <div style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px' }}>{card.value}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="card glass" style={{ padding: '20px', display: 'grid', gap: '14px', minHeight: '520px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                  <h3 className="text-sm" style={{ margin: 0 }}>测区空间概览</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <button
                    type="button"
                    onClick={() => setShowCoordinateTableDialog(true)}
                    disabled={!coordinateTableRows.length}
                    style={{
                      border: '1px solid #dbeafe',
                      background: '#fff',
                      color: '#2563eb',
                      borderRadius: '10px',
                      padding: '8px 12px',
                      cursor: coordinateTableRows.length ? 'pointer' : 'not-allowed',
                      fontWeight: 700,
                      opacity: coordinateTableRows.length ? 1 : 0.45,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    <Eye size={15} /> 查看坐标
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCoordinateImportDialog(true)}
                    disabled={!canEditPlanning}
                    style={{
                      border: '1px solid #bfdbfe',
                      background: '#eff6ff',
                      color: '#2563eb',
                      borderRadius: '10px',
                      padding: '8px 12px',
                      cursor: canEditPlanning ? 'pointer' : 'not-allowed',
                      fontWeight: 700,
                      opacity: canEditPlanning ? 1 : 0.45,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    <UploadCloud size={15} /> 导入坐标
                  </button>
                  <MapPin size={18} color="#64748b" />
                </div>
                </div>
              <div style={{ fontSize: '12px', color: '#64748b', lineHeight: '1.7' }}>
                {spatialEntriesWithData.length
                  ? `当前地图展示的是项目数据库中 ${spatialEntriesWithData.length} 个测点，其中 ${matchedSpatialEntryCount} 个测点已写入对应数据文件路径。点击地图测点可联动定位。`
                  : '当前项目数据库中还没有可用于地图展示的测线测点。请在云盘“2_野外采集”下创建对应仪器文件夹并上传数据，系统会自动生成测线测点。'}
              </div>
              {!spatialEntriesWithData.length && (
                <div style={{ padding: '14px 16px', borderRadius: '12px', border: '1px solid #dbeafe', background: '#eff6ff', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ fontSize: '13px', color: '#1d4ed8', fontWeight: 700 }}>项目数据库暂无测线测点</div>
                  <div style={{ fontSize: '12px', color: '#475569', lineHeight: 1.7 }}>
                    当前项目概览页只读取项目数据库里的测线测点。请在云盘“2_野外采集”下按仪器建立目录并上传数据，系统会自动生成并更新到数据库。
                  </div>
                </div>
              )}
                <ProjectSpatialMap
                project={project}
                entries={spatialEntriesWithData}
                selectedEntryId={selectedSpatialEntry?.id || ''}
                selectedLineKey={selectedSpatialLineKey}
                onSelectEntry={handleOpenSpatialEntryData}
                onSelectLine={handleSelectSpatialLine}
                height="calc(100vh - 560px)"
              />
            </div>
          </div>
        )}
      </div>

      {showCoordinateTableDialog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div className="card glass" style={{ width: 'min(1080px, 100%)', maxHeight: '86vh', padding: '24px', display: 'grid', gridTemplateRows: 'auto auto minmax(0, 1fr) auto', gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '18px', fontWeight: 800, color: '#0f172a' }}>查看坐标</div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '6px', lineHeight: 1.7 }}>
                  当前项目数据库中的测线测点坐标。点击“定位”可在概览地图上选中对应测点。
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowCoordinateTableDialog(false)}
                style={{ width: '34px', height: '34px', borderRadius: '10px', border: '1px solid #dbe2ea', background: '#fff', color: '#475569', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px 14px', borderRadius: '12px', background: '#f8fafc', border: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '13px', color: '#0f172a', fontWeight: 800 }}>坐标总数：{coordinateTableRows.length} 个</div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>已匹配数据文件：{matchedSpatialEntryCount} 个</div>
            </div>

            <div style={{ overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '12px', background: '#fff' }}>
              {coordinateTableRows.length ? (
                <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, minWidth: '880px', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', color: '#475569' }}>
                      {[
                        { key: 'line', label: '测线' },
                        { key: 'point', label: '测点' },
                        { key: 'instrument', label: '仪器/方法' },
                        { key: 'lng', label: '经度' },
                        { key: 'lat', label: '纬度' },
                        { key: 'z', label: '高程' },
                        { key: 'source', label: '坐标来源' },
                        { key: 'files', label: '匹配文件' }
                      ].map((column) => {
                        const SortIcon = coordinateSort.key === column.key
                          ? (coordinateSort.direction === 'asc' ? ArrowUp : ArrowDown)
                          : ArrowUpDown;
                        return (
                          <th key={column.key} style={{ position: 'sticky', top: 0, zIndex: 1, padding: '0', textAlign: 'left', borderBottom: '1px solid #e2e8f0', fontWeight: 800, background: '#f8fafc', whiteSpace: 'nowrap' }}>
                            <button
                              type="button"
                              onClick={() => handleCoordinateSort(column.key)}
                              style={{ width: '100%', border: 'none', background: 'transparent', color: coordinateSort.key === column.key ? '#1d4ed8' : '#475569', padding: '11px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-start', gap: '6px', fontWeight: 800, fontSize: '12px' }}
                            >
                              <span>{column.label}</span>
                              <SortIcon size={13} />
                            </button>
                          </th>
                        );
                      })}
                      <th style={{ position: 'sticky', top: 0, zIndex: 1, padding: '11px 12px', textAlign: 'left', borderBottom: '1px solid #e2e8f0', fontWeight: 800, background: '#f8fafc', whiteSpace: 'nowrap' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coordinateTableRows.map((entry) => (
                      <tr key={entry.id} style={{ color: '#0f172a' }}>
                        <td style={{ padding: '11px 12px', borderBottom: '1px solid #f1f5f9', whiteSpace: 'nowrap' }}>{entry.line || '--'}</td>
                        <td style={{ padding: '11px 12px', borderBottom: '1px solid #f1f5f9', whiteSpace: 'nowrap', fontWeight: 800 }}>{entry.point || '--'}</td>
                        <td style={{ padding: '11px 12px', borderBottom: '1px solid #f1f5f9', whiteSpace: 'nowrap' }}>{entry.instrument || project?.plan?.instrumentModel || project?.method || '--'}</td>
                        <td style={{ padding: '11px 12px', borderBottom: '1px solid #f1f5f9', fontFamily: 'monospace' }}>{formatOverviewNumber(entry.lng, 6)}</td>
                        <td style={{ padding: '11px 12px', borderBottom: '1px solid #f1f5f9', fontFamily: 'monospace' }}>{formatOverviewNumber(entry.lat, 6)}</td>
                        <td style={{ padding: '11px 12px', borderBottom: '1px solid #f1f5f9', fontFamily: 'monospace' }}>{formatOverviewNumber(entry.z, 2)}</td>
                        <td style={{ padding: '11px 12px', borderBottom: '1px solid #f1f5f9', whiteSpace: 'nowrap' }}>{entry.coordSource || entry.source || '项目数据'}</td>
                        <td style={{ padding: '9px 12px', borderBottom: '1px solid #f1f5f9', minWidth: '180px', maxWidth: '260px' }}>
                          {entry.matchedDataPaths?.length ? (
                            <div style={{ display: 'grid', gap: '4px' }}>
                              {entry.matchedDataPaths.map((filePath, index) => (
                                <div
                                  key={`${entry.id}-matched-file-${index}`}
                                  title={String(filePath || '')}
                                  style={{ color: '#1d4ed8', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                >
                                  {getDisplayFileName(filePath)}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span style={{ color: '#94a3b8' }}>--</span>
                          )}
                        </td>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9', whiteSpace: 'nowrap' }}>
                          <button
                            type="button"
                            onClick={() => {
                              handleSelectSpatialEntry(entry.id);
                              setShowCoordinateTableDialog(false);
                            }}
                            style={{ border: '1px solid #bfdbfe', background: '#eff6ff', color: '#2563eb', borderRadius: '9px', padding: '7px 10px', cursor: 'pointer', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                          >
                            <MapPin size={13} /> 定位
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ padding: '32px', textAlign: 'center', color: '#64748b', fontSize: '13px' }}>当前项目暂无可查看的坐标</div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setShowCoordinateTableDialog(false)} style={{ border: '1px solid #dbe2ea', background: '#fff', color: '#475569', borderRadius: '10px', padding: '10px 16px', cursor: 'pointer', fontWeight: 700 }}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      <CoordinateImportModal
        isOpen={showCoordinateImportDialog}
        onClose={closeCoordinateImportDialog}
        onImport={handleImportCoordinates}
        file={coordinateImportFile}
        onFileChange={handleCoordinateImportFileChange}
        params={coordinateImportParams}
        onParamChange={updateCoordinateImportParam}
        isBusy={coordinateImportBusy}
      />

      {showMemberSettings && (
        <div className="member-settings-overlay">
          <div className="member-settings-shell card glass">
            <div className="member-settings-header">
              <div>
                <div className="member-settings-title">项目成员设置</div>
                <div className="member-settings-subtitle">
                  管理项目成员、角色权限和协作邀请。
                </div>
              </div>
              <button
                onClick={() => setShowMemberSettings(false)}
                style={{ background: 'rgba(255,255,255,0.74)', border: '1px solid rgba(255,255,255,0.6)', cursor: 'pointer', color: '#1e3a8a', width: '38px', height: '38px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={18} />
              </button>
            </div>
            <div className="member-settings-body">
              <div className="member-settings-topbar">
                <div className="member-settings-stat-grid">
                  <div className="member-stat-card">
                    <span className="member-stat-label">成员总数</span>
                    <span className="member-stat-value">{activeMembers.length}</span>
                  </div>
                  {memberRoleStats.filter(item => item.count > 0).map(item => {
                    const theme = projectRoleThemeMap[item.roleKey];
                    return (
                      <div key={item.roleKey} className="member-stat-card" style={{ background: theme.bg, borderColor: theme.border }}>
                        <span className="member-stat-label" style={{ color: theme.color }}>{projectRoleMetaMap[item.roleKey]?.label}</span>
                        <span className="member-stat-value" style={{ color: theme.color }}>{item.count}</span>
                      </div>
                    );
                  })}
                  <div className="member-stat-card" style={{ background: '#eefbf3', borderColor: '#bbf7d0' }}>
                    <span className="member-stat-label" style={{ color: '#15803d' }}>待处理邀请</span>
                    <span className="member-stat-value" style={{ color: '#15803d' }}>{invitationStats.pending}</span>
                  </div>
                  <div className="member-stat-card" style={{ background: '#f8fafc', borderColor: '#e2e8f0' }}>
                    <span className="member-stat-label" style={{ color: '#475569' }}>已接受 / 已拒绝</span>
                    <span className="member-stat-value" style={{ color: '#475569' }}>{invitationStats.accepted} / {invitationStats.rejected}</span>
                  </div>
                </div>
              </div>

              {memberFeedback.text && (
                <div style={{
                  padding: '10px 12px',
                  borderRadius: '10px',
                  border: memberFeedback.type === 'error' ? '1px solid #fecaca' : memberFeedback.type === 'success' ? '1px solid #bbf7d0' : '1px solid #fde68a',
                  background: memberFeedback.type === 'error' ? '#fef2f2' : memberFeedback.type === 'success' ? '#f0fdf4' : '#fffbeb',
                  color: memberFeedback.type === 'error' ? '#b91c1c' : memberFeedback.type === 'success' ? '#047857' : '#92400e',
                  fontSize: '12px',
                  fontWeight: 600
                }}>
                  {memberFeedback.text}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: '16px', alignItems: 'start' }}>
                <div className="member-panel card" style={{ padding: '16px', display: 'grid', gap: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div>
                      <div className="member-panel-title">当前成员</div>
                      <div className="member-panel-desc">只有项目负责人可以调整成员角色和移除成员。</div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <div style={{ position: 'relative' }}>
                        <Search size={15} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
                        <input
                          value={memberSearchTerm}
                          onChange={(event) => setMemberSearchTerm(event.target.value)}
                          placeholder="搜索成员"
                          style={{ width: '180px', padding: '9px 10px 9px 32px', border: '1px solid #dbe2ea', borderRadius: '10px', outline: 'none', fontSize: '12px' }}
                        />
                      </div>
                      <select
                        value={memberRoleFilter}
                        onChange={(event) => setMemberRoleFilter(event.target.value)}
                        style={{ padding: '9px 10px', border: '1px solid #dbe2ea', borderRadius: '10px', outline: 'none', fontSize: '12px', background: '#fff' }}
                      >
                        <option value="all">全部角色</option>
                        {Object.keys(projectRoleMetaMap).map((roleKey) => (
                          <option key={roleKey} value={roleKey}>{projectRoleMetaMap[roleKey].label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gap: '8px' }}>
                    {filteredMembers.length ? filteredMembers.map(member => {
                      const isLastOwner = member.projectRole === 'owner' && activeOwnerCount <= 1;
                      const canEditThisMember = canManageMembers && !member.implicitAccess;
                      const isEditing = editingMemberUserId === member.userId;
                      return (
                        <div key={member.userId} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) 180px 190px', gap: '12px', alignItems: 'center', padding: '12px 14px', border: isEditing ? '1px solid #bfdbfe' : '1px solid #e2e8f0', borderRadius: '12px', background: isEditing ? '#eff6ff' : '#fff' }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>{member.name || member.email || member.userId}</div>
                              {member.implicitAccess && (
                                <span style={{ fontSize: '11px', color: '#2563eb', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '999px', padding: '2px 8px', fontWeight: 600 }}>
                                  当前访问账号
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                              {member.email || member.account || member.userId}
                            </div>
                          </div>
                          <select
                            value={member.projectRole}
                            disabled={!canEditThisMember}
                            onFocus={() => setEditingMemberUserId(member.userId)}
                            onChange={(event) => handleMemberRoleChange(member.userId, event.target.value)}
                            style={{ padding: '9px 10px', border: '1px solid #dbe2ea', borderRadius: '10px', outline: 'none', fontSize: '12px', background: canEditThisMember ? '#fff' : '#f8fafc', color: canEditThisMember ? '#0f172a' : '#94a3b8' }}
                          >
                            {Object.keys(projectRoleMetaMap).map((roleKey) => (
                              <option key={roleKey} value={roleKey} disabled={isLastOwner && roleKey !== 'owner'}>
                                {projectRoleMetaMap[roleKey].label}
                              </option>
                            ))}
                          </select>
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', alignItems: 'center' }}>
                            <button
                              type="button"
                              onClick={() => setEditingMemberUserId(isEditing ? '' : member.userId)}
                              style={{ border: '1px solid #cbd5e1', background: '#fff', color: '#475569', borderRadius: '10px', padding: '8px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600 }}
                            >
                              <Pencil size={14} /> {isEditing ? '收起' : '详情'}
                            </button>
                            <button
                              type="button"
                              disabled={!canEditThisMember || isLastOwner}
                              onClick={() => handleMemberRemove(member.userId)}
                              style={{ border: '1px solid #fecaca', background: '#fff', color: '#b91c1c', borderRadius: '10px', padding: '8px 10px', cursor: canEditThisMember && !isLastOwner ? 'pointer' : 'not-allowed', opacity: canEditThisMember && !isLastOwner ? 1 : 0.45, display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600 }}
                            >
                              <Trash2 size={14} /> 移除
                            </button>
                          </div>
                          {isEditing && (
                            <div style={{ gridColumn: '1 / -1', fontSize: '12px', color: '#64748b', borderTop: '1px solid #dbeafe', paddingTop: '10px', lineHeight: 1.7 }}>
                              {projectRoleDescriptions[member.projectRole] || '查看项目内容。'}
                              {isLastOwner ? ' 当前成员是最后一位负责人，不能降级或移除。' : ''}
                            </div>
                          )}
                        </div>
                      );
                    }) : (
                      <div style={{ padding: '24px 14px', textAlign: 'center', color: '#94a3b8', border: '1px dashed #cbd5e1', borderRadius: '12px', fontSize: '13px' }}>
                        没有匹配的成员。
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ display: 'grid', gap: '12px' }}>
                  <div className="member-panel card" style={{ padding: '16px', display: 'grid', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <div>
                        <div className="member-panel-title">邀请成员</div>
                        <div className="member-panel-desc">新邀请默认加入为只读成员。</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowInvitePanel((value) => !value)}
                        style={{ border: '1px solid #cbd5e1', background: '#fff', color: '#475569', borderRadius: '10px', padding: '8px 10px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                      >
                        {showInvitePanel ? '收起' : '展开'}
                      </button>
                    </div>
                    {showInvitePanel && (
                      <form onSubmit={handleCreateInvitations} style={{ display: 'grid', gap: '10px' }}>
                        <textarea
                          value={inviteInput}
                          onChange={(event) => setInviteInput(event.target.value)}
                          disabled={!canManageMembers}
                          placeholder="输入邮箱或手机号，多个对象可换行或用逗号分隔"
                          rows={4}
                          style={{ width: '100%', resize: 'vertical', minHeight: '88px', padding: '10px 12px', border: '1px solid #dbe2ea', borderRadius: '10px', outline: 'none', fontSize: '12px', lineHeight: 1.6, background: canManageMembers ? '#fff' : '#f8fafc' }}
                        />
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <select
                            value={externalInviteChannel}
                            onChange={(event) => setExternalInviteChannel(event.target.value)}
                            disabled={!canManageMembers}
                            style={{ flex: '1 1 auto', padding: '9px 10px', border: '1px solid #dbe2ea', borderRadius: '10px', outline: 'none', fontSize: '12px', background: '#fff' }}
                          >
                            <option value="sms">短信</option>
                            <option value="email">邮件</option>
                            <option value="code">邀请码</option>
                          </select>
                          <button
                            type="submit"
                            disabled={!canManageMembers}
                            style={{ border: 'none', background: '#2563eb', color: '#fff', borderRadius: '10px', padding: '10px 12px', cursor: canManageMembers ? 'pointer' : 'not-allowed', opacity: canManageMembers ? 1 : 0.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}
                          >
                            <UserPlus size={15} /> 创建邀请
                          </button>
                        </div>
                      </form>
                    )}
                  </div>

                  <div className="member-panel card" style={{ padding: '16px', display: 'grid', gap: '12px' }}>
                    <div className="member-panel-title">邀请记录</div>
                    <div style={{ display: 'grid', gap: '8px', maxHeight: '320px', overflowY: 'auto', paddingRight: '2px' }}>
                      {projectInvitations.length ? projectInvitations.map((invitation) => {
                        const statusMeta = invitationStatusMeta[invitation.status] || invitationStatusMeta.pending;
                        const canResend = canManageMembers && !['accepted', 'rejected', 'revoked'].includes(invitation.status);
                        const canRevoke = canManageMembers && !['accepted', 'rejected', 'revoked'].includes(invitation.status);
                        return (
                          <div key={invitation.id} style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '10px 12px', background: '#fff', display: 'grid', gap: '8px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {invitation.contactValue}
                                </div>
                                <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                                  {projectRoleMetaMap[invitation.projectRole]?.label || projectRoleMetaMap.viewer.label} · {invitation.inviteChannel || '--'}
                                </div>
                              </div>
                              <span style={{ flexShrink: 0, border: `1px solid ${statusMeta.border}`, background: statusMeta.bg, color: statusMeta.color, borderRadius: '999px', padding: '3px 8px', fontSize: '11px', fontWeight: 700 }}>
                                {statusMeta.label}
                              </span>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '8px', alignItems: 'center' }}>
                              <div style={{ fontSize: '11px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {invitation.inviteCode ? `邀请码 ${invitation.inviteCode}` : '无邀请码'}
                              </div>
                              <button
                                type="button"
                                disabled={!canResend}
                                onClick={() => handleResendInvitation(invitation.id)}
                                style={{ border: '1px solid #bfdbfe', background: '#eff6ff', color: '#2563eb', borderRadius: '9px', padding: '7px 9px', cursor: canResend ? 'pointer' : 'not-allowed', opacity: canResend ? 1 : 0.45, fontSize: '12px', fontWeight: 600 }}
                              >
                                重发
                              </button>
                              <button
                                type="button"
                                disabled={!canRevoke}
                                onClick={() => handleRevokeInvitation(invitation.id)}
                                style={{ border: '1px solid #fecaca', background: '#fff', color: '#b91c1c', borderRadius: '9px', padding: '7px 9px', cursor: canRevoke ? 'pointer' : 'not-allowed', opacity: canRevoke ? 1 : 0.45, fontSize: '12px', fontWeight: 600 }}
                              >
                                撤销
                              </button>
                            </div>
                          </div>
                        );
                      }) : (
                        <div style={{ padding: '18px 12px', textAlign: 'center', color: '#94a3b8', border: '1px dashed #cbd5e1', borderRadius: '12px', fontSize: '13px' }}>
                          暂无邀请记录。
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="member-panel card" style={{ padding: '16px', display: 'grid', gap: '10px' }}>
                    <button
                      type="button"
                      onClick={() => setShowPermissionHelp((value) => !value)}
                      style={{ border: 'none', background: 'transparent', color: '#2563eb', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '13px' }}
                    >
                      <CircleHelp size={15} /> 权限说明
                    </button>
                    {showPermissionHelp && (
                      <div style={{ display: 'grid', gap: '8px' }}>
                        {Object.keys(projectRoleMetaMap).map((roleKey) => (
                          <div key={roleKey} style={{ fontSize: '12px', color: '#475569', lineHeight: 1.6 }}>
                            <b style={{ color: '#0f172a' }}>{projectRoleMetaMap[roleKey].label}</b>：{projectRoleDescriptions[roleKey]}
                            <div style={{ color: '#94a3b8' }}>{projectRoleCapabilityMap[roleKey].join(' / ')}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {lineProfileModal.open && (
        <div style={{ position: 'fixed', inset: 0, background: lineProfileMaximized ? 'transparent' : 'rgba(15, 23, 42, 0.45)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: lineProfileMaximized ? '0' : '24px' }}>
          <div className="card glass" style={{ width: lineProfileMaximized ? '100vw' : 'min(920px, 100%)', height: lineProfileMaximized ? '100vh' : '85vh', maxHeight: lineProfileMaximized ? '100vh' : '85vh', borderRadius: lineProfileMaximized ? 0 : '24px', overflow: 'hidden', padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
              <div>
                <div style={{ fontSize: '24px', fontWeight: 800, color: '#0f172a' }}>
                  测线剖面窗口
                </div>
                <div style={{ marginTop: '6px', fontSize: '13px', color: '#64748b' }}>
                  {activeLineProfileSubtitleText}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => setLineProfileMaximized((value) => !value)}
                  title={lineProfileMaximized ? '还原窗口' : '最大化'}
                  style={{ border: '1px solid #cbd5e1', background: '#fff', color: '#475569', borderRadius: '10px', width: '38px', height: '38px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {lineProfileMaximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLineProfileModal({ open: false, lineKey: '', instrumentName: '' });
                    setLineProfileMaximized(false);
                    setLineProfileChartModalOpen(false);
                    setLineProfileStitchDialogOpen(false);
                  }}
                  style={{ border: '1px solid #cbd5e1', background: '#fff', color: '#475569', borderRadius: '10px', width: '38px', height: '38px', cursor: 'pointer', fontSize: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  ×
                </button>
              </div>
            </div>

            <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'scroll', paddingRight: '6px', display: 'grid', alignContent: 'start', gap: '18px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '12px' }}>
                {(isActiveLineProfileErt ? [
                  { label: '排列数量', value: activeLineProfileMeta.pointCount, size: 24 },
                  { label: '已匹配数量', value: activeLineProfileMeta.matchedCount, size: 24 },
                  {
                    label: '剖面长度',
                    value: Number.isFinite(Number(lineProfileDataChartState.metrics?.profileLength))
                      ? formatLengthMeters(lineProfileDataChartState.metrics.profileLength)
                      : (lineProfileDataChartState.loading ? '解析中...' : '--'),
                    size: 20
                  },
                  {
                    label: '数据点数',
                    value: Number.isFinite(Number(lineProfileDataChartState.metrics?.dataPointCount))
                      ? `${Number(lineProfileDataChartState.metrics.dataPointCount).toLocaleString()} 点`
                      : (lineProfileDataChartState.loading ? '解析中...' : '--'),
                    size: 20
                  }
                ] : [
                  { label: '测点数量', value: activeLineProfileMeta.pointCount, size: 24 },
                  { label: '已匹配数量', value: activeLineProfileMeta.matchedCount, size: 24 },
                  { label: '起点', value: activeLineProfileMeta.startPoint, size: 20 },
                  { label: '终点', value: activeLineProfileMeta.endPoint, size: 20 }
                ]).map((item) => (
                  <div key={item.label} style={{ background: '#f8fafc', borderRadius: '12px', padding: '14px 16px' }}>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>{item.label}</div>
                    <div style={{ marginTop: '6px', fontSize: `${item.size}px`, fontWeight: 800, color: '#0f172a' }}>{item.value}</div>
                  </div>
                ))}
              </div>

              {activeLineProfileCanStitch && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={() => setLineProfileStitchDialogOpen(true)}
                    style={{ border: '1px solid #bfdbfe', background: '#eff6ff', color: '#2563eb', borderRadius: '10px', padding: '9px 12px', cursor: 'pointer', fontSize: '13px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '7px' }}
                  >
                    <FileText size={15} /> 排列拼接
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  if (activeLineProfileChartOption) setLineProfileChartModalOpen(true);
                }}
                style={{ border: '1px solid #e2e8f0', borderRadius: '14px', background: '#fff', overflow: 'hidden', padding: 0, cursor: activeLineProfileChartOption ? 'zoom-in' : 'default', textAlign: 'left' }}
                title={activeLineProfileChartOption ? '点击单独显示二维剖面图' : undefined}
              >
                {activeLineProfileChartOption ? (
                  <div>
                    <div style={{ padding: '10px 14px', borderBottom: '1px solid #e2e8f0', fontSize: '12px', color: '#64748b', background: '#f8fafc' }}>
                      点击图表可单独弹出显示
                    </div>
                    <ResponsiveLineProfileChart option={activeLineProfileChartOption} style={{ height: '360px', width: '100%' }} notMerge lazyUpdate />
                  </div>
                ) : (
                  <div style={{ padding: '24px 16px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
                    当前测线还没有足够的坐标点可生成二维剖面图。
                  </div>
                )}
              </button>

              {!isActiveLineProfileErt && (
              <div style={{ border: '1px solid #e2e8f0', borderRadius: '14px', overflow: 'hidden', background: '#fff', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', minHeight: '320px', maxHeight: lineProfileMaximized ? 'calc(100vh - 520px)' : '320px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '140px 140px 140px 1fr 120px', padding: '12px 16px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: '12px', fontWeight: 700, color: '#475569' }}>
                  <div>测线</div>
                  <div>测点</div>
                  <div>仪器</div>
                  <div>坐标</div>
                  <div>数据状态</div>
                </div>
                <div style={{ overflowY: 'auto', minHeight: 0 }}>
                  {activeLineProfileEntries.length ? activeLineProfileEntries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => {
                        setLineProfileModal({ open: false, lineKey: '', instrumentName: '' });
                        handleSelectSpatialEntry(entry.id);
                        handleSelectDataEntry(entry.id);
                        setActiveTab('data');
                        setDataAutoOpenRequest({
                          pointId: entry.id,
                          stamp: `${project?.id || 'project'}:${entry.id}:${autoOpenStampRef.current++}`
                        });
                      }}
                      style={{ width: '100%', border: 'none', background: 'transparent', display: 'grid', gridTemplateColumns: '140px 140px 140px 1fr 120px', padding: '12px 16px', borderBottom: '1px solid #f1f5f9', textAlign: 'left', cursor: 'pointer' }}
                    >
                      <div style={{ color: '#0f172a', fontWeight: 600 }}>{entry.line || '--'}</div>
                      <div style={{ color: '#0f172a' }}>{entry.point || '--'}</div>
                      <div style={{ color: '#0f172a' }}>{entry.instrument || activeLineProfileMeta.instrumentName}</div>
                      <div style={{ color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {Number(entry.lat).toFixed(6)}, {Number(entry.lng).toFixed(6)}
                      </div>
                      <div style={{ color: entry.hasExistingData ? '#2563eb' : '#94a3b8', fontWeight: 600 }}>
                        {entry.hasExistingData ? `已匹配 ${entry.matchedDataCount}` : '未匹配'}
                      </div>
                    </button>
                  )) : (
                    <div style={{ padding: '24px 16px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
                      当前测线下还没有可显示的测点。
                    </div>
                  )}
                </div>
              </div>
              )}
            </div>
          </div>
        </div>
      )}

      {lineProfileStitchDialogOpen && activeLineProfileCanStitch && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', zIndex: 1350, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div className="card glass" style={{ width: 'min(980px, 100%)', maxHeight: '88vh', borderRadius: '22px', overflow: 'hidden', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '22px', fontWeight: 800, color: '#0f172a' }}>排列拼接</div>
                <div style={{ marginTop: '5px', fontSize: '13px', color: '#64748b' }}>
                  测线 {lineProfileModal.lineKey || '--'} · 共 {activeLineProfileArrayOptions.length} 个排列，生成拼接后的 RES2DINV DAT 文件。
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={handleGenerateLineProfileStitchCommand}
                  disabled={!activeLineProfileStitchReady || lineProfileCommandSaving}
                  title={activeLineProfileStitchReady ? '生成当前排列顺序的 RES2DINV 拼接 DAT 并保存到当前项目云盘目录' : '至少选择 2 个已匹配数据文件且排列长度已解析'}
                  style={{ border: 'none', background: activeLineProfileStitchReady && !lineProfileCommandSaving ? '#2563eb' : '#94a3b8', color: '#fff', borderRadius: '10px', padding: '10px 12px', cursor: activeLineProfileStitchReady && !lineProfileCommandSaving ? 'pointer' : 'not-allowed', fontSize: '12px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <FileText size={14} /> {lineProfileCommandSaving ? '保存中' : '生成DAT并保存'}
                </button>
                {lineProfileSavedCommandItem && (
                  <div style={{ border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#166534', borderRadius: '10px', padding: '6px 12px', fontSize: '12px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '6px', maxWidth: '320px' }} title={lineProfileSavedCommandItem.name}>
                    <CheckCircle size={14} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>已保存：{lineProfileSavedCommandItem.name}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setLineProfileStitchDialogOpen(false)}
                  style={{ border: '1px solid #cbd5e1', background: '#fff', color: '#475569', borderRadius: '10px', width: '38px', height: '38px', cursor: 'pointer', fontSize: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  ×
                </button>
              </div>
            </div>

            <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'grid', gap: '12px', paddingRight: '4px' }}>
              <div style={{ border: '1px solid #bfdbfe', borderRadius: '14px', background: '#eff6ff', overflow: 'hidden' }}>
                <div style={{ padding: '12px 14px', display: 'grid', gap: '12px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 220px', gap: '12px', alignItems: 'end' }}>
                    <label style={{ display: 'grid', gap: '6px' }}>
                      <span style={{ fontSize: '12px', color: '#475569', fontWeight: 700 }}>输出 DAT 文件名</span>
                      <input
                        value={activeLineProfileStitchOutputPath}
                        onChange={(event) => updateLineProfileStitchOutputPath(event.target.value)}
                        style={overviewCoordInputStyle}
                      />
                    </label>
                    <label style={{ display: 'grid', gap: '6px' }}>
                      <span style={{ fontSize: '12px', color: '#475569', fontWeight: 700 }}>重叠数据处理</span>
                      <select
                        value={activeLineProfileStitchOverlapMode}
                        onChange={(event) => updateLineProfileStitchOverlapMode(event.target.value)}
                        style={overviewCoordInputStyle}
                      >
                        <option value="previous">按前一排列</option>
                        <option value="next">按后一排列</option>
                        <option value="average">平均</option>
                      </select>
                    </label>
                  </div>

                  <div style={{ border: '1px solid #dbeafe', borderRadius: '12px', overflow: 'hidden', background: '#fff' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '62px 82px 62px 86px minmax(190px, 1fr) 96px 96px 106px', gap: '10px', padding: '10px 12px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: '12px', fontWeight: 800, color: '#475569' }}>
                      <div>参与</div>
                      <div>顺序</div>
                      <div>排列</div>
                      <div>排列长度</div>
                      <div>RES2DINV 数据文件</div>
                      <div>起点 X</div>
                      <div>终点 X</div>
                      <div>Line sign</div>
                    </div>
                    <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
                      {activeLineProfileOrderedArrayOptions.map(({ entry, label }, orderIndex) => {
                        const checked = selectedLineProfileArrayIdSet.has(entry.id);
                        const row = activeLineProfileStitchRows.find((item) => item.entry.id === entry.id);
                        const arrangementLength = activeLineProfileArrangementLengthMap[entry.id];
                        const stored = activeLineProfileStitchConfig.items?.[entry.id] || {};
                        const dataPath = stored.dataPath ?? (entry.matchedDataPaths || []).filter(Boolean)[0] ?? '';
                        return (
                          <div key={entry.id} style={{ display: 'grid', gridTemplateColumns: '62px 82px 62px 86px minmax(190px, 1fr) 96px 96px 106px', gap: '10px', padding: '10px 12px', borderBottom: '1px solid #f1f5f9', alignItems: 'center' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#475569', fontWeight: 700 }}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleLineProfileArraySelection(entry.id)}
                              />
                              拼接
                            </label>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <button
                                type="button"
                                title="上移"
                                disabled={orderIndex === 0}
                                onClick={() => moveLineProfileArrayOrder(entry.id, -1)}
                                style={{ width: '28px', height: '28px', borderRadius: '8px', border: '1px solid #dbe2ea', background: '#fff', color: orderIndex === 0 ? '#cbd5e1' : '#2563eb', cursor: orderIndex === 0 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                              >
                                <ArrowUp size={14} />
                              </button>
                              <button
                                type="button"
                                title="下移"
                                disabled={orderIndex === activeLineProfileOrderedArrayOptions.length - 1}
                                onClick={() => moveLineProfileArrayOrder(entry.id, 1)}
                                style={{ width: '28px', height: '28px', borderRadius: '8px', border: '1px solid #dbe2ea', background: '#fff', color: orderIndex === activeLineProfileOrderedArrayOptions.length - 1 ? '#cbd5e1' : '#2563eb', cursor: orderIndex === activeLineProfileOrderedArrayOptions.length - 1 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                              >
                                <ArrowDown size={14} />
                              </button>
                            </div>
                            <div style={{ fontSize: '13px', color: '#0f172a', fontWeight: 700 }}>{label}</div>
                            <div style={{ fontSize: '13px', color: checked ? '#0f172a' : '#94a3b8', fontWeight: 700 }}>
                              {formatLengthMeters(arrangementLength)}
                            </div>
                            <input
                              value={dataPath}
                              disabled={!checked}
                              onChange={(event) => updateLineProfileStitchRow(entry.id, 'dataPath', event.target.value)}
                              placeholder="c:\\data\\file1.DAT"
                              style={{ ...overviewCoordInputStyle, padding: '8px 10px', fontSize: '12px', background: checked ? '#fff' : '#f8fafc' }}
                            />
                            <input
                              type="number"
                              value={row?.xLocation ?? stored.xLocation ?? 0}
                              disabled={!checked}
                              title="修改后，后续排列起点和终点会按排列长度自动顺延"
                              onChange={(event) => updateLineProfileStitchRow(entry.id, 'xLocation', event.target.value)}
                              style={{ ...overviewCoordInputStyle, padding: '8px 10px', fontSize: '12px', background: checked ? '#fff' : '#f8fafc', color: checked ? '#0f172a' : '#94a3b8' }}
                            />
                            <input
                              type="number"
                              value={Number.isFinite(row?.endX) ? row.endX : ''}
                              readOnly
                              disabled={!checked}
                              title="终点 X = 起点 X + 排列长度"
                              style={{ ...overviewCoordInputStyle, padding: '8px 10px', fontSize: '12px', background: '#f8fafc', color: checked ? '#0f172a' : '#94a3b8' }}
                            />
                            <select
                              value={row?.lineSign ?? stored.lineSign ?? '0'}
                              disabled={!checked}
                              onChange={(event) => updateLineProfileStitchRow(entry.id, 'lineSign', event.target.value)}
                              style={{ ...overviewCoordInputStyle, padding: '8px 10px', fontSize: '12px', background: checked ? '#fff' : '#f8fafc' }}
                            >
                              <option value="0">0 正向</option>
                              <option value="1">1 反向</option>
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {lineProfileChartModalOpen && activeLineProfileChartOption && (
        <div style={{ position: 'fixed', inset: 0, background: lineProfileChartMaximized ? 'transparent' : 'rgba(15, 23, 42, 0.62)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: lineProfileChartMaximized ? '0' : '16px' }}>
          <div className="card glass" style={{ width: lineProfileChartMaximized ? '100vw' : 'min(1280px, 100%)', height: lineProfileChartMaximized ? '100vh' : 'min(88vh, 920px)', borderRadius: lineProfileChartMaximized ? 0 : '24px', overflow: 'hidden', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
              <div>
                <div style={{ fontSize: '22px', fontWeight: 800, color: '#0f172a' }}>二维剖面图</div>
                <div style={{ marginTop: '4px', fontSize: '13px', color: '#64748b' }}>
                  {activeLineProfileSubtitleText}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setShowLineProfileInversionSettings((value) => !value)}
                  title={showLineProfileInversionSettings ? (isActiveLineProfileEmap1 ? '收起 Aurora 参数面板' : '收起二维反演设置') : (isActiveLineProfileEmap1 ? '展开 Aurora 参数面板' : '展开二维反演设置')}
                  style={{ border: '1px solid #cbd5e1', background: showLineProfileInversionSettings ? '#eff6ff' : '#fff', color: showLineProfileInversionSettings ? '#2563eb' : '#475569', borderRadius: '10px', padding: '0 12px', height: '38px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600 }}
                >
                  <Settings2 size={16} style={{ marginRight: '6px' }} />
                  {isActiveLineProfileEmap1 ? 'Aurora 参数' : '二维反演设置'}
                </button>
                <button
                  type="button"
                  onClick={() => setLineProfileChartMaximized((value) => !value)}
                  title={lineProfileChartMaximized ? '还原窗口' : '最大化'}
                  style={{ border: '1px solid #cbd5e1', background: '#fff', color: '#475569', borderRadius: '10px', width: '38px', height: '38px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {lineProfileChartMaximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLineProfileChartModalOpen(false);
                    setLineProfileChartMaximized(false);
                    setShowLineProfileInversionSettings(false);
                  }}
                  style={{ border: '1px solid #cbd5e1', background: '#fff', color: '#475569', borderRadius: '10px', width: '38px', height: '38px', cursor: 'pointer', fontSize: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  ×
                </button>
              </div>
            </div>
            <div style={{ flex: '1 1 auto', minHeight: 0, display: 'grid', gridTemplateColumns: showLineProfileInversionSettings ? `minmax(0, 1fr) ${lineProfileRightPanelWidth}px` : 'minmax(0, 1fr)', gap: '16px' }}>
              <div style={{ minHeight: 0, border: '1px solid #e2e8f0', borderRadius: '14px', overflow: 'hidden', background: '#fff' }}>
                <ResponsiveLineProfileChart option={activeLineProfileChartOption} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />
              </div>
              {showLineProfileInversionSettings && (
                <div style={{ minHeight: 0, border: '1px solid #dbe2ea', borderRadius: '14px', background: '#f8fafc', padding: '16px', display: 'grid', gridTemplateRows: 'auto auto minmax(0, 1fr)', gap: '12px', overflow: 'hidden' }}>
                  {isActiveLineProfileEmap1 ? (
                    <>
                      <div style={{ display: 'grid', gap: '10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                          <div>
                            <div style={{ fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>Aurora 计算参数</div>
                            <div style={{ marginTop: '4px', fontSize: '12px', color: '#64748b' }}>右侧参数面板可收起，宽度可调。</div>
                          </div>
                          <button
                            type="button"
                            onClick={handleRunEmap1Aurora}
                            disabled={emap1AuroraState.loading || !activeLineProfileEntries.length}
                            style={{ border: 'none', background: emap1AuroraState.loading ? '#cbd5f5' : '#2563eb', color: '#fff', borderRadius: '10px', padding: '10px 14px', cursor: emap1AuroraState.loading ? 'wait' : 'pointer', fontWeight: 700 }}
                          >
                            {emap1AuroraState.loading ? 'Aurora 计算中...' : '运行 Aurora'}
                          </button>
                        </div>
                        <label style={{ display: 'grid', gap: '6px' }}>
                          <span style={{ fontSize: '12px', color: '#475569' }}>面板宽度</span>
                          <input
                            type="range"
                            min="300"
                            max="560"
                            step="20"
                            value={lineProfileRightPanelWidth}
                            onChange={(e) => setLineProfileRightPanelWidth(Number(e.target.value))}
                          />
                        </label>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
                          <label style={{ display: 'grid', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: '#475569' }}>计算模式</span>
                            <select
                              value={emap1AuroraSettings.mode}
                              onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, mode: e.target.value }))}
                              style={overviewCoordInputStyle}
                            >
                              <option value="scalar_xy">标量 XY (Ex/Hy)</option>
                              <option value="scalar_yx">标量 YX (Ey/Hx)</option>
                              <option value="scalar_both">标量双向</option>
                              <option value="tensor">张量</option>
                            </select>
                          </label>
                          <label style={{ display: 'grid', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: '#475569' }}>优选频段</span>
                            <select
                              value={emap1AuroraSettings.sampleRatePreference}
                              onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, sampleRatePreference: e.target.value }))}
                              style={overviewCoordInputStyle}
                            >
                              <option value="auto">自动</option>
                              <option value="38400H">高频 38400H</option>
                              <option value="1200L">低频 1200L</option>
                            </select>
                          </label>
                          <label style={{ display: 'grid', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: '#475569' }}>NFFT</span>
                            <input type="number" value={emap1AuroraSettings.nfft} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, nfft: Number(e.target.value) }))} style={overviewCoordInputStyle} />
                          </label>
                          <label style={{ display: 'grid', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: '#475569' }}>重叠率</span>
                            <input type="number" step="0.05" min="0" max="0.95" value={emap1AuroraSettings.overlap} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, overlap: Number(e.target.value) }))} style={overviewCoordInputStyle} />
                          </label>
                          <label style={{ display: 'grid', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: '#475569' }}>窗函数</span>
                            <select value={emap1AuroraSettings.window} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, window: e.target.value }))} style={overviewCoordInputStyle}>
                              <option value="hann">Hann</option>
                              <option value="hamming">Hamming</option>
                              <option value="boxcar">Boxcar</option>
                            </select>
                          </label>
                          <label style={{ display: 'grid', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: '#475569' }}>目标频率 (Hz)</span>
                            <input type="number" step="0.1" value={emap1AuroraSettings.targetFrequencyHz} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, targetFrequencyHz: Number(e.target.value) }))} style={overviewCoordInputStyle} />
                          </label>
                          <label style={{ display: 'grid', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: '#475569' }}>Huber 阈值</span>
                            <input type="number" step="0.1" value={emap1AuroraSettings.huberThreshold} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, huberThreshold: Number(e.target.value) }))} style={overviewCoordInputStyle} />
                          </label>
                          <label style={{ display: 'grid', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: '#475569' }}>最大迭代</span>
                            <input type="number" value={emap1AuroraSettings.maxIter} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, maxIter: Number(e.target.value) }))} style={overviewCoordInputStyle} />
                          </label>
                          <label style={{ display: 'grid', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: '#475569' }}>Ex 偶极距 (m)</span>
                            <input type="number" value={emap1AuroraSettings.dipoleExM} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, dipoleExM: Number(e.target.value) }))} style={overviewCoordInputStyle} />
                          </label>
                          <label style={{ display: 'grid', gap: '6px' }}>
                            <span style={{ fontSize: '12px', color: '#475569' }}>Ey 偶极距 (m)</span>
                            <input type="number" value={emap1AuroraSettings.dipoleEyM} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, dipoleEyM: Number(e.target.value) }))} style={overviewCoordInputStyle} />
                          </label>
                        </div>
                        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a' }}>标定文件匹配</div>
                          <div style={{ fontSize: '12px', color: '#64748b', lineHeight: 1.6 }}>
                            为 EX/EY/HX/HY 选择对应的通道和传感器标定文件，用于 Aurora 计算。
                          </div>
                          <button
                            type="button"
                            onClick={handleAutoMatchEmap1Calibration}
                            style={{ alignSelf: 'flex-start', border: '1px solid #cbd5e1', background: '#fff', color: '#2563eb', borderRadius: '8px', padding: '6px 10px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                          >
                            自动匹配
                          </button>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
                            {showLineExCalibration && (
                              <>
                                <label style={{ display: 'grid', gap: '6px' }}>
                                  <span style={{ fontSize: '12px', color: '#475569' }}>EX 通道响应</span>
                                  <select
                                    value={emap1AuroraCalibration.exChannelResponseId}
                                    onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, exChannelResponseId: e.target.value }))}
                                    style={overviewCoordInputStyle}
                                  >
                                    <option value="">请选择</option>
                                    {emap1CalibrationCandidates.map((item) => (
                                      <option key={`line-ex-channel-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>
                                        {item.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label style={{ display: 'grid', gap: '6px' }}>
                                  <span style={{ fontSize: '12px', color: '#475569' }}>EX 传感器响应</span>
                                  <select
                                    value={emap1AuroraCalibration.exSensorResponseId}
                                    onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, exSensorResponseId: e.target.value }))}
                                    style={overviewCoordInputStyle}
                                  >
                                    <option value="">请选择</option>
                                    {emap1CalibrationCandidates.map((item) => (
                                      <option key={`line-ex-sensor-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>
                                        {item.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </>
                            )}
                            {showLineEyCalibration && (
                              <>
                                <label style={{ display: 'grid', gap: '6px' }}>
                                  <span style={{ fontSize: '12px', color: '#475569' }}>EY 通道响应</span>
                                  <select
                                    value={emap1AuroraCalibration.eyChannelResponseId}
                                    onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, eyChannelResponseId: e.target.value }))}
                                    style={overviewCoordInputStyle}
                                  >
                                    <option value="">请选择</option>
                                    {emap1CalibrationCandidates.map((item) => (
                                      <option key={`line-ey-channel-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>
                                        {item.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label style={{ display: 'grid', gap: '6px' }}>
                                  <span style={{ fontSize: '12px', color: '#475569' }}>EY 传感器响应</span>
                                  <select
                                    value={emap1AuroraCalibration.eySensorResponseId}
                                    onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, eySensorResponseId: e.target.value }))}
                                    style={overviewCoordInputStyle}
                                  >
                                    <option value="">请选择</option>
                                    {emap1CalibrationCandidates.map((item) => (
                                      <option key={`line-ey-sensor-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>
                                        {item.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </>
                            )}
                            {showLineHxCalibration && (
                              <>
                                <label style={{ display: 'grid', gap: '6px' }}>
                                  <span style={{ fontSize: '12px', color: '#475569' }}>HX 通道响应</span>
                                  <select
                                    value={emap1AuroraCalibration.hxChannelResponseId}
                                    onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, hxChannelResponseId: e.target.value }))}
                                    style={overviewCoordInputStyle}
                                  >
                                    <option value="">请选择</option>
                                    {emap1CalibrationCandidates.map((item) => (
                                      <option key={`line-hx-channel-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>
                                        {item.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label style={{ display: 'grid', gap: '6px' }}>
                                  <span style={{ fontSize: '12px', color: '#475569' }}>HX 传感器响应</span>
                                  <select
                                    value={emap1AuroraCalibration.hxSensorResponseId}
                                    onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, hxSensorResponseId: e.target.value }))}
                                    style={overviewCoordInputStyle}
                                  >
                                    <option value="">请选择</option>
                                    {emap1CalibrationCandidates.map((item) => (
                                      <option key={`line-hx-sensor-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>
                                        {item.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </>
                            )}
                            {showLineHyCalibration && (
                              <>
                                <label style={{ display: 'grid', gap: '6px' }}>
                                  <span style={{ fontSize: '12px', color: '#475569' }}>HY 通道响应</span>
                                  <select
                                    value={emap1AuroraCalibration.hyChannelResponseId}
                                    onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, hyChannelResponseId: e.target.value }))}
                                    style={overviewCoordInputStyle}
                                  >
                                    <option value="">请选择</option>
                                    {emap1CalibrationCandidates.map((item) => (
                                      <option key={`line-hy-channel-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>
                                        {item.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label style={{ display: 'grid', gap: '6px' }}>
                                  <span style={{ fontSize: '12px', color: '#475569' }}>HY 传感器响应</span>
                                  <select
                                    value={emap1AuroraCalibration.hySensorResponseId}
                                    onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, hySensorResponseId: e.target.value }))}
                                    style={overviewCoordInputStyle}
                                  >
                                    <option value="">请选择</option>
                                    {emap1CalibrationCandidates.map((item) => (
                                      <option key={`line-hy-sensor-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>
                                        {item.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </>
                            )}
                          </div>
                        </div>
                        </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px' }}>
                        <div style={{ background: '#fff', borderRadius: '12px', padding: '12px' }}>
                          <div style={{ fontSize: '12px', color: '#64748b' }}>总测点</div>
                          <div style={{ marginTop: '4px', fontSize: '22px', fontWeight: 800, color: '#0f172a' }}>{activeLineProfileEntries.length}</div>
                        </div>
                        <div style={{ background: '#fff', borderRadius: '12px', padding: '12px' }}>
                          <div style={{ fontSize: '12px', color: '#64748b' }}>已完成</div>
                          <div style={{ marginTop: '4px', fontSize: '22px', fontWeight: 800, color: '#0f172a' }}>{emap1AuroraState.summary?.processedCount || 0}</div>
                        </div>
                        <div style={{ background: '#fff', borderRadius: '12px', padding: '12px' }}>
                          <div style={{ fontSize: '12px', color: '#64748b' }}>失败</div>
                          <div style={{ marginTop: '4px', fontSize: '22px', fontWeight: 800, color: '#ef4444' }}>{emap1AuroraState.summary?.failedCount || 0}</div>
                        </div>
                      </div>
                      <div style={{ minHeight: 0, overflow: 'auto', border: '1px solid #dbe2ea', borderRadius: '12px', background: '#fff' }}>
                        {emap1AuroraState.error ? (
                          <div style={{ padding: '14px 16px', color: '#dc2626', fontSize: '13px' }}>{emap1AuroraState.error}</div>
                        ) : emap1AuroraState.items.length ? (
                          <div>
                            <div style={{ display: 'grid', gridTemplateColumns: '96px 86px 92px 1fr', gap: '10px', padding: '12px 14px', borderBottom: '1px solid #e2e8f0', fontSize: '12px', fontWeight: 700, color: '#475569', background: '#f8fafc' }}>
                              <div>测点</div>
                              <div>状态</div>
                              <div>频带</div>
                              <div>目标值</div>
                            </div>
                            {emap1AuroraState.items.map((item) => (
                              <div key={item.pointId} style={{ display: 'grid', gridTemplateColumns: '96px 86px 92px 1fr', gap: '10px', padding: '12px 14px', borderBottom: '1px solid #f1f5f9', fontSize: '12px', color: '#334155' }}>
                                <div style={{ fontWeight: 700, color: '#0f172a' }}>{item.point}</div>
                                <div style={{ color: item.status === 'processed' ? '#2563eb' : '#ef4444', fontWeight: 700 }}>{item.status === 'processed' ? '已完成' : '失败'}</div>
                                <div>{item.sampleRateTag || '--'}</div>
                                <div>{item.status === 'processed' ? `${item.targetFrequencyHz.toFixed(2)} Hz / ${item.targetValue !== null ? item.targetValue.toFixed(2) : '--'}` : item.message}</div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div style={{ padding: '18px 16px', color: '#64748b', fontSize: '13px' }}>点击“运行 Aurora”后，这里会显示每个测点的计算结果。</div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div style={{ border: '1px solid #dbe2ea', borderRadius: '14px', background: '#f8fafc', padding: '16px', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px', alignContent: 'start' }}>
                      <label style={{ display: 'grid', gap: '6px' }}>
                        <span style={{ fontSize: '12px', color: '#475569' }}>面板宽度</span>
                        <input
                          type="range"
                          min="300"
                          max="560"
                          step="20"
                          value={lineProfileRightPanelWidth}
                          onChange={(e) => setLineProfileRightPanelWidth(Number(e.target.value))}
                        />
                      </label>
                      <label style={{ display: 'grid', gap: '6px' }}>
                        <span style={{ fontSize: '12px', color: '#475569' }}>反演方式</span>
                        <select
                          value={lineProfileInversionSettings.mode}
                          onChange={(e) => setLineProfileInversionSettings((prev) => ({ ...prev, mode: e.target.value }))}
                          style={overviewCoordInputStyle}
                        >
                          <option value="occam">Occam</option>
                          <option value="smooth">平滑约束</option>
                          <option value="blocky">块状模型</option>
                        </select>
                      </label>
                      <label style={{ display: 'grid', gap: '6px' }}>
                        <span style={{ fontSize: '12px', color: '#475569' }}>单元宽度 (m)</span>
                        <input
                          type="number"
                          value={lineProfileInversionSettings.cellWidth}
                          onChange={(e) => setLineProfileInversionSettings((prev) => ({ ...prev, cellWidth: Number(e.target.value) }))}
                          style={overviewCoordInputStyle}
                        />
                      </label>
                      <label style={{ display: 'grid', gap: '6px' }}>
                        <span style={{ fontSize: '12px', color: '#475569' }}>最大深度 (m)</span>
                        <input
                          type="number"
                          value={lineProfileInversionSettings.maxDepth}
                          onChange={(e) => setLineProfileInversionSettings((prev) => ({ ...prev, maxDepth: Number(e.target.value) }))}
                          style={overviewCoordInputStyle}
                        />
                      </label>
                      <label style={{ display: 'grid', gap: '6px' }}>
                        <span style={{ fontSize: '12px', color: '#475569' }}>迭代次数</span>
                        <input
                          type="number"
                          value={lineProfileInversionSettings.iterations}
                          onChange={(e) => setLineProfileInversionSettings((prev) => ({ ...prev, iterations: Number(e.target.value) }))}
                          style={overviewCoordInputStyle}
                        />
                      </label>
                      <label style={{ display: 'grid', gap: '6px' }}>
                        <span style={{ fontSize: '12px', color: '#475569' }}>正则系数</span>
                        <input
                          type="number"
                          step="0.01"
                          value={lineProfileInversionSettings.regularization}
                          onChange={(e) => setLineProfileInversionSettings((prev) => ({ ...prev, regularization: Number(e.target.value) }))}
                          style={overviewCoordInputStyle}
                        />
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
const Projects = ({
  projects = [],
  selectedProject = null,
  setSelectedProject = () => {},
  onCreateProject = async () => {},
  onUpdateProject = async () => {},
  onOpenDataDrive,
  appSettings,
  currentUser = {},
  users = [],
  pendingSelection,
  clearPendingSelection,
  openNewModalRequest = false,
  clearOpenNewModalRequest = () => {}
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const urlProjectId = useMemo(() => (
    location.pathname.match(/^\/projects\/([^/]+)/)?.[1] || ''
  ), [location.pathname]);
  const routePendingSelection = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const lineKey = String(params.get('line') || '').trim();
    if (!urlProjectId || params.get('openLineProfile') !== '1' || !lineKey) return null;
    return {
      projectId: urlProjectId,
      activeTab: 'overview',
      lineKey,
      instrumentName: String(params.get('instrument') || '').trim(),
      pointId: '',
      openLineProfile: true,
      source: 'sidebar-tree'
    };
  }, [location.search, urlProjectId]);
  const effectivePendingSelection = pendingSelection || routePendingSelection;
  const clearEffectivePendingSelection = useCallback(() => {
    clearPendingSelection?.();
    if (routePendingSelection) {
      navigate(location.pathname, { replace: true });
    }
  }, [clearPendingSelection, location.pathname, navigate, routePendingSelection]);

  useEffect(() => {
    if (urlProjectId && (!selectedProject || selectedProject.id !== urlProjectId)) {
      const matched = projects.find(p => p.id === urlProjectId);
      if (matched) {
        setSelectedProject(matched);
      }
    } else if (!urlProjectId && selectedProject) {
      setSelectedProject(null);
    }
  }, [urlProjectId, projects, selectedProject, setSelectedProject]);

  const [searchTerm, setSearchTerm] = useState('');
  
  // New Project Form State
  const [showNewModal, setShowNewModal] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProject, setNewProject] = useState({
    name: '', location: '', method: '', lat: '', lng: ''
  });
  const canCreateProject = true;

  useEffect(() => {
    if (!openNewModalRequest) return;
    if (selectedProject) {
      setSelectedProject(null);
      return;
    }
    setShowNewModal(true);
    clearOpenNewModalRequest();
  }, [clearOpenNewModalRequest, openNewModalRequest, selectedProject, setSelectedProject]);

  const getStatusColor = (status) => {
    switch (status) {
      case '进行中':
        return { bg: '#eef2ff', text: '#4f46e5' };
      case '已完成':
        return { bg: '#ecfdf5', text: '#10b981' };
      case '待开始':
        return { bg: '#fffbeb', text: '#f59e0b' };
      default:
        return { bg: '#f1f5f9', text: '#64748b' };
    }
  };

  const handleAddProject = async (e) => {
    e.preventDefault();
    if (isCreatingProject) return;
    if (!canCreateProject) {
      msg.warn('当前账号没有创建项目的权限。');
      return;
    }

    const clat = parseFloat(newProject.lat);
    const clng = parseFloat(newProject.lng);
    const hasValidCoords = Number.isFinite(clat) && Number.isFinite(clng);
    const fallbackCoords = [35.86166, 104.195397];
    const nextCoords = hasValidCoords ? [clat, clng] : fallbackCoords;
    const mockPoly = [
      [nextCoords[0] + 0.1, nextCoords[1] - 0.1],
      [nextCoords[0] + 0.1, nextCoords[1] + 0.1],
      [nextCoords[0] - 0.1, nextCoords[1] + 0.1],
      [nextCoords[0] - 0.1, nextCoords[1] - 0.1],
    ];

    const managerName = currentUser?.name || '当前用户';
    const nowText = new Date().toLocaleString();
    const projectId = createProjectId();
    const baseProject = ensureProjectShape({
      id: projectId,
      name: newProject.name.trim(),
      location: newProject.location.trim() || '未填写位置',
      method: newProject.method.trim() || '未填写方法',
      manager: managerName,
      status: '进行中',
      lastUpdate: new Date().toLocaleDateString(),
      coords: nextCoords,
      areaCoords: mockPoly,
      createdAt: nowText,
      createdByUserId: currentUser.id,
      createdByName: currentUser.name,
      createdByAccount: currentUser.account,
      projectMembers: [{
        userId: currentUser.id,
        name: currentUser.name,
        account: currentUser.account,
        projectRole: 'owner',
        status: 'active',
        invitedBy: currentUser.name,
        invitedAt: nowText,
        joinedAt: nowText,
      }],
    });

    try {
      setIsCreatingProject(true);
      await onCreateProject(baseProject);
      setNewProject({ name: '', location: '', method: '', lat: '', lng: '' });
      setShowNewModal(false);
    } catch (error) {
      msg.warn(error?.message || '创建项目失败，请检查本地后台服务。');
    } finally {
      setIsCreatingProject(false);
    }
  };

  if (selectedProject) {
    return (
      <ProjectDetail
        project={selectedProject}
        onBack={() => setSelectedProject(null)}
        onUpdateProject={async (patch) => {
          const nextProject = ensureProjectShape({ ...selectedProject, ...patch });
          try {
            const savedProject = await onUpdateProject(nextProject);
            setSelectedProject(savedProject);
            return savedProject;
          } catch (error) {
            console.warn('Failed to save project detail patch.', error);
            throw error;
          }
        }}
        onOpenDataDrive={onOpenDataDrive}
        appSettings={appSettings}
        currentUser={currentUser}
        users={users}
        pendingSelection={effectivePendingSelection}
        clearPendingSelection={clearEffectivePendingSelection}
      />
    );
  }

  const visibleProjects = (projects || []).filter((project) => {
    if (!project) return false;
    const keywordMatch =
      String(project.name || '').includes(searchTerm) ||
      String(project.id || '').includes(searchTerm);
    if (!keywordMatch) return false;
    if (!project?.projectMembers?.length) return true;
    return project.projectMembers.some(member => member.userId === currentUser?.id && member.status !== 'pending');
  });

  return (
    <>
      <div className="dashboard-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div>
            <h2>项目管理</h2>
            <p className="text-muted text-sm" style={{ marginTop: '4px' }}>
              统一查看项目概况、状态和成员协作信息。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowNewModal(true)}
            className="btn-primary"
            disabled={!canCreateProject}
            style={{ opacity: canCreateProject ? 1 : 0.55, cursor: canCreateProject ? 'pointer' : 'not-allowed' }}
          >
            <Plus size={18} /> 新建项目
          </button>
        </div>

        <div className="card glass" style={{ padding: '16px', display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', backgroundColor: 'var(--primary-bg)', borderRadius: '8px', padding: '8px 12px', flex: 1 }}>
            <Search size={18} className="text-muted" />
            <input
              type="text"
              placeholder="搜索项目名称或项目编号"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ border: 'none', background: 'transparent', outline: 'none', paddingLeft: '8px', width: '100%', fontSize: '0.875rem' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-secondary)' }}>
            <Filter size={18} /> 按关键字筛选
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '20px', overflowY: 'auto', paddingBottom: '24px' }}>
          {visibleProjects.map(project => {
            const statusStyle = getStatusColor(project.status);
            return (
              <div
                key={project.id}
                className="card glass"
                onClick={() => setSelectedProject(project)}
                style={{ display: 'flex', flexDirection: 'column', gap: '16px', cursor: 'pointer', position: 'relative', transition: 'transform 0.2s', border: '1px solid transparent' }}
                onMouseOver={(e) => e.currentTarget.style.borderColor = 'var(--brand-primary)'}
                onMouseOut={(e) => e.currentTarget.style.borderColor = 'transparent'}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span className="text-xs text-muted font-medium">{project.id}</span>
                    <h3 style={{ fontSize: '1.125rem', color: 'var(--text-primary)' }}>{project.name}</h3>
                  </div>
                  <button type="button" style={{ background: 'transparent', color: 'var(--text-secondary)', padding: '4px', cursor: 'pointer', outline: 'none', border: 'none' }}>
                    <MoreHorizontal size={20} />
                  </button>
                </div>

                <div>
                  <span style={{ display: 'inline-block', padding: '4px 8px', backgroundColor: statusStyle.bg, color: statusStyle.text, borderRadius: '4px', fontSize: '0.75rem', fontWeight: '600' }}>
                    {project.status}
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    <MapPin size={16} /> <span>{project.location || '未填写位置'}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    <Activity size={16} /> <span>{project.method || '未填写方法'}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    <Calendar size={16} /> <span>最近更新：{project.lastUpdate || '--'}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showNewModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="card glass" style={{ width: '500px', padding: '32px', position: 'relative' }}>
            <button
              type="button"
              onClick={() => setShowNewModal(false)}
              style={{ position: 'absolute', top: '24px', right: '24px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
            >
              <X size={20} />
            </button>

            <div style={{ marginBottom: '20px' }}>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>新建项目</h3>
              <p className="text-muted text-sm" style={{ marginTop: '6px' }}>填写基础信息后立即创建一个新的项目。</p>
            </div>

            <form onSubmit={handleAddProject} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span className="text-sm" style={{ fontWeight: 600 }}>项目名称</span>
                <input type="text" value={newProject.name} onChange={(e) => setNewProject(prev => ({ ...prev, name: e.target.value }))} style={overviewCoordInputStyle} required />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span className="text-sm" style={{ fontWeight: 600 }}>项目位置</span>
                <input type="text" value={newProject.location} onChange={(e) => setNewProject(prev => ({ ...prev, location: e.target.value }))} style={overviewCoordInputStyle} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span className="text-sm" style={{ fontWeight: 600 }}>勘探方法</span>
                <input type="text" value={newProject.method} onChange={(e) => setNewProject(prev => ({ ...prev, method: e.target.value }))} style={overviewCoordInputStyle} />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <span className="text-sm" style={{ fontWeight: 600 }}>纬度</span>
                  <input type="number" step="any" value={newProject.lat} onChange={(e) => setNewProject(prev => ({ ...prev, lat: e.target.value }))} style={overviewCoordInputStyle} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <span className="text-sm" style={{ fontWeight: 600 }}>经度</span>
                  <input type="number" step="any" value={newProject.lng} onChange={(e) => setNewProject(prev => ({ ...prev, lng: e.target.value }))} style={overviewCoordInputStyle} />
                </label>
              </div>

              <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
                <button type="button" onClick={() => setShowNewModal(false)} style={{ flex: 1, padding: '12px', background: 'var(--primary-bg)', color: 'var(--text-secondary)', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}>
                  取消
                </button>
                <button type="submit" className="btn-primary" disabled={!canCreateProject || isCreatingProject} style={{ flex: 2, padding: '12px', borderRadius: '8px', border: 'none', opacity: canCreateProject && !isCreatingProject ? 1 : 0.55, cursor: canCreateProject && !isCreatingProject ? 'pointer' : 'not-allowed' }}>
                  {isCreatingProject ? '创建中...' : '创建项目'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

export default Projects;
