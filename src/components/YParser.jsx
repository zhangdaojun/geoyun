import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import ReactECharts from './LazyECharts';
import { X, Maximize2, Minimize2, Activity, FileBarChart, Loader2, AlertCircle, ChevronLeft, ChevronRight, Sigma, Download } from 'lucide-react';
import { parseYFile, parseXFile, parseZFile, parseF3TimeSeriesFile, parseMTTSFile, parseMTTSHeader, parseMTTSSegment } from '../utils/eh4io';
import { buildEh4ComputationProducts, computeEh4ImpedanceFromCrosspowers } from '../utils/eh4Computation';
import { getDefaultEh4CalibrationFileTexts } from '../utils/eh4DefaultCalibration';
import { resolveDriveFileContent } from '../utils/driveFileContent';
import {
  startAdminEmap1Task,
  waitForAdminEmap1TaskResult,
} from '../services/adminEmap1Api';

const MTTS_BAND_LABELS = {
  H: '高频',
  M: '中频',
  L: '低频'
};

const MTTS_SEGMENT_OPTIONS = [1024, 2048, 4096, 8192, 16384];
const EMAP1_AURORA_DEFAULT_SETTINGS = {
  mode: 'scalar_xy',
  nfft: 4096,
  overlap: 0.5,
  window: 'hann',
  huberThreshold: 1.5,
  maxIter: 20,
  tolerance: 1e-4,
  dipoleExM: 25,
  dipoleEyM: 25,
  sampleRatePreference: 'auto',
  targetFrequencyHz: 10
};

const EMAP1_AURORA_DEFAULT_CALIBRATION = {
  exChannelResponseId: '',
  exSensorResponseId: '',
  eyChannelResponseId: '',
  eySensorResponseId: '',
  hxChannelResponseId: '',
  hxSensorResponseId: '',
  hyChannelResponseId: '',
  hySensorResponseId: ''
};

const isEmap1CalibrationFile = (name = '') => /\.(tbl|txt|rsp|resp|cal)$/i.test(String(name || '').trim());

const getEmap1CalibrationCandidateId = (item = {}) => (
  item?.id
  || item?.object_key
  || item?.objectKey
  || item?.path
  || `${item?.parentId || ''}/${item?.name || ''}`
);

const matchEmap1CalibrationAxisScore = (name, axis) => {
  if (!name) return 0;
  if (axis === 'ex') {
    if (/\bex\b|e_x|x-electric|xelectric|x电|x电场|ex[-_ ]?(channel|sensor|resp|response)\b/i.test(name)) return 10;
    if (/\bex\b|e_x|x-axis|xaxis/i.test(name)) return 8;
  }
  if (axis === 'ey') {
    if (/\bey\b|e_y|y-electric|yelectric|y电|y电场|ey[-_ ]?(channel|sensor|resp|response)\b/i.test(name)) return 10;
    if (/\bey\b|e_y|y-axis|yaxis/i.test(name)) return 8;
  }
  if (axis === 'hx') {
    if (/\bhx\b|h_x|x-axis|xaxis|x磁|x轴/i.test(name)) return 8;
    if (/\bhx[-_ ]?(channel|sensor|resp|response)\b/i.test(name)) return 10;
  }
  if (axis === 'hy') {
    if (/\bhy\b|h_y|y-axis|yaxis|y磁|y轴/i.test(name)) return 8;
    if (/\bhy[-_ ]?(channel|sensor|resp|response)\b/i.test(name)) return 10;
  }
  return 0;
};

const matchEmap1CalibrationKindScore = (name, kind) => {
  if (!name) return 0;
  if (kind === 'sensor') {
    if (/sensors?\.tbl|sensor|probe|传感器/i.test(name)) return 12;
    if (/\.tbl$/i.test(name)) return 8;
  }
  if (kind === 'channel') {
    if (/channel|chan|chn|通道/i.test(name)) return 12;
    if (/afev?|response|resp|rsp|50h|60h|hf/i.test(name)) return 6;
  }
  return 0;
};

const autoMatchEmap1Calibration = (candidates = []) => {
  const pickBest = (axis, kind) => {
    let best = null;
    let bestScore = -1;
    candidates.forEach((item, index) => {
      const name = String(item?.name || '').trim();
      const score = matchEmap1CalibrationAxisScore(name, axis) + matchEmap1CalibrationKindScore(name, kind);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      } else if (score === bestScore && best && index < candidates.indexOf(best)) {
        best = item;
      }
    });
    if (!best || bestScore <= 0) return '';
    return String(getEmap1CalibrationCandidateId(best));
  };

  return {
    exChannelResponseId: pickBest('ex', 'channel'),
    exSensorResponseId: pickBest('ex', 'sensor'),
    eyChannelResponseId: pickBest('ey', 'channel'),
    eySensorResponseId: pickBest('ey', 'sensor'),
    hxChannelResponseId: pickBest('hx', 'channel'),
    hxSensorResponseId: pickBest('hx', 'sensor'),
    hyChannelResponseId: pickBest('hy', 'channel'),
    hySensorResponseId: pickBest('hy', 'sensor')
  };
};

const deriveMTTSBandInfo = (sampleRateTag, sortedIndex, totalCount) => {
  const normalizedTag = String(sampleRateTag || '').trim().toUpperCase();
  const explicitBand = normalizedTag.match(/([HML])$/)?.[1];
  let bandId = explicitBand || '';
  if (!bandId) {
    if (totalCount <= 1) bandId = 'H';
    else if (sortedIndex === 0) bandId = 'H';
    else if (sortedIndex === totalCount - 1) bandId = 'L';
    else bandId = 'M';
  }
  return {
    id: bandId,
    label: MTTS_BAND_LABELS[bandId] || '频段'
  };
};

const buildPreviewSeriesData = (samples, dt, maxPoints = 8000) => {
  const totalLength = samples?.length || 0;
  if (!totalLength) return [];
  const step = Math.max(1, Math.ceil(totalLength / maxPoints));
  const result = [];
  for (let index = 0; index < totalLength; index += step) {
    result.push([index * dt, samples[index]]);
  }
  if ((totalLength - 1) % step !== 0) {
    const lastIndex = totalLength - 1;
    result.push([lastIndex * dt, samples[lastIndex]]);
  }
  return result;
};

const parseMTTSDisplayMeta = (name = '') => {
  const normalizedName = String(name || '').trim();
  if (!/\.mtts$/i.test(normalizedName)) return null;
  const baseName = normalizedName.replace(/\.[^.]+$/, '');
  const parts = baseName.split('_');
  return {
    pointNo: String(parts[0] || baseName).trim(),
    channel: String(parts.length >= 3 ? parts[parts.length - 2] : '').trim().toUpperCase(),
    sampleRateTag: String(parts.length >= 2 ? parts[parts.length - 1] : '').trim().toUpperCase()
  };
};

const YParser = ({ fileObj, fileSystem, onClose, onPrev, onNext, onSwitchType, onSwitchBand, currentUser = null }) => {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [allBlocks, setAllBlocks] = useState([]);
  const [currentBlockIndex, setCurrentBlockIndex] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [displayMode, setDisplayMode] = useState('chart');
  const [stationMeta, setStationMeta] = useState(fileObj?.stationMeta || null);
  const [currentMTTSBand, setCurrentMTTSBand] = useState('H');
  const [mttsSegmentLength, setMttsSegmentLength] = useState(4096);
  const [mttsSegmentIndex, setMttsSegmentIndex] = useState(0);
  const [mttsCurrentData, setMttsCurrentData] = useState([]);
  const [mttsDataLoading, setMttsDataLoading] = useState(false);
  const [eh4ComputationLoading, setEh4ComputationLoading] = useState(false);
  const [eh4ComputationStage, setEh4ComputationStage] = useState('');
  const [eh4ComputationError, setEh4ComputationError] = useState('');
  const [eh4ComputationResult, setEh4ComputationResult] = useState(null);
  const [showEmap1AuroraPanel, setShowEmap1AuroraPanel] = useState(false);
  const [emap1AuroraSettings, setEmap1AuroraSettings] = useState(EMAP1_AURORA_DEFAULT_SETTINGS);
  const [emap1AuroraCalibration, setEmap1AuroraCalibration] = useState(EMAP1_AURORA_DEFAULT_CALIBRATION);
  const [emap1AuroraState, setEmap1AuroraState] = useState({
    loading: false,
    error: '',
    response: null,
    targetRow: null,
    payloadMeta: null,
    taskStatus: null
  });
  const fileCacheRef = useRef(new Map());
  const sourceArrayBufferRef = useRef(null);
  const isMTTSGroup = fileObj?.type === 'mtts-group' && Array.isArray(fileObj?.files);
  const singleMTTSMeta = useMemo(() => parseMTTSDisplayMeta(fileObj?.name || ''), [fileObj?.name]);
  const currentNameLower = (fileObj?.name || '').toLowerCase();
  const isF3BandFile = /\.(fh|fm|fl)$/i.test(currentNameLower);
  const isMTTSFile = isMTTSGroup || currentNameLower.endsWith('.mtts');
  let currentDataType = '';
  if (currentNameLower.endsWith('.r')) currentDataType = 'Z';
  else if (currentNameLower.endsWith('.psd')) currentDataType = 'X';
  else if (currentNameLower.endsWith('.fh') || currentNameLower.endsWith('.fm') || currentNameLower.endsWith('.fl')) currentDataType = 'Y';
  else if (isMTTSFile) currentDataType = 'Y';
  else if ((fileObj?.name || '').toUpperCase().startsWith('X')) currentDataType = 'X';
  else if ((fileObj?.name || '').toUpperCase().startsWith('Y')) currentDataType = 'Y';
  else currentDataType = 'Z';
  const currentBand = currentNameLower.endsWith('.fh') ? 'H' : currentNameLower.endsWith('.fm') ? 'M' : currentNameLower.endsWith('.fl') ? 'L' : '';
  const currentBandLabel = currentBand === 'H' ? '高频(FH)' : currentBand === 'M' ? '中频(FM)' : currentBand === 'L' ? '低频(FL)' : '未知频段';
  const canRunEh4Computation = !isMTTSFile && !isF3BandFile && (fileObj?.name || '').toUpperCase().startsWith('Y');
  const siblingFiles = useMemo(() => {
    const parentId = fileObj?.parentId ?? null;
    return (fileSystem || []).filter(item => item.type === 'file' && item.parentId === parentId);
  }, [fileObj, fileSystem]);
  const mttsPointFiles = useMemo(() => {
    if (isMTTSGroup) return fileObj?.files || [];
    if (!singleMTTSMeta?.pointNo) return [];
    const candidates = siblingFiles.filter((item) => {
      const meta = parseMTTSDisplayMeta(item?.name || '');
      return meta?.pointNo === singleMTTSMeta.pointNo;
    });
    if (candidates.length) return candidates;
    return fileObj ? [fileObj] : [];
  }, [fileObj, isMTTSGroup, siblingFiles, singleMTTSMeta?.pointNo]);
  const isMTTSPointGroup = Boolean(isMTTSGroup || (!isMTTSGroup && mttsPointFiles.length > 1));
  const emap1CalibrationCandidates = useMemo(() => (
    (fileSystem || []).filter((item) => item?.type === 'file' && isEmap1CalibrationFile(item?.name))
  ), [fileSystem]);
  const suggestedEmap1Calibration = useMemo(
    () => autoMatchEmap1Calibration(emap1CalibrationCandidates),
    [emap1CalibrationCandidates]
  );
  const availableMTTSBands = useMemo(() => {
    if (!isMTTSPointGroup) return [];
    return Array.from(new Set(allBlocks.map(block => block?.header?.band).filter(Boolean)));
  }, [allBlocks, isMTTSPointGroup]);
  const visibleBlocks = useMemo(() => {
    if (!isMTTSPointGroup || availableMTTSBands.length === 0) return allBlocks;
    return allBlocks.filter(block => block?.header?.band === currentMTTSBand);
  }, [allBlocks, availableMTTSBands, currentMTTSBand, isMTTSPointGroup]);
  const currentDisplayBlock = visibleBlocks[currentBlockIndex] || null;
  const activeBandLabel = isF3BandFile
    ? currentBandLabel
    : (isMTTSPointGroup ? `${currentDisplayBlock?.header?.bandLabel || MTTS_BAND_LABELS[currentMTTSBand] || '频段'}(${currentMTTSBand})` : currentBandLabel);
  const currentMTTSSampleLength = useMemo(() => {
    if (!isMTTSFile || !currentDisplayBlock) return 0;
    if (isMTTSPointGroup) return Number(currentDisplayBlock?.header?.length) || 0;
    return currentDisplayBlock.data?.reduce((max, samples) => Math.max(max, samples?.length || 0), 0) || 0;
  }, [currentDisplayBlock, isMTTSFile, isMTTSPointGroup]);
  const currentMTTSSegmentCount = useMemo(() => {
    if (!isMTTSFile || !currentMTTSSampleLength) return 0;
    return Math.max(1, Math.ceil(currentMTTSSampleLength / mttsSegmentLength));
  }, [currentMTTSSampleLength, isMTTSFile, mttsSegmentLength]);
  const canRunSinglePointEmap1 = Boolean(isMTTSPointGroup && currentDisplayBlock?.mttsEntries?.length);
  const currentPointLabel = fileObj?.pointNo || currentDisplayBlock?.header?.pointNo || stationMeta?.rx || fileObj?.name || '--';
  const emap1RequiredChannels = useMemo(() => {
    const requestedMode = String(emap1AuroraSettings.mode || 'scalar_xy').trim().toLowerCase();
    if (requestedMode === 'tensor') return ['ex', 'ey', 'hx', 'hy'];
    if (requestedMode === 'scalar_both') return ['ex', 'ey', 'hx', 'hy'];
    if (requestedMode === 'scalar_yx') return ['ey', 'hx'];
    return ['ex', 'hy'];
  }, [emap1AuroraSettings.mode]);
  const showExCalibration = emap1RequiredChannels.includes('ex');
  const showEyCalibration = emap1RequiredChannels.includes('ey');
  const showHxCalibration = emap1RequiredChannels.includes('hx');
  const showHyCalibration = emap1RequiredChannels.includes('hy');

  const resolveBinaryFile = useCallback(async (targetFileObj, seenKeys = new Set()) => {
    const cacheKey = targetFileObj?.object_key || targetFileObj?.objectKey || targetFileObj?.id || targetFileObj?.name;
    if (cacheKey && fileCacheRef.current.has(cacheKey)) {
      return fileCacheRef.current.get(cacheKey);
    }

    let resolvedFile = await resolveDriveFileContent(targetFileObj, targetFileObj?.name || 'data.bin');

    if (!resolvedFile && targetFileObj && Array.isArray(fileSystem)) {
      const match = fileSystem.find((item) => {
        if (!item || item === targetFileObj || item.type !== 'file') return false;
        if (targetFileObj.id && item.id === targetFileObj.id) return true;
        return item.name === targetFileObj.name && (item.parentId || null) === (targetFileObj.parentId || null);
      });
      const matchKey = match?.object_key || match?.objectKey || match?.id || match?.name;
      if (match && matchKey && !seenKeys.has(matchKey)) {
        seenKeys.add(matchKey);
        resolvedFile = await resolveBinaryFile(match, seenKeys);
      }
    }

    if (cacheKey && resolvedFile) {
      fileCacheRef.current.set(cacheKey, resolvedFile);
    }
    return resolvedFile;
  }, [fileSystem]);

  const resolveTextFile = useCallback(async (targetFileObj) => {
    const resolvedFile = await resolveBinaryFile(targetFileObj);
    if (!resolvedFile) return '';
    return resolvedFile.text();
  }, [resolveBinaryFile]);

  useEffect(() => {
    setEmap1AuroraCalibration((prev) => ({
      exChannelResponseId: prev.exChannelResponseId || suggestedEmap1Calibration.exChannelResponseId || '',
      exSensorResponseId: prev.exSensorResponseId || suggestedEmap1Calibration.exSensorResponseId || '',
      eyChannelResponseId: prev.eyChannelResponseId || suggestedEmap1Calibration.eyChannelResponseId || '',
      eySensorResponseId: prev.eySensorResponseId || suggestedEmap1Calibration.eySensorResponseId || '',
      hxChannelResponseId: prev.hxChannelResponseId || suggestedEmap1Calibration.hxChannelResponseId || '',
      hxSensorResponseId: prev.hxSensorResponseId || suggestedEmap1Calibration.hxSensorResponseId || '',
      hyChannelResponseId: prev.hyChannelResponseId || suggestedEmap1Calibration.hyChannelResponseId || '',
      hySensorResponseId: prev.hySensorResponseId || suggestedEmap1Calibration.hySensorResponseId || ''
    }));
  }, [suggestedEmap1Calibration]);

  const handleAutoMatchEmap1Calibration = useCallback(() => {
    setEmap1AuroraCalibration(autoMatchEmap1Calibration(emap1CalibrationCandidates));
  }, [emap1CalibrationCandidates]);

  const buildSelectedEmap1Calibration = useCallback(async () => {
    const candidateMap = new Map(
      emap1CalibrationCandidates.map((item) => [String(getEmap1CalibrationCandidateId(item)), item])
    );

    const buildSource = async (channelResponseId, sensorResponseId) => {
      const channelFile = candidateMap.get(String(channelResponseId || ''));
      const sensorFile = candidateMap.get(String(sensorResponseId || ''));
      if (!channelFile || !sensorFile) return null;
      const [channelText, sensorText] = await Promise.all([
        resolveTextFile(channelFile),
        resolveTextFile(sensorFile)
      ]);
      if (!channelText || !sensorText) return null;
      return {
        channel_response_text: channelText,
        sensor_response_text: sensorText,
        channel_response_name: channelFile.name,
        sensor_response_name: sensorFile.name
      };
    };

    const ex = emap1RequiredChannels.includes('ex')
      ? await buildSource(
        emap1AuroraCalibration.exChannelResponseId,
        emap1AuroraCalibration.exSensorResponseId
      )
      : null;
    const ey = emap1RequiredChannels.includes('ey')
      ? await buildSource(
        emap1AuroraCalibration.eyChannelResponseId,
        emap1AuroraCalibration.eySensorResponseId
      )
      : null;
    const hx = emap1RequiredChannels.includes('hx')
      ? await buildSource(
        emap1AuroraCalibration.hxChannelResponseId,
        emap1AuroraCalibration.hxSensorResponseId
      )
      : null;
    const hy = emap1RequiredChannels.includes('hy')
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
  }, [emap1AuroraCalibration, emap1CalibrationCandidates, emap1RequiredChannels, resolveTextFile]);

  const buildSinglePointEmap1Payload = useCallback(async () => {
    if (!canRunSinglePointEmap1 || !currentDisplayBlock?.mttsEntries?.length) {
      throw new Error('????????? Aurora ??? MTTS ??');
    }
    const requestedMode = String(emap1AuroraSettings.mode || 'scalar_xy').trim().toLowerCase();
    const requiredChannels = emap1RequiredChannels;

    const entriesByChannel = new Map();
    currentDisplayBlock.mttsEntries.forEach((entry) => {
      const channelName = String(entry?.file?.mttsMeta?.channel || entry?.header?.channelType || '').trim().toLowerCase();
      if (channelName) {
        entriesByChannel.set(channelName, entry);
      }
    });

    const missingChannels = requiredChannels.filter((channelName) => !entriesByChannel.has(channelName));
    if (missingChannels.length) {
      throw new Error(`????????????${missingChannels.join(', ').toUpperCase()}`);
    }

    const sampleCount = Number(currentDisplayBlock?.header?.length || 0)
      || Math.min(...currentDisplayBlock.mttsEntries.map((entry) => Number(entry?.header?.nsamplesInFile || 0)).filter((value) => value > 0));
    if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
      throw new Error('当前点未解析出有效样本数');
    }

    let samplingRateHz = Number(currentDisplayBlock?.header?.sampleRate || 0);
    const resolvedDipoleExM = Number(entriesByChannel.get('ex')?.header?.dipoleLength || 0)
      || Number(emap1AuroraSettings.dipoleExM || 25);
    const resolvedDipoleEyM = Number(entriesByChannel.get('ey')?.header?.dipoleLength || 0)
      || Number(emap1AuroraSettings.dipoleEyM || 25);
    const channels = {};
    for (const channelName of requiredChannels) {
      const entry = entriesByChannel.get(channelName);
      const sourceFile = await resolveBinaryFile(entry?.file);
      if (!(sourceFile instanceof File)) {
        throw new Error(`无法读取 ${entry?.file?.name || channelName} 文件内容`);
      }
      const headerLength = Number(entry?.header?.headerLength || 0);
      const sampleByteLength = Number(entry?.header?.sampleLength || entry?.header?.sampleBytes || 4);
      const rawBuffer = await sourceFile
        .slice(headerLength, headerLength + sampleCount * sampleByteLength)
        .arrayBuffer();
      const values = Array.from(parseMTTSSegment(rawBuffer, entry.header, { sampleCount }));
      if (!values.length) {
        throw new Error(`${entry?.file?.name || channelName} 未解析出有效样本`);
      }
      channels[channelName] = {
        values,
        ...(channelName === 'ex' || channelName === 'ey' ? { unit: 'mV' } : {})
      };
      samplingRateHz = samplingRateHz || Number(entry?.header?.sampleRate || 0);
    }

    const calibration = await buildSelectedEmap1Calibration();

    return {
      sampling_rate_hz: Number(samplingRateHz),
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
      channels,
      ...(calibration ? { calibration } : {}),
      _meta: {
        pointLabel: currentPointLabel,
        requiredChannels,
        sampleRateTag: currentDisplayBlock?.header?.datasetLabel || currentDisplayBlock?.header?.bandLabel || '--',
        dipoleExM: resolvedDipoleExM,
        dipoleEyM: resolvedDipoleEyM,
        calibratedChannels: calibration ? Object.keys(calibration) : []
      }
    };
  }, [buildSelectedEmap1Calibration, canRunSinglePointEmap1, currentDisplayBlock, currentPointLabel, emap1AuroraSettings, emap1RequiredChannels, resolveBinaryFile]);

  const handleRunSinglePointEmap1 = useCallback(async () => {
    try {
      setEmap1AuroraState({
        loading: true,
        error: '',
        response: null,
        targetRow: null,
        payloadMeta: null,
        taskStatus: null
      });
      const payload = await buildSinglePointEmap1Payload();
      const task = await startAdminEmap1Task(payload, currentUser);
      setEmap1AuroraState((prev) => ({
        ...prev,
        taskStatus: {
          task_id: task?.task_id || '',
          status: task?.status || 'queued',
          progress: { current: 0, total: 1, percent: 0, message: '任务已提交' }
        }
      }));
      const response = await waitForAdminEmap1TaskResult(task.task_id, currentUser, {
        onStatus: (status) => {
          setEmap1AuroraState((prev) => ({
            ...prev,
            taskStatus: status
          }));
        }
      });
      const rows = Array.isArray(response?.rows) ? response.rows : [];
      const targetFrequencyHz = Number(emap1AuroraSettings.targetFrequencyHz || 10);
      const targetRow = rows.length
        ? rows.reduce((best, row) => {
          if (!best) return row;
          return Math.abs(Number(row?.freq_hz || 0) - targetFrequencyHz) < Math.abs(Number(best?.freq_hz || 0) - targetFrequencyHz) ? row : best;
        }, null)
        : null;

      setEmap1AuroraState({
        loading: false,
        error: '',
        response,
        targetRow,
        payloadMeta: payload._meta || null,
        taskStatus: {
          task_id: task?.task_id || '',
          status: 'success',
          progress: { current: 1, total: 1, percent: 100, message: '任务完成' }
        }
      });
    } catch (error) {
      setEmap1AuroraState({
        loading: false,
        error: error instanceof Error ? error.message : 'Aurora 计算失败',
        response: null,
        targetRow: null,
        payloadMeta: null,
        taskStatus: null
      });
    }
  }, [buildSinglePointEmap1Payload, currentUser, emap1AuroraSettings.targetFrequencyHz]);

  const buildCalibrationFileTexts = async () => {
    const addCalibrationText = (target, name, text) => {
      if (!name || !text) return;
      target[name] = text;
      target[String(name).toLowerCase()] = text;
      if (String(name).toLowerCase() === 'sensors.tbl') {
        target['SENSORS.TBL'] = text;
      }
    };
    const isCalibrationFile = (item) => {
      const name = String(item?.name || '').trim();
      const lower = name.toLowerCase();
      return lower === 'sensors.tbl' || /^afev/i.test(name) || /\.(50h|60h|hf)$/i.test(name);
    };
    const siblingCalibrationFiles = siblingFiles.filter(isCalibrationFile);
    const siblingIds = new Set(siblingCalibrationFiles.map(getEmap1CalibrationCandidateId));
    const projectCalibrationFiles = (fileSystem || [])
      .filter(item => item?.type === 'file' && isCalibrationFile(item))
      .filter(item => !siblingIds.has(getEmap1CalibrationCandidateId(item)));
    const calibrationCandidates = [...projectCalibrationFiles, ...siblingCalibrationFiles];
    const fileEntries = await Promise.all(calibrationCandidates.map(async (item) => {
      const text = await resolveTextFile(item);
      return [item.name, text];
    }));
    const fileTexts = getDefaultEh4CalibrationFileTexts();
    fileEntries.forEach(([name, text]) => addCalibrationText(fileTexts, name, text));
    return {
      fileTexts,
      uploadedCalibrationNames: fileEntries
        .filter(([, text]) => Boolean(text))
        .map(([name]) => name)
    };
  };

  const resolveRelatedZFile = () => {
    const currentName = String(fileObj?.name || '').trim();
    if (!currentName || !currentName.toUpperCase().startsWith('Y')) return null;
    const expectedName = `Z${currentName.slice(1)}`;
    const currentExt = currentName.includes('.') ? currentName.split('.').pop() : '';
    const currentPointKey = currentExt && /^\d{3,4}$/i.test(currentExt)
      ? String(Number(currentExt)).padStart(3, '0')
      : '';
    const isZFile = (item) => {
      const name = String(item?.name || '').trim();
      return item?.type === 'file' && name.toUpperCase().startsWith('Z') && /\.\d{3,4}$/i.test(name);
    };
    const samePoint = (item) => {
      if (!currentPointKey) return false;
      const ext = String(item?.name || '').split('.').pop();
      return /^\d{3,4}$/i.test(ext) && String(Number(ext)).padStart(3, '0') === currentPointKey;
    };
    const sameFolderZFiles = siblingFiles.filter(item => {
      const name = String(item?.name || '').trim();
      return item?.type === 'file' && name.toUpperCase().startsWith('Z') && /\.\d{3,4}$/i.test(name);
    });
    const allProjectZFiles = (fileSystem || []).filter(isZFile);
    const exactMatch = sameFolderZFiles.find(item => String(item?.name || '').toLowerCase() === expectedName.toLowerCase());
    if (exactMatch) return { ...exactMatch, matchMode: 'exact' };
    const sameExtensionMatch = sameFolderZFiles.find(item => String(item?.name || '').split('.').pop() === currentExt);
    if (sameExtensionMatch) return { ...sameExtensionMatch, matchMode: 'same-extension' };
    const exactProjectMatch = allProjectZFiles.find(item => String(item?.name || '').toLowerCase() === expectedName.toLowerCase());
    if (exactProjectMatch) return { ...exactProjectMatch, matchMode: 'project-exact' };
    const samePointProjectMatches = allProjectZFiles.filter(samePoint);
    if (samePointProjectMatches.length === 1) return { ...samePointProjectMatches[0], matchMode: 'project-same-point' };
    if (samePointProjectMatches.length > 1) {
      const sameParent = samePointProjectMatches.find(item => item.parentId === fileObj?.parentId);
      return { ...(sameParent || samePointProjectMatches[0]), matchMode: sameParent ? 'project-same-point-parent' : 'project-same-point-first' };
    }
    if (sameFolderZFiles.length === 1) return { ...sameFolderZFiles[0], matchMode: 'only-z-in-folder' };
    return null;
  };

  const resolveRelatedXFile = () => {
    const currentName = String(fileObj?.name || '').trim();
    if (!currentName || !currentName.toUpperCase().startsWith('Y')) return null;
    const expectedName = `X${currentName.slice(1)}`;
    const currentExt = currentName.includes('.') ? currentName.split('.').pop() : '';
    const currentPointKey = currentExt && /^\d{3,4}$/i.test(currentExt)
      ? String(Number(currentExt)).padStart(3, '0')
      : '';
    const isXFile = (item) => {
      const name = String(item?.name || '').trim();
      return item?.type === 'file' && name.toUpperCase().startsWith('X') && /\.\d{3,4}$/i.test(name);
    };
    const samePoint = (item) => {
      if (!currentPointKey) return false;
      const ext = String(item?.name || '').split('.').pop();
      return /^\d{3,4}$/i.test(ext) && String(Number(ext)).padStart(3, '0') === currentPointKey;
    };
    const sameFolderXFiles = siblingFiles.filter(isXFile);
    const allProjectXFiles = (fileSystem || []).filter(isXFile);
    const exactMatch = sameFolderXFiles.find(item => String(item?.name || '').toLowerCase() === expectedName.toLowerCase());
    if (exactMatch) return { ...exactMatch, matchMode: 'exact' };
    const sameExtensionMatch = sameFolderXFiles.find(item => String(item?.name || '').split('.').pop() === currentExt);
    if (sameExtensionMatch) return { ...sameExtensionMatch, matchMode: 'same-extension' };
    const exactProjectMatch = allProjectXFiles.find(item => String(item?.name || '').toLowerCase() === expectedName.toLowerCase());
    if (exactProjectMatch) return { ...exactProjectMatch, matchMode: 'project-exact' };
    const samePointProjectMatches = allProjectXFiles.filter(samePoint);
    if (samePointProjectMatches.length === 1) return { ...samePointProjectMatches[0], matchMode: 'project-same-point' };
    if (samePointProjectMatches.length > 1) {
      const sameParent = samePointProjectMatches.find(item => item.parentId === fileObj?.parentId);
      return { ...(sameParent || samePointProjectMatches[0]), matchMode: sameParent ? 'project-same-point-parent' : 'project-same-point-first' };
    }
    if (sameFolderXFiles.length === 1) return { ...sameFolderXFiles[0], matchMode: 'only-x-in-folder' };
    return null;
  };

  const buildZComparisonRows = async () => {
    const zFile = resolveRelatedZFile();
    if (!zFile) return { fileName: '', rows: [], status: 'not-found', message: '??????? Z ??' };
    const text = await resolveTextFile(zFile);
    if (!text) return { fileName: zFile.name, rows: [], status: 'not-loaded', message: `????? ${zFile.name}??????????` };
    const rows = parseZFile(text)
      .map((row) => ({
        frequency: row.freq,
        rhoXY: row.exhy_rho,
        phaseXY: row.exhy_phs,
        cohXY: row.exhy_coh,
        rhoYX: row.eyhx_rho,
        phaseYX: row.eyhx_phs,
        cohYX: row.eyhz_coh
      }))
      .filter((row) =>
        Number.isFinite(row.frequency) &&
        row.frequency > 0 &&
        Number.isFinite(row.rhoXY) &&
        row.rhoXY > 0 &&
        Number.isFinite(row.rhoYX) &&
        row.rhoYX > 0
      )
      .sort((a, b) => a.frequency - b.frequency);
    return {
      fileName: zFile.name,
      rows,
      status: rows.length ? 'loaded' : 'empty',
      matchMode: zFile.matchMode || 'exact',
      message: rows.length ? `??? ${rows.length} ? Z ??????` : `??? ${zFile.name}???????? Z ??`
    };
  };

  const buildXComparisonRows = async () => {
    const xFile = resolveRelatedXFile();
    if (!xFile) return { fileName: '', rows: [], status: 'not-found', message: '??????? X ??' };
    const text = await resolveTextFile(xFile);
    if (!text) return { fileName: xFile.name, rows: [], status: 'not-loaded', message: `????? ${xFile.name}??????????` };
    const rows = parseXFile(text)
      .map((row) => ({
        freq: row.freq,
        frequency: row.freq,
        bw: row.bw,
        avg: row.avg,
        crosspowers: row.crosspowers,
        ch1: row.crosspowers?.[0],
        ch2: row.crosspowers?.[5],
        ch3: row.crosspowers?.[10],
        ch4: row.crosspowers?.[15]
      }))
      .filter((row) =>
        Number.isFinite(row.frequency) &&
        row.frequency > 0 &&
        [row.ch1, row.ch2, row.ch3, row.ch4].some(value => Number.isFinite(value) && value > 0)
      )
      .sort((a, b) => a.frequency - b.frequency);
    return {
      fileName: xFile.name,
      rows,
      status: rows.length ? 'loaded' : 'empty',
      matchMode: xFile.matchMode || 'exact',
      message: rows.length
        ? `已加载 ${rows.length} 条 X 文件功率谱数据`
        : `已读取 ${xFile.name}，但未解析到有效功率谱数据`
    };
  };

  const handleRunEh4Computation = async () => {
    if (!canRunEh4Computation || !sourceArrayBufferRef.current) return;
    try {
      setEh4ComputationLoading(true);
      setEh4ComputationStage('读取标定与对比文件');
      setEh4ComputationError('');
      const { fileTexts: calibrationFileTexts, uploadedCalibrationNames } = await buildCalibrationFileTexts();
      const sensorsText = calibrationFileTexts['SENSORS.TBL'] || calibrationFileTexts['sensors.tbl'] || '';
      setEh4ComputationStage('计算校正功率谱与阻抗');
      await new Promise(resolve => setTimeout(resolve, 0));
      const result = buildEh4ComputationProducts(sourceArrayBufferRef.current, {
        fftSize: 4096,
        baseSampleRate: 192000,
        sensorsText,
        calibrationFileTexts,
        blocks: isF3BandFile ? allBlocks : undefined
      });
      setEh4ComputationStage('????? Z/X ??');
      await new Promise(resolve => setTimeout(resolve, 0));
      const zComparison = await buildZComparisonRows();
      const xComparison = await buildXComparisonRows();
      setEh4ComputationResult({
        ...result,
        usedCalibration: Boolean(result?.calibrationTables),
        calibrationFileCount: uploadedCalibrationNames.length,
        calibrationTotalKeyCount: Object.keys(calibrationFileTexts).length,
        calibrationFileNames: uploadedCalibrationNames,
        zComparison,
        xComparison
      });
      setDisplayMode('analysis');
    } catch (error) {
      console.warn(error);
      setEh4ComputationError(error?.message || 'EH4 计算失败');
      setDisplayMode('analysis');
    } finally {
      setEh4ComputationStage('');
      setEh4ComputationLoading(false);
    }
  };

  const handleExportEh4Computation = () => {
    if (!eh4ComputationResult) return;
    const payload = {
      fileName: fileObj?.name || '',
      stationMeta,
      summary: {
        rawCrosspowers: eh4ComputationResult.rawCrosspowers?.length || 0,
        stackedCrosspowers: eh4ComputationResult.stackedCrosspowers?.length || 0,
        calibratedCrosspowers: eh4ComputationResult.crosspowers?.length || 0,
        impedance: eh4ComputationResult.impedance?.length || 0,
        usedCalibration: eh4ComputationResult.usedCalibration,
        calibrationFileCount: eh4ComputationResult.calibrationFileCount || 0,
        calibrationTotalKeyCount: eh4ComputationResult.calibrationTotalKeyCount || 0,
        calibrationFileNames: eh4ComputationResult.calibrationFileNames || [],
        zComparisonFile: eh4ComputationResult.zComparison?.fileName || '',
        zComparisonRows: eh4ComputationResult.zComparison?.rows?.length || 0,
        xComparisonFile: eh4ComputationResult.xComparison?.fileName || '',
        xComparisonRows: eh4ComputationResult.xComparison?.rows?.length || 0
      },
      impedance: eh4ComputationResult.impedance,
      crosspowers: eh4ComputationResult.crosspowers,
      xImpedance: eh4ComputationResult.xImpedance,
      algorithmResults: eh4ComputationResult.algorithmResults,
      zComparison: eh4ComputationResult.zComparison,
      xComparison: eh4ComputationResult.xComparison
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(fileObj?.name || 'eh4').replace(/\.[^.]+$/, '')}_eh4_computation.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        setErrorMsg('');
        setMttsCurrentData([]);
        setEh4ComputationError('');
        setEh4ComputationResult(null);
        sourceArrayBufferRef.current = null;

        const buildMttsGroupBlocks = async (groupObj) => {
          const entryResults = await Promise.all((groupObj.files || []).map(async (entry) => {
            try {
              const mttsMeta = entry?.mttsMeta || parseMTTSDisplayMeta(entry?.name || '');
              const sourceFile = await resolveBinaryFile(entry);
              if (!sourceFile) {
                return {
                  entry,
                  status: 'missing-file',
                  error: new Error(`${entry?.name || 'MTTS 文件'} 未读取到原始文件内容`)
                };
              }
              const probeBuffer = await sourceFile.slice(0, Math.min(sourceFile.size, 65536)).arrayBuffer();
              const header = parseMTTSHeader(probeBuffer, entry?.name || sourceFile.name || '', { totalByteLength: sourceFile.size });
              return {
                status: 'ok',
                file: { ...entry, mttsMeta },
                header
              };
            } catch (error) {
              return {
                entry,
                status: 'parse-error',
                error
              };
            }
          }));
          const parsedEntries = entryResults.filter((result) => result.status === 'ok');
          const failedEntries = entryResults.filter((result) => result.status !== 'ok');
          if (failedEntries.length) {
            console.warn('部分 MTTS 文件未能用于预览', failedEntries.map((item) => ({
              name: item.entry?.name,
              status: item.status,
              message: item.error?.message
            })));
          }

          if (!parsedEntries.length) {
            const missingCount = failedEntries.filter((item) => item.status === 'missing-file').length;
            if (missingCount > 0) {
              throw new Error('未读取到 MTTS 原始文件内容，请重新上传或确认当前浏览器仍保留本地文件缓存');
            }
            const firstMessage = failedEntries[0]?.error?.message;
            throw new Error(firstMessage ? `MTTS 文件头解析失败：${firstMessage}` : '未找到可用的 MTTS 数据文件');
          }

          const datasetMap = new Map();
          parsedEntries.forEach((entry) => {
            const sampleRateTag = entry.file?.mttsMeta?.sampleRateTag || entry.header.sampleRate || '--';
            const sampleRate = entry.header.sampleRate || 0;
            const datasetKey = `${sampleRateTag}__${sampleRate}`;
            if (!datasetMap.has(datasetKey)) {
              datasetMap.set(datasetKey, {
                sampleRateTag,
                sampleRate,
                entries: []
              });
            }
            datasetMap.get(datasetKey).entries.push(entry);
          });

          const datasets = Array.from(datasetMap.values()).sort((a, b) => {
            const rateCompare = String(a.sampleRateTag).localeCompare(String(b.sampleRateTag), undefined, { numeric: true, sensitivity: 'base' });
            if (rateCompare !== 0) return rateCompare;
            return (Number(a.sampleRate) || 0) - (Number(b.sampleRate) || 0);
          });

          return datasets.map((dataset, index) => {
            const sortedEntries = [...dataset.entries].sort((a, b) => {
              const channelA = a.file?.mttsMeta?.channel || a.header.channelType || '';
              const channelB = b.file?.mttsMeta?.channel || b.header.channelType || '';
              return channelA.localeCompare(channelB, undefined, { sensitivity: 'base' });
            });
            const firstHeader = sortedEntries[0]?.header || {};
            const minLength = sortedEntries.reduce((min, item) => Math.min(min, item.header?.nsamplesInFile || 0), Number.POSITIVE_INFINITY);
            const effectiveLength = Number.isFinite(minLength) ? minLength : 0;
            const bandInfo = deriveMTTSBandInfo(dataset.sampleRateTag, index, datasets.length);
            return {
              header: {
                ...firstHeader,
                source: 'MTTS',
                counts: index + 1,
                band: bandInfo.id,
                bandLabel: bandInfo.label,
                datasetLabel: `${dataset.sampleRateTag}${dataset.sampleRate ? ` / ${dataset.sampleRate} Hz` : ''}`,
                datasetCount: datasets.length,
                pointNo: groupObj.pointNo || firstHeader.pointNo || '--',
                stationId: groupObj.pointNo || firstHeader.stationId || '--',
                channel: sortedEntries.length,
                channelNames: sortedEntries.map((item) => item.file?.mttsMeta?.channel || item.header.channelType?.toUpperCase?.() || '--'),
                channelFiles: sortedEntries.map((item) => item.file?.name || '--'),
                sampleRates: sortedEntries.map(() => dataset.sampleRateTag),
                length: effectiveLength
              },
              data: [],
              mttsEntries: sortedEntries
            };
          });
        };
        
        let arrayBuffer = null;
        if (!isMTTSPointGroup) {
          const binaryFile = await resolveBinaryFile(fileObj);
          if (binaryFile) {
            arrayBuffer = await binaryFile.arrayBuffer();
            sourceArrayBufferRef.current = arrayBuffer;
          }
        }
        
        let currentMeta = fileObj?.stationMeta;
        if (!currentMeta) {
           try {
              let atText = '';
              const atFile = fileSystem?.find(f => f.name === '@');
              const resolvedAtFile = await resolveBinaryFile(atFile);
              if (resolvedAtFile) atText = await resolvedAtFile.text();
              
              if (atText) {
                 const { parseAtFile } = await import('../utils/eh4io');
                 const allStations = parseAtFile(atText);
                 // 从 Y 文件名里提取站号，比如 YJLP-24.005 -> JLP-24.005。
                 const possibleId = fileObj.name.replace(/^[ZXY]/i, '').toLowerCase();
                 // @ 文件里的站号通常不带前缀，这里同时兼容原文件名和去前缀后的写法。
                 const matchedMeta = allStations.find((s) => s.id.toLowerCase() === possibleId || s.id.toLowerCase() === fileObj.name.toLowerCase());
                 if (matchedMeta) {
                    currentMeta = matchedMeta;
                 }
              }
            } catch {
              currentMeta = null;
            }
        }
        setStationMeta(currentMeta);

        if (isMTTSPointGroup) {
          const blocks = await buildMttsGroupBlocks({
            ...fileObj,
            pointNo: fileObj?.pointNo || singleMTTSMeta?.pointNo || fileObj?.name,
            files: mttsPointFiles
          });
          if (blocks && blocks.length > 0) {
            setAllBlocks(blocks);
            setCurrentBlockIndex(0);
            setLoading(false);
            return;
          }
        } else if (arrayBuffer) {
          const lowerName = (fileObj?.name || '').toLowerCase();
          const isF3Ts = lowerName.endsWith('.fh') || lowerName.endsWith('.fm') || lowerName.endsWith('.fl');
          const blocks = isMTTSFile
            ? parseMTTSFile(arrayBuffer, fileObj?.name || '')
            : (isF3Ts ? parseF3TimeSeriesFile(arrayBuffer) : parseYFile(arrayBuffer));
          
          if (blocks && blocks.length > 0) {
            setAllBlocks(blocks);
            setCurrentBlockIndex(0);
            setLoading(false);
            return;
          }
        }
        throw new Error('未找到有效的时间序列数据或数据块为空');
      } catch (e) {
        console.warn(e);
        setErrorMsg(e?.message ? `数据加载失败：${e.message}` : '数据加载失败：无法解析时间序列数据');
        sourceArrayBufferRef.current = null;
        setLoading(false);
      }
    };
    
    loadData();
  }, [fileObj, fileSystem, isMTTSFile, isMTTSPointGroup, mttsPointFiles, resolveBinaryFile, singleMTTSMeta?.pointNo]);

  useEffect(() => {
    if (!isMTTSPointGroup || !currentDisplayBlock?.mttsEntries?.length) {
      setMttsDataLoading(false);
      setMttsCurrentData(currentDisplayBlock?.data || []);
      return;
    }

    let cancelled = false;
    const loadCurrentSegment = async () => {
      try {
        setMttsDataLoading(true);
        const segmentStart = mttsSegmentIndex * mttsSegmentLength;
        const remainingCount = Math.max(0, currentMTTSSampleLength - segmentStart);
        const segmentSampleCount = Math.min(mttsSegmentLength, remainingCount);
        if (segmentSampleCount <= 0) {
          if (!cancelled) {
            setMttsCurrentData([]);
            setMttsDataLoading(false);
          }
          return;
        }

        const channelData = await Promise.all(currentDisplayBlock.mttsEntries.map(async (entry) => {
          const sourceFile = await resolveBinaryFile(entry.file);
          if (!sourceFile) return [];
          const byteStart = entry.header.headerLength + segmentStart * 4;
          const byteEnd = byteStart + segmentSampleCount * 4;
          const segmentBuffer = await sourceFile.slice(byteStart, byteEnd).arrayBuffer();
          return Array.from(parseMTTSSegment(segmentBuffer, entry.header, { sampleCount: segmentSampleCount }));
        }));

        if (!cancelled) {
          setMttsCurrentData(channelData);
          setMttsDataLoading(false);
        }
      } catch (err) {
        console.warn(err);
        if (!cancelled) {
          setErrorMsg('MTTS 分段加载失败');
          setMttsDataLoading(false);
        }
      }
    };

    loadCurrentSegment();
    return () => {
      cancelled = true;
    };
  }, [currentDisplayBlock, currentMTTSSampleLength, isMTTSPointGroup, mttsSegmentIndex, mttsSegmentLength, resolveBinaryFile]);

  useEffect(() => {
    if (!isMTTSPointGroup) return;
    if (!availableMTTSBands.length) return;
    if (!availableMTTSBands.includes(currentMTTSBand)) {
      setCurrentMTTSBand(availableMTTSBands[0]);
      setCurrentBlockIndex(0);
    }
  }, [availableMTTSBands, currentMTTSBand, isMTTSPointGroup]);

  useEffect(() => {
    if (currentBlockIndex < visibleBlocks.length) return;
    setCurrentBlockIndex(0);
  }, [currentBlockIndex, visibleBlocks.length]);

  useEffect(() => {
    setMttsSegmentIndex(0);
  }, [currentBlockIndex, currentMTTSBand, mttsSegmentLength]);

  useEffect(() => {
    if (!isMTTSFile || currentMTTSSegmentCount <= 0) return;
    if (mttsSegmentIndex < currentMTTSSegmentCount) return;
    setMttsSegmentIndex(0);
  }, [currentMTTSSegmentCount, isMTTSFile, mttsSegmentIndex]);

  const renderHeaderTable = () => {
    if (!visibleBlocks || visibleBlocks.length === 0) return null;
    const dataBlock = visibleBlocks[currentBlockIndex];
    if (!dataBlock) return null;

    const header = dataBlock.header || {};
    const { decimation, counts, registor, xlength, ylength, length, channel } = header;
    const isF3Header = header.source === 'F3' || isF3BandFile;
    const isMTTSHeader = header.source === 'MTTS';
    const samplingFreq = Number.isFinite(header.sampleRate) && header.sampleRate > 0
      ? `${header.sampleRate} Hz`
      : (decimation === 0 ? '192000 Hz' : (decimation === 4 ? '12000 Hz' : `Unknown ${decimation}`));

    return (
      <div style={{ flex: 1, padding: '40px', background: '#f8fafc', overflowY: 'auto' }}>
        <h4 style={{ marginBottom: '20px', color: '#0f172a' }}>
          {`文件头部信息 (Header) - ${activeBandLabel}${isMTTSPointGroup ? '' : ` - 段 ${counts}`}`}
        </h4>
        <table style={{ width: '100%', maxWidth: '700px', borderCollapse: 'collapse', background: '#fff', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
          <tbody>
            {isF3Header ? (
              <>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b', width: '35%' }}>工程/测线/测点</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`${header.project || '--'} / ${header.lineNo ?? '--'} / ${header.pointNo ?? '--'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>设备信息</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`device_id=${header.deviceId ?? '--'}, CPU=${header.cpuId1 ?? '--'}-${header.cpuId2 ?? '--'}-${header.cpuId3 ?? '--'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>采集时间</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`${header.year || '--'}-${String(header.month || 0).padStart(2, '0')}-${String(header.day || 0).padStart(2, '0')} ${String(header.hour || 0).padStart(2, '0')}:${String(header.minute || 0).padStart(2, '0')}:${String(header.second || 0).padStart(2, '0')}.${String(header.subSecond || 0).padStart(3, '0')}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>频带与采样</td>
                  <td style={{ padding: '12px 20px', color: '#10b981', fontWeight: 600 }}>{`band=${header.band ?? '--'}, sample_rate=${samplingFreq}, scans=${header.length ?? '--'}, decimation=${header.decimation ?? '--'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>通道与字节格式</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`channels=${header.channel ?? '--'}, sample_bytes=${header.sampleBytes ?? '--'}, valid_bytes=${header.validBytes ?? '--'}, start_byte=${header.startByte ?? '--'}, data_type=${header.dataType ?? '--'}, endian=${header.dataBigEndian ? 'BE' : 'LE'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>通道映射</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`Ex=${header.exIdx ?? '--'}, Ey=${header.eyIdx ?? '--'}, Ez=${header.ezIdx ?? '--'}, Hx=${header.hxIdx ?? '--'}, Hy=${header.hyIdx ?? '--'}, Hz=${header.hzIdx ?? '--'}, interweave=${header.dataInterweave ?? '--'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>偶极距与增益</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`X=${(header.xlength ?? 0).toFixed?.(2) ?? header.xlength} cm, Y=${(header.ylength ?? 0).toFixed?.(2) ?? header.ylength} cm, Vref=${header.fVRef ?? '--'}, LSB=${header.fLsbVal ?? '--'}, PGA_E=${header.fPgaValE ?? '--'}, PGA_H=${header.fPgaValH ?? '--'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>定位信息</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`lon=${Number.isFinite(header.gpsLongitude) ? header.gpsLongitude.toFixed(6) : '--'}, lat=${Number.isFinite(header.gpsLatitude) ? header.gpsLatitude.toFixed(6) : '--'}, ele=${Number.isFinite(header.gpsElevation) ? header.gpsElevation.toFixed(2) : '--'} m, gps_status=${header.gpsStatus ?? '--'}, satellites=${header.satellites ?? '--'}, clock=${header.clockStatus ?? '--'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>下采样与系统参数</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`band_l_direct_sample=${header.bandLDirectSample ?? '--'}, down_multiple=${header.downMultiple ?? '--'}, down_band_index=${header.downBandIndex ?? '--'}, eh4_band=${header.uEh4Band ?? '--'}, eh4_e_gain=${header.uEh4EGain ?? '--'}, eh4_m_gain=${header.uEh4MGain ?? '--'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>作业信息</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`company=${header.company || '--'}, operator=${header.operator || '--'}, segment=${header.counts ?? '--'}`}</td>
                </tr>
              </>
            ) : isMTTSHeader ? (
              <>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b', width: '35%' }}>点号</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{header.pointNo || header.stationId || '--'}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b', width: '35%' }}>通道信息</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{header.channelNames?.length > 1 ? header.channelNames.join(' / ') : `${header.channelType?.toUpperCase?.() || '--'} / channel_no=${header.channelNumber ?? '--'} / sensor=${header.sensor || '--'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>系统与设备</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`${header.systemType || '--'} / ADU=${header.aduSerialNumber ?? '--'} / ADB=${header.aduAdb ?? '--'} / sensor_no=${header.sensorNumber ?? '--'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>采集时间</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{Number.isFinite(header.startTimeMillis) ? new Date(header.startTimeMillis).toLocaleString() : '--'}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>采样参数</td>
                  <td style={{ padding: '12px 20px', color: '#10b981', fontWeight: 600 }}>{`sample_rate=${samplingFreq}, nsamples=${header.nsamples ?? '--'}, in_file=${header.nsamplesInFile ?? '--'}, header_len=${header.headerLength ?? '--'}, endian=${header.sampleEndian || '--'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>分段显示</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`${mttsSegmentLength} 点/段，第 ${Math.min(mttsSegmentIndex + 1, currentMTTSSegmentCount || 1)} / ${currentMTTSSegmentCount || 1} 段`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>量化与增益</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`lsb=${header.lsb ?? '--'}, gain=${header.internalGainAmplification ?? '--'}, pos_gain=${header.posGain ?? '--'}, chopper=${header.sensorChopper ?? '--'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>偶极与坐标</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`x1=${header.x1 ?? '--'}, y1=${header.y1 ?? '--'}, x2=${header.x2 ?? '--'}, y2=${header.y2 ?? '--'}, dipole=${header.dipoleLength ?? '--'} m`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>定位信息</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`lat=${header.latitude ?? '--'}, lon=${header.longitude ?? '--'}, ele=${header.elevation ?? '--'}, gps=${header.gpsStatus || '--'}, utc_offset=${header.utcOffset ?? '--'}`}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>附加字段</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{`survey=${header.surveyHeaderFilename || '--'}, type=${header.measurementType || '--'}, self_test=${header.selfTestResult || '--'}, bit=${header.bitIndicator ?? '--'}`}</td>
                </tr>
                {header.channelFiles?.length > 1 && (
                  <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                    <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>文件列表</td>
                    <td style={{ padding: '12px 20px', color: '#0f172a' }}>{header.channelFiles.join(' | ')}</td>
                  </tr>
                )}
              </>
            ) : (
              <>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b', width: '35%' }}>Count (段序号)</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{counts}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>Decimation (抽断因子)</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{decimation}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>Sampling Freq (采样率)</td>
                  <td style={{ padding: '12px 20px', color: '#10b981', fontWeight: 600 }}>{samplingFreq}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>Data Length (样点数)</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{length}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>Channels (通道数)</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{channel}</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>X Dipole Length (X极距)</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{xlength} cm ({xlength / 100} m)</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>Y Dipole Length (Y极距)</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a' }}>{ylength} cm ({ylength / 100} m)</td>
                </tr>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '12px 20px', fontWeight: 600, color: '#64748b' }}>Registor (寄存器原始值)</td>
                  <td style={{ padding: '12px 20px', color: '#0f172a', fontFamily: 'monospace' }}>{registor} (0b{registor.toString(2).padStart(8, '0')})</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
        <p style={{ marginTop: '20px', fontSize: '13px', color: '#64748b' }}>
          提示：您可以使用右上角的分段切换器来查看文件内其他连续采集段的头部信息和波形。
        </p>
      </div>
    );
  };

  const renderEh4Analysis = () => {
    const rows = eh4ComputationResult?.impedance || [];
    const previewRows = rows.slice(0, 12);
    const chartRows = rows
      .filter((row) =>
        Number.isFinite(row.freq) &&
        row.freq > 0 &&
        Number.isFinite(row.rhoXY) &&
        row.rhoXY > 0 &&
        Number.isFinite(row.rhoYX) &&
        row.rhoYX > 0
      )
      .sort((a, b) => a.freq - b.freq);
    const zRows = eh4ComputationResult?.zComparison?.rows || [];
    const xImpedanceRows = computeEh4ImpedanceFromCrosspowers(eh4ComputationResult?.xComparison?.rows || [])
      .filter((row) =>
        Number.isFinite(row.freq) &&
        row.freq > 0 &&
        Number.isFinite(row.rhoXY) &&
        row.rhoXY > 0 &&
        Number.isFinite(row.rhoYX) &&
        row.rhoYX > 0
      )
      .sort((a, b) => a.freq - b.freq);
    const toPowerRows = (sourceRows = []) => sourceRows
      .map((row) => ({
        frequency: row.freq,
        bw: row.bw,
        avg: row.avg,
        ch1: row.crosspowers?.[0],
        ch2: row.crosspowers?.[5],
        ch3: row.crosspowers?.[10],
        ch4: row.crosspowers?.[15]
      }))
      .filter((row) =>
        Number.isFinite(row.frequency) &&
        row.frequency > 0 &&
        [row.ch1, row.ch2, row.ch3, row.ch4].some(value => Number.isFinite(value) && value > 0)
      )
      .sort((a, b) => a.frequency - b.frequency);
    const chinesePowerRows = toPowerRows(eh4ComputationResult?.algorithmResults?.chinese?.crosspowers || eh4ComputationResult?.crosspowers || []);
    const englishPowerRows = toPowerRows(eh4ComputationResult?.algorithmResults?.english?.crosspowers || []);
    const xRows = eh4ComputationResult?.xComparison?.rows || [];
    const getAmplitudeSpectralDensity = (row, key) => {
      const value = Number(row?.[key]);
      if (!Number.isFinite(value) || value <= 0) return null;
      const amplitude = Math.sqrt(value);
      return key === 'ch1' || key === 'ch3'
        ? amplitude * 1000
        : amplitude;
    };
    const toLogPoint = (row, key) => {
      const value = getAmplitudeSpectralDensity(row, key);
      return Number.isFinite(value) && value > 0 ? [row.frequency, value] : null;
    };
    const findNearestByFrequency = (rowsSource, frequency) => {
      if (!rowsSource.length || !Number.isFinite(frequency) || frequency <= 0) return null;
      return rowsSource.reduce((best, row) => {
        const distance = Math.abs(Math.log(row.frequency / frequency));
        if (!best || distance < best.distance) return { row, distance };
        return best;
      }, null);
    };
    const median = (values) => {
      const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
      if (!sorted.length) return null;
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const buildPowerRatioStats = (rowsSource, prefix) => ['ch1', 'ch2', 'ch3', 'ch4'].map((key, index) => {
      const ratios = xRows.map((xRow) => {
        const matched = findNearestByFrequency(rowsSource, xRow.frequency);
        if (!matched || matched.distance > Math.log(1.08)) return null;
        const calValue = getAmplitudeSpectralDensity(matched.row, key);
        const xValue = getAmplitudeSpectralDensity(xRow, key);
        return Number.isFinite(calValue) && calValue > 0 && Number.isFinite(xValue) && xValue > 0 ? xValue / calValue : null;
      }).filter(Boolean);
      const ratiosWithoutAvgDivision = xRows.map((xRow) => {
        const matched = findNearestByFrequency(rowsSource, xRow.frequency);
        if (!matched || matched.distance > Math.log(1.08)) return null;
        const calValue = getAmplitudeSpectralDensity(matched.row, key);
        const calAvg = Number(matched.row?.avg);
        const xValue = getAmplitudeSpectralDensity(xRow, key);
        return Number.isFinite(calValue) && calValue > 0 &&
          Number.isFinite(calAvg) && calAvg > 0 &&
          Number.isFinite(xValue) && xValue > 0
          ? xValue / (calValue * Math.sqrt(calAvg))
          : null;
      }).filter(Boolean);
      const calBws = [];
      const calAvgs = [];
      const xBws = [];
      const xAvgs = [];
      xRows.forEach((xRow) => {
        const matched = findNearestByFrequency(rowsSource, xRow.frequency);
        if (!matched || matched.distance > Math.log(1.08)) return;
        calBws.push(Number(matched.row?.bw));
        calAvgs.push(Number(matched.row?.avg));
        xBws.push(Number(xRow?.bw));
        xAvgs.push(Number(xRow?.avg));
      });
      return {
        key: `${prefix}-${key}`,
        label: `${prefix} CH${index + 1}`,
        ratio: median(ratios),
        ratioWithoutAvgDivision: median(ratiosWithoutAvgDivision),
        calBw: median(calBws),
        calAvg: median(calAvgs),
        xBw: median(xBws),
        xAvg: median(xAvgs),
        count: ratios.length
      };
    });
    const powerRatioStats = [
      ...buildPowerRatioStats(chinesePowerRows, '中文'),
      ...buildPowerRatioStats(englishPowerRows, '英文')
    ];
    const eh4ChartOption = {
      color: ['#2563eb', '#ea580c', '#0f766e', '#9333ea', '#64748b', '#f59e0b', '#60a5fa', '#fdba74', '#5eead4', '#c084fc', '#94a3b8', '#fbbf24'],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params = []) => {
          const freq = params[0]?.value?.[0];
          const lines = [`<b>棰戠巼: ${Number(freq).toFixed(4)} Hz</b>`];
          params.forEach((item) => {
            const value = Number(item.value?.[1]);
            const formatted = item.seriesName.includes('Rho')
              ? value.toExponential(3)
              : value.toFixed(4);
            lines.push(`${item.marker} ${item.seriesName}: <b>${formatted}</b>`);
          });
          return lines.join('<br/>');
        }
      },
      legend: {
        top: 8,
        left: 16,
        selected: {
          'Y重算 PhaseXY': false,
          'Y重算 PhaseYX': false,
          'Y重算 Coh ExHy': false,
          'Y重算 Coh EyHx': false,
          'Z PhaseXY': false,
          'Z PhaseYX': false,
          'Z Coh ExHy': false,
          'Z Coh EyHx': false,
          'X PhaseXY': false,
          'X PhaseYX': false,
          'X Coh ExHy': false,
          'X Coh EyHx': false
        },
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: '#475569', fontSize: 12 }
      },
      grid: [
        { left: 76, right: 34, top: 52, height: 126 },
        { left: 76, right: 34, top: 216, height: 116 },
        { left: 76, right: 34, top: 370, height: 92 }
      ],
      xAxis: [
        { type: 'log', gridIndex: 0, inverse: true, axisLabel: { show: false }, splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } },
        { type: 'log', gridIndex: 1, inverse: true, axisLabel: { show: false }, splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } },
        { type: 'log', gridIndex: 2, inverse: true, name: 'Frequency (Hz)', nameLocation: 'middle', nameGap: 30, axisLabel: { color: '#64748b' }, splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } }
      ],
      yAxis: [
        { type: 'log', gridIndex: 0, name: 'Rho (ohm m)', nameLocation: 'middle', nameGap: 62, axisLabel: { color: '#64748b', formatter: (value) => Number(value).toExponential(1) }, splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } },
        { type: 'value', gridIndex: 1, name: 'Phase (deg)', nameLocation: 'middle', nameGap: 54, axisLabel: { color: '#64748b' }, splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } },
        { type: 'value', gridIndex: 2, name: 'Coherency', min: 0, max: 1, nameLocation: 'middle', nameGap: 54, axisLabel: { color: '#64748b' }, splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } } }
      ],
      series: [
        { name: 'Y重算 RhoXY', type: 'line', xAxisIndex: 0, yAxisIndex: 0, showSymbol: true, symbolSize: 5, data: chartRows.map(row => [row.freq, row.rhoXY]) },
        { name: 'Y重算 RhoYX', type: 'line', xAxisIndex: 0, yAxisIndex: 0, showSymbol: true, symbolSize: 5, data: chartRows.map(row => [row.freq, row.rhoYX]) },
        { name: 'Y重算 PhaseXY', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, data: chartRows.map(row => [row.freq, row.phaseXY]) },
        { name: 'Y重算 PhaseYX', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, data: chartRows.map(row => [row.freq, row.phaseYX]) },
        { name: 'Y重算 Coh ExHy', type: 'line', xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, data: chartRows.map(row => [row.freq, row.exHyCoherency]) },
        { name: 'Y重算 Coh EyHx', type: 'line', xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, data: chartRows.map(row => [row.freq, row.eyHxCoherency]) },
        { name: 'Z RhoXY', type: 'line', xAxisIndex: 0, yAxisIndex: 0, showSymbol: true, symbol: 'diamond', symbolSize: 8, z: 10, lineStyle: { type: 'dashed', width: 2.6 }, data: zRows.map(row => [row.frequency, row.rhoXY]) },
        { name: 'Z RhoYX', type: 'line', xAxisIndex: 0, yAxisIndex: 0, showSymbol: true, symbol: 'diamond', symbolSize: 8, z: 10, lineStyle: { type: 'dashed', width: 2.6 }, data: zRows.map(row => [row.frequency, row.rhoYX]) },
        { name: 'Z PhaseXY', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: true, symbol: 'diamond', symbolSize: 7, z: 10, lineStyle: { type: 'dashed', width: 2.4 }, data: zRows.map(row => [row.frequency, row.phaseXY]) },
        { name: 'Z PhaseYX', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: true, symbol: 'diamond', symbolSize: 7, z: 10, lineStyle: { type: 'dashed', width: 2.4 }, data: zRows.map(row => [row.frequency, row.phaseYX]) },
        { name: 'Z Coh ExHy', type: 'line', xAxisIndex: 2, yAxisIndex: 2, showSymbol: true, symbol: 'diamond', symbolSize: 6, z: 10, lineStyle: { type: 'dashed', width: 2 }, data: zRows.map(row => [row.frequency, row.cohXY]) },
        { name: 'Z Coh EyHx', type: 'line', xAxisIndex: 2, yAxisIndex: 2, showSymbol: true, symbol: 'diamond', symbolSize: 6, z: 10, lineStyle: { type: 'dashed', width: 2 }, data: zRows.map(row => [row.frequency, row.cohYX]) },
        { name: 'X RhoXY', type: 'line', xAxisIndex: 0, yAxisIndex: 0, showSymbol: true, symbol: 'triangle', symbolSize: 7, z: 9, lineStyle: { type: 'dotted', width: 2.4 }, data: xImpedanceRows.map(row => [row.freq, row.rhoXY]) },
        { name: 'X RhoYX', type: 'line', xAxisIndex: 0, yAxisIndex: 0, showSymbol: true, symbol: 'triangle', symbolSize: 7, z: 9, lineStyle: { type: 'dotted', width: 2.4 }, data: xImpedanceRows.map(row => [row.freq, row.rhoYX]) },
        { name: 'X PhaseXY', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: true, symbol: 'triangle', symbolSize: 6, z: 9, lineStyle: { type: 'dotted', width: 2 }, data: xImpedanceRows.map(row => [row.freq, row.phaseXY]) },
        { name: 'X PhaseYX', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: true, symbol: 'triangle', symbolSize: 6, z: 9, lineStyle: { type: 'dotted', width: 2 }, data: xImpedanceRows.map(row => [row.freq, row.phaseYX]) },
        { name: 'X Coh ExHy', type: 'line', xAxisIndex: 2, yAxisIndex: 2, showSymbol: true, symbol: 'triangle', symbolSize: 5, z: 9, lineStyle: { type: 'dotted', width: 1.8 }, data: xImpedanceRows.map(row => [row.freq, row.exHyCoherency]) },
        { name: 'X Coh EyHx', type: 'line', xAxisIndex: 2, yAxisIndex: 2, showSymbol: true, symbol: 'triangle', symbolSize: 5, z: 9, lineStyle: { type: 'dotted', width: 1.8 }, data: xImpedanceRows.map(row => [row.freq, row.eyHxCoherency]) }
      ]
    };
    const powerChartOption = {
      color: ['#2563eb', '#ea580c', '#0f766e', '#9333ea', '#60a5fa', '#fdba74', '#5eead4', '#c084fc', '#1d4ed8', '#c2410c', '#047857', '#7e22ce'],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params = []) => {
          const freq = params[0]?.value?.[0];
          const lines = [`<b>棰戠巼: ${Number(freq).toFixed(4)} Hz</b>`];
          params.forEach((item) => {
            const value = Number(item.value?.[1]);
            lines.push(`${item.marker} ${item.seriesName}: <b>${value.toExponential(3)}</b>`);
          });
          return lines.join('<br/>');
        }
      },
      legend: {
        top: 8,
        left: 16,
        selected: {
          '中文 CH3': false,
          '中文 CH4': false,
          '英文 CH3': false,
          '英文 CH4': false,
          'X CH3': false,
          'X CH4': false
        },
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: '#475569', fontSize: 12 }
      },
      grid: { left: 76, right: 34, top: 54, bottom: 58 },
      xAxis: {
        type: 'log',
        inverse: true,
        name: 'Frequency (Hz)',
        nameLocation: 'middle',
        nameGap: 32,
        axisLabel: { color: '#64748b' },
        splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } }
      },
      yAxis: {
        type: 'log',
        name: 'Amplitude spectral density',
        nameLocation: 'middle',
        nameGap: 62,
        axisLabel: { color: '#64748b', formatter: (value) => Number(value).toExponential(1) },
        splitLine: { lineStyle: { type: 'dashed', color: '#e2e8f0' } }
      },
      series: [
        { name: '中文 CH1', type: 'line', showSymbol: false, lineStyle: { width: 2.6 }, data: chinesePowerRows.map(row => toLogPoint(row, 'ch1')).filter(Boolean) },
        { name: '中文 CH2', type: 'line', showSymbol: false, lineStyle: { width: 2.6 }, data: chinesePowerRows.map(row => toLogPoint(row, 'ch2')).filter(Boolean) },
        { name: '中文 CH3', type: 'line', showSymbol: false, lineStyle: { width: 2.6 }, data: chinesePowerRows.map(row => toLogPoint(row, 'ch3')).filter(Boolean) },
        { name: '中文 CH4', type: 'line', showSymbol: false, lineStyle: { width: 2.6 }, data: chinesePowerRows.map(row => toLogPoint(row, 'ch4')).filter(Boolean) },
        { name: '英文 CH1', type: 'line', showSymbol: false, lineStyle: { type: 'dotted', width: 2.4 }, data: englishPowerRows.map(row => toLogPoint(row, 'ch1')).filter(Boolean) },
        { name: '英文 CH2', type: 'line', showSymbol: false, lineStyle: { type: 'dotted', width: 2.4 }, data: englishPowerRows.map(row => toLogPoint(row, 'ch2')).filter(Boolean) },
        { name: '英文 CH3', type: 'line', showSymbol: false, lineStyle: { type: 'dotted', width: 2.4 }, data: englishPowerRows.map(row => toLogPoint(row, 'ch3')).filter(Boolean) },
        { name: '英文 CH4', type: 'line', showSymbol: false, lineStyle: { type: 'dotted', width: 2.4 }, data: englishPowerRows.map(row => toLogPoint(row, 'ch4')).filter(Boolean) },
        { name: 'X CH1', type: 'line', showSymbol: true, symbol: 'diamond', symbolSize: 7, z: 10, lineStyle: { type: 'dashed', width: 2.4 }, data: xRows.map(row => toLogPoint(row, 'ch1')).filter(Boolean) },
        { name: 'X CH2', type: 'line', showSymbol: true, symbol: 'diamond', symbolSize: 7, z: 10, lineStyle: { type: 'dashed', width: 2.4 }, data: xRows.map(row => toLogPoint(row, 'ch2')).filter(Boolean) },
        { name: 'X CH3', type: 'line', showSymbol: true, symbol: 'diamond', symbolSize: 7, z: 10, lineStyle: { type: 'dashed', width: 2.4 }, data: xRows.map(row => toLogPoint(row, 'ch3')).filter(Boolean) },
        { name: 'X CH4', type: 'line', showSymbol: true, symbol: 'diamond', symbolSize: 7, z: 10, lineStyle: { type: 'dashed', width: 2.4 }, data: xRows.map(row => toLogPoint(row, 'ch4')).filter(Boolean) }
      ]
    };
    return (
      <div style={{ flex: 1, padding: '32px', background: '#f8fafc', overflowY: 'auto' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
          <div style={{ padding: '12px 16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '10px' }}>
            <div style={{ fontSize: '12px', color: '#64748b' }}>原始频点</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#0f172a' }}>{eh4ComputationResult?.rawCrosspowers?.length || 0}</div>
          </div>
          <div style={{ padding: '12px 16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '10px' }}>
            <div style={{ fontSize: '12px', color: '#64748b' }}>校正频点</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#0f172a' }}>{eh4ComputationResult?.crosspowers?.length || 0}</div>
          </div>
          <div style={{ padding: '12px 16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '10px' }}>
            <div style={{ fontSize: '12px', color: '#64748b' }}>校正状态</div>
            <div style={{ fontSize: '16px', fontWeight: 700, color: eh4ComputationResult?.usedCalibration ? '#10b981' : '#f59e0b' }}>
              {eh4ComputationResult?.usedCalibration ? '已应用校正' : '未应用校正'}
            </div>
          </div>
          <div style={{ padding: '12px 16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '10px' }}>
            <div style={{ fontSize: '12px', color: '#64748b' }}>校正文件</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#0f172a' }}>{eh4ComputationResult?.calibrationFileCount || 0}</div>
            <div style={{ fontSize: '11px', color: '#64748b', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={(eh4ComputationResult?.calibrationFileNames || []).join(', ')}>
              {eh4ComputationResult?.calibrationFileCount ? '已加载校正文件' : '未加载校正文件'}
            </div>
          </div>
          <div style={{ padding: '12px 16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '10px' }}>
            <div style={{ fontSize: '12px', color: '#64748b' }}>Z 对比文件</div>
            <div style={{ fontSize: '16px', fontWeight: 700, color: eh4ComputationResult?.zComparison?.rows?.length ? '#2563eb' : '#94a3b8' }}>
              {eh4ComputationResult?.zComparison?.rows?.length ? `${eh4ComputationResult.zComparison.fileName} (${eh4ComputationResult.zComparison.rows.length})` : '无'}
            </div>
          </div>
        </div>

        {eh4ComputationError && (
          <div style={{ marginBottom: '16px', padding: '12px 14px', background: '#fff1f2', color: '#be123c', border: '1px solid #fecdd3', borderRadius: '10px' }}>
            {eh4ComputationError}
          </div>
        )}

        {!eh4ComputationError && !rows.length && (
          <div style={{ padding: '16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '10px', color: '#64748b' }}>
            请先运行 EH4 计算以生成结果。
          </div>
        )}

        {rows.length > 0 && (
          <>
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden', marginBottom: '18px' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid #e2e8f0', fontWeight: 700, color: '#0f172a', display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
              <span>视电阻率 / 相位 / 相干度对比</span>
              <span style={{ fontSize: '12px', fontWeight: 500, color: '#64748b' }}>
                {zRows.length || xImpedanceRows.length ? '当前图表同时对比 Y 计算结果、Z 文件结果以及 X 文件反算结果。' : '当前图表仅显示基于 Y 文件计算得到的结果。'}
              </span>
            </div>
            <ReactECharts option={eh4ChartOption} style={{ width: '100%', height: '500px' }} notMerge={true} lazyUpdate={true} />
          </div>

          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden', marginBottom: '18px' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid #e2e8f0', fontWeight: 700, color: '#0f172a', display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
              <span>功率谱与校正对比</span>
              <span style={{ fontSize: '12px', fontWeight: 500, color: '#64748b' }}>
                {xRows.length ? `当前图表对比校正后功率谱与 X 文件 ${eh4ComputationResult.xComparison.fileName} 的功率谱；CH1/CH3 为磁场通道，CH2/CH4 为电场通道。` : '当前图表显示校正后的功率谱结果。'}
              </span>
            </div>
            <ReactECharts option={powerChartOption} style={{ width: '100%', height: '360px' }} notMerge={true} lazyUpdate={true} />
            <div style={{ padding: '0 16px 14px', display: 'flex', flexWrap: 'wrap', gap: '10px', color: '#475569', fontSize: '12px' }}>
              {powerRatioStats.map((item) => (
                <span key={item.key} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '999px', padding: '5px 10px' }}>
                  {item.label} X/Cal: <b style={{ color: '#0f172a' }}>{item.ratio ? item.ratio.toExponential(3) : '--'}</b>
                  <span style={{ marginLeft: '8px' }}>X/(Cal脳鈭歛vg): <b style={{ color: '#0f172a' }}>{item.ratioWithoutAvgDivision ? item.ratioWithoutAvgDivision.toExponential(3) : '--'}</b></span>
                  <span style={{ marginLeft: '8px', color: '#64748b' }}>
                    bw {item.calBw ? item.calBw.toExponential(2) : '--'}/{item.xBw ? item.xBw.toExponential(2) : '--'}
                    , avg {item.calAvg ? item.calAvg.toExponential(2) : '--'}/{item.xAvg ? item.xAvg.toExponential(2) : '--'}
                  </span>
                  <span style={{ marginLeft: '4px', color: '#94a3b8' }}>n={item.count}</span>
                </span>
              ))}
              <span style={{ color: '#64748b' }}>X/Cal 表示 X 文件与当前校正结果的比值，X/(Cal×√avg) 表示同时考虑平均次数后的对比比值。</span>
            </div>
          </div>

          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid #e2e8f0', fontWeight: 700, color: '#0f172a' }}>阻抗结果明细</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {['频率(Hz)', 'RhoXY', 'RhoYX', 'PhaseXY', 'PhaseYX', 'Coh ExHy', 'Coh EyHx'].map((title) => (
                      <th key={title} style={{ textAlign: 'left', padding: '12px 14px', fontSize: '12px', color: '#475569', borderBottom: '1px solid #e2e8f0' }}>{title}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row) => (
                    <tr key={row.freq} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '12px 14px', color: '#0f172a' }}>{row.freq.toFixed(3)}</td>
                      <td style={{ padding: '12px 14px', color: '#0f172a' }}>{row.rhoXY.toExponential(3)}</td>
                      <td style={{ padding: '12px 14px', color: '#0f172a' }}>{row.rhoYX.toExponential(3)}</td>
                      <td style={{ padding: '12px 14px', color: '#0f172a' }}>{row.phaseXY.toFixed(2)}</td>
                      <td style={{ padding: '12px 14px', color: '#0f172a' }}>{row.phaseYX.toFixed(2)}</td>
                      <td style={{ padding: '12px 14px', color: '#0f172a' }}>{row.exHyCoherency.toFixed(4)}</td>
                      <td style={{ padding: '12px 14px', color: '#0f172a' }}>{row.eyHxCoherency.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > previewRows.length && (
              <div style={{ padding: '12px 16px', color: '#64748b', fontSize: '12px' }}>
                ???? {previewRows.length} ??? {rows.length} ??????????????????????              </div>
            )}
          </div>
          </>
        )}
      </div>
    );
  };

  const getOption = () => {
    if (!visibleBlocks || visibleBlocks.length === 0) return {};
    const dataBlock = visibleBlocks[currentBlockIndex];
    if (!dataBlock) return {};

    const { header } = dataBlock;
    const data = isMTTSPointGroup ? mttsCurrentData : dataBlock.data;
    const { length, channel, decimation, sampleRate } = header;
    const channelNames = Array.isArray(header.channelNames) && header.channelNames.length
      ? header.channelNames
      : ['Hy', 'Ex', 'Hx', 'Ey'].slice(0, Math.max(data?.length || 0, channel || 0));
    const visibleChannelCount = Math.max(1, Math.min(channelNames.length || 1, data?.length || channel || 1));

    const dt = Number.isFinite(sampleRate) && sampleRate > 0
      ? (1000 / sampleRate)
      : (decimation === 0 ? (1000 / 192000) : (1000 / 12000));
    const segmentStartIndex = isMTTSFile ? mttsSegmentIndex * mttsSegmentLength : 0;
    const segmentEndIndex = isMTTSFile ? Math.min(currentMTTSSampleLength, segmentStartIndex + mttsSegmentLength) : length;
    const activePointLength = isMTTSFile ? Math.max(0, segmentEndIndex - segmentStartIndex) : length;
    const segmentDuration = activePointLength * dt;
    const totalDuration = length * dt;
    const displayDuration = isMTTSFile ? segmentDuration : totalDuration;

    const series = [];
    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b'];
    const grids = [];
    const xAxes = [];
    const yAxes = [];
    const gridGap = 4;
    const gridTop = 8;
    const gridHeight = Math.max(14, (84 - (visibleChannelCount - 1) * gridGap) / visibleChannelCount);

    for (let i = 0; i < visibleChannelCount; i++) {
      const topPos = gridTop + i * (gridHeight + gridGap);
      grids.push({
        left: '7%',
        right: '6%',
        top: `${topPos}%`,
        height: `${gridHeight}%`,
        show: true,
        borderColor: '#0f172a',
        borderWidth: 1,
        backgroundColor: 'transparent'
      });

      xAxes.push({
        gridIndex: i,
        type: 'value',
        min: 0,
        max: Math.max(displayDuration, dt || 1),
        name: i === visibleChannelCount - 1 ? 'ms' : '',
        nameLocation: 'middle',
        nameGap: 28,
        axisLabel: {
          show: i === visibleChannelCount - 1,
          color: '#0f172a',
          fontWeight: 'bold',
          formatter: (value) => value.toFixed(1)
        },
        axisTick: { show: i === visibleChannelCount - 1 },
        splitLine: {
          show: true,
          lineStyle: { type: 'dashed', color: 'rgba(0,0,0,0.3)' }
        },
        interval: Math.max((isMTTSFile ? segmentDuration : totalDuration) / 4, dt || 1),
        axisLine: { show: true }
      });

      yAxes.push({
        gridIndex: i,
        type: 'value',
        scale: true,
        axisLabel: { 
          show: true, 
          color: '#0f172a', 
          fontWeight: 'bold',
          formatter: (value) => Number(value).toFixed(0)
        },
        position: 'left',
        name: channelNames[i] || `CH${i + 1}`,
        nameLocation: 'middle',
        nameGap: 42,
        splitLine: { 
           show: false
        },
        axisLine: { show: true },
        axisTick: { show: true }
      });

      if (data[i]) {
        const segmentSamples = isMTTSFile
          ? (isMTTSPointGroup ? (data[i] || []) : Array.from(data[i] || []).slice(segmentStartIndex, segmentEndIndex))
          : data[i];
        const seriesData = buildPreviewSeriesData(segmentSamples, dt);

        series.push({
          name: channelNames[i] || `CH${i + 1}`,
          type: 'line',
          xAxisIndex: i,
          yAxisIndex: i,
          showSymbol: false,
          sampling: 'lttb',
          progressive: 2000,
          progressiveThreshold: 3000,
          lineStyle: { width: 1, color: colors[i] },
          data: seriesData
        });
      }
    }

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params) => {
          let res = `<b>时间: ${params[0].value[0].toFixed(3)} ms</b><br/>`;
          params.forEach(p => {
             res += `${p.marker} ${p.seriesName}: <b>${p.value[1].toFixed(2)}</b><br/>`;
          });
          return res;
        }
      },
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      series: series
    };
  };

  const modalStyle = maximized
    ? { position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', borderRadius: 0, display: 'flex', flexDirection: 'column', background: '#ffffff' }
    : { width: '88vw', maxWidth: '1400px', height: '82vh', display: 'flex', flexDirection: 'column', position: 'relative', background: '#ffffff', borderRadius: '16px', border: '1px solid var(--border-color)', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)', overflow: 'hidden' };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: maximized ? 'transparent' : 'rgba(0,0,0,0.6)', backdropFilter: maximized ? 'none' : 'blur(4px)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card glass" style={modalStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: maximized ? '12px 20px' : '16px 24px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', zIndex: 1 }}>
            <Activity size={24} color="#10b981" />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{isMTTSPointGroup ? `${currentPointLabel} 测点` : fileObj?.name}</h3>
                {canRunEh4Computation && !(isF3BandFile || (isMTTSPointGroup && availableMTTSBands.length > 1)) && (
                  <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: '6px', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                    <button
                      onClick={() => setDisplayMode('chart')}
                      style={{ background: displayMode === 'chart' ? '#10b981' : 'transparent', color: displayMode === 'chart' ? '#fff' : '#64748b', border: 'none', padding: '6px 12px', cursor: 'pointer', fontSize: '13px', fontWeight: displayMode === 'chart' ? 600 : 400 }}
                    >
                      波形
                    </button>
                    <button
                      onClick={() => setDisplayMode('table')}
                      style={{ background: displayMode === 'table' ? '#10b981' : 'transparent', color: displayMode === 'table' ? '#fff' : '#64748b', border: 'none', borderLeft: '1px solid #e2e8f0', padding: '6px 12px', cursor: 'pointer', fontSize: '13px', fontWeight: displayMode === 'table' ? 600 : 400 }}
                    >
                      头信息
                    </button>
                    <button
                      onClick={() => setDisplayMode('analysis')}
                      style={{ background: displayMode === 'analysis' ? '#10b981' : 'transparent', color: displayMode === 'analysis' ? '#fff' : '#64748b', border: 'none', borderLeft: '1px solid #e2e8f0', padding: '6px 12px', cursor: 'pointer', fontSize: '13px', fontWeight: displayMode === 'analysis' ? 600 : 400 }}
                    >
                      计算结果
                    </button>
                  </div>
                )}
                {(isF3BandFile || (isMTTSPointGroup && availableMTTSBands.length > 1)) && (
                  <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: '6px', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                    {(isF3BandFile
                      ? [
                          { id: 'H', label: '高频' },
                          { id: 'M', label: '中频' },
                          { id: 'L', label: '低频' }
                        ]
                      : availableMTTSBands.map((id) => ({ id, label: MTTS_BAND_LABELS[id] || '频段' }))
                    ).map(({ id, label }) => (
                      <button
                        key={id}
                        onClick={() => {
                          if (isF3BandFile) {
                            if (!onSwitchBand) return;
                            if (currentBand === id) return;
                            onSwitchBand(id);
                            return;
                          }
                          if (currentMTTSBand === id) return;
                          setCurrentMTTSBand(id);
                          setCurrentBlockIndex(0);
                        }}
                        style={{
                          background: (isF3BandFile ? currentBand : currentMTTSBand) === id ? '#10b981' : 'transparent',
                          color: (isF3BandFile ? currentBand : currentMTTSBand) === id ? '#fff' : '#64748b',
                          border: 'none',
                          padding: '6px 12px',
                          cursor: 'pointer',
                          fontSize: '13px',
                          fontWeight: (isF3BandFile ? currentBand : currentMTTSBand) === id ? 600 : 400
                        }}
                      >
                        {label}
                      </button>
                    ))}
                    <button
                      onClick={() => setDisplayMode(prev => (prev === 'table' ? 'chart' : 'table'))}
                      style={{ background: displayMode === 'table' ? '#10b981' : 'transparent', color: displayMode === 'table' ? '#fff' : '#64748b', border: 'none', borderLeft: '1px solid #e2e8f0', padding: '6px 12px', cursor: 'pointer', fontSize: '13px', fontWeight: displayMode === 'table' ? 600 : 400 }}
                    >
                      头信息
                    </button>
                    {canRunEh4Computation && (
                      <button
                        onClick={() => setDisplayMode('analysis')}
                        style={{ background: displayMode === 'analysis' ? '#10b981' : 'transparent', color: displayMode === 'analysis' ? '#fff' : '#64748b', border: 'none', borderLeft: '1px solid #e2e8f0', padding: '6px 12px', cursor: 'pointer', fontSize: '13px', fontWeight: displayMode === 'analysis' ? 600 : 400 }}
                      >
                        计算结果
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '12px', color: '#64748b' }}>{isMTTSFile ? 'MTTS 原始时间序列波形预览' : '原始时间序列 (Y_file) 波形预览'}</span>
                {stationMeta && (
                  <div style={{ display: 'flex', gap: '8px', fontSize: '11px', color: '#64748b', background: '#f8fafc', padding: '2px 8px', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                    <span>点号: <b style={{ color: '#0f172a' }}>{stationMeta.rx ?? '--'}</b></span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span>线号: <b style={{ color: '#0f172a' }}>{stationMeta.ry ?? '--'}</b></span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span>X极距: <b style={{ color: '#0f172a' }}>{stationMeta.xl ?? '--'} m</b></span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span>Y极距: <b style={{ color: '#0f172a' }}>{stationMeta.yl ?? '--'} m</b></span>
                  </div>
                )}
                {!stationMeta && isMTTSFile && (
                  <div style={{ display: 'flex', gap: '8px', fontSize: '11px', color: '#64748b', background: '#f8fafc', padding: '2px 8px', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                    <span>点号: <b style={{ color: '#0f172a' }}>{currentDisplayBlock?.header?.pointNo || '--'}</b></span>
                  </div>
                )}
              </div>
            </div>
          </div>
          
          <div style={{ position: 'absolute', left: '55%', transform: 'translateX(-50%)', display: 'flex', background: '#f1f5f9', borderRadius: '6px', border: '1px solid #e2e8f0', overflow: 'hidden', zIndex: 0 }}>
              {[
                { type: 'Y', label: '时间序列' },
                { type: 'X', label: '功率谱' },
                { type: 'Z', label: '视电阻率' }
              ].map(({ type, label }) => {
               const isActive = currentDataType === type;
               return (
                 <button
                   key={type}
                   onClick={() => {
                     if (!onSwitchType) return;
                          if (isMTTSFile && type !== 'Y') return;
                     if (currentDataType === type) return;
                     onSwitchType(type);
                   }}
                   style={{
                     background: isActive ? '#10b981' : 'transparent',
                          color: isActive ? '#fff' : '#64748b',
                          opacity: isMTTSFile && type !== 'Y' ? 0.45 : 1,
                          border: 'none', cursor: isMTTSFile && type !== 'Y' ? 'not-allowed' : 'pointer', padding: '6px 16px',
                     display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: isActive ? 600 : 400
                   }}
                 >
                   {label}
                 </button>
               );
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', zIndex: 1 }}>
            {canRunSinglePointEmap1 && (
              <button
                onClick={() => setShowEmap1AuroraPanel((prev) => !prev)}
                style={{ background: showEmap1AuroraPanel ? '#2563eb' : '#eff6ff', color: showEmap1AuroraPanel ? '#fff' : '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: '6px', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600 }}
              >
                <Sigma size={14} />
                {showEmap1AuroraPanel ? '收起计算面板' : 'Aurora 计算'}
              </button>
            )}
            {canRunEh4Computation && (
              <>
                <button
                  onClick={handleRunEh4Computation}
                  disabled={eh4ComputationLoading || loading}
                  style={{ background: '#10b981', color: '#fff', border: 'none', borderRadius: '6px', cursor: eh4ComputationLoading || loading ? 'not-allowed' : 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600, opacity: eh4ComputationLoading || loading ? 0.6 : 1 }}
                >
                  {eh4ComputationLoading ? <Loader2 size={14} className="animate-spin" /> : <Sigma size={14} />}
                  EH4 计算
                </button>
                {eh4ComputationLoading && (
                  <span style={{ color: '#047857', fontSize: '12px', fontWeight: 600 }}>
                    {eh4ComputationStage || '准备计算'}
                  </span>
                )}
                <button
                  onClick={handleExportEh4Computation}
                  disabled={!eh4ComputationResult}
                  style={{ background: '#f59e0b', color: '#fff', border: 'none', borderRadius: '6px', cursor: eh4ComputationResult ? 'pointer' : 'not-allowed', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600, opacity: eh4ComputationResult ? 1 : 0.55 }}
                >
                  <Download size={14} />
                    导出结果
                </button>
              </>
            )}
            {isMTTSFile && (
              <div style={{ display: 'flex', alignItems: 'center', background: '#f1f5f9', borderRadius: '6px', border: '1px solid #e2e8f0', overflow: 'hidden', marginLeft: '8px' }}>
                <select
                  value={mttsSegmentLength}
                  onChange={(e) => {
                    setMttsSegmentLength(Number(e.target.value));
                    setMttsSegmentIndex(0);
                  }}
                  title="窗口长度"
                  style={{ border: 'none', borderLeft: '1px solid #e2e8f0', borderRight: '1px solid #e2e8f0', background: '#ffffff', color: '#0f172a', padding: '4px 10px', fontSize: '12px', fontWeight: 600, outline: 'none', cursor: 'pointer' }}
                >
                  {MTTS_SEGMENT_OPTIONS.map((size) => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Block/Segment Switcher */}
            {visibleBlocks.length > 0 && !isMTTSPointGroup && (
              <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: '6px', border: '1px solid #e2e8f0', overflow: 'hidden', marginLeft: '8px', alignItems: 'center' }}>
                <button 
                  onClick={() => setCurrentBlockIndex(Math.max(0, currentBlockIndex - 1))}
                  disabled={currentBlockIndex === 0}
                  style={{ background: 'transparent', color: currentBlockIndex === 0 ? '#cbd5e1' : '#64748b', border: 'none', cursor: currentBlockIndex === 0 ? 'not-allowed' : 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center' }}
                >
                  <ChevronLeft size={16} />
                </button>
                <div style={{ fontSize: '12px', color: '#0f172a', fontWeight: 'bold', padding: '0 8px', minWidth: '60px', textAlign: 'center' }}>
                  {`段 ${visibleBlocks[currentBlockIndex]?.header?.counts ?? currentBlockIndex}`}
                </div>
                <button 
                  onClick={() => setCurrentBlockIndex(Math.min(visibleBlocks.length - 1, currentBlockIndex + 1))}
                  disabled={currentBlockIndex === visibleBlocks.length - 1}
                  style={{ background: 'transparent', color: currentBlockIndex === visibleBlocks.length - 1 ? '#cbd5e1' : '#64748b', border: 'none', cursor: currentBlockIndex === visibleBlocks.length - 1 ? 'not-allowed' : 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center' }}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}

            {isMTTSFile && currentMTTSSegmentCount > 1 && (
              <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: '6px', border: '1px solid #e2e8f0', overflow: 'hidden', marginLeft: '8px', alignItems: 'center' }}>
                <button
                  onClick={() => setMttsSegmentIndex(Math.max(0, mttsSegmentIndex - 1))}
                  disabled={mttsSegmentIndex === 0}
                  style={{ background: 'transparent', color: mttsSegmentIndex === 0 ? '#cbd5e1' : '#64748b', border: 'none', cursor: mttsSegmentIndex === 0 ? 'not-allowed' : 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center' }}
                >
                  <ChevronLeft size={16} />
                </button>
                <div style={{ fontSize: '12px', color: '#0f172a', fontWeight: 'bold', padding: '0 8px', minWidth: '84px', textAlign: 'center' }}>
                  {`分段 ${Math.min(mttsSegmentIndex + 1, currentMTTSSegmentCount)} / ${currentMTTSSegmentCount}`}
                </div>
                <button
                  onClick={() => setMttsSegmentIndex(Math.min(currentMTTSSegmentCount - 1, mttsSegmentIndex + 1))}
                  disabled={mttsSegmentIndex === currentMTTSSegmentCount - 1}
                  style={{ background: 'transparent', color: mttsSegmentIndex === currentMTTSSegmentCount - 1 ? '#cbd5e1' : '#64748b', border: 'none', cursor: mttsSegmentIndex === currentMTTSSegmentCount - 1 ? 'not-allowed' : 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center' }}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}

            <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: '6px', border: '1px solid #e2e8f0', overflow: 'hidden', marginLeft: '8px' }}>
              <button onClick={onPrev} title="上一个测点" style={{ background: 'transparent', color: '#64748b', border: 'none', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center' }}>
                <ChevronLeft size={16} />
              </button>
              <div style={{ width: '1px', background: '#e2e8f0' }}></div>
              <button onClick={onNext} title="下一个测点" style={{ background: 'transparent', color: '#64748b', border: 'none', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center' }}>
                <ChevronRight size={16} />
              </button>
            </div>

            <button onClick={() => setMaximized(!maximized)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b', marginLeft: '8px' }}>{maximized ? <Minimize2 size={20} /> : <Maximize2 size={20} />}</button>
            <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}><X size={20} /></button>
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingRight: showEmap1AuroraPanel ? '360px' : 0, transition: 'padding-right 0.2s ease' }}>
          {loading || mttsDataLoading ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: '#10b981' }}>
              <Loader2 size={48} className="animate-spin" />
              <p>{loading ? '正在读取二进制时间序列数据...' : '正在按需加载当前分段...'}</p>
            </div>
          ) : errorMsg ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: '#ef4444' }}>
              <AlertCircle size={48} />
              <p>{errorMsg}</p>
            </div>
          ) : displayMode === 'table' ? (
            renderHeaderTable()
          ) : displayMode === 'analysis' ? (
            renderEh4Analysis()
          ) : (
            <div style={{ flex: 1, background: '#ffffff' }}>
              <ReactECharts option={getOption()} style={{ width: '100%', height: '100%' }} notMerge={true} />
            </div>
          )}

          {!loading && !errorMsg && visibleBlocks.length > 1 && (
            <div style={{ padding: '10px 20px 14px', borderTop: '1px solid #e2e8f0', background: '#f8fafc', flexShrink: 0 }}>
              <input
                type="range"
                min={0}
                max={visibleBlocks.length - 1}
                step={1}
                value={currentBlockIndex}
                onChange={(e) => setCurrentBlockIndex(Number(e.target.value))}
                style={{ width: '100%', accentColor: '#475569', cursor: 'pointer', opacity: 0.8 }}
              />
            </div>
          )}
          {!loading && !errorMsg && isMTTSFile && currentMTTSSegmentCount > 1 && (
            <div style={{ padding: '0 20px 14px', borderTop: visibleBlocks.length > 1 ? 'none' : '1px solid #e2e8f0', background: '#f8fafc', flexShrink: 0 }}>
              <input
                type="range"
                min={0}
                max={currentMTTSSegmentCount - 1}
                step={1}
                value={mttsSegmentIndex}
                onChange={(e) => setMttsSegmentIndex(Number(e.target.value))}
                style={{ width: '100%', accentColor: '#10b981', cursor: 'pointer', opacity: 0.85 }}
              />
            </div>
          )}
        </div>

        {showEmap1AuroraPanel && (
          <div
            style={{
              position: 'absolute',
              top: maximized ? 61 : 73,
              right: 0,
              bottom: 0,
              width: '360px',
              background: '#ffffff',
              borderLeft: '1px solid #e2e8f0',
              boxShadow: '-10px 0 24px rgba(15, 23, 42, 0.08)',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 5
            }}
          >
            <div style={{ padding: '16px 18px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>Aurora 单点计算</div>
                <div style={{ marginTop: '4px', fontSize: '12px', color: '#64748b' }}>
                  {currentPointLabel} · {currentDisplayBlock?.header?.datasetLabel || currentDisplayBlock?.header?.bandLabel || '当前频带'}
                </div>
              </div>
              <button onClick={() => setShowEmap1AuroraPanel(false)} style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '12px' }}>关闭</button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                  计算模式
                  <select value={emap1AuroraSettings.mode} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, mode: e.target.value }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }}>
                    <option value="scalar_xy">scalar_xy</option>
                    <option value="scalar_yx">scalar_yx</option>
                    <option value="scalar_both">scalar_both</option>
                    <option value="tensor">tensor</option>
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                  目标频率 (Hz)
                  <input type="number" step="0.1" value={emap1AuroraSettings.targetFrequencyHz} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, targetFrequencyHz: Number(e.target.value) }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                  NFFT
                  <input type="number" value={emap1AuroraSettings.nfft} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, nfft: Number(e.target.value) }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                  窗函数
                  <input type="number" step="0.05" min="0" max="0.95" value={emap1AuroraSettings.overlap} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, overlap: Number(e.target.value) }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                  最大迭代
                  <select value={emap1AuroraSettings.window} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, window: e.target.value }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }}>
                    <option value="hann">hann</option>
                    <option value="hamming">hamming</option>
                    <option value="blackman">blackman</option>
                    <option value="boxcar">boxcar</option>
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                  重叠率
                  <input type="number" value={emap1AuroraSettings.maxIter} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, maxIter: Number(e.target.value) }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                  Ex 偶极距 (m)
                  <input type="number" value={emap1AuroraSettings.dipoleExM} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, dipoleExM: Number(e.target.value) }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                  Ey 偶极距 (m)
                  <input type="number" value={emap1AuroraSettings.dipoleEyM} onChange={(e) => setEmap1AuroraSettings((prev) => ({ ...prev, dipoleEyM: Number(e.target.value) }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }} />
                </label>
              </div>

              <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a' }}>通道和传感器校正</div>
                <div style={{ fontSize: '12px', color: '#64748b', lineHeight: 1.6 }}>
                  先把 EX/EY/HX/HY 的通道响应和传感器响应文件上传到云盘，再在这里选择。后端会把这些文件交给 Aurora 做校正。
                </div>
                <button
                  type="button"
                  onClick={handleAutoMatchEmap1Calibration}
                  style={{ alignSelf: 'flex-start', border: '1px solid #cbd5e1', background: '#fff', color: '#2563eb', borderRadius: '8px', padding: '6px 10px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                >
                  按文件名自动配对
                </button>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  {showExCalibration && (
                    <>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                        EX 通道响应
                        <select value={emap1AuroraCalibration.exChannelResponseId} onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, exChannelResponseId: e.target.value }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }}>
                          <option value="">不使用</option>
                          {emap1CalibrationCandidates.map((item) => <option key={`ex-chan-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>{item.name}</option>)}
                        </select>
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                        EX 传感器响应
                        <select value={emap1AuroraCalibration.exSensorResponseId} onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, exSensorResponseId: e.target.value }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }}>
                          <option value="">不使用</option>
                          {emap1CalibrationCandidates.map((item) => <option key={`ex-sensor-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>{item.name}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                  {showEyCalibration && (
                    <>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                        EY 通道响应
                        <select value={emap1AuroraCalibration.eyChannelResponseId} onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, eyChannelResponseId: e.target.value }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }}>
                          <option value="">不使用</option>
                          {emap1CalibrationCandidates.map((item) => <option key={`ey-chan-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>{item.name}</option>)}
                        </select>
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                        EY 传感器响应
                        <select value={emap1AuroraCalibration.eySensorResponseId} onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, eySensorResponseId: e.target.value }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }}>
                          <option value="">不使用</option>
                          {emap1CalibrationCandidates.map((item) => <option key={`ey-sensor-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>{item.name}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                  {showHxCalibration && (
                    <>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                        HX 通道响应
                        <select value={emap1AuroraCalibration.hxChannelResponseId} onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, hxChannelResponseId: e.target.value }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }}>
                          <option value="">不使用</option>
                          {emap1CalibrationCandidates.map((item) => <option key={`hx-chan-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>{item.name}</option>)}
                        </select>
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                        HX 传感器响应
                        <select value={emap1AuroraCalibration.hxSensorResponseId} onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, hxSensorResponseId: e.target.value }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }}>
                          <option value="">不使用</option>
                          {emap1CalibrationCandidates.map((item) => <option key={`hx-sensor-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>{item.name}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                  {showHyCalibration && (
                    <>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                        HY 通道响应
                        <select value={emap1AuroraCalibration.hyChannelResponseId} onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, hyChannelResponseId: e.target.value }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }}>
                          <option value="">不使用</option>
                          {emap1CalibrationCandidates.map((item) => <option key={`hy-chan-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>{item.name}</option>)}
                        </select>
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#475569' }}>
                        HY 传感器响应
                        <select value={emap1AuroraCalibration.hySensorResponseId} onChange={(e) => setEmap1AuroraCalibration((prev) => ({ ...prev, hySensorResponseId: e.target.value }))} style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '8px 10px', fontSize: '13px' }}>
                          <option value="">不使用</option>
                          {emap1CalibrationCandidates.map((item) => <option key={`hy-sensor-${getEmap1CalibrationCandidateId(item)}`} value={String(getEmap1CalibrationCandidateId(item))}>{item.name}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                </div>
              </div>

              <button
                onClick={handleRunSinglePointEmap1}
                disabled={emap1AuroraState.loading || !canRunSinglePointEmap1}
                style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: '10px', cursor: emap1AuroraState.loading || !canRunSinglePointEmap1 ? 'not-allowed' : 'pointer', padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '14px', fontWeight: 700, opacity: emap1AuroraState.loading || !canRunSinglePointEmap1 ? 0.6 : 1 }}
              >
                {emap1AuroraState.loading ? <Loader2 size={15} className="animate-spin" /> : <Sigma size={15} />}
                {emap1AuroraState.loading ? 'Aurora 计算中...' : '运行 Aurora'}
              </button>

              <div style={{ marginTop: '-4px', fontSize: '12px', color: '#64748b', lineHeight: 1.6 }}>
                会基于当前点的全频带数据一次计算所有频率，目标频率只用于高亮查看与摘要展示。
              </div>

              {emap1AuroraState.loading && emap1AuroraState.taskStatus && (
                <div style={{ display: 'grid', gap: '6px', borderRadius: '10px', border: '1px solid #bbf7d0', background: '#f0fdf4', padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', fontSize: '12px', color: '#166534', fontWeight: 700 }}>
                    <span>{emap1AuroraState.taskStatus.progress?.message || '后台任务处理中'}</span>
                    <span>{Number(emap1AuroraState.taskStatus.progress?.percent || 0)}%</span>
                  </div>
                  <div style={{ height: '8px', borderRadius: '999px', background: '#dcfce7', overflow: 'hidden' }}>
                    <div style={{ width: `${Number(emap1AuroraState.taskStatus.progress?.percent || 0)}%`, height: '100%', background: '#16a34a', transition: 'width 240ms ease' }} />
                  </div>
                  <div style={{ fontSize: '11px', color: '#15803d' }}>
                    Task ID: {emap1AuroraState.taskStatus.task_id || '--'}
                  </div>
                </div>
              )}

              {emap1AuroraState.error && (
                <div style={{ borderRadius: '10px', border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c', padding: '10px 12px', fontSize: '13px', lineHeight: 1.6 }}>
                  {emap1AuroraState.error}
                </div>
              )}

              {emap1AuroraState.response?.summary && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <div style={{ borderRadius: '10px', background: '#f8fafc', border: '1px solid #e2e8f0', padding: '10px 12px' }}>
                      <div style={{ fontSize: '12px', color: '#64748b' }}>计算引擎</div>
                      <div style={{ marginTop: '4px', fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>{emap1AuroraState.response.summary.engine || '--'}</div>
                    </div>
                    <div style={{ borderRadius: '10px', background: '#f8fafc', border: '1px solid #e2e8f0', padding: '10px 12px' }}>
                      <div style={{ fontSize: '12px', color: '#64748b' }}>频点数量</div>
                      <div style={{ marginTop: '4px', fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>{emap1AuroraState.response.summary.frequency_count ?? '--'}</div>
                    </div>
                  </div>

                  <div style={{ borderRadius: '12px', border: '1px solid #e2e8f0', background: '#ffffff', overflow: 'hidden' }}>
                    <div style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0', fontSize: '13px', fontWeight: 700, color: '#0f172a' }}>
                      目标频率结果
                    </div>
                    <div style={{ padding: '12px', display: 'grid', gap: '8px', fontSize: '13px', color: '#334155' }}>
                      <div>匹配目标频率：<b style={{ color: '#0f172a' }}>{Number(emap1AuroraState.targetRow?.freq_hz || emap1AuroraSettings.targetFrequencyHz).toFixed(3)} Hz</b></div>
                      <div>Zxy：<b style={{ color: '#0f172a' }}>{Number.isFinite(Number(emap1AuroraState.targetRow?.zxy_real)) ? `${Number(emap1AuroraState.targetRow.zxy_real).toFixed(4)} + ${Number(emap1AuroraState.targetRow?.zxy_imag || 0).toFixed(4)}i` : '--'}</b></div>
                      <div>Zyx：<b style={{ color: '#0f172a' }}>{Number.isFinite(Number(emap1AuroraState.targetRow?.zyx_real)) ? `${Number(emap1AuroraState.targetRow.zyx_real).toFixed(4)} + ${Number(emap1AuroraState.targetRow?.zyx_imag || 0).toFixed(4)}i` : '--'}</b></div>
                      <div>ρxy：<b style={{ color: '#0f172a' }}>{Number.isFinite(Number(emap1AuroraState.targetRow?.rho_xy)) ? Number(emap1AuroraState.targetRow.rho_xy).toFixed(3) : '--'}</b></div>
                      <div>ρyx：<b style={{ color: '#0f172a' }}>{Number.isFinite(Number(emap1AuroraState.targetRow?.rho_yx)) ? Number(emap1AuroraState.targetRow.rho_yx).toFixed(3) : '--'}</b></div>
                      <div>相位 XY：<b style={{ color: '#0f172a' }}>{Number.isFinite(Number(emap1AuroraState.targetRow?.phase_xy_deg)) ? `${Number(emap1AuroraState.targetRow.phase_xy_deg).toFixed(2)}°` : '--'}</b></div>
                      <div>相位 YX：<b style={{ color: '#0f172a' }}>{Number.isFinite(Number(emap1AuroraState.targetRow?.phase_yx_deg)) ? `${Number(emap1AuroraState.targetRow.phase_yx_deg).toFixed(2)}°` : '--'}</b></div>
                    </div>
                  </div>

                  <div style={{ borderRadius: '10px', background: '#f8fafc', border: '1px solid #e2e8f0', padding: '10px 12px', fontSize: '12px', lineHeight: 1.7, color: '#475569' }}>
                      <div>样本数：<b style={{ color: '#0f172a' }}>{emap1AuroraState.response.summary.sample_count ?? '--'}</b></div>
                      <div>分段数：<b style={{ color: '#0f172a' }}>{emap1AuroraState.response.summary.segment_count ?? '--'}</b></div>
                      <div>参与通道：<b style={{ color: '#0f172a' }}>{(emap1AuroraState.payloadMeta?.requiredChannels || []).join(', ').toUpperCase() || '--'}</b></div>
                      <div>数据频带：<b style={{ color: '#0f172a' }}>{emap1AuroraState.payloadMeta?.sampleRateTag || '--'}</b></div>
                  </div>
                  <div style={{ borderRadius: '12px', border: '1px solid #e2e8f0', background: '#ffffff', overflow: 'hidden' }}>
                    <div style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0', fontSize: '13px', fontWeight: 700, color: '#0f172a' }}>
                      全频率结果
                    </div>
                    <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                        <thead style={{ position: 'sticky', top: 0, background: '#f8fafc', zIndex: 1 }}>
                          <tr>
                            <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e2e8f0', color: '#475569' }}>频率 (Hz)</th>
                            <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e2e8f0', color: '#475569' }}>?xy</th>
                            <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e2e8f0', color: '#475569' }}>?yx</th>
                            <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e2e8f0', color: '#475569' }}>相位 XY</th>
                            <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e2e8f0', color: '#475569' }}>相位 YX</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(Array.isArray(emap1AuroraState.response?.rows) ? emap1AuroraState.response.rows : []).map((row, index) => {
                            const isTargetRow = Number.isFinite(Number(emap1AuroraState.targetRow?.freq_hz))
                              && Math.abs(Number(row?.freq_hz || 0) - Number(emap1AuroraState.targetRow?.freq_hz || 0)) < 1e-9;
                            return (
                              <tr key={`${row?.freq_hz || 'row'}_${index}`} style={{ background: isTargetRow ? '#eff6ff' : '#ffffff' }}>
                                <td style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', color: isTargetRow ? '#1d4ed8' : '#0f172a', fontWeight: isTargetRow ? 700 : 500 }}>
                                  {Number.isFinite(Number(row?.freq_hz)) ? Number(row.freq_hz).toFixed(3) : '--'}
                                </td>
                                <td style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', color: '#334155' }}>
                                  {Number.isFinite(Number(row?.rho_xy)) ? Number(row.rho_xy).toFixed(3) : '--'}
                                </td>
                                <td style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', color: '#334155' }}>
                                  {Number.isFinite(Number(row?.rho_yx)) ? Number(row.rho_yx).toFixed(3) : '--'}
                                </td>
                                <td style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', color: '#334155' }}>
                                  {Number.isFinite(Number(row?.phase_xy_deg)) ? Number(row.phase_xy_deg).toFixed(2) : '--'}
                                </td>
                                <td style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', color: '#334155' }}>
                                  {Number.isFinite(Number(row?.phase_yx_deg)) ? Number(row.phase_yx_deg).toFixed(2) : '--'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default YParser;
