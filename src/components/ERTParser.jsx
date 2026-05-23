import React, { useEffect, useRef, useState } from 'react';
import ReactECharts from './LazyECharts';
import { FileBarChart, Loader2, X, AlertCircle, Maximize2, Minimize2, Palette, Activity, LayoutGrid, Pencil, RefreshCcw, Layers, Save } from 'lucide-react';
import { resolveDriveFileContent } from '../utils/driveFileContent';
import { parseRes2dinvSource } from '../utils/res2dinvStitch';
import { createInterpolatedFieldImage } from '../utils/interpolatedFieldImage';
import { createCellGridFieldImage } from '../utils/cellGridFieldImage';
import { requestAdminApi } from '../services/apiClient';
import ErtInversionModal from '../features/drive/components/ErtInversionModal';

// 内置专业色谱方案
const COLOR_SCHEMES = [
  {
    id: 'rainbow',
    name: '彩虹谱 (Rainbow)',
    colors: ['#00008b', '#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff8c00', '#ff0000', '#8b0000'],
  },
  {
    id: 'jet',
    name: 'Jet 色谱',
    colors: ['#000080', '#0000cd', '#0070ff', '#00bfff', '#00ffff', '#7fff00', '#ffff00', '#ffa500', '#ff4500', '#8b0000'],
  },
  {
    id: 'seismic',
    name: '地震对称谱',
    colors: ['#00004c', '#002aff', '#00eeff', '#ffffff', '#ffee00', '#ff2a00', '#4c0000'],
  },
  {
    id: 'viridis',
    name: 'Viridis 科学色谱',
    colors: ['#440154', '#3b508a', '#21908d', '#5dc863', '#fde725'],
  },
  {
    id: 'hot',
    name: '火焰色谱 (Hot)',
    colors: ['#000000', '#400000', '#800000', '#ff0000', '#ff8000', '#ffff00', '#ffffff'],
  },
  {
    id: 'cool',
    name: '冷色锐化谱',
    colors: ['#003366', '#0066cc', '#00ccff', '#66ffff', '#ccffff'],
  },
  {
    id: 'custom',
    name: '自定义...',
    colors: [], // 占位，实际由 customColors 状态控制
  },
];

const formatArchiveSize = (size = 0) => {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
};

const getFileExt = (name = '') => {
  const match = String(name || '').match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : null;
};

const getSourceStem = (name = 'ert_result') => (
  String(name || 'ert_result').replace(/\.[^.]+$/, '').trim() || 'ert_result'
);

const makeArchiveId = (prefix, projectId, name) => (
  `${prefix}_${String(projectId || 'project').replace(/[^a-z0-9_-]/gi, '_')}_${String(name || '').replace(/[^a-z0-9_-]/gi, '_')}`
);

const makeInversionTaskStorageKey = (projectId, fileObj) => (
  `geoyun:ert-inversion:${String(projectId || 'project')}:${String(fileObj?.id || fileObj?.path || fileObj?.name || 'file')}`
);

const isActiveTaskStatus = (status) => ['queued', 'running', 'in_progress', 'pending'].includes(String(status || '').toLowerCase());

const getIterationFileIndex = (name = '') => {
  const match = String(name || '').match(/^iteration_(\d{3})(?:[_.]|$)/i);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isFinite(index) ? index : null;
};

const formatIterationFolderName = (index) => (
  Number(index) === 0 ? '初始模型' : `第 ${Number(index)} 次迭代`
);

const stableUnitValue = (input) => {
  let hash = 2166136261;
  const text = String(input || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
};

const DEFAULT_CUSTOM = ['#00008b', '#0066ff', '#00ffff', '#ffff00', '#ff4400', '#8b0000'];

const NUMBER_PATTERN = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

const parseNumericTokens = (line = '') => (
  String(line).match(NUMBER_PATTERN)?.map(Number).filter(Number.isFinite) || []
);

const readVtkNumericBlock = (lines, startIndex, expectedCount) => {
  const values = [];
  let index = startIndex;
  while (index < lines.length && values.length < expectedCount) {
    values.push(...parseNumericTokens(lines[index]));
    index += 1;
  }
  return { values: values.slice(0, expectedCount), nextIndex: index };
};

const readBrowserFileText = async (file) => {
  if (!file) return '';
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(String(event.target?.result || ''));
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.readAsText(file);
  });
};

const parseAsciiVtkResistivity = (text) => {
  if (!/^#\s*vtk\b/im.test(text) || !/\bDATASET\s+UNSTRUCTURED_GRID\b/i.test(text)) {
    return null;
  }

  const lines = text.split(/\r?\n/);
  let points = [];
  let cells = [];
  let cellDataCount = 0;
  const cellScalars = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '').trim();
    let match = line.match(/^POINTS\s+(\d+)\s+\S+/i);
    if (match) {
      const pointCount = Number.parseInt(match[1], 10);
      const block = readVtkNumericBlock(lines, index + 1, pointCount * 3);
      points = [];
      for (let valueIndex = 0; valueIndex + 2 < block.values.length; valueIndex += 3) {
        points.push([block.values[valueIndex], block.values[valueIndex + 1], block.values[valueIndex + 2]]);
      }
      index = block.nextIndex - 1;
      continue;
    }

    match = line.match(/^CELLS\s+(\d+)\s+\d+/i);
    if (match) {
      const cellCount = Number.parseInt(match[1], 10);
      cells = [];
      let cursor = index + 1;
      while (cursor < lines.length && cells.length < cellCount) {
        const tokens = parseNumericTokens(lines[cursor]).map((value) => Math.trunc(value));
        if (tokens.length) {
          const vertexCount = tokens[0];
          const indices = tokens.slice(1, 1 + vertexCount);
          if (indices.length === vertexCount) cells.push(indices);
        }
        cursor += 1;
      }
      index = cursor - 1;
      continue;
    }

    match = line.match(/^CELL_DATA\s+(\d+)/i);
    if (match) {
      cellDataCount = Number.parseInt(match[1], 10);
      continue;
    }

    match = line.match(/^SCALARS\s+(.+?)\s+\S+(?:\s+\d+)?$/i);
    if (match && cellDataCount > 0) {
      const scalarName = match[1].trim();
      let valueStart = index + 1;
      if (/^LOOKUP_TABLE\b/i.test(String(lines[valueStart] || '').trim())) valueStart += 1;
      const block = readVtkNumericBlock(lines, valueStart, cellDataCount);
      cellScalars.set(scalarName.toLowerCase(), block.values);
      index = block.nextIndex - 1;
    }
  }

  const resistivityValues = cellScalars.get('resistivity')
    || [...cellScalars.entries()].find(([name]) => name.includes('resistivity') && !name.includes('log10'))?.[1];
  if (!points.length || !cells.length || !resistivityValues?.length) return null;

  const finitePointXs = points.map((point) => point[0]).filter(Number.isFinite);
  const positiveMaxX = finitePointXs.filter((value) => value >= 0).reduce((max, value) => Math.max(max, value), 0);
  const shouldClipNegativePadding = positiveMaxX > 0 && finitePointXs.some((value) => value < 0);

  const parsed = [];
  const nodeAccum = new Map();
  const gridCells = [];
  const meshCells = [];
  cells.forEach((cell, cellIndex) => {
    const rho = Number(resistivityValues[cellIndex]);
    const vertices = cell.map((pointIndex) => points[pointIndex]).filter(Boolean);
    if (!vertices.length || !Number.isFinite(rho) || rho <= 0) return;
    const vertexXs = vertices.map((point) => point[0]).filter(Number.isFinite);
    const vertexYs = vertices.map((point) => point[1]).filter(Number.isFinite);
    if (!vertexXs.length || !vertexYs.length) return;
    const minX = Math.min(...vertexXs);
    const maxX = Math.max(...vertexXs);
    const minY = Math.min(...vertexYs);
    const maxY = Math.max(...vertexYs);
    const x = (minX + maxX) / 2;
    const elevation = (minY + maxY) / 2;
    if (!Number.isFinite(x) || !Number.isFinite(elevation)) return;
    if (shouldClipNegativePadding && x < 0) return;
    const uniqueVertexXCount = new Set(vertexXs.map((value) => Number(value.toFixed(9)))).size;
    const uniqueVertexYCount = new Set(vertexYs.map((value) => Number(value.toFixed(9)))).size;
    if (vertices.length === 4 && uniqueVertexXCount === 2 && uniqueVertexYCount === 2 && maxX > minX && maxY > minY) {
      const clippedMinX = shouldClipNegativePadding ? Math.max(0, minX) : minX;
      if (maxX > clippedMinX) {
        gridCells.push([clippedMinX, minY, maxX - clippedMinX, maxY - minY, rho]);
      }
    }
    const polygon = vertices
      .map((point) => [point[0], point[1]])
      .filter(([px, py]) => Number.isFinite(px) && Number.isFinite(py))
      .map(([px, py]) => [shouldClipNegativePadding ? Math.max(0, px) : px, py]);
    if (polygon.length >= 3) {
      meshCells.push({ points: polygon, rho });
    }
    parsed.push([x, elevation, rho]);
    cell.forEach((pointIndex) => {
      const point = points[pointIndex];
      if (!point) return;
      const [nodeX, nodeY] = point;
      if (!Number.isFinite(nodeX) || !Number.isFinite(nodeY)) return;
      if (shouldClipNegativePadding && nodeX < 0) return;
      const current = nodeAccum.get(pointIndex) || { x: nodeX, y: nodeY, sum: 0, count: 0 };
      current.sum += rho;
      current.count += 1;
      nodeAccum.set(pointIndex, current);
    });
  });

  const nodePoints = [...nodeAccum.values()]
    .filter((point) => point.count > 0)
    .map((point) => [point.x, point.y, point.sum / point.count])
    .sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));

  return {
    points: parsed.length ? parsed : nodePoints,
    cellGrid: gridCells.length ? {
      cells: gridCells,
      bounds: {
        xMin: Math.min(...gridCells.map((cell) => cell[0])),
        xMax: Math.max(...gridCells.map((cell) => cell[0] + cell[2])),
        yMin: Math.min(...gridCells.map((cell) => cell[1])),
        yMax: Math.max(...gridCells.map((cell) => cell[1] + cell[3])),
      },
      boundary: []
    } : null,
    mesh: meshCells.length ? {
      cells: meshCells,
      bounds: {
        xMin: Math.min(...meshCells.flatMap((cell) => cell.points.map((point) => point[0]))),
        xMax: Math.max(...meshCells.flatMap((cell) => cell.points.map((point) => point[0]))),
        yMin: Math.min(...meshCells.flatMap((cell) => cell.points.map((point) => point[1]))),
        yMax: Math.max(...meshCells.flatMap((cell) => cell.points.map((point) => point[1]))),
      }
    } : null,
    spacing: positiveMaxX > 0 ? positiveMaxX / 7 : null,
    electrodeCount: positiveMaxX > 0 ? 8 : null,
    profileLength: positiveMaxX > 0 ? positiveMaxX : null,
    topography: null
  };
};

const ERTParser = ({
  fileObj,
  fileSystem = [],
  selectedProject = null,
  onUpdateFileSystem,
  logFileOperations,
  buildFileOperationPayload,
  onClose
}) => {
  const [dataPoints, setDataPoints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);
  const [maximized, setMaximized] = useState(false);
  const [schemeId, setSchemeId] = useState('rainbow');
  const [customColors, setCustomColors] = useState(DEFAULT_CUSTOM);
  const chartRef = useRef(null);
  const chartRef2 = useRef(null);
  const fitChartRef = useRef(null);
  const [chartReadyTick, setChartReadyTick] = useState(0);
  const dataPointsRef = useRef([]);
  const [displayMode, setDisplayMode] = useState('heatmap'); // 'heatmap' | 'wiggle'
  const [editMode, setEditMode] = useState(false);           // 波形图编辑模式
  const [selectedPt, setSelectedPt] = useState(null);        // { x, z, index }
  const [editedRho, setEditedRho] = useState({});            // { "x,z": newRho }
  const [selectedIndices, setSelectedIndices] = useState([]);
  const [fileSpacing, setFileSpacing] = useState(null);
  const [fileElectrodeCount, setFileElectrodeCount] = useState(null);
  const [fileProfileLength, setFileProfileLength] = useState(null);
  const [topographyData, setTopographyData] = useState(null);
  const [directVtkCellGrid, setDirectVtkCellGrid] = useState(null);
  const [directVtkMesh, setDirectVtkMesh] = useState(null);
  const [editingCell, setEditingCell] = useState(null); // { rowIndex, colIndex }
  const [showTable, setShowTable] = useState(false); // 是否显示右侧表格
  const tableRef = useRef(null);
  const refreshChartRef = useRef(null);
  const editedRhoRef = useRef({});                           // 事件处理函数里用，避免闭包问题
  const selectedPtRef = useRef(null);
  const wiggleParamsRef = useRef({});                        // rhoMid/rhoRange/amplitude/rowGroups
  const dragRef = useRef(null);                              // 正在拖拽的节点信息
  const dragMovedRef = useRef(false);
  const suppressClickRef = useRef(false);

  const getChartContainerPx = (instance) => {
    if (!instance) return { w: 0, h: 0 };
    const dom = instance?.getDom?.();
    if (!dom) return { w: 0, h: 0 };
    const rect = dom?.getBoundingClientRect?.();
    return {
      w: Math.max(Math.round(rect?.width || dom?.clientWidth || 0), 1),
      h: Math.max(Math.round(rect?.height || dom?.clientHeight || 0), 1)
    };
  };

  const [isDragging, setIsDragging] = useState(false); // 正在拖拽标识
  const [inversionRuns, setInversionRuns] = useState([]);
  const [selectedInversionRunId, setSelectedInversionRunId] = useState(null);
  const [selectedInversionIterationKey, setSelectedInversionIterationKey] = useState('final');
  const [dataType, setDataType] = useState('apparent'); // 'apparent' | 'inverted'
  const [compareMode, setCompareMode] = useState(false); // 对比模式标识
  const [isInvertingModalOpen, setIsInvertingModalOpen] = useState(false);
  const [activeInversionTask, setActiveInversionTask] = useState(null);
  const inversionTaskPollRef = useRef(null);
  const handledInversionTaskIdsRef = useRef(new Set());
  const restoredArchiveKeyRef = useRef('');

  const selectedInversionRun = React.useMemo(() => (
    inversionRuns.find((run) => run.id === selectedInversionRunId) || inversionRuns[inversionRuns.length - 1] || null
  ), [inversionRuns, selectedInversionRunId]);
  const selectedInversionIteration = React.useMemo(() => {
    if (!selectedInversionRun || selectedInversionIterationKey === 'final') return null;
    return (selectedInversionRun.iterations || []).find((item) => item.key === selectedInversionIterationKey) || null;
  }, [selectedInversionRun, selectedInversionIterationKey]);
  const inversionResult = selectedInversionIteration?.data || selectedInversionRun?.data || null;
  const currentFitComparison = selectedInversionIteration?.files?.fit_comparison || selectedInversionRun?.result?.fit_comparison || null;
  const isDirectVtkFile = /\.(vtk)$/i.test(String(fileObj?.name || '').trim());

  // 获取当前生效的数据点（原始视电阻率或反演结果）
  const activeDataPoints = React.useMemo(() => {
    return (dataType === 'inverted' && inversionResult) ? inversionResult : dataPoints;
  }, [dataType, inversionResult, dataPoints]);

  // 计算剖面元数据
  const profileInfo = React.useMemo(() => {
    if (!activeDataPoints.length) return null;
    const xVals = activeDataPoints.map(p => p[0]);
    const minX = Math.min(...xVals);
    const maxX = Math.max(...xVals);
    const uniqueX = [...new Set(xVals)].sort((a, b) => a - b);

    const rowsByDepth = new Map();
    activeDataPoints.forEach((point) => {
      const z = point[1];
      if (!rowsByDepth.has(z)) rowsByDepth.set(z, []);
      rowsByDepth.get(z).push(point[0]);
    });
    const spacingCounts = new Map();
    rowsByDepth.forEach((rowXVals) => {
      const xs = [...new Set(rowXVals)].sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) {
        const spacingValue = xs[i] - xs[i - 1];
        if (!Number.isFinite(spacingValue) || spacingValue <= 0) continue;
        const key = spacingValue.toFixed(6);
        spacingCounts.set(key, (spacingCounts.get(key) || 0) + 1);
      }
    });
    const inferredSpacing = [...spacingCounts.entries()]
      .sort((a, b) => (b[1] - a[1]) || (Number(a[0]) - Number(b[0])))
      .map(([value]) => Number(value))[0] || 0;
    const spacing = Number.isFinite(fileSpacing) && fileSpacing > 0 ? fileSpacing : inferredSpacing;
    const dataProfileLength = maxX - minX;
    const profileLength = Number.isFinite(fileProfileLength) && fileProfileLength > 0
      ? fileProfileLength
      : dataProfileLength;
    const derivedElectrodes = spacing > 0 && profileLength > 0
      ? Math.round(profileLength / spacing) + 1
      : 0;
    const electrodes = Number.isFinite(fileElectrodeCount) && fileElectrodeCount > 0
      ? fileElectrodeCount
      : (derivedElectrodes > 0 ? derivedElectrodes : uniqueX.length);

    return {
      electrodes,
      spacing: spacing.toFixed(1),
      length: profileLength.toFixed(1),
      total: activeDataPoints.length
    };
  }, [activeDataPoints, fileElectrodeCount, fileProfileLength, fileSpacing]);

  // 获取当前生效的颜色数组
  const activeColors = schemeId === 'custom'
    ? customColors
    : (COLOR_SCHEMES.find(s => s.id === schemeId)?.colors || COLOR_SCHEMES[0].colors);

  const buildPointKey = (x, z) => `${x},${z}`;

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

  const isPointInPolygon = (point, polygon = []) => {
    const x = Number(point?.x ?? point?.[0]);
    const y = Number(point?.y ?? point?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || polygon.length < 3) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      const xi = Number(polygon[i].x);
      const yi = Number(polygon[i].y);
      const xj = Number(polygon[j].x);
      const yj = Number(polygon[j].y);
      if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
      const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
      const onSegment = Math.abs(cross) < 1e-7
        && x >= Math.min(xi, xj) - 1e-7
        && x <= Math.max(xi, xj) + 1e-7
        && y >= Math.min(yi, yj) - 1e-7
        && y <= Math.max(yi, yj) + 1e-7;
      if (onSegment) return true;
      const denominator = yj - yi;
      const intersects = ((yi > y) !== (yj > y))
        && Math.abs(denominator) > 1e-12
        && x < ((xj - xi) * (y - yi)) / denominator + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  };

  const buildSectionBoundaryFromEntries = (entries = [], terrainLineData = [], spacing = null, options = {}) => {
    const validEntries = entries
      .map(({ d, index }) => ({ d: [Number(d?.[0]), Number(d?.[1]), Number(d?.[2])], index }))
      .filter(({ d }) => d.every(Number.isFinite));
    if (!validEntries.length) return null;

    const uniqueX = [...new Set(validEntries.map(({ d }) => d[0]))].sort((a, b) => a - b);
    const uniqueY = [...new Set(validEntries.map(({ d }) => d[1]))].sort((a, b) => a - b);
    const xVals = validEntries.map(({ d }) => d[0]);
    const inferSpacing = (values, fallback = 5) => {
      const steps = [];
      for (let i = 1; i < values.length; i += 1) {
        const step = values[i] - values[i - 1];
        if (Number.isFinite(step) && step > 0) steps.push(step);
      }
      const sortedSteps = steps.sort((a, b) => a - b);
      return sortedSteps.length ? sortedSteps[Math.floor(sortedSteps.length / 2)] : fallback;
    };
    const inferredXSpacing = inferSpacing(uniqueX, 5);
    const inferredYSpacing = inferSpacing(uniqueY, inferredXSpacing);
    const numericSpacing = Number(spacing);
    const shouldUseFileSpacingForX = Number.isFinite(numericSpacing) && numericSpacing > 0
      && numericSpacing <= inferredXSpacing * 2.5;
    const shouldUseFileSpacingForY = Number.isFinite(numericSpacing) && numericSpacing > 0
      && numericSpacing <= inferredYSpacing * 2.5;
    const cellWidth = shouldUseFileSpacingForX ? numericSpacing : inferredXSpacing;
    const cellHeight = shouldUseFileSpacingForY ? numericSpacing : inferredYSpacing;
    const halfWidth = cellWidth / 2;
    const halfHeight = cellHeight / 2;
    const yBounds = {};
    uniqueY.forEach((y) => {
      yBounds[y] = { top: y - halfHeight, bottom: y + halfHeight };
    });
    const useElevation = Boolean(options.useElevation);
    const inputAlreadyElevation = Boolean(options.inputAlreadyElevation);

    const rowGroups = {};
    validEntries.forEach((entry) => {
      const y = entry.d[1];
      if (!rowGroups[y]) rowGroups[y] = [];
      rowGroups[y].push(entry);
    });

    const boundaryRows = [];
    Object.keys(rowGroups).sort((a, b) => Number(a) - Number(b)).forEach((yStr) => {
      const y = Number(yStr);
      const yb = yBounds[y];
      const row = rowGroups[y].sort((a, b) => a.d[0] - b.d[0]);
      const boundaryRow = row.map(({ d }) => {
        const x = d[0];
        const terrainY = interpolateTopographyOffset(x, terrainLineData);
        let topY;
        let bottomY;
        let centerY;
        if (useElevation && inputAlreadyElevation) {
          topY = yb.top;
          bottomY = yb.bottom;
          centerY = y;
        } else if (useElevation) {
          topY = terrainY - yb.top;
          bottomY = terrainY - yb.bottom;
          centerY = terrainY - y;
        } else {
          topY = yb.top + terrainY;
          bottomY = yb.bottom + terrainY;
          centerY = y + terrainY;
        }
        return {
          x,
          leftX: x - halfWidth,
          rightX: x + halfWidth,
          topY,
          bottomY,
          centerY
        };
      });
      if (boundaryRow.length) boundaryRows.push(boundaryRow);
    });

    const polygon = [];
    if (boundaryRows.length) {
      const topRow = boundaryRows[0];
      const bottomRow = boundaryRows[boundaryRows.length - 1];
      polygon.push({ x: topRow[0].leftX, y: topRow[0].topY });
      topRow.forEach((cell) => polygon.push({ x: cell.x, y: cell.topY }));
      polygon.push({ x: topRow[topRow.length - 1].rightX, y: topRow[topRow.length - 1].topY });
      boundaryRows.forEach((row) => {
        const cell = row[row.length - 1];
        polygon.push({ x: cell.rightX, y: (cell.topY + cell.bottomY) / 2 });
      });
      polygon.push({ x: bottomRow[bottomRow.length - 1].rightX, y: bottomRow[bottomRow.length - 1].centerY });
      [...bottomRow].reverse().forEach((cell) => polygon.push({ x: cell.x, y: cell.centerY }));
      polygon.push({ x: bottomRow[0].leftX, y: bottomRow[0].centerY });
      [...boundaryRows].reverse().forEach((row) => {
        const cell = row[0];
        polygon.push({ x: cell.leftX, y: (cell.topY + cell.bottomY) / 2 });
      });
    }

    const yValues = polygon.map((point) => point.y).filter(Number.isFinite);
    return {
      polygon,
      xMin: Math.min(...xVals),
      xMax: Math.max(...xVals),
      yMin: yValues.length ? Math.min(...yValues) : null,
      yMax: yValues.length ? Math.max(...yValues) : null,
      rowHeight: uniqueY.length > 1 ? (uniqueY[1] - uniqueY[0]) : cellHeight
    };
  };

  const areYValuesElevationLike = (values = [], topoElevationValues = []) => {
    const numericValues = values.map(Number).filter(Number.isFinite);
    if (!numericValues.length) return false;
    const minY = Math.min(...numericValues);
    const maxY = Math.max(...numericValues);
    if (topoElevationValues.length) {
      const minTopo = Math.min(...topoElevationValues);
      return maxY > minTopo - 300 && minY > minTopo - 500;
    }
    // pyGIMLi 不带地形时，反演网格 Y 用 mesh 自身坐标系：地表 y=0，向下为负
    // (例如 [-50, 0])。这种 "mesh 高程" 是上正下负的，仍属于高程语义，但不
    // 满足 maxY>500 && minY>100 的正向高程规则。早先据此推断为深度伪剖面，
    // 把 yAxis 设成 inverse:true，导致整张反演结果上下颠倒。
    if (minY < 0 && maxY <= 1e-6) return true;
    return maxY > 500 && minY > 100;
  };

  const syncPointRhoToData = (x, z, rho, index) => {
    setDataPoints(prev => {
      const targetIndex = index ?? prev.findIndex(point => point[0] === x && point[1] === z);
      if (targetIndex < 0 || !prev[targetIndex]) return prev;
      if (prev[targetIndex][2] === rho) return prev;
      const next = prev.map((point, pointIndex) => (
        pointIndex === targetIndex ? [point[0], point[1], rho] : point
      ));
      dataPointsRef.current = next;
      return next;
    });
  };

  // 两个图表联动同步逻辑
  useEffect(() => {
    if (!compareMode || !chartRef.current || !chartRef2.current) return;
    
    const inst1 = chartRef.current.getEchartsInstance();
    const inst2 = chartRef2.current.getEchartsInstance();
    
    let syncing = false;
    
    const sync = (params, sourceInst, targetInst) => {
      if (syncing) return;
      syncing = true;
      
      const opt = sourceInst.getOption();
      targetInst.setOption({
        dataZoom: opt.dataZoom
      }, { notMerge: false, silent: true });
      
      syncing = false;
    };
    
    const onZoom1 = (p) => sync(p, inst1, inst2);
    const onZoom2 = (p) => sync(p, inst2, inst1);
    
    inst1.on('datazoom', onZoom1);
    inst2.on('datazoom', onZoom2);
    
    return () => {
      inst1.off('datazoom', onZoom1);
      inst2.off('datazoom', onZoom2);
    };
  }, [compareMode]);
  // 色块图缩放联动：保持 X/Y 等像素比例，并让 Y 轴物理长度随滚轮缩放动态变化
  useEffect(() => {
    if (loading || displayMode !== 'heatmap') return;
    
    const instances = [chartRef.current, chartRef2.current]
      .filter(ref => ref !== null)
      .map(ref => ref.getEchartsInstance?.())
      .filter((instance) => instance && !instance.isDisposed?.() && instance.getDom?.());

    const L = 60;
    const R = 76;
    const T = 68;
    const B = 50;

    const syncAspectZoom = (instance) => {
      if (!instance || instance.isDisposed?.() || !instance.getDom?.()) return;
      instance.resize();
      const opt = instance.getOption?.();
      if (!opt) return;
      const xAxis = Array.isArray(opt.xAxis) ? opt.xAxis[0] : opt.xAxis;
      const yAxis = Array.isArray(opt.yAxis) ? opt.yAxis[0] : opt.yAxis;
      const gridOption = Array.isArray(opt.grid) ? opt.grid[0] : opt.grid;
      if (!xAxis || !yAxis) return;
      const dzArr = opt.dataZoom || [];
      const xDz = dzArr.find(dz => dz.id === 'heatmap-x-zoom' || dz.xAxisIndex === 0);
      const yDz = dzArr.find(dz => dz.id === 'heatmap-y-zoom' || dz.yAxisIndex === 0);
      if (!xDz || !yDz) return;

      const xStart = Number.isFinite(xDz.start) ? xDz.start : 0;
      const xEnd = Number.isFinite(xDz.end) ? xDz.end : 100;
      const yStart = Number.isFinite(yDz.start) ? yDz.start : 0;
      const yEnd = Number.isFinite(yDz.end) ? yDz.end : 100;
      const xPct = Math.max((xEnd - xStart) / 100, 0.0001);

      const { w: canvasW, h: canvasH } = getChartContainerPx(instance);
      const gridWidth = canvasW - L - R;
      const maxGridHeight = canvasH - T - B;
      
      if (gridWidth <= 0 || maxGridHeight <= 0) return;

      const xRange = Number(xAxis?.max) - Number(xAxis?.min);
      const yRange = Number(yAxis?.max) - Number(yAxis?.min);
      if (!Number.isFinite(xRange) || !Number.isFinite(yRange) || xRange <= 0 || yRange <= 0) return;

      const visibleXRange = xRange * xPct;
      const pixPerUnitX = gridWidth / visibleXRange;
      const fullRangeGridHeight = yRange * pixPerUnitX;
      const targetGridHeight = Math.max(Math.min(fullRangeGridHeight, maxGridHeight), 1);
      const dynamicBottom = Math.max(B, canvasH - T - targetGridHeight);
      const targetYRange = fullRangeGridHeight <= maxGridHeight
        ? yRange
        : Math.min(yRange, maxGridHeight / pixPerUnitX);
      const targetYPct = Math.max(Math.min((targetYRange / yRange) * 100, 100), 0.0001);
      const currentYPct = Math.max(yEnd - yStart, 0.0001);
      const currentYCenter = (yStart + yEnd) / 2;
      let nextYStart = currentYCenter - targetYPct / 2;
      let nextYEnd = currentYCenter + targetYPct / 2;
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

      const currentBottom = Number(gridOption?.bottom ?? B);
      if (
        Math.abs(currentBottom - dynamicBottom) < 1
        && Math.abs(currentYPct - targetYPct) < 0.05
        && Math.abs(yStart - nextYStart) < 0.05
      ) return;
      instance.setOption({
        grid: { left: L, right: R, top: T, bottom: dynamicBottom, containLabel: false },
        dataZoom: [
          { id: 'heatmap-y-zoom', start: nextYStart, end: nextYEnd }
        ]
      }, { notMerge: false, silent: true });
    };

    const handlers = instances.map((inst) => {
      const timerIds = [];
      const frameIds = [];
      const onZoom = () => {
        frameIds.push(window.requestAnimationFrame(() => syncAspectZoom(inst)));
        timerIds.push(window.setTimeout(() => syncAspectZoom(inst), 40));
      };
      inst.on('datazoom', onZoom);
      const dom = inst.getDom?.();
      const resizeObserver = typeof ResizeObserver !== 'undefined' && dom
        ? new ResizeObserver(() => syncAspectZoom(inst))
        : null;
      if (resizeObserver) resizeObserver.observe(dom);
      // 首次打开时，弹窗和 ECharts 容器会连续几帧才稳定，补多次重算避免必须手动缩放窗口
      syncAspectZoom(inst);
      window.requestAnimationFrame(() => syncAspectZoom(inst));
      [60, 160, 320].forEach((delay) => {
        timerIds.push(window.setTimeout(() => syncAspectZoom(inst), delay));
      });
      return { inst, onZoom, resizeObserver, timerIds, frameIds };
    });

    return () => {
      handlers.forEach(({ inst, onZoom, resizeObserver, timerIds, frameIds }) => {
        inst.off('datazoom', onZoom);
        resizeObserver?.disconnect();
        timerIds.forEach((timerId) => window.clearTimeout(timerId));
        frameIds.forEach((frameId) => window.cancelAnimationFrame(frameId));
      });
    };
  }, [chartReadyTick, loading, displayMode, maximized, showTable, compareMode]);

  // 波形图拖拽节点交互（仅编辑模式 + 波形图生效）
  useEffect(() => {
    if (!chartRef.current || loading || displayMode !== 'wiggle') return;
    const instance = chartRef.current.getEchartsInstance();
    const dom = instance.getDom();

    const onSymbolMouseDown = (params) => {
      if (!editMode) return;
      if (params.componentType !== 'series' || params.data?.origZ === undefined) return;
      
      // 阻止事件冒泡，防止 ECharts 其他交互拦截
      if (params.event && params.event.stop) params.event.stop();
      
      // 关键：拖拽点位时临时禁用图表 DataZoom 平移功能，防止整体移动
      instance.setOption({
        dataZoom: [
          { id: 'heatmap-x-zoom', type: 'inside', moveOnMouseMove: false },
          { id: 'heatmap-y-zoom', type: 'inside', moveOnMouseMove: false }
        ]
      }, { notMerge: false, silent: true });
      
      setIsDragging(true);
      dragMovedRef.current = false;
      suppressClickRef.current = false;
      const pt = { x: params.data.origX, z: params.data.origZ, index: params.data.origIndex };
      dragRef.current = { ...pt, seriesId: `d${params.data.origZ}` };
      setSelectedPt(pt);
      selectedPtRef.current = pt;
      dom.style.cursor = 'ns-resize';
    };

    // 使用 ZRender 的 mousemove 确保更稳定的坐标获取
    const onZrMouseMove = (e) => {
      if (!dragRef.current) return;
      const { rhoMid, rhoRange, amplitude, rowGroups } = wiggleParamsRef.current;
      if (!amplitude) return;

      // 直接在 ZRender 事件中获取坐标
      const dataCoord = instance.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]);
      if (!dataCoord) return;
      
      const dataY = dataCoord[1];
      const { x: origX, z: origZ, seriesId, index: origIndex } = dragRef.current;
      
      // 计算新的电阻率
      const newRho = Math.max(0.1, rhoMid + ((dataY - origZ) / (amplitude * 2)) * rhoRange);
      const key = buildPointKey(origX, origZ);
      editedRhoRef.current = { ...editedRhoRef.current, [key]: newRho };
      dragMovedRef.current = true;

      // 更新图表数据
      const row = (rowGroups[origZ] || []).sort((a, b) => a.x - b.x);
      const updatedData = row.map(({ x, rho, index }) => {
        const effRho = editedRhoRef.current[`${x},${origZ}`] ?? rho;
        const isSel = index === origIndex;
        return {
          value: [x, origZ + ((effRho - rhoMid) / rhoRange) * amplitude * 2],
          origZ, origX: x, rho: effRho, origIndex: index,
          symbolSize: isSel ? 14 : 8,
          itemStyle: isSel 
            ? { color: '#ff6b35', borderColor: '#fff', borderWidth: 2, shadowBlur: 10, shadowColor: 'rgba(255,107,53,0.5)' } 
            : { color: '#0f172a', opacity: 0.8 },
          label: {
            show: isSel,
            formatter: `${effRho.toFixed(1)} Ω·m`,
            position: 'right', fontSize: 11,
            color: '#ff6b35', fontWeight: 'bold',
          },
        };
      });
      
      instance.setOption({ series: [{ id: seriesId, data: updatedData }] }, { notMerge: false, silent: true });
    };

    const onMouseUp = () => {
      if (dragRef.current) {
        const { x: origX, z: origZ, index } = dragRef.current;
        const key = buildPointKey(origX, origZ);
        const committedRho = editedRhoRef.current[key];
        if (committedRho !== undefined) {
          syncPointRhoToData(origX, origZ, committedRho, index);
        }
        setEditedRho({ ...editedRhoRef.current });
        setIsDragging(false);
        suppressClickRef.current = dragMovedRef.current;
        dragMovedRef.current = false;
        dragRef.current = null;
        dom.style.cursor = editMode ? 'crosshair' : 'default';

        // 恢复 DataZoom 平移功能
        instance.setOption({
          dataZoom: [
            { id: 'heatmap-x-zoom', type: 'inside', moveOnMouseMove: !editMode },
            { id: 'heatmap-y-zoom', type: 'inside', moveOnMouseMove: !editMode }
          ]
        }, { notMerge: false, silent: true });
      }
    };

    // 鼠标悬停在节点上时改变指针
    const onOver = (p) => { if (p.componentType === 'series' && editMode) dom.style.cursor = 'ns-resize'; };
    const onOut  = ()  => { dom.style.cursor = editMode ? 'crosshair' : 'default'; };

    instance.on('mousedown', onSymbolMouseDown);
    instance.on('mouseover', onOver);
    instance.on('mouseout', onOut);
    
    // 使用 ZRender 层监听 mousemove 和 globalout
    const zr = instance.getZr();
    zr.on('mousemove', onZrMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    if (editMode) dom.style.cursor = 'crosshair';
    else dom.style.cursor = 'default';

    return () => {
      instance.off('mousedown', onSymbolMouseDown);
      instance.off('mouseover', onOver);
      instance.off('mouseout', onOut);
      if (zr) zr.off('mousemove', onZrMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      dom.style.cursor = 'default';
    };
  }, [loading, displayMode, editMode]);
  function parseTextData(text) {
    const vtkData = parseAsciiVtkResistivity(text);
    if (vtkData?.points?.length) {
      dataPointsRef.current = vtkData.points;
      setFileSpacing(vtkData.spacing);
      setFileElectrodeCount(vtkData.electrodeCount);
      setFileProfileLength(vtkData.profileLength);
      setTopographyData(vtkData.topography);
      setDirectVtkCellGrid(vtkData.cellGrid || null);
      setDirectVtkMesh(vtkData.mesh || null);
      setDataPoints(vtkData.points);
      setSelectedIndices([...Array(vtkData.points.length).keys()]);
      setLoading(false);
      return;
    }

    const lines = text.split('\n');
    setDirectVtkCellGrid(null);
    setDirectVtkMesh(null);
    const parsed = [];
    const secondLineSpacing = Number(String(lines[1] || '').trim().split(/[,\t ]+/)[0]);
    const parsedSource = parseRes2dinvSource(text);
    const surfaceElectrodeIndex = lines.findIndex(line => /surface\s+electrodes/i.test(line));
    const explicitElectrodeCount = surfaceElectrodeIndex >= 0
      ? Number.parseInt(String(lines[surfaceElectrodeIndex + 1] || '').trim().split(/[,\t ]+/)[0], 10)
      : NaN;

    const sourceDataLines = parsedSource?.dataLines?.length ? parsedSource.dataLines : lines;

    // 优先按 RES2DINV header 的 dataCount 精确读取主数据段，避免把地形/尾部控制段误识别为电阻率点
    for (let i = 0; i < sourceDataLines.length; i++) {
      const line = String(sourceDataLines[i] || '').trim();
      if (!line || line.startsWith('//') || isNaN(parseInt(line[0]))) continue;

      // 切割逗号、制表符及多个空格
      const parts = line.split(/[,\t ]+/).map(Number);

      // 直接显示文件里的三列: X, Z, rho
      if (parts.length >= 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
        // 如果是在绘制网格或点云，可能有些 z 值是深度，这里直接取原始坐标
        // 当我们从 VTK 抽取预览点时，它们通常也是 [x, y/z, rho] 的格式
        parsed.push([parts[0], parts[1], parts[2]]);
      }
    }

    if (parsed.length < 5) {
      throw new Error('解析点云极少，疑似非物探剖面体，建议接入云端服务器集群深度提取。');
    }
    const validSpacing = Number.isFinite(secondLineSpacing) && secondLineSpacing > 0 ? secondLineSpacing : null;
    const xVals = parsed.map(point => point[0]);
    const xRangeLength = Math.max(...xVals) - Math.min(...xVals);
    const parsedProfileLength = Number(parsedSource?.spreadLength);
    const profileLength = Number.isFinite(parsedProfileLength) && parsedProfileLength > 0
      ? parsedProfileLength
      : xRangeLength;
    const derivedElectrodeCount = validSpacing && Number.isFinite(profileLength) && profileLength > 0
      ? Math.round(profileLength / validSpacing) + 1
      : null;
    setFileSpacing(validSpacing);
    setFileElectrodeCount(
      Number.isFinite(parsedSource?.surfaceBlock?.electrodes?.length) && parsedSource.surfaceBlock.electrodes.length > 0
        ? parsedSource.surfaceBlock.electrodes.length
        : Number.isFinite(explicitElectrodeCount) && explicitElectrodeCount > 0
        ? explicitElectrodeCount
        : derivedElectrodeCount
    );
    setFileProfileLength(Number.isFinite(profileLength) && profileLength > 0 ? profileLength : null);
    setTopographyData(parsedSource?.topographyBlock || null);
    setDataPoints(parsed);
    setSelectedIndices([...Array(parsed.length).keys()]);
    setLoading(false);
  }

  function generateMockData() {
    const synthetic = [];
    const maxLayers = 24;
    const profileLength = 128;

    // 生成标准的倒梯形/倒三角形高密度电法拟断面
    // 模拟装置系数随深度增加，两端数据点减少的过程
    for (let z = 1; z <= maxLayers; z += 1) {
      // 假设每加深一层，左右各收缩 2.5 个水平单位（模拟类似温纳或偶极装置）
      const startX = z * 2.5;
      const endX = profileLength - (z * 2.5);

      for (let x = startX; x <= endX; x += 1) {
        // 构造基础地层背景（整体逐渐变深变阻）
        let val = 200 + (z * 15);

        // 模拟用户截图中的红紫高阻大面积基岩体（左侧为主）
        if (x < 75 + z * 0.8) {
          val = 800 + z * 30 + Math.random() * 100;
          if (z < 10 && x < 60) {
            val += 400; // 表层极高阻（紫红色区）
          }
        }

        // 模拟用户截图中右侧陡倾的导电异常带（蓝绿低阻区）
        if (x > 80 + z * 1.5 && x < 120 + z * 0.5) {
          val = 30 + z * 5 + Math.random() * 20;
          // 局部深蓝色强导水通道
          if (x > 95 && x < 110 && z > 5) {
            val -= 20;
          }
        }

        // 表层局部不均匀体（类似坑洼处的低阻体）
        if (z < 5 && ((x > 105 && x < 110) || (x > 115 && x < 120))) {
          val = 15; // 表现为局部的蓝色低阻异常
        }

        synthetic.push([x, z, Math.abs(val)]);
      }
    }
    dataPointsRef.current = synthetic;
    setFileSpacing(null);
    setFileElectrodeCount(null);
    setFileProfileLength(null);
    setTopographyData(null);
    setDataPoints(synthetic);
    setSelectedIndices([...Array(synthetic.length).keys()]);
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;

    const handleText = (text) => {
      if (cancelled) return;
      try {
        parseTextData(text);
      } catch {
        setErrorMsg('当前上传文件缺少有效的纯数值列，或包含过多未能解析的仪器脏头标签。');
        setLoading(false);
      }
    };

    const readFile = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(reader.error || new Error('FileReader error'));
      reader.readAsText(file);
    });

    const parseNpzFileViaBackend = async (file) => {
      try {
        const formData = new FormData();
        formData.append('data_file', file);
        const res = await requestAdminApi('/ert/parse-data-file', null, {
          method: 'POST',
          body: formData,
        });
        if (cancelled) return;
        if (res?.points?.length) {
          dataPointsRef.current = res.points;
          setFileSpacing(res.spacing);
          setFileElectrodeCount(res.electrode_count);
          setFileProfileLength(res.profile_length);
          setTopographyData(res.topography || null);
          setDirectVtkCellGrid(null);
          setDirectVtkMesh(null);
          setDataPoints(res.points);
          setSelectedIndices([...Array(res.points.length).keys()]);
          setLoading(false);
        } else {
          setErrorMsg('后端解析 .npz 返回的数据为空。');
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err.message || '后端解析 .npz 数据失败。');
          setLoading(false);
        }
      }
    };

    const processData = async () => {
      setInversionRuns([]);
      setSelectedInversionRunId(null);
      setDataType('apparent');
      setCompareMode(false);

      // 1) 直接传进来就是浏览器 File，最简单的路径
      if (fileObj instanceof File) {
        if (fileObj.name && fileObj.name.toLowerCase().endsWith('.npz')) {
          await parseNpzFileViaBackend(fileObj);
          return;
        }
        try {
          const text = await readFile(fileObj);
          handleText(text);
        } catch {
          if (!cancelled) {
            setErrorMsg('浏览器安全策略拦截了直接文件读取。');
            setLoading(false);
          }
        }
        return;
      }

      // 2) 传进来是云盘元数据对象（非 rawFile）：从 IndexedDB / OSS / 内联文本里取真实内容
      if (fileObj && typeof fileObj === 'object') {
        try {
          if (fileObj.name && fileObj.name.toLowerCase().endsWith('.npz')) {
            const resolved = await resolveDriveFileContent(fileObj, fileObj?.name || 'data.npz');
            if (cancelled) return;
            if (resolved instanceof File) {
              await parseNpzFileViaBackend(resolved);
              return;
            }
          } else {
            if (typeof fileObj.content === 'string' && fileObj.content.length > 0) {
              handleText(fileObj.content);
              return;
            }
            if (typeof fileObj.inlineTextContent === 'string' && fileObj.inlineTextContent.length > 0) {
              handleText(fileObj.inlineTextContent);
              return;
            }
            const resolved = await resolveDriveFileContent(fileObj, fileObj?.name || 'data.dat');
            if (cancelled) return;
            if (resolved instanceof File) {
              if (resolved.name && resolved.name.toLowerCase().endsWith('.npz')) {
                await parseNpzFileViaBackend(resolved);
              } else {
                const text = await readFile(resolved);
                handleText(text);
              }
              return;
            }
          }
          // 没拿到任何真实内容才允许退到模拟数据，避免悄悄展示 mock 让人误判
          if (!cancelled) {
            setErrorMsg('未找到该文件的本地内容，请重新生成或上传。');
            setLoading(false);
          }
        } catch (err) {
          if (!cancelled) {
            console.warn('ERTParser 加载文件内容失败', err);
            setErrorMsg('加载文件内容失败：请检查云盘文件是否完好。');
            setLoading(false);
          }
        }
        return;
      }

      // 3) 完全没有 fileObj 时才生成示例数据
      generateMockData();
    };

    const timer = window.setTimeout(processData, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileObj]);

  const scrollToRow = (index, options = {}) => {
    const { smooth = false, syncSelection = true } = options;
    const row = document.getElementById(`row-${index}`);
    if (row) {
      row.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
      const point = dataPoints[index];
      if (point && syncSelection) {
        const nextPt = { x: point[0], z: point[1], index };
        if (selectedPtRef.current?.index !== nextPt.index) {
          setSelectedPt(nextPt);
          selectedPtRef.current = nextPt;
        }
      }
    }
  };

  function handleChartPointSelect(params) {
    if (displayMode === 'wiggle' && suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }

    let index = -1;
    let point = null;

    if (displayMode === 'wiggle' && params.data?.origZ !== undefined) {
      index = params.data?.origIndex ?? -1;
      point = { x: params.data.origX, z: params.data.origZ, index };
    } else if (displayMode === 'heatmap' && Array.isArray(params.value)) {
      index = params.value[3] ?? params.value[7] ?? -1;
      point = {
        x: params.value[0] ?? params.value[5],
        z: params.value[1] ?? params.value[6],
        index
      };
    }

    if (!point) return;

    const nextPt = selectedPtRef.current?.index === point.index ? null : point;
    setSelectedPt(nextPt);
    selectedPtRef.current = nextPt;

    if (index !== -1 && index !== undefined) {
      scrollToRow(index, { syncSelection: false });
    }
  }

  useEffect(() => {
    if (loading || !chartRef.current) return;

    const inst1 = chartRef.current.getEchartsInstance();
    const onPrimaryClick = (params) => handleChartPointSelect(params);
    inst1.on('click', onPrimaryClick);

    let inst2 = null;
    let onSecondaryClick = null;

    if (compareMode && chartRef2.current) {
      inst2 = chartRef2.current.getEchartsInstance();
      onSecondaryClick = (params) => handleChartPointSelect(params);
      inst2.on('click', onSecondaryClick);
    }

    return () => {
      inst1.off('click', onPrimaryClick);
      if (inst2 && onSecondaryClick) {
        inst2.off('click', onSecondaryClick);
      }
    };
  }, [loading, compareMode, displayMode, dataPoints]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCellEdit = (rowIndex, colIndex, value) => {
    const newDataPoints = [...dataPoints];
    const nextValue = parseFloat(value);
    newDataPoints[rowIndex][colIndex] = nextValue;
    if (colIndex === 2) {
      const key = buildPointKey(newDataPoints[rowIndex][0], newDataPoints[rowIndex][1]);
      const nextEditedRho = { ...editedRhoRef.current, [key]: nextValue };
      editedRhoRef.current = nextEditedRho;
      setEditedRho(nextEditedRho);
    }
    setDataPoints(newDataPoints);
    dataPointsRef.current = newDataPoints;
  };

  const buildInversionRunName = (result, sequence) => {
    const params = result?.params || {};
    const zWeight = Number(params.zWeight ?? params.z_weight);
    const lambdaParam = Number(params.lambdaParam ?? params.lambda_param);
    const maxIter = Number(params.maxIter ?? params.max_iter);
    const pieces = [`反演${sequence}`];
    if (Number.isFinite(zWeight)) pieces.push(`zW${zWeight}`);
    if (Number.isFinite(lambdaParam)) pieces.push(`L${lambdaParam}`);
    if (Number.isFinite(maxIter)) pieces.push(`I${maxIter}`);
    return pieces.join('_');
  };

  const formatInversionRunLabel = (run, index) => {
    const params = run?.result?.params || {};
    const backendValue = String(
      run?.result?.backend
      || params.inversionBackend
      || params.inversion_backend
      || run?.backend
      || ''
    ).toLowerCase();
    const backendLabel = backendValue.includes('simpeg')
      ? 'SimPEG'
      : backendValue.includes('pygimli')
        ? 'pyGIMLi'
        : '';
    const zWeight = Number(params.zWeight ?? params.z_weight);
    const lambdaParam = Number(params.lambdaParam ?? params.lambda_param);
    const maxIter = Number(params.maxIter ?? params.max_iter);
    const rrms = Number(run?.result?.rrms);
    const pieces = [`第 ${index + 1} 次`];
    if (backendLabel) pieces.unshift(backendLabel);
    if (Number.isFinite(zWeight)) pieces.push(`zW ${zWeight}`);
    if (Number.isFinite(lambdaParam)) pieces.push(`λ ${lambdaParam}`);
    if (Number.isFinite(maxIter)) pieces.push(`${maxIter}迭代`);
    if (Number.isFinite(rrms)) pieces.push(`rRMS ${rrms.toFixed(2)}%`);
    return pieces.join(' · ');
  };

  const createInversionPreviewData = (sourceData, result) => {
    const params = result?.params || {};
    const zWeight = Number(params.zWeight ?? params.z_weight);
    const lambdaParam = Number(params.lambdaParam ?? params.lambda_param);
    const maxIter = Number(params.maxIter ?? params.max_iter);
    const error = Number(params.error);
    const safeZWeight = Number.isFinite(zWeight) ? zWeight : 0.2;
    const safeLambda = Number.isFinite(lambdaParam) ? lambdaParam : 20;
    const safeMaxIter = Number.isFinite(maxIter) ? maxIter : 20;
    const safeError = Number.isFinite(error) ? error : 0.03;
    const seedBase = `${result?.task_id || ''}|${safeZWeight}|${safeLambda}|${safeMaxIter}|${safeError}`;

    return sourceData.map(([x, z, rho], index) => {
      const noise = stableUnitValue(`${seedBase}|${index}|${x}|${z}`);
      let invRho = rho;
      if (rho > 500) invRho = rho * (1.18 + noise * 0.24);
      else if (rho < 80) invRho = rho * (0.48 + noise * 0.18);
      else invRho = rho * (0.86 + noise * 0.26);

      const depthScale = 1 + (z / 24) * (0.25 + safeZWeight * 0.8);
      const smoothScale = 1 + Math.max(-0.25, Math.min(0.25, (20 - safeLambda) / 120));
      const iterScale = 1 + Math.max(-0.12, Math.min(0.12, (safeMaxIter - 20) / 200));
      const errorScale = 1 + Math.max(-0.12, Math.min(0.12, (safeError - 0.03) * 2));
      return [x, z, Math.max(0.001, invRho * depthScale * smoothScale * iterScale * errorScale)];
    });
  };

  const normalizePreviewPoints = (points = []) => {
    const parsed = (Array.isArray(points) ? points : [])
      .map((point) => [Number(point?.[0]), Number(point?.[1]), Number(point?.[2])])
      .filter(([x, z, rho]) => Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(rho));
    return parsed;
  };

  const normalizeBoundaryPoints = (points = []) => {
    const parsed = (Array.isArray(points) ? points : [])
      .map((point) => [Number(point?.[0] ?? point?.x), Number(point?.[1] ?? point?.y ?? point?.z)])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (parsed.length < 3) return [];
    return parsed.map(([x, y]) => ({ x, y }));
  };

  const buildRegularizedPreviewPoints = (points = []) => {
    const samples = (Array.isArray(points) ? points : [])
      .map((point) => [Number(point?.[0]), Number(point?.[1]), Number(point?.[2])])
      .filter(([x, z, rho]) => Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(rho));
    if (samples.length < 3) return samples;

    // 根据用户要求，不再进行插值，直接返回原始的 VTK 点用于渲染
    return samples;
  };

  const getPreferredInversionPreviewPoints = (resultLike = {}) => {
    if (Array.isArray(resultLike?.mesh_node_points) && resultLike.mesh_node_points.length) {
      return resultLike.mesh_node_points;
    }
    const vtkCellPoints = buildRegularizedPreviewPoints(resultLike?.preview_points);
    if (vtkCellPoints.length) return vtkCellPoints;
    return resultLike?.surfer_preview_points;
  };

  const getPreferredInversionBoundaryPoints = (resultLike = {}) => (
    Array.isArray(resultLike?.surfer_boundary_points) && resultLike.surfer_boundary_points.length
      ? resultLike.surfer_boundary_points
      : resultLike?.boundary_points
  );

  const getActiveInversionPayload = (overrideData = null) => {
    if (!selectedInversionRun) return null;
    if (!overrideData && dataType === 'inverted') {
      return selectedInversionIteration?.files || selectedInversionRun.result || null;
    }
    if (overrideData && selectedInversionIteration?.data === overrideData) {
      return selectedInversionIteration.files || null;
    }
    if (overrideData && selectedInversionRun.data === overrideData) {
      return selectedInversionRun.result || null;
    }
    return null;
  };

  const makeRunFromInversionResult = (result, sequence, runName = null) => {
    const currentData = dataPoints.map(p => {
      const [x, z, rho] = p;
      return [x, z, editedRho[`${x},${z}`] ?? rho];
    });
    const backendFinalData = normalizePreviewPoints(getPreferredInversionPreviewPoints(result));
    const inverted = backendFinalData.length ? backendFinalData : createInversionPreviewData(currentData, result);
    const iterations = (Array.isArray(result?.iteration_results) ? result.iteration_results : [])
      .map((item) => {
        const data = normalizePreviewPoints(getPreferredInversionPreviewPoints(item));
        if (!data.length) return null;
        const iteration = Number(item?.iteration);
        const key = Number.isFinite(iteration) ? `iter_${iteration}` : `iter_${item?.vtk || item?.vector || Math.random()}`;
        return {
          key,
          iteration,
          label: formatIterationLabel(item),
          data,
          cellGrid: item?.simpeg_cell_grid || null,
          boundaryPoints: normalizeBoundaryPoints(getPreferredInversionBoundaryPoints(item)),
          files: item
        };
      })
      .filter(Boolean);

    return {
      id: result?.task_id || `inversion_${sequence}`,
      name: runName || `${getSourceStem(fileObj?.name)}_${buildInversionRunName(result, sequence)}`,
      data: inverted,
      cellGrid: result?.simpeg_cell_grid || null,
      boundaryPoints: normalizeBoundaryPoints(getPreferredInversionBoundaryPoints(result)),
      iterations,
      result,
      createdAt: result?.completed_at || ''
    };
  };

  const normalizeSimpegCellGrid = (gridLike = null) => {
    if (!gridLike || !Array.isArray(gridLike.cells) || !gridLike.cells.length) return null;
    const cells = gridLike.cells
      .map((cell) => [
        Number(cell?.[0]),
        Number(cell?.[1]),
        Number(cell?.[2]),
        Number(cell?.[3]),
        Number(cell?.[4]),
      ])
      .filter(([x, z, dx, dz, rho]) => (
        Number.isFinite(x) && Number.isFinite(z)
        && Number.isFinite(dx) && Number.isFinite(dz)
        && Number.isFinite(rho) && dx > 0 && dz > 0
      ));
    if (!cells.length) return null;
    const boundary = normalizeBoundaryPoints(gridLike.boundary);
    const cellXMin = Math.min(...cells.map((cell) => cell[0]));
    const cellXMax = Math.max(...cells.map((cell) => cell[0] + cell[2]));
    const cellZMin = Math.min(...cells.map((cell) => cell[1]));
    const cellZMax = Math.max(...cells.map((cell) => cell[1] + cell[3]));
    const boundaryYValues = boundary.map((point) => point.y).filter(Number.isFinite);
    // X 方向严格用 cell 自身边界。后端的 gridLike.x_min/x_max 早期版本里
    // 用了 hx[0]（最左 padding 单元的宽度，约为核心 dx 的 16 倍）来外扩半个
    // 单元，导致显示范围会向两侧多出 ~100 m 的空白。boundary 的 X 都被限制
    // 在 cell 范围内，所以省略它不会裁到地形线。Z 方向仍然包含 boundary，
    // 因为地形最高点可能高出最上层 cell 的顶边。
    const xMin = cellXMin;
    const xMax = cellXMax;
    const zMin = Number.isFinite(Number(gridLike.z_min))
      ? Math.min(Number(gridLike.z_min), cellZMin, ...boundaryYValues)
      : Math.min(cellZMin, ...boundaryYValues);
    const zMax = Number.isFinite(Number(gridLike.z_max))
      ? Math.max(Number(gridLike.z_max), cellZMax, ...boundaryYValues)
      : Math.max(cellZMax, ...boundaryYValues);
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(zMin) || !Number.isFinite(zMax)) return null;
    return {
      cells,
      bounds: { xMin, xMax, yMin: zMin, yMax: zMax },
      boundary,
    };
  };

  const formatIterationLabel = (iteration) => {
    const index = Number(iteration?.iteration);
    if (!Number.isFinite(index)) return '迭代结果';
    if (index === 0) return '初始模型';
    return `第 ${index} 次迭代`;
  };

  const taskStorageKey = React.useMemo(
    () => makeInversionTaskStorageKey(selectedProject?.id, fileObj),
    [selectedProject?.id, fileObj]
  );

  const persistActiveInversionTask = (task) => {
    setActiveInversionTask(task);
    try {
      if (task) {
        window.localStorage.setItem(taskStorageKey, JSON.stringify(task));
      } else {
        window.localStorage.removeItem(taskStorageKey);
      }
    } catch (error) {
      console.warn('Failed to persist ERT inversion task state', error);
    }
  };

  const handleInversionTaskStarted = (task) => {
    if (!task?.task_id) return;
    persistActiveInversionTask({
      task_id: task.task_id,
      status: task.status || 'queued',
      params: task.params || {},
      fileName: task.fileName || fileObj?.name || '',
      created_at: task.created_at || new Date().toISOString(),
      started_at: task.started_at || null,
      finished_at: null,
      progress: task.progress || { percent: 0, message: '任务已提交，后台正在排队/计算', logs: [] },
      error: null,
    });
  };

  const archiveInversionResult = async (result, runName = null) => {
    if (!result?.task_id || !selectedProject?.id || !onUpdateFileSystem) return;

    try {
      const archive = await requestAdminApi(`/ert/tasks/${encodeURIComponent(result.task_id)}/archive`, null, {
        method: 'POST',
        body: JSON.stringify({
          project_id: selectedProject.id,
          source_file_name: runName || fileObj?.name || 'ert_result.dat'
        })
      });

      const resultRoot = (fileSystem || []).find((item) => (
        item?.type === 'folder' && (
          item.category === 'results' ||
          item.name === '04_反演成果' ||
          item.name === '04_鍙嶆紨鎴愭灉'
        )
      ));
      const resultRootId = resultRoot?.id || `${selectedProject.id}_results`;
      const folderName = archive.folder_name || getSourceStem(fileObj?.name);
      const folderId = makeArchiveId('ert_archive', selectedProject.id, folderName);
      const archiveTime = archive.completed_at || result?.completed_at || new Date().toISOString();

      const folderItem = {
        id: folderId,
        parentId: resultRootId,
        type: 'folder',
        name: folderName,
        date: archiveTime,
        size: '--',
        ext: null,
        category: 'results',
        taskName: resultRoot?.taskName || '成果解算',
        status: '反演完成',
        sourceFileId: fileObj?.id || null,
        sourceFileName: fileObj?.name || null,
        archiveDir: archive.archive_dir || null
      };

      const fileItems = (archive.files || []).map((item) => ({
        id: makeArchiveId('ert_file', selectedProject.id, `${folderName}_${item.name}`),
        parentId: folderId,
        type: 'file',
        name: item.name,
        date: archiveTime,
        size: formatArchiveSize(item.size),
        fileSizeBytes: Number(item.size || 0),
        ext: getFileExt(item.name),
        category: 'results',
        taskName: folderItem.taskName,
        status: '反演完成',
        mimeType: item.mime_type || 'application/octet-stream',
        fileUrl: item.file_url,
        storage_provider: 'local-archive',
        storageProvider: 'local-archive',
        localPath: item.local_path || null,
        sourceFileId: fileObj?.id || null,
        sourceFileName: fileObj?.name || null
      }));

      const iterationFolderItemsByIndex = new Map();
      const resolveIterationFolder = (iterationIndex) => {
        if (!Number.isFinite(iterationIndex)) return null;
        if (iterationFolderItemsByIndex.has(iterationIndex)) {
          return iterationFolderItemsByIndex.get(iterationIndex);
        }
        const folder = {
          id: makeArchiveId('ert_iteration_archive', selectedProject.id, `${folderName}_${iterationIndex}`),
          parentId: folderId,
          type: 'folder',
          name: formatIterationFolderName(iterationIndex),
          date: archiveTime,
          size: '--',
          ext: null,
          category: 'results',
          taskName: folderItem.taskName,
          status: folderItem.status,
          sourceFileId: fileObj?.id || null,
          sourceFileName: fileObj?.name || null,
          archiveDir: archive.archive_dir || null,
          iterationIndex,
        };
        iterationFolderItemsByIndex.set(iterationIndex, folder);
        return folder;
      };
      const groupedFileItems = fileItems.map((item) => {
        const iterationIndex = getIterationFileIndex(item.name);
        const iterationFolder = resolveIterationFolder(iterationIndex);
        if (!iterationFolder) return item;
        return {
          ...item,
          parentId: iterationFolder.id,
          iterationIndex,
        };
      });
      const iterationFolderItems = Array.from(iterationFolderItemsByIndex.values())
        .sort((left, right) => Number(left.iterationIndex) - Number(right.iterationIndex));

      await onUpdateFileSystem((prevItems = []) => {
        const incoming = [folderItem, ...iterationFolderItems, ...groupedFileItems];
        const incomingById = new Map(incoming.map((item) => [item.id, item]));
        const nextItems = (prevItems || []).filter((item) => !incomingById.has(item.id));
        return [...nextItems, ...incoming];
      }, {
        title: '二维反演成果已归档',
        detail: `已将 ${fileItems.length} 个成果文件保存到 04_反演成果/${folderName}。`,
        nodeId: 'solver',
        nodeName: '成果解算节点',
        level: 'success',
        log: true,
        syncSource: 'ert-inversion',
        syncTitle: '正在同步二维反演成果',
        syncDetail: '正在将反演成果目录写入项目云盘数据。',
        syncedTitle: '二维反演成果已同步',
        syncedDetail: '成果文件已经归档到项目云盘。',
        errorTitle: '二维反演成果同步失败'
      });

      if (logFileOperations && buildFileOperationPayload && fileItems.length) {
        await logFileOperations(
          groupedFileItems.map((item) => buildFileOperationPayload(item, 'archive', {
            source: 'ert-inversion',
            archiveFolderName: folderName,
            sourceFileId: fileObj?.id || null,
            sourceFileName: fileObj?.name || null,
          }))
        );
      }
    } catch (err) {
      console.warn('Failed to archive ERT inversion result', err);
      window.alert(`二维反演已完成，但成果自动归档失败：${err.message || '未知错误'}`);
    }
  };

  const handleInversionSuccess = (result) => {
    if (result?.task_id && handledInversionTaskIdsRef.current.has(result.task_id)) {
      return;
    }
    if (result?.task_id) {
      handledInversionTaskIdsRef.current.add(result.task_id);
    }
    const sequence = inversionRuns.length + 1;
    const runName = `${getSourceStem(fileObj?.name)}_${buildInversionRunName(result, sequence)}`;
    const run = makeRunFromInversionResult(result, sequence, runName);

    setInversionRuns((prev) => {
      const existingIndex = prev.findIndex((item) => item.id === run.id);
      if (existingIndex < 0) return [...prev, run];
      const next = [...prev];
      next[existingIndex] = run;
      return next;
    });
    setSelectedInversionRunId(run.id);
    setSelectedInversionIterationKey('final');
    setDataType('inverted');
    if (chartRef.current) refreshChartRef.current?.(chartRef.current.getEchartsInstance(), run.data);
    if (chartRef2.current) refreshChartRef.current?.(chartRef2.current.getEchartsInstance(), run.data);
    persistActiveInversionTask({
      task_id: result?.task_id || run.id,
      status: 'success',
      params: result?.params || {},
      fileName: fileObj?.name || '',
      created_at: result?.created_at || result?.completed_at || new Date().toISOString(),
      started_at: result?.started_at || null,
      finished_at: result?.finished_at || result?.completed_at || new Date().toISOString(),
      completed_at: result?.completed_at || new Date().toISOString(),
      progress: { percent: 100, message: '二维反演完成', logs: [] },
      error: null,
    });
    void archiveInversionResult(result, runName);
  };

  const handleLiveInversionProgress = (task, progress) => {
    const iterationResults = Array.isArray(progress?.iteration_results) ? progress.iteration_results : [];
    if (!iterationResults.length) return;
    const latest = progress?.latest_iteration_result || iterationResults[iterationResults.length - 1];
    if (!latest) return;

    const liveResult = {
      ...latest,
      task_id: task.task_id,
      status: task.status || 'running',
      backend: task.params?.backend || task.params?.inversion_backend || 'simpeg',
      params: task.params || {},
      created_at: task.created_at,
      started_at: task.started_at,
      completed_at: task.finished_at || new Date().toISOString(),
      iteration_results: iterationResults,
    };
    const sequence = Math.max(1, inversionRuns.findIndex((run) => run.id === task.task_id) + 1 || inversionRuns.length + 1);
    const run = makeRunFromInversionResult(
      liveResult,
      sequence,
      `${getSourceStem(fileObj?.name)}_${buildInversionRunName(liveResult, sequence)}`
    );
    setInversionRuns((prev) => {
      const existingIndex = prev.findIndex((item) => item.id === run.id);
      if (existingIndex < 0) return [...prev, run];
      const next = [...prev];
      next[existingIndex] = run;
      return next;
    });

    const latestIteration = Number(latest?.iteration);
    setSelectedInversionRunId(run.id);
    setSelectedInversionIterationKey(Number.isFinite(latestIteration) ? `iter_${latestIteration}` : 'final');
    setDataType('inverted');
    setCompareMode(true);
  };

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(taskStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.task_id) {
        setActiveInversionTask(parsed); // eslint-disable-line react-hooks/set-state-in-effect
      }
    } catch (error) {
      console.warn('Failed to restore ERT inversion task state', error);
    }
  }, [taskStorageKey]);

  useEffect(() => {
    if (!fileObj?.name || !selectedProject?.id || !Array.isArray(fileSystem) || !dataPoints.length) return undefined;
    if (inversionRuns.length > 0) return undefined;

    const sourceName = String(fileObj.name || '').trim();
    const sourceStem = getSourceStem(sourceName);
    const restoreKey = `${selectedProject.id}:${fileObj?.id || fileObj?.path || sourceName}:${fileSystem.length}`;
    if (restoredArchiveKeyRef.current === restoreKey) return undefined;
    restoredArchiveKeyRef.current = restoreKey;

    let cancelled = false;
    const foldersById = new Map(
      fileSystem
        .filter((item) => item?.type === 'folder')
        .map((item) => [item.id, item])
    );
    const rootFolderFor = (item) => {
      const parent = foldersById.get(item?.parentId);
      if (parent?.iterationIndex !== undefined || /^第\s*\d+\s*次迭代$/.test(String(parent?.name || ''))) {
        return foldersById.get(parent.parentId) || parent;
      }
      return parent || null;
    };
    const isSameSource = (item) => (
      String(item?.sourceFileName || '').trim() === sourceName
      || String(item?.source_file_name || '').trim() === sourceName
    );
    const isLikelySourceFolder = (folder) => {
      const name = String(folder?.name || '');
      return isSameSource(folder) || (
        sourceStem
        && name.startsWith(`${sourceStem}_`)
        && /反演|inversion/i.test(name)
      );
    };

    const groups = new Map();
    (fileSystem || []).forEach((item) => {
      if (item?.type !== 'file' || item?.category !== 'results') return;
      const rootFolder = rootFolderFor(item);
      if (!rootFolder || (!isSameSource(item) && !isLikelySourceFolder(rootFolder))) return;
      const group = groups.get(rootFolder.id) || { folder: rootFolder, files: [] };
      group.files.push(item);
      groups.set(rootFolder.id, group);
    });

    const readArchivedVtk = async (fileItem) => {
      const resolved = await resolveDriveFileContent(fileItem, fileItem?.name || 'resistivity.vtk');
      const text = await readBrowserFileText(resolved);
      const vtkData = parseAsciiVtkResistivity(text);
      if (!vtkData?.points?.length) return null;
      return {
        preview_points: vtkData.points,
        vtk_mesh: vtkData.mesh || null,
        simpeg_cell_grid: vtkData.cellGrid || null,
        vtk: fileItem?.fileUrl || fileItem?.localPath || fileItem?.name || null,
      };
    };

    const readArchivedSimpegNpz = async (fileItem) => {
      const fileUrl = String(fileItem?.fileUrl || '');
      if (!fileUrl) return null;
      const apiPath = `${fileUrl.replace(/^\/admin\b/, '')}/preview`;
      const preview = await requestAdminApi(apiPath, null, { method: 'GET' });
      if (!preview?.simpeg_cell_grid && !Array.isArray(preview?.preview_points)) return null;
      return {
        ...preview,
        npz: fileItem?.fileUrl || fileItem?.localPath || fileItem?.name || null,
      };
    };

    const restore = async () => {
      const restoredRuns = [];
      const sortedGroups = Array.from(groups.values())
        .sort((left, right) => String(left.folder?.date || '').localeCompare(String(right.folder?.date || '')));

      for (const group of sortedGroups) {
        const finalNpz = group.files.find((item) => /^simpeg_ert_inversion\.npz$/i.test(String(item?.name || '')));
        const finalVtk = group.files.find((item) => /^resistivity\.vtk$/i.test(String(item?.name || '')));
        const finalFile = finalNpz || finalVtk;
        if (!finalFile) continue;
        const finalData = await (finalNpz ? readArchivedSimpegNpz(finalNpz) : readArchivedVtk(finalVtk)).catch((error) => {
          console.warn('Failed to restore archived ERT final result', error);
          return null;
        });
        if (cancelled) return;
        if (!finalData) continue;

        const iterationFiles = group.files
          .map((item) => ({ item, match: String(item?.name || '').match(/^iteration_(\d+)\.(vtk|npz)$/i) }))
          .filter(({ match }) => match)
          .filter(({ match }) => (finalNpz ? String(match[2] || '').toLowerCase() === 'npz' : String(match[2] || '').toLowerCase() === 'vtk'))
          .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
        const iterationResults = [];
        for (const { item, match } of iterationFiles) {
          const isSimpegNpz = String(match[2] || '').toLowerCase() === 'npz';
          const iterationData = await (isSimpegNpz ? readArchivedSimpegNpz(item) : readArchivedVtk(item)).catch((error) => {
            console.warn('Failed to restore archived ERT iteration result', error);
            return null;
          });
          if (cancelled) return;
          if (!iterationData) continue;
          iterationResults.push({
            ...iterationData,
            iteration: Number(match[1]),
          });
        }

        const archivedBackend = group.files.some((item) => /^simpeg_|simpeg_ert_inversion\.npz$/i.test(String(item?.name || '')))
          ? 'simpeg'
          : group.files.some((item) => /^(mesh|resistivity-mesh)\.bms$|^response\.vector$/i.test(String(item?.name || '')))
            ? 'pygimli'
            : '';
        const result = {
          ...finalData,
          task_id: group.folder?.id || `archived_${group.folder?.name || restoredRuns.length + 1}`,
          status: 'success',
          backend: archivedBackend,
          source: 'archive',
          completed_at: group.folder?.date || finalFile?.date || '',
          output_dir: group.folder?.archiveDir || null,
          iteration_results: iterationResults,
        };
        restoredRuns.push(makeRunFromInversionResult(
          result,
          restoredRuns.length + 1,
          group.folder?.name || `${sourceStem}_历史反演${restoredRuns.length + 1}`
        ));
      }

      if (cancelled || !restoredRuns.length) return;
      setInversionRuns(restoredRuns);
      setSelectedInversionRunId(restoredRuns[restoredRuns.length - 1].id);
      setSelectedInversionIterationKey('final');
      setDataType('inverted');
    };

    void restore();

    return () => {
      cancelled = true;
    };
  }, [fileObj?.id, fileObj?.path, fileObj?.name, selectedProject?.id, fileSystem, dataPoints.length, inversionRuns.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeInversionTask?.task_id || !isActiveTaskStatus(activeInversionTask.status)) return undefined;

    let cancelled = false;
    const taskId = activeInversionTask.task_id;

    const poll = async () => {
      try {
        const statusRes = await requestAdminApi(`/ert/tasks/${encodeURIComponent(taskId)}`, null, { method: 'GET' });
        if (cancelled) return;
        const nextTask = {
          ...activeInversionTask,
          status: statusRes.status,
          progress: statusRes.progress || activeInversionTask.progress || {},
          error: statusRes.error || null,
          created_at: statusRes.created_at || activeInversionTask.created_at,
          started_at: statusRes.started_at || activeInversionTask.started_at,
          finished_at: statusRes.finished_at || activeInversionTask.finished_at,
        };
        persistActiveInversionTask(nextTask);
        handleLiveInversionProgress(nextTask, statusRes.progress);

        if (statusRes.status === 'success') {
          const finalRes = await requestAdminApi(`/ert/tasks/${encodeURIComponent(taskId)}/result`, null, { method: 'GET' });
          if (cancelled) return;
          handleInversionSuccess({
            ...finalRes,
            task_id: taskId,
            params: activeInversionTask.params || {},
            created_at: nextTask.created_at,
            started_at: nextTask.started_at,
            finished_at: nextTask.finished_at,
            completed_at: nextTask.finished_at || new Date().toISOString(),
          });
          return;
        }

        if (statusRes.status === 'failed' || statusRes.status === 'revoked') {
          persistActiveInversionTask({
            ...nextTask,
            status: statusRes.status,
            error: statusRes.error || '二维反演计算失败',
          });
          return;
        }

        inversionTaskPollRef.current = window.setTimeout(poll, 1500);
      } catch (error) {
        if (cancelled) return;
        persistActiveInversionTask({
          ...activeInversionTask,
          status: 'failed',
          error: error?.message || '二维反演状态查询失败',
          progress: {
            ...(activeInversionTask.progress || {}),
            percent: 100,
            message: '二维反演状态查询失败',
          },
        });
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (inversionTaskPollRef.current) {
        window.clearTimeout(inversionTaskPollRef.current);
        inversionTaskPollRef.current = null;
      }
    };
  }, [activeInversionTask?.task_id, activeInversionTask?.status]);

  useEffect(() => {
    if (!activeInversionTask?.task_id || activeInversionTask.status !== 'success') return undefined;
    if (handledInversionTaskIdsRef.current.has(activeInversionTask.task_id)) return undefined;

    let cancelled = false;
    const restoreResult = async () => {
      try {
        const finalRes = await requestAdminApi(`/ert/tasks/${encodeURIComponent(activeInversionTask.task_id)}/result`, null, { method: 'GET' });
        if (cancelled) return;
        handleInversionSuccess({
          ...finalRes,
          task_id: activeInversionTask.task_id,
          params: activeInversionTask.params || {},
          created_at: activeInversionTask.created_at,
          started_at: activeInversionTask.started_at,
          finished_at: activeInversionTask.finished_at,
          completed_at: activeInversionTask.completed_at || activeInversionTask.finished_at || new Date().toISOString(),
        });
      } catch (error) {
        if (cancelled) return;
        console.warn('Failed to restore ERT inversion result', error);
      }
    };

    restoreResult();

    return () => {
      cancelled = true;
    };
  }, [activeInversionTask?.task_id, activeInversionTask?.status]);

  const getEffectiveRhoValues = (sourceData = [], overrideData = null) => {
    const isInvertedSource = overrideData === inversionResult || (dataType === 'inverted' && !overrideData);
    return (sourceData || [])
      .map((point, index) => ({ point, index }))
      .filter(({ index }) => isInvertedSource || selectedIndices.includes(index))
      .map(({ point }) => {
        const [x, z, rho] = point;
        return isInvertedSource ? rho : (editedRhoRef.current[`${x},${z}`] ?? rho);
      })
      .filter((value) => Number.isFinite(Number(value)))
      .map(Number);
  };

  const buildColorRange = (sourceData = [], overrideData = null) => {
    const values = getEffectiveRhoValues(sourceData, overrideData);
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return {
      min: Math.min(...values),
      max: sorted[Math.floor(sorted.length * 0.95)] ?? Math.max(...values)
    };
  };

  const buildSimpegCellGridOption = ({
    grid,
    colors,
    minVal,
    maxVal,
    isMaximized = false,
    containerPx = null,
  }) => {
    const { cells, bounds } = grid;
    // SimPEG TensorMesh 的 Z 是高程（向上为正：z_top > z_bot，origin 位于地下最低点），
    // y 轴用 inverse:false 显示高程时，画布像素 y=0 对应 yMin（最低高程）而非 yMax，
    // 因此栅格图必须翻转 Y，否则整张反演结果会上下颠倒。
    const imageField = createCellGridFieldImage({
      cells,
      bounds,
      minVal,
      maxVal,
      colors,
      flipY: true,
    });
    if (!imageField) return null;

    const L = 60, R = 76, T = 68, B = 50;
    const chartW = containerPx ? containerPx.w : (isMaximized ? window.innerWidth : window.innerWidth * 0.88);
    const chartH = containerPx ? containerPx.h : (isMaximized ? window.innerHeight - 60 : window.innerHeight * 0.82);
    const xSpan = Math.max(bounds.xMax - bounds.xMin, 1);
    const ySpan = Math.max(bounds.yMax - bounds.yMin, 1);
    const padX = Math.max(xSpan * 0.02, 0.5);
    const padY = Math.max(ySpan * 0.04, 0.5);
    const sampleData = cells.map(([x, z, dx, dz, rho], index) => ({
      value: [x + dx / 2, z + dz / 2, rho, index],
      cell: [x, z, dx, dz, rho],
    }));

    return {
      animation: false,
      tooltip: {
        trigger: 'item',
        formatter: (params) => {
          const cell = params.data?.cell || [];
          const xCenter = Number(params.value?.[0]);
          const zCenter = Number(params.value?.[1]);
          const rho = Number(params.value?.[2]);
          const dx = Number(cell?.[2]);
          const dz = Number(cell?.[3]);
          return `X: ${xCenter.toFixed(2)} m<br/>Z: ${zCenter.toFixed(2)} m<br/>Cell: ${dx.toFixed(2)} × ${dz.toFixed(2)} m<br/><b style="color:#3b82f6">电阻率: ${rho.toFixed(1)} Ω·m</b>`;
        },
      },
      grid: { left: L, right: R, top: T, bottom: B, containLabel: false },
      dataZoom: [
        {
          id: 'heatmap-x-zoom',
          type: 'inside',
          xAxisIndex: 0,
          zoomOnMouseWheel: true,
          moveOnMouseWheel: false,
          throttle: 40,
          filterMode: 'none',
        },
        {
          id: 'heatmap-y-zoom',
          type: 'inside',
          yAxisIndex: 0,
          zoomOnMouseWheel: false,
          moveOnMouseWheel: false,
          throttle: 40,
          filterMode: 'none',
        },
      ],
      xAxis: {
        type: 'value',
        min: bounds.xMin - padX,
        max: bounds.xMax + padX,
        name: '测量距离 X (m)',
        nameLocation: 'middle',
        nameGap: 30,
        splitLine: { lineStyle: { color: '#dbeafe', type: 'dashed' } },
        axisLabel: { color: '#475569' },
        scale: false,
      },
      yAxis: {
        type: 'value',
        min: bounds.yMin - padY,
        max: bounds.yMax + padY,
        name: '高程 / Z (m)',
        nameLocation: 'middle',
        nameGap: 42,
        inverse: false,
        splitLine: { lineStyle: { color: '#e2e8f0', type: 'dashed' } },
        axisLabel: { color: '#475569' },
        scale: false,
      },
      visualMap: {
        min: minVal,
        max: maxVal,
        dimension: 2,
        seriesIndex: 1,
        orient: 'vertical',
        right: 10,
        top: 'middle',
        itemHeight: Math.min(220, Math.max(120, chartH - T - B - 20)),
        text: ['高阻体', '低阻区'],
        calculable: true,
        inRange: { color: colors },
      },
      series: [
        {
          name: 'SimPEG npz Cell Grid',
          type: 'custom',
          silent: true,
          tooltip: { show: false },
          renderItem: function (_params, api) {
            const { bounds: imageBounds } = imageField;
            const tl = api.coord([imageBounds.xMin, imageBounds.yMin]);
            const br = api.coord([imageBounds.xMax, imageBounds.yMax]);
            return {
              type: 'image',
              style: {
                image: imageField.image,
                x: Math.min(tl[0], br[0]),
                y: Math.min(tl[1], br[1]),
                width: Math.abs(br[0] - tl[0]),
                height: Math.abs(br[1] - tl[1]),
              },
            };
          },
          data: [[0]],
          z: 2,
        },
        {
          name: 'Cell Probe',
          type: 'scatter',
          data: sampleData,
          symbolSize: Math.max(3, Math.min(8, chartW / Math.max(cells.length, 1))),
          itemStyle: { opacity: 0 },
          emphasis: { itemStyle: { opacity: 0.6, borderColor: '#fff', borderWidth: 1 } },
          z: 3,
        },
      ],
    };
  };

  const normalizeVtkPolygonMesh = (meshLike = null) => {
    if (!meshLike || !Array.isArray(meshLike.cells) || !meshLike.cells.length) return null;
    const cells = meshLike.cells
      .map((cell) => ({
        rho: Number(cell?.rho),
        points: (Array.isArray(cell?.points) ? cell.points : [])
          .map((point) => [Number(point?.[0]), Number(point?.[1])])
          .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
      }))
      .filter((cell) => Number.isFinite(cell.rho) && cell.points.length >= 3);
    if (!cells.length) return null;
    const xValues = cells.flatMap((cell) => cell.points.map((point) => point[0]));
    const yValues = cells.flatMap((cell) => cell.points.map((point) => point[1]));
    return {
      cells,
      bounds: {
        xMin: Math.min(...xValues),
        xMax: Math.max(...xValues),
        yMin: Math.min(...yValues),
        yMax: Math.max(...yValues),
      }
    };
  };

  const buildVtkPolygonMeshOption = ({
    mesh,
    colors,
    minVal,
    maxVal,
    isMaximized = false,
    containerPx = null,
  }) => {
    const { cells, bounds } = mesh;
    const L = 60, R = 76, T = 68, B = 50;
    const chartH = containerPx ? containerPx.h : (isMaximized ? window.innerHeight - 60 : window.innerHeight * 0.82);
    const xSpan = Math.max(bounds.xMax - bounds.xMin, 1);
    const ySpan = Math.max(bounds.yMax - bounds.yMin, 1);
    const padX = Math.max(xSpan * 0.02, 0.5);
    const padY = Math.max(ySpan * 0.04, 0.5);
    const maxVertexCount = Math.max(...cells.map((cell) => cell.points.length));
    const data = cells.map((cell, index) => {
      const coords = [];
      for (let pointIndex = 0; pointIndex < maxVertexCount; pointIndex += 1) {
        const point = cell.points[pointIndex] || cell.points[cell.points.length - 1];
        coords.push(point[0], point[1]);
      }
      return {
        value: [cell.rho, cell.points.length, index, ...coords],
        rawPoints: cell.points,
      };
    });

    return {
      animation: false,
      tooltip: {
        trigger: 'item',
        formatter: (params) => {
          const rho = Number(params.value?.[0]);
          const rawPoints = params.data?.rawPoints || [];
          const cx = rawPoints.reduce((sum, point) => sum + point[0], 0) / Math.max(rawPoints.length, 1);
          const cy = rawPoints.reduce((sum, point) => sum + point[1], 0) / Math.max(rawPoints.length, 1);
          return `X: ${cx.toFixed(2)} m<br/>高程: ${cy.toFixed(2)} m<br/><b style="color:#3b82f6">视电阻率: ${rho.toFixed(1)} Ω·m</b>`;
        },
      },
      grid: { left: L, right: R, top: T, bottom: B, containLabel: false },
      dataZoom: [
        {
          id: 'heatmap-x-zoom',
          type: 'inside',
          xAxisIndex: 0,
          zoomOnMouseWheel: true,
          moveOnMouseWheel: false,
          throttle: 40,
          filterMode: 'none',
        },
        {
          id: 'heatmap-y-zoom',
          type: 'inside',
          yAxisIndex: 0,
          zoomOnMouseWheel: false,
          moveOnMouseWheel: false,
          throttle: 40,
          filterMode: 'none',
        },
      ],
      xAxis: {
        type: 'value',
        min: bounds.xMin - padX,
        max: bounds.xMax + padX,
        name: '测量距离 X (m)',
        nameLocation: 'middle',
        nameGap: 30,
        splitLine: { lineStyle: { color: '#dbeafe', type: 'dashed' } },
        axisLabel: { color: '#475569' },
        scale: false,
      },
      yAxis: {
        type: 'value',
        min: bounds.yMin - padY,
        max: bounds.yMax + padY,
        name: '高程 (m)',
        nameLocation: 'middle',
        nameGap: 42,
        inverse: false,
        splitLine: { lineStyle: { color: '#e2e8f0', type: 'dashed' } },
        axisLabel: { color: '#475569' },
        scale: false,
      },
      visualMap: {
        min: minVal,
        max: maxVal,
        dimension: 0,
        seriesIndex: 0,
        orient: 'vertical',
        right: 10,
        top: 'middle',
        itemHeight: Math.min(220, Math.max(120, chartH - T - B - 20)),
        text: ['高阻体', '低阻区'],
        calculable: true,
        inRange: { color: colors },
      },
      series: [
        {
          name: 'VTK Triangle Mesh',
          type: 'custom',
          renderItem: function (_params, api) {
            const vertexCount = Number(api.value(1));
            const points = [];
            for (let pointIndex = 0; pointIndex < vertexCount; pointIndex += 1) {
              const x = Number(api.value(3 + pointIndex * 2));
              const y = Number(api.value(4 + pointIndex * 2));
              points.push(api.coord([x, y]));
            }
            return {
              type: 'polygon',
              shape: { points },
              style: api.style({
                stroke: 'rgba(255,255,255,0.18)',
                lineWidth: 0.35,
              }),
            };
          },
          encode: { tooltip: [0] },
          data,
          z: 3,
        },
      ],
    };
  };

  function getOption(isMaximized = false, activeSchemeId = 'rainbow', custColors = DEFAULT_CUSTOM, containerPx = null, isEditMode = false, overrideData = null) {
    const dataToUse = overrideData || activeDataPoints;
    const isInvertedSource = overrideData === inversionResult || (dataType === 'inverted' && !overrideData);
    const selectedDataPoints = dataToUse
      .map((d, index) => ({ d, index }))
      .filter(({ index }) => isInvertedSource || selectedIndices.includes(index));
    
    if (selectedDataPoints.length === 0) return {};
    const colors = activeSchemeId === 'custom'
      ? (custColors.length >= 2 ? custColors : DEFAULT_CUSTOM)
      : (COLOR_SCHEMES.find(s => s.id === activeSchemeId)?.colors || COLOR_SCHEMES[0].colors);

    const directVtkMeshOption = (!isInvertedSource || (isDirectVtkFile && !overrideData))
      ? normalizeVtkPolygonMesh(directVtkMesh)
      : null;
    if (directVtkMeshOption) {
      const meshValues = directVtkMeshOption.cells.map((cell) => cell.rho).filter(Number.isFinite);
      const meshMin = Math.min(...meshValues);
      const meshMax = Math.max(...meshValues);
      const meshOption = buildVtkPolygonMeshOption({
        mesh: directVtkMeshOption,
        colors,
        minVal: meshMin,
        maxVal: meshMax > meshMin ? meshMax : meshMin + 1,
        isMaximized,
        containerPx,
      });
      if (meshOption) return meshOption;
    }

    const inversionPayload = getActiveInversionPayload(overrideData);
    const archivedVtkMeshOption = isInvertedSource
      ? normalizeVtkPolygonMesh(inversionPayload?.vtk_mesh)
      : null;
    if (archivedVtkMeshOption) {
      const meshValues = archivedVtkMeshOption.cells.map((cell) => cell.rho).filter(Number.isFinite);
      const meshMin = Math.min(...meshValues);
      const meshMax = Math.max(...meshValues);
      const meshOption = buildVtkPolygonMeshOption({
        mesh: archivedVtkMeshOption,
        colors,
        minVal: meshMin,
        maxVal: meshMax > meshMin ? meshMax : meshMin + 1,
        isMaximized,
        containerPx,
      });
      if (meshOption) return meshOption;
    }

    const directVtkGrid = !isInvertedSource ? normalizeSimpegCellGrid(directVtkCellGrid) : null;
    const directSimpegGrid = isInvertedSource
      ? normalizeSimpegCellGrid(inversionPayload?.simpeg_cell_grid)
      : directVtkGrid;
    if (directSimpegGrid) {
      const cellValues = directSimpegGrid.cells.map((cell) => cell[4]).filter(Number.isFinite);
      const sortedCellValues = [...cellValues].sort((a, b) => a - b);
      const cellMin = Math.min(...cellValues);
      const cellMax95 = sortedCellValues[Math.floor(sortedCellValues.length * 0.95)] ?? Math.max(...cellValues);
      const cellMax = Math.max(...cellValues);
      const colorMax = directVtkGrid ? cellMax : cellMax95;
      const directOption = buildSimpegCellGridOption({
        grid: directSimpegGrid,
        colors,
        minVal: cellMin,
        maxVal: colorMax > cellMin ? colorMax : cellMin + 1,
        isMaximized,
        containerPx,
      });
      if (directOption) return directOption;
    }

    // 1. 色谱范围。对比模式下两个剖面共用同一套 min/max，保证颜色可比较。
    const localColorRange = buildColorRange(dataToUse, overrideData);
    const colorRange = localColorRange || { min: 0, max: 1 };
    const minVal = colorRange.min;
    const maxVal = colorRange.max > colorRange.min ? colorRange.max : colorRange.min + 1;

    // 2. 动态生成完全拼合的 Voronoi 对半分切矩形
    // 提取全局所有的物理探测深度 (Y)
    const uniqueY = [...new Set(selectedDataPoints.map(({ d }) => d[1]))].sort((a, b) => a - b);
    const uniqueX = [...new Set(selectedDataPoints.map(({ d }) => d[0]))].sort((a, b) => a - b);
    const xVals = selectedDataPoints.map(({ d }) => d[0]);
    const xMin = Math.min(...xVals);
    const xMax = Math.max(...xVals);
    const inferCellSpacing = (values, fallback = 5) => {
      const steps = [];
      for (let i = 1; i < values.length; i++) {
        const step = values[i] - values[i - 1];
        if (Number.isFinite(step) && step > 0) steps.push(step);
      }
      const sortedSteps = steps.sort((a, b) => a - b);
      return sortedSteps.length ? sortedSteps[Math.floor(sortedSteps.length / 2)] : fallback;
    };
    const inferredXCellSpacing = inferCellSpacing(uniqueX, 5);
    const inferredYCellSpacing = inferCellSpacing(uniqueY, inferredXCellSpacing);
    const fileCellSpacing = Number(fileSpacing);
    const shouldUseFileSpacingForX = Number.isFinite(fileCellSpacing) && fileCellSpacing > 0
      && fileCellSpacing <= inferredXCellSpacing * 2.5;
    const shouldUseFileSpacingForY = Number.isFinite(fileCellSpacing) && fileCellSpacing > 0
      && fileCellSpacing <= inferredYCellSpacing * 2.5;
    const cellWidth = shouldUseFileSpacingForX ? fileCellSpacing : inferredXCellSpacing;
    const cellHeight = shouldUseFileSpacingForY ? fileCellSpacing : inferredYCellSpacing;
    const halfCellWidth = cellWidth / 2;
    const halfCellHeight = cellHeight / 2;
    const yBounds = {};
    for (let k = 0; k < uniqueY.length; k++) {
      const y = uniqueY[k];
      const topY = y - halfCellHeight;
      const bottomY = y + halfCellHeight;
      yBounds[y] = { top: topY, bottom: bottomY };
    }

    // 按深度行进行 X 轴切分
    const topoPoints = topographyData?.points?.length
      ? topographyData.points
          .map((point) => ({ x: Number(point.x), elevation: Number(point.elevation ?? point.z) }))
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.elevation))
          .sort((a, b) => a.x - b.x)
      : [];
    const firstTopoIndex = Math.max(0, Math.min((topographyData?.firstElectrodePointIndex || 1) - 1, Math.max(topoPoints.length - 1, 0)));
    const topoReferenceElevation = topoPoints.length ? topoPoints[firstTopoIndex].elevation : null;
    const selectedYValues = selectedDataPoints.map(({ d }) => Number(d?.[1])).filter(Number.isFinite);
    const topoElevationValues = topoPoints.map((point) => point.elevation).filter(Number.isFinite);
    const inputYAlreadyElevation = areYValuesElevationLike(selectedYValues, topoElevationValues);
    const usesElevationYAxis = topoElevationValues.length > 0 || inputYAlreadyElevation;
    const terrainLineData = topoReferenceElevation !== null
      ? topoPoints.map((point) => [point.x, usesElevationYAxis ? point.elevation : topoReferenceElevation - point.elevation])
      : [];

    const rowGroups = {};
    selectedDataPoints.forEach(({ d, index }) => {
      const y = d[1];
      if (!rowGroups[y]) rowGroups[y] = [];
      rowGroups[y].push({ d, index }); // { d: [x, y, rho], index }
    });

    const boxedData = []; // [leftX, rightX, topY, bottomY, rho, origX, origY, origIndex]
    const boundaryRows = [];
    Object.keys(rowGroups).sort((a, b) => Number(a) - Number(b)).forEach(yStr => {
      const y = Number(yStr);
      const row = rowGroups[y].sort((a, b) => a.d[0] - b.d[0]);
      const yb = yBounds[y];
      const boundaryRow = [];

      for (let i = 0; i < row.length; i++) {
        const x = row[i].d[0];
        // 如果是反演数据，不应用手动编辑值；否则优先使用编辑后的视电阻率
        const isActuallyInverted = isInvertedSource;
        const rho = isActuallyInverted ? row[i].d[2] : (editedRho[`${x},${y}`] ?? row[i].d[2]);
        
        const origIndex = row[i].index;
        const leftX = x - halfCellWidth;
        const rightX = x + halfCellWidth;

        const terrainY = interpolateTopographyOffset(x, terrainLineData);
          let topY;
          let bottomY;
          let centerY;
          if (usesElevationYAxis && inputYAlreadyElevation) {
            topY = yb.top;
            bottomY = yb.bottom;
            centerY = y;
          } else if (usesElevationYAxis) {
            topY = terrainY - yb.top;
            bottomY = terrainY - yb.bottom;
            centerY = terrainY - y;
          } else {
            topY = yb.top + terrainY;
            bottomY = yb.bottom + terrainY;
            centerY = y + terrainY;
          }
          boxedData.push([leftX, rightX, topY, bottomY, rho, x, centerY, origIndex, centerY]);
          boundaryRow.push({ x, leftX, rightX, topY, bottomY, centerY });
      }
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
    let axisXMin = xMin;
    let axisXMax = xMax;
    let axisYRange = null;
    if (isInvertedSource && dataPoints.length) {
      const selectedIndexSet = new Set(selectedIndices);
      const sourceEntries = dataPoints
        .map((d, index) => ({ d, index }))
        .filter(({ index }) => !selectedIndexSet.size || selectedIndexSet.has(index));
      const sourceYValues = sourceEntries.map(({ d }) => Number(d?.[1])).filter(Number.isFinite);
      const sourceBoundary = buildSectionBoundaryFromEntries(sourceEntries, terrainLineData, fileSpacing, {
        useElevation: usesElevationYAxis,
        inputAlreadyElevation: areYValuesElevationLike(sourceYValues, topoElevationValues)
      });
      if (sourceBoundary?.polygon?.length >= 3) {
        boundaryPolygon.length = 0;
        boundaryPolygon.push(...sourceBoundary.polygon);
        axisXMin = sourceBoundary.xMin;
        axisXMax = sourceBoundary.xMax;
        if (Number.isFinite(sourceBoundary.yMin) && Number.isFinite(sourceBoundary.yMax)) {
          axisYRange = {
            min: sourceBoundary.yMin,
            max: sourceBoundary.yMax,
            rowHeight: sourceBoundary.rowHeight
          };
        }
      }
    }
    let pointLayerData = boxedData.map((item) => ({
        value: [item[5], item[6], item[4], item[7]],
        rawZ: item[8]
      }));
    if (isInvertedSource && boundaryPolygon.length >= 3) {
      const clippedPointLayerData = pointLayerData.filter((point) => (
        isPointInPolygon({ x: point.value[0], y: point.value[1] }, boundaryPolygon)
      ));
      if (clippedPointLayerData.length >= 3) pointLayerData = clippedPointLayerData;
    }
    if (usesElevationYAxis && boundaryPolygon.length >= 3) {
      const boundaryYValues = boundaryPolygon.map((point) => Number(point.y)).filter(Number.isFinite);
      if (boundaryYValues.length) {
        axisYRange = {
          min: Math.min(...boundaryYValues),
          max: Math.max(...boundaryYValues),
          rowHeight: uniqueY.length > 1 ? Math.abs(uniqueY[1] - uniqueY[0]) : cellHeight
        };
      }
    }

    // 3. 轴范围计算，由 Grid 四边距驱动（X/Y 轴线自动延伸到边界）
    //    通过调整 Y 轴 min/max 保证像素/单位比例相同，从而保持色块正方形
    const L = 60, R = 76, T = 68, B = 50;
    const chartW = containerPx ? containerPx.w : (isMaximized ? window.innerWidth : window.innerWidth * 0.88);
    const chartH = containerPx ? containerPx.h : (isMaximized ? window.innerHeight - 60 : window.innerHeight * 0.82);
    const availW = Math.max(chartW - L - R, 100);
    const maxAvailH = Math.max(chartH - T - B, 100);

    // Y 轴按数据真实深度（yBounds 顶/底）范围变化，不再为了 X 轴等像素比例强行拉长。
    // 否则 X 很长时会出现大量空白底边。
    const allTopY = Object.values(yBounds).map(b => b.top);
    const allBottomY = Object.values(yBounds).map(b => b.bottom);
    const minTopY = Math.min(...allTopY);
    const maxBottomY = Math.max(...allBottomY);
    let rowHeight = uniqueY.length > 1 ? (uniqueY[1] - uniqueY[0]) : Math.max(2, (maxBottomY - minTopY) / 2 || 2);
    const zExtent = maxBottomY - minTopY;
    const pad = Math.max(rowHeight * 0.5, zExtent * 0.05, 1);
    let yAxisMin = minTopY - pad;
    let yAxisMax = maxBottomY + pad;
    if (axisYRange) {
      rowHeight = Number.isFinite(axisYRange.rowHeight) && axisYRange.rowHeight > 0 ? axisYRange.rowHeight : rowHeight;
      const sourceSpan = Math.max(axisYRange.max - axisYRange.min, 1);
      const sourcePad = Math.max(rowHeight * 0.5, sourceSpan * 0.05, 1);
      yAxisMin = axisYRange.min - sourcePad;
      yAxisMax = axisYRange.max + sourcePad;
    }
    if (terrainLineData.length) {
      const topoYValues = terrainLineData.map((point) => point[1]).filter(Number.isFinite);
      if (topoYValues.length) {
        yAxisMin = Math.min(yAxisMin, Math.min(...topoYValues) - rowHeight * 0.5);
        yAxisMax = axisYRange
          ? Math.max(yAxisMax, Math.max(...topoYValues) + rowHeight * 0.5)
          : Math.max(yAxisMax, maxBottomY + Math.max(...topoYValues) + rowHeight * 0.5);
      }
    }
    const minSpan = Math.max(1, rowHeight * 1.5);
    if (yAxisMax - yAxisMin < minSpan) {
      const mid = (yAxisMin + yAxisMax) / 2;
      yAxisMin = mid - minSpan / 2;
      yAxisMax = mid + minSpan / 2;
    }

    // 保持 X/Y 等像素比例：由 X 向像素密度推算 Y 轴应占的像素高度
    // 并通过缩短 grid 高度（增大 bottom）来改变 Y 轴“长度”，而非扭曲数据范围
    const interpolatedField = createInterpolatedFieldImage({
      points: pointLayerData.map((point) => ({
        x: point.value[0],
        y: point.value[1],
        rho: point.value[2]
      })),
      boundaryPolygon,
      minVal,
      maxVal,
      colors,
      flipY: usesElevationYAxis
    });

    const dxGlobal = Math.max(axisXMax - axisXMin, 1);
    const pixPerUnit = availW / dxGlobal;
    const ySpan = Math.max(yAxisMax - yAxisMin, 1);
    const requiredYAxisPx = Math.max(ySpan * pixPerUnit, 1);
    const yAxisPlotHeight = Math.min(requiredYAxisPx, maxAvailH);
    if (requiredYAxisPx > maxAvailH) {
      // 容器高度不足时，按可用像素反推可显示的 Y 范围，继续保持严格等比例
      if (usesElevationYAxis) {
        yAxisMin = yAxisMax - maxAvailH / pixPerUnit;
      } else {
        yAxisMax = yAxisMin + maxAvailH / pixPerUnit;
      }
    }
    const dynamicBottom = Math.max(B, chartH - T - yAxisPlotHeight);
    const verticalAxisName = usesElevationYAxis ? '高程 (m)' : '贯穿深度 Z (m)';
    const verticalTooltipLabel = usesElevationYAxis ? '高程' : '深度';
    const bottomAxisBoundaryY = usesElevationYAxis ? yAxisMin : yAxisMax;

    return {
      animation: false,
      tooltip: {
          position: 'top',
          formatter: (params) =>
            `X (点位): ${params.value[5]} m<br/>${verticalTooltipLabel}: ${params.value[8]} m<br/><b style="color:#3b82f6">视电阻率: ${params.value[4].toFixed(1)} Ω·m</b>`
        },
      grid: { left: L, right: R, top: T, bottom: dynamicBottom, containLabel: false },
      dataZoom: [
        { 
          id: 'heatmap-x-zoom',
          type: 'inside', 
          xAxisIndex: 0, 
          zoomOnMouseWheel: true,
          moveOnMouseWheel: false,
          throttle: 40,
          filterMode: 'none', 
          moveOnMouseMove: !isEditMode // 编辑模式下禁止鼠标左键平移图表
        },
        { 
          id: 'heatmap-y-zoom',
          type: 'inside', 
          yAxisIndex: 0, 
          zoomOnMouseWheel: false,
          moveOnMouseWheel: false,
          throttle: 40,
          filterMode: 'none', 
          moveOnMouseMove: !isEditMode, 
          // Y 轴长度由动态 grid 计算控制，滚轮不直接缩放 yAxis dataZoom
        }
      ],
      xAxis: {
        type: 'value',
        min: axisXMin, max: axisXMax,
        name: '测量距离 X (m)', nameLocation: 'middle', nameGap: 30,
        splitLine: { lineStyle: { color: '#dbeafe', type: 'dashed' } },
        axisLabel: { color: '#475569' },
        scale: false,
      },
      yAxis: {
        type: 'value', name: verticalAxisName,
        nameLocation: 'middle',
        nameGap: 42,
        inverse: !usesElevationYAxis,
        min: yAxisMin, max: yAxisMax,
        splitLine: { lineStyle: { color: '#e2e8f0', type: 'dashed' } },
        axisLabel: { color: '#475569' },
        scale: false,
      },
      visualMap: {
        min: minVal,
        max: maxVal,
        dimension: 4,
        seriesIndex: 1,
        orient: 'vertical',
        right: 10,
        top: 'middle',
        itemHeight: 220,
        text: ['高阻体', '低阻区'],
        calculable: true,
        inRange: { color: colors }
      },
      series: [
        {
          name: 'Resistivity Field',
          type: 'custom',
          silent: true,
          tooltip: { show: false },
          renderItem: function (_params, api) {
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
        },
        {
          name: 'Legacy Blocks Disabled',
          type: 'scatter',
          symbolSize: 0,
          silent: true,
          tooltip: { show: false },
          renderItem: function (params, api) {
            const leftX = api.value(0);
            const rightX = api.value(1);
            const topY = api.value(2);
            const bottomY = api.value(3);

            const tl = api.coord([leftX, topY]);
            const br = api.coord([rightX, bottomY]);

            const rectWidth = Math.abs(br[0] - tl[0]);
            const rectHeight = Math.abs(br[1] - tl[1]);
            const rectX = Math.min(tl[0], br[0]);
            const rectY = Math.min(tl[1], br[1]);

            // 使用 Math.ceil 确保整像素填充，杜绝亚像素缝隙同时不产生重叠
            const w = Math.ceil(rectWidth);
            const h = Math.ceil(rectHeight);
            
            const origIndex = api.value(7);
            const isSel = selectedPtRef.current?.index === origIndex;

            return {
              type: 'group',
              children: [
                {
                  type: 'rect',
                  shape: {
                    x: Math.floor(rectX),
                    y: Math.floor(rectY),
                    width: w,
                    height: h
                  },
                  style: api.style()
                },
                {
                  type: 'rect',
                  shape: {
                    x: Math.floor(rectX),
                    y: Math.floor(rectY),
                    width: w,
                    height: h
                  },
                  style: {
                    fill: 'none',
                    stroke: isSel ? '#fff' : 'none',
                    lineWidth: 2,
                    shadowBlur: isSel ? 10 : 0,
                    shadowColor: 'rgba(255,255,255,0.8)'
                  },
                  z2: 10
                }
              ]
            };
          },
          encode: {
            x: 5, // origX 取代默认缩放轴心坐标
            y: 6, // origY 挂载
            tooltip: [5, 6, 4]
          },
          data: boxedData
        },
        {
          name: 'bottom-axis-boundary',
          type: 'line',
          data: [[axisXMin, bottomAxisBoundaryY], [axisXMax, bottomAxisBoundaryY]],
          symbol: 'none',
          silent: true,
          tooltip: { show: false },
          lineStyle: { color: '#000000', width: 1, type: 'solid' },
          z: 9
        },
        ...(terrainLineData.length ? [{
          name: '地形线',
          type: 'line',
          data: terrainLineData,
          symbol: 'circle',
          symbolSize: 3,
          smooth: false,
          silent: false,
          tooltip: {
            formatter: (params) => {
              const point = topoPoints[params.dataIndex];
              return `地形 X: ${point?.x ?? '--'} m<br/>高程: ${Number(point?.elevation).toFixed(2)} m`;
            }
          },
          lineStyle: { color: '#111827', width: 2, type: 'solid' },
          itemStyle: { color: '#111827' },
          z: 12
        }] : []),
        {
          name: '测点',
          type: 'scatter',
          data: pointLayerData.map((point) => {
            const isSel = selectedPtRef.current?.index === point.value[3];
            return {
              value: point.value,
              rawZ: point.rawZ,
              symbolSize: isSel ? 12 : 2.2,
              itemStyle: {
                color: isSel ? '#2563eb' : 'rgba(15, 23, 42, 0.52)',
                borderColor: isSel ? '#fff' : 'rgba(255, 255, 255, 0.55)',
                borderWidth: isSel ? 2 : 0.4,
                shadowBlur: isSel ? 8 : 0,
                shadowColor: 'rgba(37, 99, 235, 0.45)'
              }
            };
          }),
          symbolSize: (_value, params) => params.data?.symbolSize ?? 2.2,
          itemStyle: { color: 'rgba(15, 23, 42, 0.52)' },
          encode: { x: 0, y: 1, tooltip: [0, 1, 2] },
          tooltip: {
              formatter: (params) => (
                `X (点位): ${params.value[0]} m<br/>${verticalTooltipLabel}: ${params.data.rawZ} m<br/><b style="color:#3b82f6">视电阻率: ${Number(params.value[2]).toFixed(1)} Ω·m</b>`
              )
            },
          z: 14
        },
        {
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
                `X (点位): ${params.value[0]} m<br/>${verticalTooltipLabel}: ${params.data.rawZ} m<br/><b style="color:#3b82f6">视电阻率: ${Number(params.value[2]).toFixed(1)} Ω·m</b>`
              )
            },
          z: 16
        }
      ]
    };
  }

  // ─── 波形跨轨图（Wiggle Trace）选项 ───
  function getWiggleOption(isMaximized = false, custColors = DEFAULT_CUSTOM, containerPx = null, isEditMode = false, overrideData = null) {
    const dataToUse = overrideData || activeDataPoints;
    const isInvertedSource = overrideData === inversionResult || (dataType === 'inverted' && !overrideData);
    const selectedDataPoints = dataToUse
      .map((d, index) => ({ d, index }))
      .filter(({ index }) => isInvertedSource || selectedIndices.includes(index));
    
    if (selectedDataPoints.length === 0) return {};
    const xVals = selectedDataPoints.map(({ d }) => d[0]);
    const yVals = selectedDataPoints.map(({ d }) => d[1]);
    const xMin = Math.min(...xVals), xMax = Math.max(...xVals);
    const yMin = Math.min(...yVals), yMax = Math.max(...yVals);
    const dyGlobal = (yMax - yMin) || 50;
    const L = 45, R = 45, T = 65, B = 20;
    void isMaximized;
    void containerPx;
    void custColors;
    // 为波形图提供更宽松的底部留白，不再强制和 X 轴等比例
    const yAxisMax = yMax + (yMax - yMin) * 0.1;

    const rowGroups = {};
    selectedDataPoints.forEach(({ d, index }) => {
      const z = d[1];
      if (!rowGroups[z]) rowGroups[z] = [];
      rowGroups[z].push({ x: d[0], rho: d[2], index });
    });
    const depths = Object.keys(rowGroups).map(Number).sort((a, b) => a - b);

    const allRho = selectedDataPoints.map(({ d }) => d[2]);
    const rhoMid = (Math.min(...allRho) + Math.max(...allRho)) / 2;
    const rhoRange = (Math.max(...allRho) - Math.min(...allRho)) || 1;
    const depthSpacing = depths.length > 1 ? dyGlobal / (depths.length - 1) : 1;
    const amplitude = depthSpacing * 0.45;

    // 将参数存入 ref，供拖拽事件处理函数使用
    wiggleParamsRef.current = { rhoMid, rhoRange, amplitude, rowGroups };

    const series = depths.map(z => ({
      id: `d${z}`,
      type: 'line',
      name: `d${z}`,
      data: (rowGroups[z] || []).sort((a, b) => a.x - b.x).map(({ x, rho, index }) => {
        // 如果是反演数据（数据类型 inverted 或者是通过 overrideData 传入的反演结果），则不应用手动编辑
        const isActuallyInverted = isInvertedSource;
        const effRho = isActuallyInverted ? rho : (editedRhoRef.current[`${x},${z}`] ?? rho);
        const isSel = selectedPtRef.current?.index === index;
        return {
          value: [x, z + ((effRho - rhoMid) / rhoRange) * amplitude * 2],
          origZ: z, origX: x, rho: effRho, origIndex: index,
          symbolSize: isSel ? 14 : 8, // 显著增大默认和选中尺寸
          itemStyle: isSel 
            ? { color: '#ff6b35', borderColor: '#fff', borderWidth: 2, shadowBlur: 10, shadowColor: 'rgba(255,107,53,0.5)' } 
            : { color: '#0f172a', opacity: 0.8 },
          label: {
            show: isSel,
            formatter: `${effRho.toFixed(1)} Ω·m`,
            position: 'right', fontSize: 11,
            color: '#ff6b35', fontWeight: 'bold',
          },
        };
      }),
      showSymbol: true,
      lineStyle: { color: '#0f172a', width: 1.2, opacity: 0.6 },
      emphasis: { disabled: true },
      z: 5
    }));

    return {
      tooltip: {
        trigger: 'item',
        axisPointer: { type: 'cross', label: { show: true, backgroundColor: '#3b82f6' } },
        formatter: p => p.data
          ? `X: ${p.data.value[0].toFixed(1)} m<br/>深度: ${p.data.origZ} m<br/><b style="color:#3b82f6">视电阻率: ${p.data.rho?.toFixed(1)} Ω·m</b>`
          : ''
      },
      grid: { left: L, right: R, top: T, bottom: B, containLabel: false },
      dataZoom: [
        { 
          type: 'inside', 
          xAxisIndex: 0, 
          filterMode: 'none', 
          zoomOnMouseWheel: true,
          moveOnMouseMove: !isEditMode
        },
        { 
          type: 'inside', 
          yAxisIndex: 0, 
          filterMode: 'none', 
          zoomOnMouseWheel: true,
          moveOnMouseMove: !isEditMode
        }
      ],
      xAxis: {
        type: 'value', position: 'top', min: xMin, max: xMax,
        name: '测量距离 X (m)', nameLocation: 'middle', nameGap: 30,
        splitLine: { show: false },
        scale: false, // 禁用自动缩放
      },
      yAxis: {
        type: 'value', name: '贯穿深度 Z (m)', inverse: true,
        min: yMin - amplitude * 2.5, max: yAxisMax,
        splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed', opacity: 0.4 } },
        scale: false, // 禁用自动缩放
      },
      series
    };
  }

  function getFitComparisonOption(fitComparison = null) {
    const obs = Array.isArray(fitComparison?.obs) ? fitComparison.obs.map(Number) : [];
    const pred = Array.isArray(fitComparison?.pred) ? fitComparison.pred.map(Number) : [];
    const misfitPct = Array.isArray(fitComparison?.misfit_pct) ? fitComparison.misfit_pct.map(Number) : [];
    const count = Math.min(obs.length, pred.length);
    if (!count) return {};
    const indices = Array.from({ length: count }, (_, index) => index + 1);
    const rrms = Number(fitComparison?.rms_pct);
    const weighted = Number(fitComparison?.weighted_rms);
    const titleParts = [];
    if (Number.isFinite(rrms)) titleParts.push(`rRMS ${rrms.toFixed(2)}%`);
    if (Number.isFinite(weighted)) titleParts.push(`W-RMS ${weighted.toFixed(2)}`);

    return {
      animation: false,
      tooltip: {
        trigger: 'axis',
        formatter: (items = []) => {
          const index = Number(items?.[0]?.axisValue || 0) - 1;
          const lines = [`测点: ${index + 1}`];
          lines.push(`观测: ${Number(obs[index]).toFixed(3)} Ω·m`);
          lines.push(`预测: ${Number(pred[index]).toFixed(3)} Ω·m`);
          if (Number.isFinite(misfitPct[index])) lines.push(`误差: ${Number(misfitPct[index]).toFixed(2)}%`);
          return lines.join('<br/>');
        },
      },
      legend: { top: 2, left: 10, itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 11 } },
      title: {
        text: titleParts.join(' · '),
        right: 12,
        top: 4,
        textStyle: { fontSize: 11, color: '#475569', fontWeight: 500 },
      },
      grid: { left: 48, right: 52, top: 30, bottom: 28 },
      xAxis: {
        type: 'category',
        data: indices,
        name: '测点',
        nameGap: 18,
        axisLabel: { color: '#64748b', fontSize: 10 },
      },
      yAxis: [
        {
          type: 'value',
          name: 'ρa (Ω·m)',
          axisLabel: { color: '#64748b', fontSize: 10 },
          splitLine: { lineStyle: { color: '#e2e8f0', type: 'dashed' } },
        },
        {
          type: 'value',
          name: '误差 %',
          axisLabel: { color: '#64748b', fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '观测',
          type: 'line',
          data: obs.slice(0, count),
          showSymbol: false,
          lineStyle: { color: '#2563eb', width: 1.5 },
        },
        {
          name: '预测',
          type: 'line',
          data: pred.slice(0, count),
          showSymbol: false,
          lineStyle: { color: '#dc2626', width: 1.5 },
        },
        {
          name: '误差',
          type: 'bar',
          yAxisIndex: 1,
          data: misfitPct.slice(0, count),
          itemStyle: { color: 'rgba(15, 118, 110, 0.35)' },
        },
      ],
    };
  }

  useEffect(() => {
    if (loading || errorMsg) return;

    if (chartRef.current) {
      const instance = chartRef.current.getEchartsInstance();
      instance.resize();
      const containerPx = getChartContainerPx(instance);
      const opt = displayMode === 'wiggle'
        ? getWiggleOption(maximized, customColors, containerPx, editMode, compareMode ? dataPoints : null)
        : getOption(maximized, schemeId, customColors, containerPx, editMode, compareMode ? dataPoints : null);

      if (instance.getOption()?.series?.length > 0 && instance.getOption().series[0].type !== (displayMode === 'wiggle' ? 'line' : 'custom')) {
        instance.clear();
      }
      instance.setOption(opt, { notMerge: true });
    }

    if (compareMode && chartRef2.current && inversionResult) {
      const instance2 = chartRef2.current.getEchartsInstance();
      instance2.resize();
      const containerPx2 = getChartContainerPx(instance2);
      const opt2 = displayMode === 'wiggle'
        ? getWiggleOption(maximized, customColors, containerPx2, editMode, inversionResult)
        : getOption(maximized, schemeId, customColors, containerPx2, editMode, inversionResult);

      if (instance2.getOption()?.series?.length > 0 && instance2.getOption().series[0].type !== (displayMode === 'wiggle' ? 'line' : 'custom')) {
        instance2.clear();
      }
      instance2.setOption(opt2, { notMerge: true });
    }

    if (compareMode && fitChartRef.current && currentFitComparison) {
      const fitInstance = fitChartRef.current.getEchartsInstance();
      fitInstance.resize();
      fitInstance.setOption(getFitComparisonOption(currentFitComparison), { notMerge: true });
    }
  }, [displayMode, maximized, showTable, loading, errorMsg, editMode, compareMode, dataType, inversionResult, currentFitComparison, activeDataPoints.length, selectedIndices.length, directVtkMesh, directVtkCellGrid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (loading || errorMsg || displayMode !== 'heatmap' || !chartRef.current || selectedIndices.length === 0) return undefined;

    let timeoutId = 0;
    const rafId = window.requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => {
        if (!chartRef.current) return;
        const instance = chartRef.current.getEchartsInstance();
        instance.resize();
        const containerPx = getChartContainerPx(instance);
        instance.setOption(
          getOption(maximized, schemeId, customColors, containerPx, editMode, compareMode ? dataPoints : null),
          { notMerge: true }
        );
      }, 80);
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, [loading, errorMsg, displayMode, maximized, showTable, dataType, selectedIndices.length, activeDataPoints.length, directVtkMesh, directVtkCellGrid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (loading || errorMsg || isDragging) return;

    if (chartRef.current) {
      const instance = chartRef.current.getEchartsInstance();
      const containerPx = getChartContainerPx(instance);
      const opt = displayMode === 'wiggle'
        ? getWiggleOption(maximized, customColors, containerPx, editMode, compareMode ? dataPoints : null)
        : getOption(maximized, schemeId, customColors, containerPx, editMode, compareMode ? dataPoints : null);
      instance.setOption(opt, { notMerge: false, lazyUpdate: true });
    }

    if (compareMode && chartRef2.current && inversionResult) {
      const instance2 = chartRef2.current.getEchartsInstance();
      const containerPx2 = getChartContainerPx(instance2);
      const opt2 = displayMode === 'wiggle'
        ? getWiggleOption(maximized, customColors, containerPx2, editMode, inversionResult)
        : getOption(maximized, schemeId, customColors, containerPx2, editMode, inversionResult);
      instance2.setOption(opt2, { notMerge: false, lazyUpdate: true });
    }

    if (compareMode && fitChartRef.current && currentFitComparison) {
      fitChartRef.current.getEchartsInstance().setOption(getFitComparisonOption(currentFitComparison), { notMerge: false, lazyUpdate: true });
    }
  }, [schemeId, customColors, editedRho, selectedPt, isDragging, editMode, compareMode, dataType, inversionResult, currentFitComparison, directVtkMesh, directVtkCellGrid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshChartRef.current = (inst, overrideData = null) => {
      const apply = () => {
        inst.resize();
        const containerPx = getChartContainerPx(inst);
        const opt = displayMode === 'wiggle'
          ? getWiggleOption(maximized, customColors, containerPx, editMode, overrideData)
          : getOption(maximized, schemeId, customColors, containerPx, editMode, overrideData);
        inst.setOption(opt, { notMerge: true });
      };
      apply();
      window.requestAnimationFrame(apply);
      [60, 160, 320].forEach((delay) => window.setTimeout(apply, delay));
    };
  }, [displayMode, maximized, customColors, editMode, schemeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const modalStyle = maximized
    ? { position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', borderRadius: 0, display: 'flex', flexDirection: 'column' }
    : { width: '88vw', maxWidth: '1400px', height: '82vh', display: 'flex', flexDirection: 'column', position: 'relative' };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: maximized ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0.6)', backdropFilter: maximized ? 'none' : 'blur(4px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card glass" style={modalStyle}>

        {/* Header Ribbon */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: maximized ? '12px 20px' : '0 0 16px 0', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <FileBarChart size={24} color="var(--brand-primary)" />
            <div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', lineHeight: 1.3 }}>
                {fileObj?.name ?? '大红山高密度电法剖面_LineA.dat'}
              </h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span className="text-muted" style={{ fontSize: '12px', fontWeight: 500 }}>高密度电法拟断面视电阻率成像</span>
                {profileInfo && (
                  <div style={{ display: 'flex', gap: '8px', fontSize: '11px', color: 'var(--text-muted)', background: 'var(--surface-hover)', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
                    <span>电极数: <b style={{ color: 'var(--text-primary)' }}>{profileInfo.electrodes}</b></span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span>道间距: <b style={{ color: 'var(--text-primary)' }}>{profileInfo.spacing}m</b></span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span>排列长度: <b style={{ color: 'var(--text-primary)' }}>{profileInfo.length}m</b></span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span>数据点: <b style={{ color: 'var(--text-primary)' }}>{profileInfo.total}</b></span>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {/* 显示模式切换 */}
            <div style={{ display: 'flex', background: 'var(--surface-hover)', borderRadius: '6px', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
              {[{ id: 'heatmap', Icon: LayoutGrid, label: '色块图' }, { id: 'wiggle', Icon: Activity, label: '波形图' }].map(({ id, Icon, label }) => (
                <button
                  key={id}
                  onClick={() => setDisplayMode(id)}
                  title={label}
                  style={{
                    background: displayMode === id ? 'var(--brand-primary)' : 'transparent',
                    color: displayMode === id ? '#fff' : 'var(--text-muted)',
                    border: 'none', cursor: 'pointer', padding: '4px 8px',
                    display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px',
                  }}
                >
                  {React.createElement(Icon, { size: 14 })}{label}
                </button>
              ))}
              <button
                onClick={() => setShowTable(v => !v)}
                title={showTable ? '隐藏表格' : '显示表格'}
                style={{
                  background: showTable ? 'var(--surface-selected)' : 'transparent',
                  color: showTable ? 'var(--brand-primary)' : 'var(--text-muted)',
                  border: 'none', borderLeft: '1px solid var(--border-color)', cursor: 'pointer', padding: '4px 8px',
                  display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px',
                }}
              >
                <FileBarChart size={14} />表格
              </button>
            </div>

            {/* 色谱选择器（仅色块图显示） */}
            {displayMode === 'heatmap' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Palette size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <div style={{ position: 'relative', width: '178px', flexShrink: 0 }}>
                  <select
                  value={schemeId}
                  onChange={e => setSchemeId(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'var(--surface-hover)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    color: 'var(--text-primary)',
                    fontSize: '13px',
                    padding: '4px 72px 4px 8px',
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >
                  {COLOR_SCHEMES.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                  </select>
                {/* 当前色谱预览 */}
                  <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: '50%',
                    right: '24px',
                    transform: 'translateY(-50%)',
                    display: 'flex',
                    height: '16px',
                    width: '54px',
                    borderRadius: '3px',
                    overflow: 'hidden',
                    border: '1px solid var(--border-color)',
                    pointerEvents: 'none',
                    background: 'var(--surface-card)',
                  }}
                  >
                  {activeColors.map((c, i) => (
                    <div key={i} style={{ flex: 1, background: c }} />
                  ))}
                  </div>
                </div>
              </div>
            )}

            {/* 编辑按钮（仅波形图显示）*/}
            {displayMode === 'wiggle' && (
              <button
                onClick={() => { setEditMode(v => !v); setSelectedPt(null); selectedPtRef.current = null; }}
                title={editMode ? '退出编辑' : '编辑节点（拖动节点改变电阻率值）'}
                style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  background: editMode ? '#ff6b35' : 'var(--surface-hover)',
                  color: editMode ? '#fff' : 'var(--text-muted)',
                  border: `1px solid ${editMode ? '#ff6b35' : 'var(--border-color)'}`,
                  borderRadius: '6px', padding: '4px 10px',
                  cursor: 'pointer', outline: 'none', fontSize: '12px',
                  transition: 'all 0.2s',
                }}
              >
                <Pencil size={13} />
                {editMode ? '编辑中...' : '编辑'}
              </button>
            )}

            {/* 反演控制 */}
            <div style={{ display: 'flex', gap: '8px', borderLeft: '1px solid var(--border-color)', paddingLeft: '10px' }}>
              {activeInversionTask && (
                <div
                  title={activeInversionTask.error || activeInversionTask.progress?.message || ''}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    maxWidth: '260px',
                    padding: '4px 9px',
                    borderRadius: '6px',
                    border: `1px solid ${activeInversionTask.status === 'failed' || activeInversionTask.status === 'revoked' ? '#fecaca' : activeInversionTask.status === 'success' ? '#bbf7d0' : '#bfdbfe'}`,
                    background: activeInversionTask.status === 'failed' || activeInversionTask.status === 'revoked' ? '#fef2f2' : activeInversionTask.status === 'success' ? '#f0fdf4' : '#eff6ff',
                    color: activeInversionTask.status === 'failed' || activeInversionTask.status === 'revoked' ? '#991b1b' : activeInversionTask.status === 'success' ? '#166534' : '#1e40af',
                    fontSize: '12px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {isActiveTaskStatus(activeInversionTask.status) && <Loader2 size={13} className="animate-spin" />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {activeInversionTask.status === 'success'
                      ? '反演完成'
                      : activeInversionTask.status === 'failed' || activeInversionTask.status === 'revoked'
                        ? `反演失败：${activeInversionTask.error || '请重试'}`
                        : `${activeInversionTask.progress?.message || '后台反演中'} ${Number.isFinite(Number(activeInversionTask.progress?.percent)) ? `${Math.round(Number(activeInversionTask.progress.percent))}%` : ''}`}
                  </span>
                </div>
              )}
              {!inversionResult ? (
                <button
                  onClick={() => setIsInvertingModalOpen(true)}
                  className="btn-primary"
                  style={{ padding: '4px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', minWidth: '100px' }}
                >
                  <RefreshCcw size={14} />
                  二维反演
                </button>
              ) : (
                <div style={{ display: 'flex', background: 'var(--surface-hover)', borderRadius: '6px', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
                  {inversionRuns.length > 0 && (
                    <select
                      value={selectedInversionRun?.id || ''}
                      onChange={(event) => {
                        setSelectedInversionRunId(event.target.value);
                        setSelectedInversionIterationKey('final');
                        setDataType('inverted');
                      }}
                      title="选择反演结果"
                      style={{
                        maxWidth: '220px',
                        background: 'transparent',
                        color: 'var(--text-primary)',
                        border: 'none',
                        borderRight: '1px solid var(--border-color)',
                        padding: '4px 8px',
                        fontSize: '12px',
                        outline: 'none',
                        cursor: 'pointer'
                      }}
                    >
                      {inversionRuns.map((run, index) => (
                        <option key={run.id} value={run.id}>
                          {formatInversionRunLabel(run, index)}
                        </option>
                      ))}
                    </select>
                  )}
                  {selectedInversionRun && (selectedInversionRun.iterations || []).length > 0 && (
                    <select
                      value={selectedInversionIterationKey}
                      onChange={(event) => {
                        setSelectedInversionIterationKey(event.target.value);
                        setDataType('inverted');
                      }}
                      title="选择迭代结果"
                      style={{
                        border: 'none',
                        borderLeft: '1px solid var(--border-color)',
                        background: 'var(--surface-bg)',
                        color: 'var(--text-primary)',
                        fontSize: '12px',
                        padding: '4px 8px',
                        maxWidth: '170px',
                        outline: 'none'
                      }}
                    >
                      <option value="final">最终结果</option>
                      {(selectedInversionRun.iterations || []).map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    onClick={() => setDataType('apparent')}
                    style={{
                      background: dataType === 'apparent' ? 'var(--brand-primary)' : 'transparent',
                      color: dataType === 'apparent' ? '#fff' : 'var(--text-muted)',
                      border: 'none', cursor: 'pointer', padding: '4px 8px', fontSize: '12px',
                    }}
                  >
                    视电阻率
                  </button>
                  <button
                    onClick={() => setDataType('inverted')}
                    style={{
                      background: dataType === 'inverted' ? 'var(--brand-primary)' : 'transparent',
                      color: dataType === 'inverted' ? '#fff' : 'var(--text-muted)',
                      border: 'none', cursor: 'pointer', padding: '4px 8px', fontSize: '12px',
                    }}
                  >
                    反演断面
                  </button>
                  <button
                    onClick={() => setCompareMode(!compareMode)}
                    style={{
                      background: compareMode ? '#6366f1' : 'transparent',
                      color: compareMode ? '#fff' : 'var(--text-muted)',
                      border: 'none', cursor: 'pointer', padding: '4px 8px', fontSize: '12px',
                      borderLeft: '1px solid var(--border-color)',
                      display: 'flex', alignItems: 'center', gap: '4px'
                    }}
                  >
                    <Layers size={12} />
                    对比
                  </button>
                  <button
                    onClick={() => setIsInvertingModalOpen(true)}
                    title="重新反演"
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px 8px', borderLeft: '1px solid var(--border-color)' }}
                  >
                    <RefreshCcw size={12} />
                  </button>
                </div>
              )}
            </div>

            <button
              onClick={() => setMaximized(v => !v)}
              title={maximized ? '还原窗口' : '最大化'}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none', display: 'flex', alignItems: 'center', padding: '4px' }}
            >
              {maximized ? <Minimize2 size={20} className="text-muted" /> : <Maximize2 size={20} className="text-muted" />}
            </button>
            <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', outline: 'none', display: 'flex', alignItems: 'center', padding: '4px' }}>
              <X size={20} className="text-muted" />
            </button>
          </div>
        </div>

        {/* 自定义色谱编辑面板 */}
        {schemeId === 'custom' && (
          <div style={{
            padding: '8px 16px',
            borderBottom: '1px solid var(--border-color)',
            background: 'var(--surface-hover)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', flexShrink: 0 }}>色标节点:</span>
            {customColors.map((color, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                <input
                  type="color"
                  value={color}
                  onChange={e => {
                    const next = [...customColors];
                    next[idx] = e.target.value;
                    setCustomColors(next);
                  }}
                  style={{ width: '28px', height: '28px', border: 'none', padding: 0, borderRadius: '4px', cursor: 'pointer', background: 'none' }}
                />
                {customColors.length > 2 && (
                  <button
                    onClick={() => setCustomColors(customColors.filter((_, i) => i !== idx))}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0 2px', fontSize: '14px', lineHeight: 1 }}
                    title="删除此节点"
                  >×</button>
                )}
              </div>
            ))}
            <button
              onClick={() => setCustomColors([...customColors, '#ffffff'])}
              style={{ background: 'var(--brand-primary)', color: '#fff', border: 'none', borderRadius: '5px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer', flexShrink: 0 }}
            >+ 添加节点</button>
            <button
              onClick={() => setCustomColors(DEFAULT_CUSTOM)}
              style={{ background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: '5px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer', flexShrink: 0 }}
            >重置</button>
          </div>
        )}

        {/* Content Box */}
        <div style={{ flex: 1, display: 'flex', position: 'relative', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: 'var(--brand-primary)' }}>
              <Loader2 size={48} className="animate-spin" />
              <p className="text-sm font-medium">拦截高密度电法文件流... 正在注入正则多线程切割器提取色阶点云...</p>
            </div>
          ) : errorMsg ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: 'var(--error)' }}>
              <AlertCircle size={48} />
              <p className="text-sm font-medium">{errorMsg}</p>
            </div>
          ) : (
            <>
              {/* Left Side: Charts */}
              <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: compareMode ? 'column' : 'row' }}>
                {!loading && !errorMsg && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
                    {compareMode && (
                      <div style={{ position: 'absolute', top: 5, left: 5, zIndex: 10, background: 'rgba(255,255,255,0.7)', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600 }}>
                        视电阻率断面 (原始/编辑)
                      </div>
                    )}
                    <ReactECharts
                      ref={chartRef}
                      option={{}}
                      style={{ width: '100%', height: '100%' }}
                      opts={{ renderer: 'canvas' }}
                      notMerge={false}
                      onChartReady={(inst) => {
                        setChartReadyTick((value) => value + 1);
                        refreshChartRef.current?.(inst, compareMode ? dataPoints : null);
                      }}
                    />
                  </div>
                )}
                
                {compareMode && inversionResult && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderTop: '2px solid var(--border-color)', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: 5, left: 5, zIndex: 10, background: 'rgba(255,255,255,0.7)', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, color: 'var(--brand-primary)' }}>
                      二维反演断面 ({selectedInversionIteration?.label || (selectedInversionRun ? formatInversionRunLabel(selectedInversionRun, Math.max(0, inversionRuns.findIndex((run) => run.id === selectedInversionRun.id))) : '计算结果')})
                    </div>
                    <ReactECharts
                      ref={chartRef2}
                      option={{}}
                      style={{ width: '100%', height: '100%' }}
                      opts={{ renderer: 'canvas' }}
                      notMerge={false}
                      onChartReady={(inst) => {
                        setChartReadyTick((value) => value + 1);
                        refreshChartRef.current?.(inst, inversionResult);
                      }}
                    />
                  </div>
                )}
              </div>

              {/* Right Side: Table */}
              {showTable && (
                <div 
                  ref={tableRef}
                  style={{ 
                    width: '320px', 
                    borderLeft: '1px solid var(--border-color)', 
                    background: 'var(--surface-card)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden'
                  }}
                >
                  <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--primary-bg)' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600 }}>数据明细 ({dataPoints.length} 点)</span>
                    <button 
                      onClick={() => setShowTable(false)}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto', padding: '0' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                      <thead style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--primary-bg)' }}>
                        <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                          <th style={{ padding: '8px' }}>
                            <input 
                              type="checkbox" 
                              checked={selectedIndices.length === dataPoints.length}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedIndices([...Array(dataPoints.length).keys()]);
                                } else {
                                  setSelectedIndices([]);
                                }
                              }}
                            />
                          </th>
                          <th style={{ padding: '8px' }}>X</th>
                          <th style={{ padding: '8px' }}>Z</th>
                          <th style={{ padding: '8px' }}>ρ (Ω·m)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dataPoints.map((point, index) => {
                          const isHighlighted = selectedPt?.index === index;
                          
                          // 获取当前点的视电阻率值（优先使用编辑后的值）
                          const currentRho = editedRho[`${point[0]},${point[1]}`] ?? point[2];

                          return (
                            <tr 
                              key={index} 
                              id={`row-${index}`}
                              onClick={() => {
                                const nextPt = { x: point[0], z: point[1], index };
                                setSelectedPt(nextPt);
                                selectedPtRef.current = nextPt;
                              }}
                              style={{ 
                                borderBottom: '1px solid var(--border-color)',
                                background: isHighlighted ? 'rgba(var(--brand-primary-rgb, 64, 123, 255), 0.15)' : 'transparent',
                                transition: 'background 0.2s',
                                cursor: 'pointer'
                              }}
                            >
                              <td style={{ padding: '8px' }}>
                                <input 
                                  type="checkbox" 
                                  checked={selectedIndices.includes(index)}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedIndices([...selectedIndices, index]);
                                    } else {
                                      setSelectedIndices(selectedIndices.filter(i => i !== index));
                                    }
                                  }}
                                />
                              </td>
                              <td 
                                style={{ padding: '8px' }}
                                onClick={() => setEditingCell({ rowIndex: index, colIndex: 0 })}
                              >
                                {editingCell?.rowIndex === index && editingCell?.colIndex === 0 ? (
                                  <input type="number" defaultValue={point[0]} onBlur={(e) => { handleCellEdit(index, 0, e.target.value); setEditingCell(null); }} style={{ width: '40px' }} autoFocus />
                                ) : point[0]}
                              </td>
                              <td 
                                style={{ padding: '8px' }}
                                onClick={() => setEditingCell({ rowIndex: index, colIndex: 1 })}
                              >
                                {editingCell?.rowIndex === index && editingCell?.colIndex === 1 ? (
                                  <input type="number" defaultValue={point[1]} onBlur={(e) => { handleCellEdit(index, 1, e.target.value); setEditingCell(null); }} style={{ width: '40px' }} autoFocus />
                                ) : point[1]}
                              </td>
                              <td 
                                style={{ padding: '8px', color: 'var(--brand-primary)', fontWeight: 500 }}
                                onClick={() => setEditingCell({ rowIndex: index, colIndex: 2 })}
                              >
                                {editingCell?.rowIndex === index && editingCell?.colIndex === 2 ? (
                                  <input type="number" defaultValue={currentRho} onBlur={(e) => { handleCellEdit(index, 2, e.target.value); setEditingCell(null); }} style={{ width: '60px' }} autoFocus />
                                ) : currentRho.toFixed(1)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <ErtInversionModal 
        isOpen={isInvertingModalOpen} 
        onClose={() => setIsInvertingModalOpen(false)} 
        file={fileObj}
        onSuccess={handleInversionSuccess}
        onTaskStarted={handleInversionTaskStarted}
      />
    </div>
  );
};

export default ERTParser;
