import React, { useEffect, useMemo, useState } from 'react';
import ReactECharts from './LazyECharts';
import { useCallback } from 'react';
import { useRef } from 'react';
import { ChevronDown, ChevronRight, Compass, Database, FolderKanban, GitBranch, Search, HardDrive, CheckCircle2, Clock3 } from 'lucide-react';
import { parseEDIFile, parseF3File, parseXFile, parseZFile } from '../utils/eh4io';
import { computeEh4ImpedanceFromCrosspowers } from '../utils/eh4Computation';
import { resolveDriveFileContent } from '../utils/driveFileContent';
import MTParser from './MTParser';
import XParser from './XParser';
import YParser from './YParser';
import { List } from 'react-window';
import { AutoSizer } from 'react-virtualized-auto-sizer';
import { useSurveyTreeStore } from '../store/surveyTreeStore';

const normalizeInstrumentType = (value = '') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized.includes('emap')) return 'emap';
  if (
    normalized.includes('eh4') ||
    normalized.includes('mt') ||
    normalized.includes('edi') ||
    String(value || '').includes('大地电磁')
  ) return 'eh4';
  if (normalized.includes('f3')) return 'f3';
  return normalized;
};

const getInstrumentLabel = (value = '', fallback = '') => {
  const text = String(value || fallback || '').trim();
  return text || '未标注仪器';
};

const getProjectMethodLabel = (project = {}) => {
  const text = String(project?.plan?.instrumentModel || project?.method || '').trim();
  return text || '未标注方法';
};

const getMethodLabelForInstrument = (instrument = '', fallback = '') => {
  const raw = String(instrument || '').trim();
  const normalized = raw.toLowerCase();
  if (normalized.includes('emap') || normalized.includes('eh4') || normalized.includes('edi') || normalized.includes('f3')) {
    return '大地电磁';
  }
  const instrumentType = normalizeInstrumentType(raw || fallback);
  if (instrumentType === 'emap' || instrumentType === 'eh4' || instrumentType === 'f3') return '大地电磁';
  return String(fallback || raw || '').trim() || '未标注方法';
};

const buildPointTokens = (...values) => {
  const tokens = new Set();
  values.forEach((value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return;
    tokens.add(raw);
    const digits = raw.replace(/\D/g, '');
    if (digits) {
      tokens.add(digits);
      if (digits.length >= 3) tokens.add(digits.slice(-3));
      if (digits.length >= 4) tokens.add(digits.slice(-4));
      if (digits.length >= 5) tokens.add(digits.slice(-5));
    }
  });
  return Array.from(tokens);
};

const buildExactPointTokens = (...values) => {
  const tokens = new Set();
  values.forEach((value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return;
    tokens.add(raw);
    const digits = raw.replace(/\D/g, '');
    if (digits) tokens.add(digits);
  });
  return Array.from(tokens);
};

const getFileNameTokens = (name = '') => {
  const normalized = String(name || '').trim().toLowerCase();
  const stem = normalized.replace(/\.(edi|mt|r|psd|\d{3,4})$/i, '').replace(/^[xyz]/i, '');
  const digits = normalized.replace(/\D/g, '');
  return new Set([normalized, stem, digits, digits.slice(-3), digits.slice(-4), digits.slice(-5)].filter(Boolean));
};

const matchesExactPointToken = (fileName = '', exactPointTokens = []) => {
  if (!exactPointTokens.length) return false;
  const normalizedName = String(fileName || '').trim().toLowerCase();
  const fileTokens = getFileNameTokens(normalizedName);
  return exactPointTokens.some((token) => {
    if (!token) return false;
    if (fileTokens.has(token)) return true;
    return new RegExp(`(^|[^0-9a-z])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9a-z]|$)`, 'i').test(normalizedName);
  });
};

const isEh4ZLikeFile = (name = '') => {
  const normalized = String(name || '').trim();
  return /\.edi$/i.test(normalized) || /\.mt$/i.test(normalized) || /^z/i.test(normalized);
};

const isEh4XLikeFile = (name = '') => {
  const normalized = String(name || '').trim();
  return /\.psd$/i.test(normalized) || /^x/i.test(normalized);
};

const isEh4YLikeFile = (name = '') => {
  const normalized = String(name || '').trim();
  return /^y/i.test(normalized) || /\.(fh|fm|fl|mtts)$/i.test(normalized);
};

const getEh4FileSerial = (name = '') => {
  const match = String(name || '').trim().match(/^[xyz]?[^.]*\.(\d{3,4})$/i);
  return match ? Number(match[1]) : Number.NaN;
};

const isF3ZLikeFile = (name = '') => /\.r$/i.test(String(name || '').trim());

const isF3XLikeFile = (name = '') => /\.psd$/i.test(String(name || '').trim());

const isF3YLikeFile = (name = '') => /\.(fh|fm|fl)$/i.test(String(name || '').trim());

const getF3FileSerial = (name = '') => {
  const match = String(name || '').trim().match(/^.+\.(\d+)\.(r|psd|fh|fm|fl)$/i);
  return match ? Number(match[1]) : Number.NaN;
};

const isEmapFile = (name = '') => /\.mtts$/i.test(String(name || '').trim());

const parseMTTSDisplayMeta = (name = '') => {
  const normalizedName = String(name || '').trim();
  if (!/\.mtts$/i.test(normalizedName)) return null;
  const baseName = normalizedName.replace(/\.[^.]+$/, '');
  const parts = baseName.split('_');
  const pointNo = (parts[0] || baseName).trim();
  const channel = (parts.length >= 3 ? parts[parts.length - 2] : '').trim().toUpperCase();
  const sampleRateTag = (parts.length >= 2 ? parts[parts.length - 1] : '').trim().toUpperCase();
  return {
    pointNo: pointNo || normalizedName,
    channel: channel || '--',
    sampleRateTag: sampleRateTag || '--'
  };
};

const parseMTTSPointNo = (name = '') => {
  return parseMTTSDisplayMeta(name)?.pointNo || '';
};

const extractFileNameFromPath = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.split(/[\\/]/).filter(Boolean).pop() || text;
};

const normalizeFileName = (value = '') => String(value || '').trim().toLowerCase();
const normalizeFileId = (value = '') => String(value || '').trim();

const uniqueBy = (items = [], getKey = (item) => item) => {
  const seen = new Set();
  return (items || []).filter((item) => {
    const key = String(getKey(item) || '').trim().toLowerCase();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const uniquePathList = (paths = []) => uniqueBy(paths.filter(Boolean), (path) => extractFileNameFromPath(path) || path);

const uniqueFileList = (files = []) => uniqueBy(files.filter(Boolean), (file) => (
  file.object_key ||
  file.objectKey ||
  file.name ||
  file.id
));

const buildPointBoundFileNameSet = (pointNode = {}) => {
  const names = [
    ...(Array.isArray(pointNode.fileNames) ? pointNode.fileNames : []),
    ...(Array.isArray(pointNode.matchedDataPaths) ? pointNode.matchedDataPaths.map(extractFileNameFromPath) : []),
    pointNode.sourceFileName,
    pointNode.sourceCoordFileName
  ];
  return new Set(names.map(normalizeFileName).filter(Boolean));
};

const buildPointBoundFileIdSet = (pointNode = {}) => {
  const ids = Array.isArray(pointNode.matchedFileIds) ? pointNode.matchedFileIds : [];
  return new Set(ids.map(normalizeFileId).filter(Boolean));
};

const collectPointBoundFiles = (pointNode, files = [], matcher = () => true) => {
  const boundFileNames = buildPointBoundFileNameSet(pointNode);
  const boundFileIds = buildPointBoundFileIdSet(pointNode);
  if (!boundFileNames.size && !boundFileIds.size) return [];
  const directMatches = (files || []).filter((file) => (
    file?.type === 'file'
    && matcher(file.name)
    && (
      boundFileNames.has(normalizeFileName(file.name))
      || boundFileIds.has(normalizeFileId(file.backendFileId))
      || boundFileIds.has(normalizeFileId(file.id))
    )
  ));
  if (directMatches.length) return uniqueFileList(directMatches);

  const boundEh4Seeds = (files || []).filter((file) => (
    file?.type === 'file'
    && Number.isFinite(getEh4FileSerial(file.name))
    && (
      boundFileNames.has(normalizeFileName(file.name))
      || boundFileIds.has(normalizeFileId(file.backendFileId))
      || boundFileIds.has(normalizeFileId(file.id))
    )
  ));
  if (!boundEh4Seeds.length) return [];

  const siblingMatches = [];
  boundEh4Seeds.forEach((seedFile) => {
    const serial = getEh4FileSerial(seedFile.name);
    (files || []).forEach((file) => {
      if (
        file?.type === 'file'
        && (seedFile.parentId == null || file.parentId === seedFile.parentId)
        && getEh4FileSerial(file.name) === serial
        && matcher(file.name)
      ) {
        siblingMatches.push(file);
      }
    });
  });
  return uniqueFileList(siblingMatches);
};

const buildEmapGroupForPoint = (pointNode, files = []) => {
  if (pointNode?.type !== 'point' || pointNode?.instrumentType !== 'emap') return null;
  const pointNo = String(pointNode.pointValue || pointNode?.meta?.['点号'] || '').trim();
  if (!pointNo) return null;
  const boundFiles = collectPointBoundFiles(pointNode, files, isEmapFile);
  const candidateFiles = boundFiles.length
    ? boundFiles
    : (files || []).filter((file) => file?.type === 'file' && isEmapFile(file.name) && parseMTTSPointNo(file.name) === pointNo);
  const matchedFiles = candidateFiles
    .map((file) => {
      const meta = parseMTTSDisplayMeta(file.name);
      return meta ? { ...file, mttsMeta: meta } : null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aRate = a.mttsMeta?.sampleRateTag || '';
      const bRate = b.mttsMeta?.sampleRateTag || '';
      const rateCompare = aRate.localeCompare(bRate, undefined, { numeric: true, sensitivity: 'base' });
      if (rateCompare !== 0) return rateCompare;
      return (a.mttsMeta?.channel || '').localeCompare(b.mttsMeta?.channel || '', undefined, { sensitivity: 'base' });
    });
  if (!matchedFiles.length) return null;
  return {
    id: `mtts-group:${pointNode.lineKey || 'line'}:${pointNo}`,
    type: 'mtts-group',
    name: pointNo,
    pointNo,
    files: matchedFiles,
    stationMeta: {
      id: pointNode.pointId || pointNode.id || '',
      rx: pointNo,
      ry: pointNode.lineKey || pointNode?.meta?.['线号'] || '--'
    }
  };
};

const resolveProjectFileText = async (file) => {
  if (!file) return '';
  const resolvedFile = await resolveDriveFileContent(file, file.name || 'data.txt');
  if (resolvedFile) return resolvedFile.text();
  return '';
};

const parseEh4ResistivityRowsFromFile = (file, text) => {
  const lowerName = String(file?.name || '').toLowerCase();
  if (!text) return [];
  if (lowerName.endsWith('.edi')) {
    return parseEDIFile(text);
  }
  if (lowerName.endsWith('.mt') || lowerName.endsWith('.r')) {
    return parseF3File(text, file?.name || '');
  }
  return parseZFile(text).map((row) => ({
    frequency: row.freq,
    rhoXY: row.exhy_rho,
    phaseXY: row.exhy_phs,
    cohXY: row.exhy_coh,
    rhoYX: row.eyhx_rho,
    phaseYX: row.eyhx_phs,
    cohYX: row.eyhx_coh
  }));
};

const findBestEh4ResistivityFileForPoint = (pointNode, files = [], pointPool = []) => {
  if (pointNode?.type !== 'point' || pointNode?.instrumentType !== 'eh4') return null;

  const exactPointTokens = buildExactPointTokens(
    pointNode.pointValue,
    pointNode?.meta?.['点号']
  );
  const exactMatch = (files || []).find((file) => file?.type === 'file' && isEh4ZLikeFile(file.name) && matchesExactPointToken(file.name, exactPointTokens));
  if (exactMatch) return exactMatch;
  const serialCandidates = (files || [])
    .filter((file) => file?.type === 'file' && isEh4ZLikeFile(file.name))
    .map((file) => ({ file, serial: getEh4FileSerial(file.name) }))
    .filter((item) => Number.isFinite(item.serial))
    .sort((a, b) => a.serial - b.serial);

  if (!serialCandidates.length || !pointPool.length) return null;

  const sameLinePoints = pointPool
    .filter((node) => node.instrumentType === 'eh4' && String(node.lineKey || '') === String(pointNode.lineKey || ''));

  const ordinal = sameLinePoints.findIndex((node) => String(node.pointId || node.id) === String(pointNode.pointId || pointNode.id));
  if (ordinal < 0) return null;
  if (ordinal >= serialCandidates.length) return null;

  return serialCandidates[ordinal]?.file || null;
};

const findBestEh4FileForPointByType = (pointNode, files = [], type = 'Z', pointPool = []) => {
  if (type === 'Z') return findBestEh4ResistivityFileForPoint(pointNode, files, pointPool);
  if (pointNode?.type !== 'point' || pointNode?.instrumentType !== 'eh4') return null;

  const exactPointTokens = buildExactPointTokens(
    pointNode.pointValue,
    pointNode?.meta?.['点号']
  );
  const matcher = type === 'X' ? isEh4XLikeFile : isEh4YLikeFile;

  const exactMatch = (files || []).find((file) => file?.type === 'file' && matcher(file.name) && matchesExactPointToken(file.name, exactPointTokens));
  if (exactMatch) return exactMatch;
  const serialCandidates = (files || [])
    .filter((file) => file?.type === 'file' && matcher(file.name))
    .map((file) => ({ file, serial: getEh4FileSerial(file.name) }))
    .filter((item) => Number.isFinite(item.serial))
    .sort((a, b) => a.serial - b.serial);

  if (!serialCandidates.length || !pointPool.length) return null;

  const sameLinePoints = pointPool
    .filter((node) => node.instrumentType === 'eh4' && String(node.lineKey || '') === String(pointNode.lineKey || ''));

  const ordinal = sameLinePoints.findIndex((node) => String(node.pointId || node.id) === String(pointNode.pointId || pointNode.id));
  if (ordinal < 0) return null;
  if (ordinal >= serialCandidates.length) return null;

  return serialCandidates[ordinal]?.file || null;
};

const findBestF3FileForPointByType = (pointNode, files = [], type = 'Z', pointPool = []) => {
  if (pointNode?.type !== 'point' || pointNode?.instrumentType !== 'f3') return null;

  const matcher = type === 'X' ? isF3XLikeFile : type === 'Y' ? isF3YLikeFile : isF3ZLikeFile;

  const siblingCandidates = (files || [])
    .filter((file) => file?.type === 'file' && matcher(file.name))
    .map((file) => ({ file, serial: getF3FileSerial(file.name) }))
    .filter((item) => Number.isFinite(item.serial))
    .sort((a, b) => a.serial - b.serial);

  if (!siblingCandidates.length || !pointPool.length) return null;

  const sameLinePoints = pointPool
    .filter((node) => node.instrumentType === 'f3' && String(node.lineKey || '') === String(pointNode.lineKey || ''));

  const ordinal = sameLinePoints.findIndex((node) => String(node.pointId || node.id) === String(pointNode.pointId || pointNode.id));
  if (ordinal < 0) return null;
  if (ordinal >= siblingCandidates.length) return null;

  return siblingCandidates[ordinal]?.file || null;
};

const prepareParserFile = async (file) => {
  if (!file) return null;
  return file;
};

const withPointStationMeta = (file, pointNode) => {
  if (!file || !pointNode) return file;
  const pointMeta = pointNode?.meta || {};
  const currentMeta = file.stationMeta || {};
  return {
    ...file,
    stationMeta: {
      ...currentMeta,
      id: currentMeta.id || pointNode.pointId || pointNode.id || '',
      rx: pointNode.pointValue || pointMeta['点号'] || currentMeta.rx || '--',
      ry: pointNode.lineKey || pointMeta['线号'] || currentMeta.ry || '--',
      xl: pointMeta['X极距'] || currentMeta.xl || '--',
      yl: pointMeta['Y极距'] || currentMeta.yl || '--'
    }
  };
};

const buildParserFileProp = (file) => {
  if (!file) return file;
  return {
    ...file,
    stationMeta: file.stationMeta
  };
};

const findPointBoundFileByType = (pointNode, files = [], matcher) => {
  if (!pointNode || typeof matcher !== 'function') return null;
  return collectPointBoundFiles(pointNode, files, matcher)[0] || null;
};

const buildEh4SiblingFile = (sourceFile, targetType, pointNode) => {
  if (!sourceFile?.name) return null;
  const sourceName = String(sourceFile.name || '').trim();
  if (!sourceName) return null;
  const lowerName = sourceName.toLowerCase();

  if (targetType !== 'Z' && (lowerName.endsWith('.edi') || lowerName.endsWith('.mt'))) {
    return null;
  }

  let nextName = '';
  if (/^[xyz]/i.test(sourceName)) {
    nextName = `${targetType}${sourceName.slice(1)}`;
  } else if (/\.(r|psd|fh|fm|fl|mtts)$/i.test(sourceName)) {
    const stem = sourceName.replace(/\.[^.]+$/, '');
    nextName = `${targetType}${stem.replace(/^[xyz]/i, '')}${sourceName.slice(stem.length)}`;
  }

  if (!nextName) return null;

  return {
    ...sourceFile,
    name: nextName,
    stationMeta: sourceFile.stationMeta || pointNode?.stationMeta || null
  };
};

const buildF3SiblingFile = (sourceFile, targetType) => {
  if (!sourceFile?.name) return null;
  const match = String(sourceFile.name || '').trim().match(/^(.+)\.(\d+)\.(r|psd|fh|fm|fl)$/i);
  if (!match) return null;
  const [, projectPart, serialRaw, currentExt] = match;
  const extMap = {
    Z: 'r',
    X: 'psd',
    Y: ['fh', 'fm', 'fl'].includes(currentExt.toLowerCase()) ? currentExt.toLowerCase() : 'fh'
  };
  const nextExt = extMap[targetType];
  if (!nextExt) return null;
  return {
    ...sourceFile,
    name: `${projectPart}.${serialRaw}.${nextExt}`
  };
};

const buildEh4ResistivityChartOption = (rows = []) => ({
  animation: false,
  tooltip: {
    trigger: 'axis',
    formatter: (params = []) => {
      const items = Array.isArray(params) ? params : [params];
      if (!items.length) return '';
      const freq = items[0]?.value?.[0];
      const lines = [`频率: ${Number(freq).toExponential(3)} Hz`];
      items.forEach((item) => {
        const value = item?.value?.[1];
        if (!Number.isFinite(value)) return;
        lines.push(`${item.seriesName}: ${value.toExponential(3)} ohm·m`);
      });
      return lines.join('<br/>');
    }
  },
  legend: { top: 8, textStyle: { color: '#475569', fontSize: 12 } },
  grid: { left: 56, right: 28, top: 48, bottom: 42 },
  xAxis: {
    type: 'log',
    name: '频率(Hz)',
    nameLocation: 'middle',
    nameGap: 28,
    inverse: true,
    minorSplitLine: { show: true },
    splitLine: { lineStyle: { color: '#e2e8f0' } }
  },
  yAxis: {
    type: 'log',
    name: '视电阻率(ohm·m)',
    nameLocation: 'middle',
    nameGap: 44,
    minorSplitLine: { show: true },
    splitLine: { lineStyle: { color: '#e2e8f0' } }
  },
  series: [
    {
      name: 'RhoXY',
      type: 'line',
      showSymbol: true,
      symbolSize: 6,
      lineStyle: { width: 2.2, color: '#2563eb' },
      itemStyle: { color: '#2563eb' },
      data: rows.map((row) => [row.frequency, row.rhoXY]).filter((item) => Number.isFinite(item[0]) && item[0] > 0 && Number.isFinite(item[1]) && item[1] > 0)
    },
    {
      name: 'RhoYX',
      type: 'line',
      showSymbol: true,
      symbolSize: 6,
      lineStyle: { width: 2.2, color: '#ea580c' },
      itemStyle: { color: '#ea580c' },
      data: rows.map((row) => [row.frequency, row.rhoYX]).filter((item) => Number.isFinite(item[0]) && item[0] > 0 && Number.isFinite(item[1]) && item[1] > 0)
    }
  ]
});

const collectFilesForPoint = (pointNode, files = []) => {
  if (!pointNode || pointNode.type !== 'point') return [];

  const exactPointTokens = buildExactPointTokens(
    pointNode.pointValue,
    pointNode?.meta?.['点号']
  );
  const matcher = pointNode.instrumentType === 'eh4'
    ? (name) => isEh4ZLikeFile(name) || isEh4XLikeFile(name) || isEh4YLikeFile(name)
    : pointNode.instrumentType === 'emap'
      ? (name) => isEmapFile(name)
      : (name) => isF3ZLikeFile(name) || isF3XLikeFile(name) || isF3YLikeFile(name);

  const boundFiles = collectPointBoundFiles(pointNode, files, matcher);
  const ranked = (files || [])
    .filter((file) => file?.type === 'file' && matcher(file.name))
    .filter((file) => {
      if (pointNode.instrumentType === 'emap') {
        return String(parseMTTSPointNo(file.name) || '').trim() === String(pointNode.pointValue || pointNode?.meta?.['点号'] || '').trim();
      }
      return matchesExactPointToken(file.name, exactPointTokens);
    })
    .map((file) => ({ file }));

  const uniqueFiles = [];
  const seen = new Set();
  [
    ...boundFiles,
    ...ranked.map(({ file }) => file)
  ].forEach((file) => {
    const key = String(file.id || file.name || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    uniqueFiles.push(file);
  });
  return uniqueFiles;
};

const buildSurveyTree = (project, dataFiles = []) => {
  const normalizedFiles = dataFiles.map((file, idx) => ({
    ...file,
    id: file.id || `file_${idx + 1}`
  }));

  const plannedEntries = project?.plan?.designEntries || [];
  const projectMethodLabel = getProjectMethodLabel(project);
  if (plannedEntries.length) {
    const groupedByLine = plannedEntries.reduce((acc, entry) => {
      const lineKey = String(entry.line || '未命名测线').trim();
      const instrumentName = getInstrumentLabel(entry.instrument, projectMethodLabel);
      const methodName = getMethodLabelForInstrument(entry.instrument, projectMethodLabel);
      const groupKey = `${lineKey}__${instrumentName}`;
      if (!acc[groupKey]) {
        acc[groupKey] = {
          lineKey,
          instrumentName,
          methodName,
          entries: []
        };
      }
      acc[groupKey].entries.push(entry);
      return acc;
    }, {});

    const lineNodes = Object.values(groupedByLine)
      .sort((a, b) => {
        const lineCompare = String(a.lineKey || '').localeCompare(String(b.lineKey || ''), 'zh-Hans-CN', { numeric: true });
        if (lineCompare !== 0) return lineCompare;
        return String(a.instrumentName || '').localeCompare(String(b.instrumentName || ''), 'zh-Hans-CN', { numeric: true });
      })
      .map(({ lineKey, instrumentName, methodName, entries }, lineIndex) => ({
      id: `${project.id}_line_${lineIndex + 1}`,
      name: `测线 ${lineKey} · ${instrumentName}`,
      type: 'line',
      lineKey,
      methodName,
      status: entries.length ? '处理中' : '待处理',
      meta: {
        勘探方法: methodName,
        仪器: instrumentName,
        覆盖测点: `${entries.length} 个`,
        数据文件: `${normalizedFiles.length} 个`,
        最近更新: project.lastUpdate
      },
      children: entries
        .sort((a, b) => String(a.point || '').localeCompare(String(b.point || ''), 'zh-Hans-CN', { numeric: true }))
        .map((entry, pointIndex) => {
          const pointNode = {
            id: entry.id || `${project.id}_line_${lineIndex + 1}_point_${pointIndex + 1}`,
            name: `测点 ${entry.point || pointIndex + 1}`,
            type: 'point',
            status: '已采集',
            pointId: entry.id || `${project.id}_line_${lineIndex + 1}_point_${pointIndex + 1}`,
            pointValue: String(entry.point || pointIndex + 1),
            lineKey,
            instrumentName,
            instrumentType: normalizeInstrumentType(entry.instrument || projectMethodLabel),
            matchedDataPaths: uniquePathList(Array.isArray(entry.matchedDataPaths) ? entry.matchedDataPaths : []),
            matchedDataCount: uniquePathList(Array.isArray(entry.matchedDataPaths) ? entry.matchedDataPaths : []).length || Number(entry.matchedDataCount || 0),
            hasExistingData: Boolean(entry.hasExistingData),
            sourceFileName: entry.sourceFileName || '',
            sourceCoordFileName: entry.sourceCoordFileName || '',
            meta: {
              线号: entry.line || '--',
              点号: entry.point || '--',
              勘探方法: methodName,
              仪器: instrumentName,
              经度: Number(entry.gpsLongitude)?.toFixed?.(6) ?? '--',
              纬度: Number(entry.gpsLatitude)?.toFixed?.(6) ?? '--',
              最近更新: project.lastUpdate
            },
            children: []
          };
          const pointFiles = uniqueFileList(collectFilesForPoint(pointNode, normalizedFiles));
          const pointFileNames = uniqueBy(pointFiles.map((file) => file.name).filter(Boolean));
          return {
            ...pointNode,
            matchedDataCount: pointFiles.length || pointNode.matchedDataPaths.length || 0,
            fileNames: pointFileNames,
            fileNamesSummary: pointFileNames.join('、'),
            meta: {
              ...pointNode.meta,
              数据文件: `${pointFiles.length || pointNode.matchedDataPaths.length || 0} 个`,
              文件清单: pointFileNames.join('、') || '暂无'
            }
          };
        })
    }));

    const methodNodes = Object.values(lineNodes.reduce((acc, lineNode) => {
      const methodName = String(lineNode.methodName || projectMethodLabel || '未标注方法').trim();
      if (!acc[methodName]) {
        acc[methodName] = {
          id: `${project.id}_method_${methodName}`,
          name: methodName,
          type: 'method',
          status: project.status,
          meta: {
            所属项目: project.name,
            覆盖测线: '0 条',
            规划测点: '0 个',
            最近更新: project.lastUpdate
          },
          children: []
        };
      }
      acc[methodName].children.push(lineNode);
      return acc;
    }, {})).map((methodNode) => ({
      ...methodNode,
      meta: {
        ...methodNode.meta,
        覆盖测线: `${methodNode.children.length} 条`,
        规划测点: `${methodNode.children.reduce((sum, line) => sum + (line.children?.length || 0), 0)} 个`
      }
    }));

    return {
      id: project.id,
      name: project.name,
      type: 'project',
      status: project.status,
      meta: {
        负责人: project.manager,
        勘探方法: projectMethodLabel,
        测区位置: project.location,
        最近更新: project.lastUpdate
      },
      children: methodNodes
    };
  }

  const fallbackMethodLabel = getMethodLabelForInstrument(projectMethodLabel, projectMethodLabel);

  return {
    id: project.id,
    name: project.name,
    type: 'project',
    status: project.status,
    meta: {
      负责人: project.manager,
      勘探方法: projectMethodLabel,
      测区位置: project.location,
      最近更新: project.lastUpdate
    },
    children: [
      {
        id: `${project.id}_method`,
        name: fallbackMethodLabel,
        type: 'method',
        status: project.status,
        meta: {
          所属项目: project.name,
          覆盖测线: '0 条',
          规划测点: '0 个',
          数据文件: `${normalizedFiles.length} 个`,
          最近更新: project.lastUpdate
        },
        children: []
      }
    ]
  };
};

const nodeIconMap = {
  project: FolderKanban,
  method: Compass,
  line: GitBranch,
  point: Database
};

const statusColor = {
  '规划中': { bg: '#f8fafc', text: '#64748b' },
  '采集中': { bg: '#eef2ff', text: '#4f46e5' },
  '处理中': { bg: '#eff6ff', text: '#2563eb' },
  '已采集': { bg: '#ecfdf5', text: '#10b981' },
  '待处理': { bg: '#fffbeb', text: '#f59e0b' },
  '解算完成': { bg: '#ecfdf5', text: '#10b981' }
};


const flattenNodes = (node) => {
  if (!node) return [];
  const result = [node];
  (node.children || []).forEach(child => {
    result.push(...flattenNodes(child));
  });
  return result;
};

const buildPointAncestorMap = (node, ancestors = [], acc = {}) => {
  if (!node) return acc;
  if (node.type === 'point') {
    acc[node.pointId || node.id] = ancestors;
  }
  (node.children || []).forEach(child => {
    buildPointAncestorMap(child, [...ancestors, node.id], acc);
  });
  return acc;
};

const TreeRow = ({ index, style, visibleFlatNodes, expandedKeys, onToggle, selectedId, onSelect }) => {
  const { node, level } = visibleFlatNodes[index];
  const hasChildren = Boolean(node.children?.length);
  const expanded = expandedKeys.has(node.id);
  const Icon = nodeIconMap[node.type] || Database;
  const color = statusColor[node.status] || statusColor['规划中'];
  const subtitle = node.type === 'point'
    ? (node.fileNamesSummary || '测点节点')
    : node.type === 'line'
      ? '测线节点'
      : node.type === 'method'
        ? '勘探方法节点'
        : '项目节点';

  return (
    <div style={style}>
      <div
        onClick={() => onSelect(node)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 12px',
          paddingLeft: `${12 + level * 18}px`,
          cursor: 'pointer',
          background: selectedId === node.id ? '#eff6ff' : 'transparent',
          borderBottom: '1px solid #f1f5f9',
          height: '100%',
          boxSizing: 'border-box'
        }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
            style={{ background: 'transparent', border: 'none', padding: 0, display: 'flex', alignItems: 'center', cursor: 'pointer', color: '#64748b' }}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        ) : (
          <span style={{ width: '16px' }} />
        )}
        <Icon size={16} color={node.type === 'file' ? '#64748b' : '#3b82f6'} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '13px', color: '#0f172a', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</div>
          <div style={{ fontSize: '12px', color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</div>
        </div>
        <span style={{ padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 600, background: color.bg, color: color.text }}>{node.status}</span>
      </div>
    </div>
  );
};

const SurveyDataTree = ({ project, files = [], selectedPointId = '', selectedLineKey = '', autoOpenPointRequest = null, showPanel = true, onSelectPoint, onSelectLine, onLocatePoint, onLocateLine, onOpenLineProfile, currentUser = null }) => {
  const initTree = useSurveyTreeStore((state) => state.initTree);
  const query = useSurveyTreeStore((state) => state.query);
  const setQuery = useSurveyTreeStore((state) => state.setQuery);
  const expandedKeys = useSurveyTreeStore((state) => state.expandedKeys);
  const toggleExpanded = useSurveyTreeStore((state) => state.toggleExpanded);
  const setExpandedKeys = useSurveyTreeStore((state) => state.setExpandedKeys);
  const visibleFlatNodes = useSurveyTreeStore((state) => state.visibleFlatNodes);
  const allNodes = useSurveyTreeStore((state) => state.allNodes);
  const stats = useSurveyTreeStore((state) => state.stats);
  const pointAncestorMap = useSurveyTreeStore((state) => state.pointAncestorMap);
  const eh4Points = useSurveyTreeStore((state) => state.eh4Points);
  const emapPoints = useSurveyTreeStore((state) => state.emapPoints);
  const f3Points = useSurveyTreeStore((state) => state.f3Points);
  const rootNode = useSurveyTreeStore((state) => state.rootNode);

  useEffect(() => {
    const nextRootNode = buildSurveyTree(project, files);
    const nextAllNodes = flattenNodes(nextRootNode);
    const nextPointAncestorMap = buildPointAncestorMap(nextRootNode);
    const methods = nextAllNodes.filter(node => node.type === 'method').length;
    const lines = nextAllNodes.filter(node => node.type === 'line').length;
    const points = nextAllNodes.filter(node => node.type === 'point').length;
    initTree(nextRootNode, nextAllNodes, nextPointAncestorMap, { methods, lines, points });
  }, [project, files, initTree]);

  const [selectedNode, setSelectedNode] = useState(null);

  useEffect(() => {
    if (rootNode && !selectedNode) {
      setSelectedNode(rootNode); // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [rootNode, selectedNode]);
  const [eh4PointData, setEh4PointData] = useState({ status: 'idle', rows: [], fileName: '', sourceType: '', message: '' });
  const [parsingMTFile, setParsingMTFile] = useState(null);
  const [parsingXFile, setParsingXFile] = useState(null);
  const [parsingYFile, setParsingYFile] = useState(null);
  const [activeParserPointId, setActiveParserPointId] = useState('');
  const [activeParserType, setActiveParserType] = useState('Z');
  const [activeParserInstrument, setActiveParserInstrument] = useState('');
  const lastAutoOpenedPointIdRef = useRef('');
  const pendingTreeOpenPointIdRef = useRef('');
  const lastHandledAutoOpenStampRef = useRef('');
  const filesRef = useRef(files);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const selectedEh4PointDataKey = useMemo(() => {
    if (selectedNode?.type !== 'point' || selectedNode?.instrumentType !== 'eh4') {
      return 'idle';
    }
    const relevantFiles = files
      .filter((file) => file?.type === 'file' && (
        isEh4ZLikeFile(file.name) ||
        isEh4XLikeFile(file.name) ||
        collectPointBoundFiles(selectedNode, [file], () => true).length > 0
      ))
      .map((file) => [
        file.id || '',
        file.name || '',
        file.parentId || '',
        file.object_key || file.objectKey || '',
        file.storage_provider || file.storageProvider || ''
      ].join(':'))
      .sort()
      .join('|');
    return [
      selectedNode.pointId || selectedNode.id || '',
      selectedNode.pointValue || '',
      selectedNode.lineKey || '',
      selectedNode?.meta?.['点号'] || '',
      selectedNode?.meta?.['线号'] || '',
      relevantFiles
    ].join('|');
  }, [
    files,
    selectedNode
  ]);
  useEffect(() => {
    if (!selectedPointId) return;
    const matched = allNodes.find(node => node.type === 'point' && (node.pointId || node.id) === selectedPointId);
    if (!matched) return;
    const timeoutId = window.setTimeout(() => {
      setSelectedNode(matched);
      setExpandedKeys(prev => {
        const next = new Set(prev);
        (pointAncestorMap[selectedPointId] || []).forEach(id => next.add(id));
        return next;
      });
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [allNodes, pointAncestorMap, selectedPointId, setExpandedKeys]);

  useEffect(() => {
    if (!selectedLineKey) return;
    const matched = allNodes.find(node => node.type === 'line' && String(node.lineKey || '').trim() === String(selectedLineKey).trim());
    if (!matched) return;
    const timeoutId = window.setTimeout(() => {
      setSelectedNode(prev => selectedPointId ? prev : matched);
      setExpandedKeys(prev => {
        const next = new Set(prev);
        next.add(matched.id);
        return next;
      });
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [allNodes, selectedLineKey, selectedPointId, setExpandedKeys]);

  const closeAllParsers = useCallback(() => {
    setParsingMTFile(null);
    setParsingXFile(null);
    setParsingYFile(null);
  }, []);

  const handleCloseParser = useCallback(() => {
    closeAllParsers();
    setActiveParserPointId('');
    setActiveParserType('Z');
    setActiveParserInstrument('');
    lastAutoOpenedPointIdRef.current = activeParserPointId || selectedPointId || lastAutoOpenedPointIdRef.current;
  }, [activeParserPointId, closeAllParsers, selectedPointId]);

  const getActiveParserFile = useCallback(
    () => parsingMTFile || parsingXFile || parsingYFile || null,
    [parsingMTFile, parsingXFile, parsingYFile]
  );

  const openParserForPoint = useCallback(async (pointNode, type = 'Z', options = {}) => {
    const { allowActiveFallback = false } = options;
    if (!pointNode || pointNode.type !== 'point') return false;
    let matchedFile = null;
    if (pointNode.instrumentType === 'eh4') {
      const matcher = type === 'Z' ? isEh4ZLikeFile : type === 'X' ? isEh4XLikeFile : isEh4YLikeFile;
      matchedFile = findPointBoundFileByType(pointNode, files, matcher) || findBestEh4FileForPointByType(pointNode, files, type, eh4Points);
      if (!matchedFile) {
        const fallbackSource =
          (allowActiveFallback ? getActiveParserFile() : null) ||
          findPointBoundFileByType(pointNode, files, isEh4ZLikeFile) ||
          findPointBoundFileByType(pointNode, files, isEh4XLikeFile) ||
          findPointBoundFileByType(pointNode, files, isEh4YLikeFile) ||
          findBestEh4FileForPointByType(pointNode, files, 'Z', eh4Points) ||
          findBestEh4FileForPointByType(pointNode, files, 'X', eh4Points) ||
          findBestEh4FileForPointByType(pointNode, files, 'Y', eh4Points);
        matchedFile = buildEh4SiblingFile(fallbackSource, type, pointNode);
      }
    } else if (pointNode.instrumentType === 'emap') {
      if (type !== 'Z' && type !== 'Y') return false;
      const emapGroup = buildEmapGroupForPoint(pointNode, files);
      if (!emapGroup) return false;
      closeAllParsers();
      setActiveParserPointId(pointNode.pointId || pointNode.id);
      setActiveParserType('Y');
      setActiveParserInstrument(pointNode.instrumentType || '');
      setParsingYFile(emapGroup);
      return true;
    } else if (pointNode.instrumentType === 'f3') {
      matchedFile = findBestF3FileForPointByType(pointNode, files, type, f3Points);
      if (!matchedFile) {
        const fallbackSource =
          (allowActiveFallback ? getActiveParserFile() : null) ||
          findBestF3FileForPointByType(pointNode, files, 'Z', f3Points) ||
          findBestF3FileForPointByType(pointNode, files, 'X', f3Points) ||
          findBestF3FileForPointByType(pointNode, files, 'Y', f3Points);
        matchedFile = buildF3SiblingFile(fallbackSource, type);
      }
    }
    if (!matchedFile) return false;
    const parserFile = withPointStationMeta(await prepareParserFile(matchedFile), pointNode);
    if (!parserFile) return false;
    closeAllParsers();
    setActiveParserPointId(pointNode.pointId || pointNode.id);
    setActiveParserType(type);
    setActiveParserInstrument(pointNode.instrumentType || '');
    if (type === 'X') {
      setParsingXFile(parserFile);
      return true;
    }
    if (type === 'Y') {
      setParsingYFile(parserFile);
      return true;
    }
    setParsingMTFile(parserFile);
    return true;
  }, [closeAllParsers, eh4Points, f3Points, files, getActiveParserFile]);

  const openMatchedMtParser = useCallback(async (pointNode) => {
    if (!pointNode || pointNode.type !== 'point') return false;
    if (await openParserForPoint(pointNode, 'Z')) return true;
    if (await openParserForPoint(pointNode, 'Y')) return true;
    return openParserForPoint(pointNode, 'X');
  }, [openParserForPoint]);

  const handleParserSwitchType = (type) => {
    const pointId = String(activeParserPointId || selectedPointId || selectedNode?.pointId || selectedNode?.id || '');
    const pointPool = activeParserInstrument === 'f3' ? f3Points : activeParserInstrument === 'emap' ? emapPoints : eh4Points;
    const matchedPoint = pointPool.find((node) => String(node.pointId || node.id || '') === pointId);
    if (!matchedPoint) return;
    openParserForPoint(matchedPoint, type, { allowActiveFallback: true });
  };

  const handleParserSwitchPoint = useCallback(async (direction) => {
    const pointPool = activeParserInstrument === 'f3' ? f3Points : activeParserInstrument === 'emap' ? emapPoints : eh4Points;
    if (!pointPool.length) return;
    const pointId = String(activeParserPointId || selectedPointId || selectedNode?.pointId || selectedNode?.id || '');
    const currentIndex = pointPool.findIndex((node) => String(node.pointId || node.id || '') === pointId);
    if (currentIndex < 0) return;

    const parserType = activeParserType || 'Z';
    for (let offset = 1; offset <= pointPool.length; offset++) {
      const nextIndex = (currentIndex + direction * offset + pointPool.length) % pointPool.length;
      if (nextIndex === currentIndex) continue;
      const nextPoint = pointPool[nextIndex];
      const opened = await openParserForPoint(nextPoint, parserType);
      if (!opened) continue;
      setSelectedNode(nextPoint);
      setActiveParserPointId(nextPoint.pointId || nextPoint.id);
      onSelectPoint?.(nextPoint.pointId || nextPoint.id);
      onSelectLine?.(nextPoint.lineKey || nextPoint.meta?.线号 || '');
      return;
    }
  }, [activeParserInstrument, activeParserPointId, activeParserType, eh4Points, emapPoints, f3Points, onSelectLine, onSelectPoint, openParserForPoint, selectedNode, selectedPointId]);

  useEffect(() => {
    if (!selectedPointId) {
      lastAutoOpenedPointIdRef.current = '';
      return;
    }
    lastAutoOpenedPointIdRef.current = selectedPointId;
  }, [selectedPointId]);

  useEffect(() => {
    let cancelled = false;

    const loadEh4PointData = async () => {
      if (selectedNode?.type !== 'point' || selectedNode?.instrumentType !== 'eh4') {
        setEh4PointData({ status: 'idle', rows: [], fileName: '', sourceType: '', message: '' });
        return;
      }

      const currentFiles = filesRef.current || [];
      const pointTokens = buildPointTokens(
        selectedNode.pointValue,
        selectedNode.name,
        selectedNode.pointId,
        selectedNode?.meta?.['点号']
      );
      const lineTokens = buildPointTokens(selectedNode.lineKey, selectedNode?.meta?.['线号']);

      const scoreFile = (file) => {
        const fileTokens = getFileNameTokens(file.name);
        let score = 0;
        pointTokens.forEach((token) => {
          if (!token) return;
          if (fileTokens.has(token)) score += token.length >= 4 ? 6 : 4;
          else if (String(file.name || '').toLowerCase().includes(token)) score += 2;
        });
        lineTokens.forEach((token) => {
          if (!token) return;
          if (fileTokens.has(token)) score += 2;
          else if (String(file.name || '').toLowerCase().includes(token)) score += 1;
        });
        return score;
      };

      const boundZCandidates = collectPointBoundFiles(selectedNode, currentFiles, isEh4ZLikeFile)
        .map((file) => ({ file, score: 100 }));
      const boundXCandidates = collectPointBoundFiles(selectedNode, currentFiles, isEh4XLikeFile)
        .map((file) => ({ file, score: 100 }));

      const zCandidates = [
        ...boundZCandidates,
        ...currentFiles
        .filter((file) => file?.type === 'file' && isEh4ZLikeFile(file.name))
        .map((file) => ({ file, score: scoreFile(file) }))
        .filter((item) => item.score > 0)
      ].sort((a, b) => b.score - a.score);

      const xCandidates = [
        ...boundXCandidates,
        ...currentFiles
        .filter((file) => file?.type === 'file' && isEh4XLikeFile(file.name))
        .map((file) => ({ file, score: scoreFile(file) }))
        .filter((item) => item.score > 0)
      ].sort((a, b) => b.score - a.score);

        setEh4PointData({ status: 'loading', rows: [], fileName: '', sourceType: '', message: '正在读取测点视电阻率数据...' });

      try {
        const zMatch = zCandidates[0]?.file;
        if (zMatch) {
          const text = await resolveProjectFileText(zMatch);
          const rows = parseEh4ResistivityRowsFromFile(zMatch, text)
            .filter((row) => Number.isFinite(row.frequency) && row.frequency > 0 && Number.isFinite(row.rhoXY) && row.rhoXY > 0 && Number.isFinite(row.rhoYX) && row.rhoYX > 0)
            .sort((a, b) => a.frequency - b.frequency);
          if (!cancelled && rows.length) {
            setEh4PointData({
              status: 'ready',
              rows,
              fileName: zMatch.name,
              sourceType: 'Z',
              message: `已从 ${zMatch.name} 读取 ${rows.length} 条视电阻率曲线`
            });
            return;
          }
        }

        const xMatch = xCandidates[0]?.file;
        if (xMatch) {
          const text = await resolveProjectFileText(xMatch);
          const rows = computeEh4ImpedanceFromCrosspowers(parseXFile(text))
            .map((row) => ({
              frequency: row.freq,
              rhoXY: row.rhoXY,
              rhoYX: row.rhoYX,
              phaseXY: row.phaseXY,
              phaseYX: row.phaseYX,
              cohXY: row.exHyCoherency,
              cohYX: row.eyHxCoherency
            }))
            .filter((row) => Number.isFinite(row.frequency) && row.frequency > 0 && Number.isFinite(row.rhoXY) && row.rhoXY > 0 && Number.isFinite(row.rhoYX) && row.rhoYX > 0)
            .sort((a, b) => a.frequency - b.frequency);
          if (!cancelled && rows.length) {
            setEh4PointData({
              status: 'ready',
              rows,
              fileName: xMatch.name,
              sourceType: 'X',
              message: `已从 ${xMatch.name} 反算 ${rows.length} 条视电阻率曲线`
            });
            return;
          }
        }

        if (!cancelled) {
          setEh4PointData({
            status: 'empty',
            rows: [],
            fileName: '',
            sourceType: '',
            message: '当前测点未匹配到可用的视电阻率文件'
          });
        }
      } catch (error) {
        if (!cancelled) {
          setEh4PointData({
            status: 'error',
            rows: [],
            fileName: '',
            sourceType: '',
            message: `视电阻率读取失败：${error.message}`
          });
        }
      }
    };

    loadEh4PointData();
    return () => {
      cancelled = true;
    };
  }, [selectedEh4PointDataKey, selectedNode]);

  useEffect(() => {
    const pendingPointId = String(pendingTreeOpenPointIdRef.current || '');
    const selectedPointIdText = String(selectedNode?.pointId || selectedNode?.id || '');
    if (!pendingPointId || pendingPointId !== selectedPointIdText) return;
    if (parsingMTFile || parsingXFile || parsingYFile) {
      pendingTreeOpenPointIdRef.current = '';
      return;
    }
    if (selectedNode?.type !== 'point' || selectedNode?.instrumentType !== 'eh4') return;
    if (eh4PointData.status !== 'ready' || !eh4PointData.fileName) return;

    const matchedFile = files.find((file) => String(file?.name || '').trim().toLowerCase() === String(eh4PointData.fileName || '').trim().toLowerCase());
    if (!matchedFile) return;

    let cancelled = false;
    (async () => {
      const parserFile = withPointStationMeta(await prepareParserFile(matchedFile), selectedNode);
      if (cancelled || !parserFile) return;
      closeAllParsers();
      setActiveParserPointId(selectedNode.pointId || selectedNode.id);
      setActiveParserType(eh4PointData.sourceType === 'X' ? 'X' : 'Z');
      setActiveParserInstrument(selectedNode.instrumentType || '');
      if (eh4PointData.sourceType === 'X') setParsingXFile(parserFile);
      else setParsingMTFile(parserFile);
      pendingTreeOpenPointIdRef.current = '';
    })();

    return () => {
      cancelled = true;
    };
  }, [closeAllParsers, eh4PointData.fileName, eh4PointData.sourceType, eh4PointData.status, files, parsingMTFile, parsingXFile, parsingYFile, selectedNode]);

  useEffect(() => {
    const requestPointId = String(autoOpenPointRequest?.pointId || '').trim();
    const requestStamp = String(autoOpenPointRequest?.stamp || '').trim();
    if (!requestPointId || !requestStamp || requestStamp === lastHandledAutoOpenStampRef.current) return;

    const matchedPoint = allNodes.find((node) => node.type === 'point' && String(node.pointId || node.id || '') === requestPointId);
    if (!matchedPoint) return;

    lastHandledAutoOpenStampRef.current = requestStamp;
    pendingTreeOpenPointIdRef.current = matchedPoint.pointId || matchedPoint.id;
    queueMicrotask(() => {
      setSelectedNode(matchedPoint);
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        (pointAncestorMap[requestPointId] || []).forEach((id) => next.add(id));
        return next;
      });
      openMatchedMtParser(matchedPoint);
    });
  }, [allNodes, autoOpenPointRequest, openMatchedMtParser, pointAncestorMap, setExpandedKeys]);

  const handleSelectNode = async (node) => {
    setSelectedNode(node);
    if (node.type === 'point') {
      onSelectPoint?.(node.pointId || node.id);
      onSelectLine?.(node.lineKey || node.meta?.线号 || '');
      if (node.instrumentType === 'eh4' || node.instrumentType === 'emap' || node.instrumentType === 'f3') {
        pendingTreeOpenPointIdRef.current = node.pointId || node.id;
        const opened = await openMatchedMtParser(node);
        if (opened) pendingTreeOpenPointIdRef.current = '';
      }
    }
    if (node.type === 'line') {
      onSelectLine?.(node.lineKey || node.name.replace(/^测线\s*/, ''));
      onOpenLineProfile?.({
        lineKey: node.lineKey || node.name.replace(/^测线\s*/, ''),
        instrumentName: node.instrumentName || '',
        methodName: node.methodName || ''
      });
    }
  };

  return (
    <>
      {showPanel && (
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '20px' }}>
          <div className="card glass" style={{ padding: '16px', display: 'flex', flexDirection: 'column', minHeight: '560px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: '#0f172a' }}>测区数据树</div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>项目 - 勘探方法 - 测线 - 测点</div>
          </div>
          <button
            onClick={() => setExpandedKeys(new Set(allNodes.filter(node => node.children?.length).map(node => node.id)))}
            style={{ background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '6px 10px', cursor: 'pointer', fontSize: '12px', fontWeight: 500 }}
          >
            全部展开
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '10px 12px', marginBottom: '12px' }}>
          <Search size={16} color="#94a3b8" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索勘探方法、测线或测点..."
            style={{ border: 'none', outline: 'none', background: 'transparent', width: '100%', fontSize: '13px', color: '#0f172a' }}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
          <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '10px 12px' }}>
            <div style={{ fontSize: '12px', color: '#64748b' }}>项目</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>1</div>
          </div>
          <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '10px 12px' }}>
            <div style={{ fontSize: '12px', color: '#64748b' }}>勘探方法</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>{stats.methods}</div>
          </div>
          <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '10px 12px' }}>
            <div style={{ fontSize: '12px', color: '#64748b' }}>测线</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>{stats.lines}</div>
          </div>
          <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '10px 12px' }}>
            <div style={{ fontSize: '12px', color: '#64748b' }}>测点</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>{stats.points}</div>
          </div>
        </div>
        <div style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: '12px', background: '#fff', overflow: 'hidden' }}>
          {visibleFlatNodes.length > 0 ? (
            <AutoSizer>
              {({ height, width }) => (
                <List
                  rowComponent={TreeRow}
                  rowCount={visibleFlatNodes.length}
                  rowHeight={56}
                  rowProps={{ visibleFlatNodes, expandedKeys, onToggle: toggleExpanded, selectedId: selectedNode?.id, onSelect: handleSelectNode }}
                  style={{ height, width }}
                />
              )}
            </AutoSizer>
          ) : (
            <div style={{ padding: '40px 16px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>未找到匹配的数据树节点</div>
          )}
        </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div className="card glass" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>{selectedNode?.name || '节点详情'}</div>
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>当前选中节点的结构信息与状态摘要</div>
            </div>
            <span style={{ padding: '4px 10px', borderRadius: '999px', background: (statusColor[selectedNode?.status] || statusColor['规划中']).bg, color: (statusColor[selectedNode?.status] || statusColor['规划中']).text, fontSize: '12px', fontWeight: 600 }} >
              {selectedNode?.status || '--'}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' }}>
            <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '12px 14px' }}>
              <div style={{ fontSize: '12px', color: '#64748b' }}>节点类型</div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: '#0f172a', marginTop: '4px' }}>{selectedNode?.type || '--'}</div>
            </div>
            <div style={{ background: '#f8fafc', borderRadius: '10px', padding: '12px 14px' }}>
              <div style={{ fontSize: '12px', color: '#64748b' }}>子节点数量</div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: '#0f172a', marginTop: '4px' }}>{selectedNode?.children?.length || 0}</div>
            </div>
          </div>
          <div style={{ marginTop: '16px', display: 'grid', gap: '10px' }}>
            {Object.entries(selectedNode?.meta || {}).map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', padding: '10px 0', borderBottom: '1px dashed #e2e8f0' }}>
                <span style={{ color: '#64748b', fontSize: '13px' }}>{label}</span>
                <span style={{ color: '#0f172a', fontSize: '13px', fontWeight: 500, textAlign: 'right' }}>{value}</span>
              </div>
            ))}
          </div>
          {selectedNode?.type === 'point' && selectedNode?.instrumentType === 'eh4' && (
            <div style={{ marginTop: '18px', border: '1px solid #dbeafe', borderRadius: '12px', overflow: 'hidden', background: '#f8fbff' }}>
              <div style={{ padding: '14px 16px', borderBottom: '1px solid #dbeafe', display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>视电阻率</div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                    {eh4PointData.fileName ? `${eh4PointData.sourceType} 文件: ${eh4PointData.fileName}` : '按当前测点自动匹配'}
                  </div>
                </div>
                <div style={{ fontSize: '12px', color: eh4PointData.status === 'error' ? '#b91c1c' : '#475569' }}>
                  {eh4PointData.rows?.length ? `${eh4PointData.rows.length} 条` : '--'}
                </div>
              </div>
              <div style={{ padding: '14px 16px' }}>
                {eh4PointData.status === 'loading' && (
                  <div style={{ fontSize: '12px', color: '#475569' }}>{eh4PointData.message}</div>
                )}
                {eh4PointData.status === 'error' && (
                  <div style={{ fontSize: '12px', color: '#b91c1c' }}>{eh4PointData.message}</div>
                )}
                {eh4PointData.status === 'empty' && (
                  <div style={{ fontSize: '12px', color: '#64748b' }}>{eh4PointData.message}</div>
                )}
                {eh4PointData.status === 'ready' && eh4PointData.rows.length > 0 && (
                  <div style={{ display: 'grid', gap: '14px' }}>
                    <div style={{ fontSize: '12px', color: '#475569' }}>{eh4PointData.message}</div>
                    <ReactECharts option={buildEh4ResistivityChartOption(eh4PointData.rows)} style={{ width: '100%', height: '280px' }} notMerge={true} lazyUpdate={true} />
                    <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: '10px', background: '#fff' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                        <thead style={{ background: '#eff6ff' }}>
                          <tr>
                            {['频率(Hz)', 'RhoXY', 'RhoYX', 'PhaseXY', 'PhaseYX'].map((title) => (
                              <th key={title} style={{ padding: '10px 12px', textAlign: 'left', color: '#475569', borderBottom: '1px solid #dbeafe' }}>{title}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {eh4PointData.rows.slice(0, 12).map((row) => (
                            <tr key={`${eh4PointData.fileName}_${row.frequency}`} style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '10px 12px', color: '#0f172a' }}>{row.frequency.toExponential(3)}</td>
                              <td style={{ padding: '10px 12px', color: '#0f172a' }}>{row.rhoXY.toExponential(3)}</td>
                              <td style={{ padding: '10px 12px', color: '#0f172a' }}>{row.rhoYX.toExponential(3)}</td>
                              <td style={{ padding: '10px 12px', color: '#0f172a' }}>{Number.isFinite(row.phaseXY) ? row.phaseXY.toFixed(2) : '--'}</td>
                              <td style={{ padding: '10px 12px', color: '#0f172a' }}>{Number.isFinite(row.phaseYX) ? row.phaseYX.toFixed(2) : '--'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          {selectedNode?.type === 'point' && (
            <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
              <button
                onClick={() => onLocatePoint?.(selectedNode.pointId || selectedNode.id, 'overview')}
                style={{ background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '8px 12px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}
              >
                定位到概览图
              </button>
              <button
                onClick={() => onLocatePoint?.(selectedNode.pointId || selectedNode.id, 'planning')}
                style={{ background: '#fff7ed', color: '#ea580c', border: '1px solid #fdba74', borderRadius: '10px', padding: '8px 12px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}
              >
                定位到方案规划
              </button>
            </div>
          )}
          {selectedNode?.type === 'line' && (
            <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
              <button
                onClick={() => onLocateLine?.(selectedNode.lineKey || selectedNode.name.replace(/^测线\s*/, ''), 'overview')}
                style={{ background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '8px 12px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}
              >
                高亮概览测线
              </button>
              <button
                onClick={() => onLocateLine?.(selectedNode.lineKey || selectedNode.name.replace(/^测线\s*/, ''), 'planning')}
                style={{ background: '#fff7ed', color: '#ea580c', border: '1px solid #fdba74', borderRadius: '10px', padding: '8px 12px', cursor: 'pointer', fontWeight: 600, fontSize: '12px' }}
              >
                高亮规划测线
              </button>
            </div>
          )}
        </div>

        <div className="card glass" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>执行状态</div>
            <HardDrive size={18} color="#64748b" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px' }}>
            <div style={{ background: '#eff6ff', borderRadius: '10px', padding: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#2563eb', marginBottom: '8px' }}>
                <Clock3 size={16} />
                <span style={{ fontSize: '12px', fontWeight: 600 }}>待处理</span>
              </div>
              <div style={{ fontSize: '22px', fontWeight: 700, color: '#1e3a8a' }}>{allNodes.filter(node => node.status === '待处理' || node.status === '规划中').length}</div>
            </div>
            <div style={{ background: '#f5f3ff', borderRadius: '10px', padding: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#7c3aed', marginBottom: '8px' }}>
                <Database size={16} />
                <span style={{ fontSize: '12px', fontWeight: 600 }}>处理中</span>
              </div>
              <div style={{ fontSize: '22px', fontWeight: 700, color: '#5b21b6' }}>{allNodes.filter(node => node.status === '处理中' || node.status === '采集中').length}</div>
            </div>
            <div style={{ background: '#ecfdf5', borderRadius: '10px', padding: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#10b981', marginBottom: '8px' }}>
                <CheckCircle2 size={16} />
                <span style={{ fontSize: '12px', fontWeight: 600 }}>已完成</span>
              </div>
              <div style={{ fontSize: '22px', fontWeight: 700, color: '#047857' }}>{allNodes.filter(node => node.status === '解算完成' || node.status === '已采集').length}</div>
            </div>
          </div>
          </div>
        </div>
      </div>
      )}

      {parsingMTFile && (
        <MTParser
          fileObj={buildParserFileProp(parsingMTFile)}
          fileSystem={files}
          onClose={handleCloseParser}
          onSwitchType={handleParserSwitchType}
          onPrev={() => handleParserSwitchPoint(-1)}
          onNext={() => handleParserSwitchPoint(1)}
        />
      )}

      {parsingXFile && (
        <XParser
          fileObj={buildParserFileProp(parsingXFile)}
          fileSystem={files}
          onClose={handleCloseParser}
          onSwitchType={handleParserSwitchType}
          onPrev={() => handleParserSwitchPoint(-1)}
          onNext={() => handleParserSwitchPoint(1)}
        />
      )}

      {parsingYFile && (
        <YParser
          fileObj={buildParserFileProp(parsingYFile)}
          fileSystem={files}
          currentUser={currentUser}
          onClose={handleCloseParser}
          onSwitchType={handleParserSwitchType}
          onPrev={() => handleParserSwitchPoint(-1)}
          onNext={() => handleParserSwitchPoint(1)}
        />
      )}
    </>
  );
};

export default SurveyDataTree;
