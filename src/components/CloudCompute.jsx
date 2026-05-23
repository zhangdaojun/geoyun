/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactECharts from './LazyECharts';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderOpen,
  Loader2,
  Play,
  Server,
  UploadCloud,
} from 'lucide-react';
import {
  startAdminEmap1BatchTask,
  waitForAdminEmap1TaskResult,
} from '../services/adminEmap1Api';

const CHANNEL_PATTERN = /^(.*?)(?:[_\-. ]?)(ex|ey|hx|hy|rx|ry)$/i;
const REQUIRED_CHANNELS = ['ex', 'ey', 'hx', 'hy'];

const createEmptyProgress = () => ({ current: 0, total: 0, status: '' });

const inferGroupFromRelativePath = (file) => {
  const relativePath = String(file?.webkitRelativePath || file?.name || '').replace(/\\/g, '/');
  if (!relativePath) return null;
  const parts = relativePath.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] || '';
  const stem = fileName.replace(/\.[^.]+$/, '');
  const match = stem.match(CHANNEL_PATTERN);
  if (!match) return null;

  const base = String(match[1] || '').trim().replace(/[_\-. ]+$/g, '');
  const channelName = String(match[2] || '').toLowerCase();
  const parentPath = parts.slice(0, -1).join('/');
  const groupKey = base
    ? (parentPath ? `${parentPath}/${base}` : base)
    : (parentPath || 'emap1');

  return {
    groupKey,
    channelName,
    relativePath,
  };
};

export const buildUploadGroups = (files = []) => {
  const grouped = new Map();

  Array.from(files || []).forEach((file) => {
    const resolved = inferGroupFromRelativePath(file);
    if (!resolved) return;
    const current = grouped.get(resolved.groupKey) || {
      groupKey: resolved.groupKey,
      channels: {},
      duplicates: {},
    };
    if (current.channels[resolved.channelName]) {
      current.duplicates[resolved.channelName] = [
        ...(current.duplicates[resolved.channelName] || []),
        file,
      ];
    } else {
      current.channels[resolved.channelName] = file;
    }
    grouped.set(resolved.groupKey, current);
  });

  return Array.from(grouped.values())
    .map((item) => ({
      ...item,
      missingChannels: REQUIRED_CHANNELS.filter((channelName) => !item.channels[channelName]),
      duplicateChannels: Object.keys(item.duplicates || {}),
    }))
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey, 'zh-Hans-CN', { numeric: true }));
};

const parseNumericText = (text, options = {}) => {
  const columnIndex = Number.isFinite(Number(options.columnIndex)) ? Number(options.columnIndex) : 0;
  const skipRows = Number.isFinite(Number(options.skipRows)) ? Number(options.skipRows) : 0;
  const scale = Number.isFinite(Number(options.scale)) ? Number(options.scale) : 1;
  const values = [];

  String(text || '')
    .split(/\r?\n/)
    .forEach((rawLine, lineIndex) => {
      if (lineIndex < skipRows) return;
      const line = rawLine.split('#', 1)[0].trim();
      if (!line) return;
      const tokens = line.split(/[\s,;]+/).filter(Boolean);
      if (!tokens.length || columnIndex >= tokens.length) return;
      const parsed = Number(tokens[columnIndex]);
      if (!Number.isFinite(parsed)) return;
      values.push(parsed * scale);
    });

  if (!values.length) {
    throw new Error('未能从文件中读取到有效数值列');
  }
  return values;
};

export const buildChartOption = (rows = [], groupKey = '') => {
  const data = (rows || []).filter((row) => Number(row?.freq_hz) > 0);
  if (!data.length) return {};

  return {
    title: {
      text: `EMAP-1 处理结果：${groupKey}`,
      left: 'center',
      top: 8,
      textStyle: {
        fontSize: 14,
        fontWeight: 700,
        color: '#0f172a',
      },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
    },
    legend: {
      top: 36,
      data: ['Rho XY', 'Rho YX', 'Phase XY', 'Phase YX', 'Coh XY', 'Coh YX'],
    },
    grid: [
      { left: 68, right: 24, top: 84, height: '36%' },
      { left: 68, right: 24, top: '55%', height: '18%' },
      { left: 68, right: 24, top: '77%', height: '16%' },
    ],
    axisPointer: {
      link: [{ xAxisIndex: [0, 1, 2] }],
    },
    xAxis: [
      {
        type: 'log',
        inverse: true,
        gridIndex: 0,
        axisLabel: { show: false },
        splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } },
      },
      {
        type: 'log',
        inverse: true,
        gridIndex: 1,
        axisLabel: { show: false },
        splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } },
      },
      {
        type: 'log',
        inverse: true,
        gridIndex: 2,
        name: 'Frequency (Hz)',
        nameLocation: 'middle',
        nameGap: 28,
        splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } },
      },
    ],
    yAxis: [
      {
        type: 'log',
        gridIndex: 0,
        name: 'Rho (ohm·m)',
        nameLocation: 'middle',
        nameGap: 52,
        splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } },
      },
      {
        type: 'value',
        gridIndex: 1,
        name: 'Phase (deg)',
        nameLocation: 'middle',
        nameGap: 52,
        min: -180,
        max: 180,
        interval: 90,
        splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } },
      },
      {
        type: 'value',
        gridIndex: 2,
        name: 'Coherency',
        nameLocation: 'middle',
        nameGap: 52,
        min: 0,
        max: 1,
        interval: 0.5,
        splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } },
      },
    ],
    series: [
      {
        name: 'Rho XY',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        showSymbol: true,
        symbolSize: 7,
        itemStyle: { color: '#2563eb' },
        lineStyle: { color: '#2563eb', width: 1.5 },
        data: data.map((row) => [row.freq_hz, row.rho_xy]),
      },
      {
        name: 'Rho YX',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        showSymbol: true,
        symbolSize: 7,
        itemStyle: { color: '#ef4444' },
        lineStyle: { color: '#ef4444', width: 1.5 },
        data: data.map((row) => [row.freq_hz, row.rho_yx]),
      },
      {
        name: 'Phase XY',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        showSymbol: true,
        symbolSize: 6,
        itemStyle: { color: '#2563eb' },
        lineStyle: { color: '#2563eb', width: 1.2 },
        data: data.map((row) => [row.freq_hz, row.phase_xy_deg]),
      },
      {
        name: 'Phase YX',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        showSymbol: true,
        symbolSize: 6,
        itemStyle: { color: '#ef4444' },
        lineStyle: { color: '#ef4444', width: 1.2 },
        data: data.map((row) => [row.freq_hz, row.phase_yx_deg]),
      },
      {
        name: 'Coh XY',
        type: 'line',
        xAxisIndex: 2,
        yAxisIndex: 2,
        showSymbol: true,
        symbolSize: 5,
        itemStyle: { color: '#16a34a' },
        lineStyle: { color: '#16a34a', width: 1.2 },
        data: data.map((row) => [row.freq_hz, row.coherency_xy]),
      },
      {
        name: 'Coh YX',
        type: 'line',
        xAxisIndex: 2,
        yAxisIndex: 2,
        showSymbol: true,
        symbolSize: 5,
        itemStyle: { color: '#f59e0b' },
        lineStyle: { color: '#f59e0b', width: 1.2 },
        data: data.map((row) => [row.freq_hz, row.coherency_yx]),
      },
    ],
  };
};

const buildRowsCsv = (rows = []) => {
  const headers = [
    'freq_hz',
    'zxx_real',
    'zxx_imag',
    'zxy_real',
    'zxy_imag',
    'zyx_real',
    'zyx_imag',
    'zyy_real',
    'zyy_imag',
    'rho_xy',
    'rho_yx',
    'phase_xy_deg',
    'phase_yx_deg',
    'coherency_xy',
    'coherency_yx',
  ];
  const lines = [
    headers.join(','),
    ...(rows || []).map((row) => headers.map((key) => row?.[key] ?? '').join(',')),
  ];
  return lines.join('\n');
};

const triggerTextDownload = (text, fileName) => {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

const defaultProcessForm = {
  samplingRateHz: 1024,
  mode: 'tensor',
  nfft: 4096,
  overlap: 0.5,
  window: 'hann',
  huberThreshold: 1.5,
  maxIter: 20,
  tolerance: 1e-4,
  dipoleExM: 25,
  dipoleEyM: 25,
  useRemoteReference: true,
  skipRows: 0,
  columnIndex: 0,
  scale: 1,
  serverInputDir: '',
  serverOutputDir: '',
};

const CloudCompute = ({ currentUser }) => {
  const directoryInputRef = useRef(null);
  const [processForm, setProcessForm] = useState(defaultProcessForm);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploadGroups, setUploadGroups] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isServerProcessing, setIsServerProcessing] = useState(false);
  const [progress, setProgress] = useState(createEmptyProgress());
  const [batchResult, setBatchResult] = useState(null);
  const [selectedGroupKey, setSelectedGroupKey] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [serverErrorMsg, setServerErrorMsg] = useState('');

  useEffect(() => {
    if (!directoryInputRef.current) return;
    directoryInputRef.current.setAttribute('webkitdirectory', '');
    directoryInputRef.current.setAttribute('directory', '');
  }, []);

  const uploadSummary = useMemo(() => {
    const totalGroups = uploadGroups.length;
    const readyGroups = uploadGroups.filter(
      (group) => !group.missingChannels.length && !group.duplicateChannels.length,
    ).length;
    const skippedGroups = totalGroups - readyGroups;
    return {
      totalFiles: selectedFiles.length,
      totalGroups,
      readyGroups,
      skippedGroups,
    };
  }, [selectedFiles.length, uploadGroups]);

  const selectedItem = useMemo(() => {
    if (!batchResult?.items?.length) return null;
    return batchResult.items.find((item) => item.group_key === selectedGroupKey) || batchResult.items[0] || null;
  }, [batchResult, selectedGroupKey]);

  const selectedChartOption = useMemo(
    () => buildChartOption(selectedItem?.rows || [], selectedItem?.group_key || ''),
    [selectedItem],
  );

  const handleDirectorySelect = (event) => {
    const files = Array.from(event.target.files || []);
    setSelectedFiles(files);
    const groups = buildUploadGroups(files);
    setUploadGroups(groups);
    setBatchResult(null);
    setSelectedGroupKey(groups[0]?.groupKey || '');
    setErrorMsg('');
    setProgress(createEmptyProgress());
  };

  const handleProcessFormChange = (key, value) => {
    setProcessForm((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const buildBatchPayload = (browserGroups) => ({
    input_dir: selectedFiles[0]?.webkitRelativePath
      ? selectedFiles[0].webkitRelativePath.split('/')[0]
      : 'browser-upload',
    sampling_rate_hz: Number(processForm.samplingRateHz),
    mode: processForm.mode,
    nfft: Number(processForm.nfft),
    overlap: Number(processForm.overlap),
    window: processForm.window,
    huber_threshold: Number(processForm.huberThreshold),
    max_iter: Number(processForm.maxIter),
    tolerance: Number(processForm.tolerance),
    dipole_ex_m: Number(processForm.dipoleExM),
    dipole_ey_m: Number(processForm.dipoleEyM),
    use_remote_reference: Boolean(processForm.useRemoteReference),
    return_rows: true,
    browser_groups: browserGroups,
  });

  const handleRunUploadBatch = async () => {
    if (!uploadGroups.length) {
      setErrorMsg('请先选择一个 EMAP-1 数据目录。');
      return;
    }

    setIsProcessing(true);
    setErrorMsg('');
    setProgress({ current: 0, total: uploadGroups.length, status: '正在扫描与处理…' });

    const skippedItems = [];
    const readyGroups = [];

    for (const group of uploadGroups) {
      setProgress({
        current: skippedItems.length + readyGroups.length,
        total: uploadGroups.length,
        status: `正在处理 ${group.groupKey}`,
      });

      if (group.missingChannels.length || group.duplicateChannels.length) {
        const reasons = [];
        if (group.missingChannels.length) {
          reasons.push(`缺少通道：${group.missingChannels.join(', ')}`);
        }
        if (group.duplicateChannels.length) {
          reasons.push(`重复通道：${group.duplicateChannels.join(', ')}`);
        }
        skippedItems.push({
          group_key: group.groupKey,
          status: 'skipped',
          reason: reasons.join('；'),
          channel_files: Object.fromEntries(
            Object.entries(group.channels || {}).map(([name, file]) => [name, file?.name || '']),
          ),
          rows: [],
        });
        continue;
      }

      try {
        const entries = await Promise.all(
          Object.entries(group.channels || {}).map(async ([channelName, file]) => {
            const text = await file.text();
            const values = parseNumericText(text, {
              columnIndex: processForm.columnIndex,
              skipRows: processForm.skipRows,
              scale: processForm.scale,
            });
            return [channelName, { values }];
          }),
        );

        readyGroups.push({
          group_key: group.groupKey,
          channel_files: Object.fromEntries(
            Object.entries(group.channels || {}).map(([name, file]) => [name, file?.name || '']),
          ),
          channels: Object.fromEntries(entries),
        });
      } catch (error) {
        skippedItems.push({
          group_key: group.groupKey,
          status: 'failed',
          reason: error?.message || '处理失败',
          channel_files: Object.fromEntries(
            Object.entries(group.channels || {}).map(([name, file]) => [name, file?.name || '']),
          ),
          rows: [],
        });
      }
    }

    if (readyGroups.length) {
      try {
        const task = await startAdminEmap1BatchTask(buildBatchPayload(readyGroups), currentUser);
        const response = await waitForAdminEmap1TaskResult(task.task_id, currentUser, {
          onStatus: (status) => {
            const remoteProgress = status?.progress || {};
            setProgress({
              current: skippedItems.length + Number(remoteProgress.current || 0),
              total: uploadGroups.length,
              status: remoteProgress.message || `后台任务 ${status?.status || 'running'}`,
            });
          },
        });
        const items = [...skippedItems, ...(response?.items || [])];
        const summary = {
          ...(response?.summary || {}),
          input_dir: selectedFiles[0]?.webkitRelativePath
            ? selectedFiles[0].webkitRelativePath.split('/')[0]
            : 'browser-upload',
          total_groups: items.length,
          processed_count: items.filter((item) => item.status === 'processed').length,
          skipped_count: items.filter((item) => item.status !== 'processed').length,
        };
        setBatchResult({ summary, items });
        setSelectedGroupKey(items[0]?.group_key || '');
        setProgress({
          current: items.length,
          total: items.length,
          status: '处理完成',
        });
      } catch (error) {
        setErrorMsg(error?.message || '处理失败');
      } finally {
        setIsProcessing(false);
      }
      return;
    }

    const items = skippedItems;
    const summary = {
      input_dir: selectedFiles[0]?.webkitRelativePath
        ? selectedFiles[0].webkitRelativePath.split('/')[0]
        : 'browser-upload',
      output_dir: null,
      recursive: true,
      file_glob: '*',
      total_groups: items.length,
      processed_count: items.filter((item) => item.status === 'processed').length,
      skipped_count: items.filter((item) => item.status !== 'processed').length,
      manifest_path: null,
    };
    setBatchResult({ summary, items });
    setSelectedGroupKey(items[0]?.group_key || '');
    setProgress({
      current: items.length,
      total: items.length,
      status: '处理完成',
    });
    setIsProcessing(false);
  };

  const handleRunServerBatch = async () => {
    if (!String(processForm.serverInputDir || '').trim()) {
      setServerErrorMsg('请先填写服务器上的输入目录。');
      return;
    }
    setIsServerProcessing(true);
    setServerErrorMsg('');
    try {
      const payload = {
        input_dir: String(processForm.serverInputDir || '').trim(),
        output_dir: String(processForm.serverOutputDir || '').trim() || null,
        sampling_rate_hz: Number(processForm.samplingRateHz),
        mode: processForm.mode,
        nfft: Number(processForm.nfft),
        overlap: Number(processForm.overlap),
        window: processForm.window,
        huber_threshold: Number(processForm.huberThreshold),
        max_iter: Number(processForm.maxIter),
        tolerance: Number(processForm.tolerance),
        dipole_ex_m: Number(processForm.dipoleExM),
        dipole_ey_m: Number(processForm.dipoleEyM),
        use_remote_reference: Boolean(processForm.useRemoteReference),
        return_rows: false,
      };
      const task = await startAdminEmap1BatchTask(payload, currentUser);
      const response = await waitForAdminEmap1TaskResult(task.task_id, currentUser, {
        onStatus: (status) => {
          const remoteProgress = status?.progress || {};
          setProgress({
            current: Number(remoteProgress.current || 0),
            total: Number(remoteProgress.total || 0),
            status: remoteProgress.message || `后台任务 ${status?.status || 'running'}`,
          });
        },
      });
      setBatchResult(response);
      setSelectedGroupKey(response?.items?.[0]?.group_key || '');
    } catch (error) {
      setServerErrorMsg(error?.message || '服务器目录批处理失败');
    } finally {
      setIsServerProcessing(false);
    }
  };

  const handleDownloadCurrentCsv = () => {
    if (!selectedItem?.rows?.length) return;
    triggerTextDownload(
      buildRowsCsv(selectedItem.rows),
      `${String(selectedItem.group_key || 'emap1').replace(/[^\w.-]+/g, '_')}.csv`,
    );
  };

  const renderFormInput = (label, inputNode) => (
    <label style={{ display: 'grid', gap: '6px', minWidth: 0 }}>
      <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 600 }}>{label}</span>
      {inputNode}
    </label>
  );

  return (
    <div
      className="dashboard-container"
      style={{
        display: 'grid',
        gridTemplateRows: 'auto auto minmax(0, 1fr)',
        height: '100%',
        padding: '24px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '16px',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ fontSize: '24px', marginBottom: '4px' }}>EMAP-1 批处理工作台</h2>
          <p className="text-sm text-muted">
            直接上传整目录的 EX/EY/HX/HY/RX/RY 通道文件，批量完成 EMAP-1 视电阻率处理并查看结果。
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 12px',
            borderRadius: '8px',
            border: '1px solid var(--border-color)',
            background: '#fff',
          }}
        >
          <Server size={18} color="#2563eb" />
          <div>
            <div style={{ fontSize: '12px', color: '#64748b' }}>当前操作者</div>
            <div style={{ fontSize: '13px', fontWeight: 700 }}>{currentUser?.name || currentUser?.account || '未登录'}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: '20px' }}>
        <div className="card" style={{ display: 'grid', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ fontSize: '16px', marginBottom: '4px' }}>本地目录上传处理</h3>
              <p className="text-xs text-muted">浏览器读取目录文件后，逐测点调用后台处理接口并返回结果。</p>
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <input
                ref={directoryInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={handleDirectorySelect}
              />
              <button
                type="button"
                className="btn-primary"
                onClick={() => directoryInputRef.current?.click()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
              >
                <FolderOpen size={16} />
                选择 EMAP-1 目录
              </button>
              <button
                type="button"
                onClick={handleRunUploadBatch}
                disabled={isProcessing || !uploadGroups.length}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 14px',
                  borderRadius: '6px',
                  border: '1px solid #bfdbfe',
                  background: isProcessing || !uploadGroups.length ? '#e2e8f0' : '#eff6ff',
                  color: isProcessing || !uploadGroups.length ? '#94a3b8' : '#2563eb',
                  fontWeight: 700,
                }}
              >
                {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                开始批处理
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '12px' }}>
            {[
              { label: '已选文件', value: uploadSummary.totalFiles },
              { label: '识别测点组', value: uploadSummary.totalGroups },
              { label: '可处理组', value: uploadSummary.readyGroups },
              { label: '跳过组', value: uploadSummary.skippedGroups },
            ].map((item) => (
              <div
                key={item.label}
                style={{
                  padding: '14px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color)',
                  background: '#fff',
                }}
              >
                <div className="text-xs text-muted">{item.label}</div>
                <div style={{ marginTop: '8px', fontSize: '22px', fontWeight: 800 }}>{item.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '12px' }}>
            {renderFormInput(
              '采样率 (Hz)',
              <input
                value={processForm.samplingRateHz}
                onChange={(event) => handleProcessFormChange('samplingRateHz', event.target.value)}
                style={{ padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}
              />,
            )}
            {renderFormInput(
              '处理模式',
              <select
                value={processForm.mode}
                onChange={(event) => handleProcessFormChange('mode', event.target.value)}
                style={{ padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}
              >
                <option value="tensor">tensor</option>
                <option value="scalar_xy">scalar_xy</option>
                <option value="scalar_yx">scalar_yx</option>
                <option value="scalar_both">scalar_both</option>
              </select>,
            )}
            {renderFormInput(
              'NFFT',
              <input
                value={processForm.nfft}
                onChange={(event) => handleProcessFormChange('nfft', event.target.value)}
                style={{ padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}
              />,
            )}
            {renderFormInput(
              'Overlap',
              <input
                value={processForm.overlap}
                onChange={(event) => handleProcessFormChange('overlap', event.target.value)}
                style={{ padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}
              />,
            )}
            {renderFormInput(
              '跳过表头行数',
              <input
                value={processForm.skipRows}
                onChange={(event) => handleProcessFormChange('skipRows', event.target.value)}
                style={{ padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}
              />,
            )}
            {renderFormInput(
              '读取列序号',
              <input
                value={processForm.columnIndex}
                onChange={(event) => handleProcessFormChange('columnIndex', event.target.value)}
                style={{ padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}
              />,
            )}
            {renderFormInput(
              '统一缩放系数',
              <input
                value={processForm.scale}
                onChange={(event) => handleProcessFormChange('scale', event.target.value)}
                style={{ padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}
              />,
            )}
            {renderFormInput(
              '窗口函数',
              <select
                value={processForm.window}
                onChange={(event) => handleProcessFormChange('window', event.target.value)}
                style={{ padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}
              >
                <option value="hann">hann</option>
                <option value="hamming">hamming</option>
                <option value="boxcar">boxcar</option>
              </select>,
            )}
          </div>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#334155' }}>
            <input
              type="checkbox"
              checked={processForm.useRemoteReference}
              onChange={(event) => handleProcessFormChange('useRemoteReference', event.target.checked)}
            />
            有 RX/RY 时启用远参考
          </label>

          {progress.total > 0 && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: '8px',
                border: '1px solid #dbeafe',
                background: '#eff6ff',
                fontSize: '13px',
                color: '#1d4ed8',
              }}
            >
              {progress.status} {progress.current}/{progress.total}
            </div>
          )}

          {errorMsg && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '12px 14px',
                borderRadius: '8px',
                border: '1px solid #fecaca',
                background: '#fef2f2',
                color: '#b91c1c',
                fontSize: '13px',
              }}
            >
              <AlertTriangle size={16} />
              {errorMsg}
            </div>
          )}
        </div>

        <div className="card" style={{ display: 'grid', gap: '14px' }}>
          <div>
            <h3 style={{ fontSize: '16px', marginBottom: '4px' }}>服务器目录批处理</h3>
            <p className="text-xs text-muted">适合已经落在后台机器上的 EMAP-1 目录，直接调用后端批处理接口。</p>
          </div>
          {renderFormInput(
            '输入目录',
            <input
              value={processForm.serverInputDir}
              onChange={(event) => handleProcessFormChange('serverInputDir', event.target.value)}
              placeholder="例如：D:/emap1/input"
              style={{ padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}
            />,
          )}
          {renderFormInput(
            '输出目录',
            <input
              value={processForm.serverOutputDir}
              onChange={(event) => handleProcessFormChange('serverOutputDir', event.target.value)}
              placeholder="例如：D:/emap1/output"
              style={{ padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}
            />,
          )}
          <button
            type="button"
            onClick={handleRunServerBatch}
            disabled={isServerProcessing}
            className="btn-primary"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              width: '100%',
            }}
          >
            {isServerProcessing ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
            运行服务器目录批处理
          </button>
          {serverErrorMsg && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '12px 14px',
                borderRadius: '8px',
                border: '1px solid #fecaca',
                background: '#fef2f2',
                color: '#b91c1c',
                fontSize: '13px',
              }}
            >
              <AlertTriangle size={16} />
              {serverErrorMsg}
            </div>
          )}
          <div
            style={{
              padding: '14px',
              borderRadius: '8px',
              border: '1px dashed var(--border-color)',
              background: '#f8fafc',
              fontSize: '12px',
              color: '#64748b',
              lineHeight: 1.7,
            }}
          >
            本地上传模式适合你手头目录刚采集完成、还没放到服务器上的情况；服务器目录模式适合已经同步到后台磁盘后的批量重跑。
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '360px minmax(0, 1fr)',
          gap: '20px',
          minHeight: 0,
        }}
      >
        <div className="card" style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '12px' }}>
            <div>
              <h3 style={{ fontSize: '16px', marginBottom: '4px' }}>批处理结果列表</h3>
              <p className="text-xs text-muted">
                {batchResult?.summary
                  ? `共 ${batchResult.summary.total_groups} 组，成功 ${batchResult.summary.processed_count} 组`
                  : '处理完成后会在这里展示每个测点组的状态'}
              </p>
            </div>
            {selectedItem?.rows?.length ? (
              <button
                type="button"
                onClick={handleDownloadCurrentCsv}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid #bfdbfe',
                  background: '#eff6ff',
                  color: '#2563eb',
                  fontWeight: 700,
                }}
              >
                <Download size={14} />
                导出当前 CSV
              </button>
            ) : null}
          </div>

          <div style={{ overflowY: 'auto', minHeight: 0, display: 'grid', gap: '10px' }}>
            {(batchResult?.items || uploadGroups.map((group) => ({
              group_key: group.groupKey,
              status: group.missingChannels.length || group.duplicateChannels.length ? 'skipped' : 'ready',
              reason: group.missingChannels.length
                ? `缺少通道：${group.missingChannels.join(', ')}`
                : group.duplicateChannels.length
                  ? `重复通道：${group.duplicateChannels.join(', ')}`
                  : '',
              channel_files: Object.fromEntries(
                Object.entries(group.channels || {}).map(([name, file]) => [name, file?.name || '']),
              ),
              rows: [],
            }))).map((item) => {
              const isActive = selectedGroupKey === item.group_key;
              const statusColor = item.status === 'processed'
                ? '#16a34a'
                : item.status === 'failed'
                  ? '#dc2626'
                  : item.status === 'skipped'
                    ? '#f59e0b'
                    : '#64748b';
              return (
                <button
                  key={item.group_key}
                  type="button"
                  onClick={() => setSelectedGroupKey(item.group_key)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '14px',
                    borderRadius: '8px',
                    border: isActive ? '1px solid #93c5fd' : '1px solid var(--border-color)',
                    background: isActive ? '#eff6ff' : '#fff',
                    display: 'grid',
                    gap: '8px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.group_key}
                    </div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: statusColor, fontSize: '12px', fontWeight: 700 }}>
                      {item.status === 'processed' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                      {item.status}
                    </div>
                  </div>
                  <div className="text-xs text-muted">
                    {Object.keys(item.channel_files || {}).length
                      ? Object.entries(item.channel_files || {}).map(([name, value]) => `${name}:${value}`).join(' | ')
                      : '尚未识别到通道文件'}
                  </div>
                  {item.reason ? (
                    <div style={{ fontSize: '12px', color: statusColor }}>{item.reason}</div>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="card" style={{ display: 'grid', gridTemplateRows: 'auto minmax(280px, 1fr) auto', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ fontSize: '16px', marginBottom: '4px' }}>
                {selectedItem?.group_key ? `结果详情：${selectedItem.group_key}` : '结果详情'}
              </h3>
              <p className="text-xs text-muted">
                {selectedItem?.summary
                  ? `样本数 ${selectedItem.summary.sample_count}，频点 ${selectedItem.summary.frequency_count}，分段 ${selectedItem.summary.segment_count}`
                  : '选中左侧测点组后查看处理结果、曲线和频点表'}
              </p>
            </div>
          </div>

          <div style={{ minHeight: 0 }}>
            {selectedItem?.rows?.length ? (
              <ReactECharts option={selectedChartOption} style={{ width: '100%', height: '100%' }} />
            ) : (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  minHeight: '280px',
                  borderRadius: '8px',
                  border: '1px dashed var(--border-color)',
                  background: '#f8fafc',
                  color: '#64748b',
                  fontSize: '14px',
                  textAlign: 'center',
                  padding: '24px',
                }}
              >
                {selectedItem?.reason || '还没有可展示的频点结果。'}
              </div>
            )}
          </div>

          <div style={{ marginTop: '14px', overflowX: 'auto', borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: '#f8fafc', color: '#64748b' }}>
                  {['freq_hz', 'rho_xy', 'rho_yx', 'phase_xy_deg', 'phase_yx_deg', 'coherency_xy', 'coherency_yx'].map((header) => (
                    <th key={header} style={{ padding: '10px 8px', textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(selectedItem?.rows || []).slice(0, 18).map((row, index) => (
                  <tr key={`${row.freq_hz}_${index}`} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '10px 8px' }}>{Number(row.freq_hz || 0).toFixed(4)}</td>
                    <td style={{ padding: '10px 8px' }}>{row.rho_xy == null ? '--' : Number(row.rho_xy).toFixed(4)}</td>
                    <td style={{ padding: '10px 8px' }}>{row.rho_yx == null ? '--' : Number(row.rho_yx).toFixed(4)}</td>
                    <td style={{ padding: '10px 8px' }}>{row.phase_xy_deg == null ? '--' : Number(row.phase_xy_deg).toFixed(4)}</td>
                    <td style={{ padding: '10px 8px' }}>{row.phase_yx_deg == null ? '--' : Number(row.phase_yx_deg).toFixed(4)}</td>
                    <td style={{ padding: '10px 8px' }}>{row.coherency_xy == null ? '--' : Number(row.coherency_xy).toFixed(4)}</td>
                    <td style={{ padding: '10px 8px' }}>{row.coherency_yx == null ? '--' : Number(row.coherency_yx).toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CloudCompute;
