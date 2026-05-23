import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, Play, Loader, Settings2, FileText } from 'lucide-react';
import { requestAdminApi } from '../../../services/apiClient';
import { resolveDriveFileContent } from '../../../utils/driveFileContent';
import LazyECharts from '../../../components/LazyECharts';

const buildFitChartOption = (fit) => {
  if (!fit || !Array.isArray(fit.obs) || !Array.isArray(fit.pred) || fit.obs.length === 0) {
    return null;
  }
  const n = Math.min(fit.obs.length, fit.pred.length);
  const obs = fit.obs.slice(0, n);
  const pred = fit.pred.slice(0, n);
  const misfit = (fit.misfit_pct || []).slice(0, n);
  const indices = Array.from({ length: n }, (_, i) => i + 1);

  return {
    animation: false,
    grid: [
      { left: 60, right: 24, top: 36, height: '52%' },
      { left: 60, right: 24, top: '68%', bottom: 48 },
    ],
    legend: {
      data: ['观测 ρa', '预测 ρa', '相对偏差'],
      top: 4,
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      formatter: (params) => {
        if (!params?.length) return '';
        const idx = params[0].dataIndex;
        const o = obs[idx];
        const p = pred[idx];
        const m = misfit[idx];
        return [
          `数据点 #${idx + 1}`,
          `观测 ρa: ${Number.isFinite(o) ? o.toFixed(3) : '--'} Ω·m`,
          `预测 ρa: ${Number.isFinite(p) ? p.toFixed(3) : '--'} Ω·m`,
          `相对偏差: ${Number.isFinite(m) ? m.toFixed(2) : '--'} %`,
        ].join('<br/>');
      },
    },
    xAxis: [
      { type: 'category', gridIndex: 0, data: indices, axisLabel: { show: false }, axisTick: { show: false } },
      { type: 'category', gridIndex: 1, data: indices, name: '数据点序号', nameLocation: 'middle', nameGap: 28 },
    ],
    yAxis: [
      { type: 'log', gridIndex: 0, name: 'ρa (Ω·m)', nameLocation: 'middle', nameGap: 44, scale: true },
      { type: 'value', gridIndex: 1, name: '相对偏差 (%)', nameLocation: 'middle', nameGap: 44 },
    ],
    series: [
      {
        name: '观测 ρa',
        type: 'scatter',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: obs,
        symbolSize: 5,
        itemStyle: { color: '#0ea5e9' },
      },
      {
        name: '预测 ρa',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: pred,
        showSymbol: false,
        smooth: false,
        lineStyle: { color: '#ef4444', width: 1.5 },
      },
      {
        name: '相对偏差',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: misfit,
        itemStyle: {
          color: (params) => (Number(params.value) >= 0 ? '#ef4444' : '#3b82f6'),
        },
        barWidth: '80%',
      },
    ],
  };
};

const FitComparisonChart = ({ fit }) => {
  const option = useMemo(() => buildFitChartOption(fit), [fit]);
  if (!option) return null;
  const n = fit?.n ?? fit?.obs?.length ?? 0;
  const rms = Number.isFinite(fit?.rms_pct) ? fit.rms_pct.toFixed(2) : '--';
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 12px 8px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px' }}>
        <strong style={{ fontSize: '0.95rem', color: '#0f172a' }}>观测 vs 预测 视电阻率</strong>
        <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
          数据点: {n}  ·  相对偏差 RMS: {rms}%
        </span>
      </div>
      <LazyECharts option={option} style={{ width: '100%', height: 380 }} notMerge lazyUpdate />
    </div>
  );
};

const coerceResolvedFileToBlob = (resolvedFile, fallbackName = 'data.dat') => {
  if (resolvedFile instanceof File) return resolvedFile;
  if (resolvedFile instanceof Blob) return resolvedFile;
  if (typeof resolvedFile === 'string') {
    return new Blob([resolvedFile], { type: 'application/octet-stream' });
  }
  if (resolvedFile instanceof ArrayBuffer || ArrayBuffer.isView(resolvedFile)) {
    return new Blob([resolvedFile], { type: 'application/octet-stream' });
  }
  throw new Error(`无法读取 ${fallbackName} 文件内容`);
};

const normalizeInversionError = (error, fileName = '目标文件') => {
  const message = String(error?.message || error || '').trim();
  if (/rhoa|apparent resistivity|视电阻率/i.test(message)) {
    return `${fileName} 缺少有效的正值视电阻率（rhoa），请检查 DAT 数据列是否为 RES2DINV 格式，且视电阻率不能为 0。`;
  }
  if (/data values equals 0\.0|equals 0\.0/i.test(message)) {
    return `${fileName} 中存在 0 值数据，pyGIMLi 无法反演。请检查并剔除视电阻率/电阻为 0 的测点后重试。`;
  }
  if (/simpeg.*未安装|simpeg.*not installed|No module named ['"]simpeg/i.test(message)) {
    return '后端 Python 环境未安装 SimPEG，无法使用 SimPEG 反演。请安装后重试，或切换为 pyGIMLi。';
  }
  if (/not\s*found/i.test(message) || /404/.test(message)) {
    return `${fileName} 在云端未找到，请重新上传或等待项目文件同步完成后再试。`;
  }
  if (/failed to download oss file/i.test(message)) {
    return `${fileName} 下载失败，请检查云端文件是否仍然存在。`;
  }
  return message || '启动反演失败';
};

const ErtInversionModal = ({ isOpen, onClose, file, onSuccess, onTaskStarted }) => {
  const [params, setParams] = useState({
    inversionBackend: 'pygimli',
    zWeight: 0.2,
    maxIter: 20,
    lambdaParam: 20,
    error: 0.03
  });
  
  const [status, setStatus] = useState('idle'); // idle, loading, in_progress, success, error
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [iterationLogs, setIterationLogs] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [resultData, setResultData] = useState(null);
  const [terrainFile, setTerrainFile] = useState(null);
  const [queueInfo, setQueueInfo] = useState(null); // { position, total } when task is queued
  
  const pollIntervalRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setStatus('idle');
      setProgress(0);
      setProgressMessage('');
      setIterationLogs([]);
      setErrorMsg('');
      setResultData(null);
      setTerrainFile(null);
      setQueueInfo(null);
      setParams({
        inversionBackend: 'pygimli',
        zWeight: 0.2,
        maxIter: 20,
        lambdaParam: 20,
        error: 0.03
      });
    }
    return () => {
      if (pollIntervalRef.current) {
        clearTimeout(pollIntervalRef.current);
      }
    };
  }, [isOpen]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setParams(prev => ({
      ...prev,
      [name]: name === 'inversionBackend' ? value : parseFloat(value) || 0
    }));
  };

  const handleTerrainFileChange = (e) => {
    const nextFile = e.target.files?.[0] || null;
    setTerrainFile(nextFile);
  };

  const startInversion = async () => {
    if (!file) return;

    setStatus('loading');
    setErrorMsg('');
    setProgress(5);
    setProgressMessage('正在准备数据...');
    setIterationLogs([]);

    try {
      const fileName = file?.name || 'data.dat';
      const resolvedFile = await resolveDriveFileContent(file, fileName);
      const dataBlob = resolvedFile ? coerceResolvedFileToBlob(resolvedFile, fileName) : null;
      if (!dataBlob || dataBlob.size === 0) {
        throw new Error(`${fileName} 内容为空或无法读取，无法进行二维反演`);
      }

      setProgress(20);

      const formData = new FormData();
      formData.append('data_file', dataBlob, fileName);
      if (terrainFile) {
        formData.append('terrain_file', terrainFile, terrainFile.name || 'terrain.txt');
      }
      formData.append('inversion_backend', params.inversionBackend);
      formData.append('z_weight', String(params.zWeight));
      formData.append('max_iter', String(params.maxIter));
      formData.append('lambda_param', String(params.lambdaParam));
      formData.append('error', String(params.error));

      const res = await requestAdminApi('/ert/invert', null, {
        method: 'POST',
        body: formData,
      });

      const taskId = res.task_id;
      onTaskStarted?.({
        task_id: taskId,
        status: res.status || 'queued',
        params: { ...params },
        fileName,
        created_at: new Date().toISOString(),
        progress: {
          current: 0,
          total: Number(params.maxIter) || 1,
          percent: 0,
          message: '任务已提交，后台正在排队/计算',
          logs: []
        }
      });
      onClose?.();
      if (onTaskStarted) return;
      setStatus('in_progress');
      setProgress(30);

      const poll = async () => {
        try {
          const statusRes = await requestAdminApi(`/ert/tasks/${taskId}`, null, { method: 'GET' });
          const taskProgress = statusRes.progress || {};
          if (statusRes.status === 'queued') {
            const position = Number(taskProgress.queue_position) || null;
            const total = Number(taskProgress.queue_total) || null;
            setQueueInfo(position ? { position, total } : null);
            setProgress(5);
          } else {
            setQueueInfo(null);
            if (taskProgress.percent !== undefined) {
              setProgress(Math.max(30, Math.min(100, Number(taskProgress.percent || 0))));
            }
          }
          if (taskProgress.message) {
            setProgressMessage(taskProgress.message);
          }
          if (Array.isArray(taskProgress.logs)) {
            setIterationLogs(taskProgress.logs.slice(-80));
          }

          if (statusRes.status === 'success') {
            setProgress(100);
            setProgressMessage('二维反演完成');
            const finalRes = await requestAdminApi(`/ert/tasks/${taskId}/result`, null, { method: 'GET' });
            const finalResult = {
              ...finalRes,
              task_id: taskId,
              params: { ...params },
              completed_at: new Date().toISOString(),
            };
            setResultData(finalResult);
            setStatus('success');
            if (onSuccess) onSuccess(finalResult);
          } else if (statusRes.status === 'failed' || statusRes.status === 'revoked') {
            if (Array.isArray(taskProgress.logs)) {
              setIterationLogs(taskProgress.logs.slice(-80));
            }
            throw new Error(statusRes.error || '二维反演计算失败');
          } else {
            pollIntervalRef.current = setTimeout(poll, 1500);
          }
        } catch (err) {
          console.error('Polling error', err);
          setStatus('error');
          setErrorMsg(normalizeInversionError(err, file?.name));
        }
      };

      poll();
    } catch (err) {
      console.error('Inversion error', err);
      setStatus('error');
      setErrorMsg(normalizeInversionError(err, file?.name));
    }
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(15, 23, 42, 0.6)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      backdropFilter: 'blur(4px)'
    }}>
      <div style={{
        background: '#ffffff',
        borderRadius: '16px',
        width: '500px',
        maxWidth: '90vw',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: '#f8fafc'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: '#eff6ff', color: '#3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Settings2 size={18} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.125rem', color: '#0f172a', fontWeight: 600 }}>
                二维反演计算 ({params.inversionBackend === 'simpeg' ? 'SimPEG' : 'pyGIMLi'})
              </h3>
              <p style={{ margin: '4px 0 0 0', fontSize: '0.875rem', color: '#64748b' }}>
                目标文件：{file?.name}
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            disabled={status === 'in_progress' || status === 'loading'}
            style={{
          background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px',
              color: '#64748b'
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '24px' }}>
          {(status === 'idle' || status === 'error') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {status === 'error' && (
                <div style={{ padding: '12px', background: '#fef2f2', color: '#991b1b', borderRadius: '8px', fontSize: '0.875rem', border: '1px solid #fecaca' }}>
                  {errorMsg}
                </div>
              )}
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#334155', marginBottom: '8px' }}>
                    反演程序
                  </label>
                  <select
                    name="inversionBackend"
                    value={params.inversionBackend}
                    onChange={handleChange}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none', background: '#fff' }}
                  >
                    <option value="pygimli">pyGIMLi</option>
                    <option value="simpeg">SimPEG</option>
                  </select>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>可选择开源反演后端</div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#334155', marginBottom: '8px' }}>
                    垂直权重 (zWeight)
                  </label>
                  <input 
                    type="number" 
                    name="zWeight" 
                    value={params.zWeight} 
                    onChange={handleChange}
                    step="0.1"
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }}
                  />
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>通常为 0.1 - 0.3</div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#334155', marginBottom: '8px' }}>
                    最大迭代次数 (maxIter)
                  </label>
                  <input 
                    type="number" 
                    name="maxIter" 
                    value={params.maxIter} 
                    onChange={handleChange}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }}
                  />
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>建议 10 - 20</div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#334155', marginBottom: '8px' }}>
                    正则化参数 (lambda)
                  </label>
                  <input 
                    type="number" 
                    name="lambdaParam" 
                    value={params.lambdaParam} 
                    onChange={handleChange}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }}
                  />
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>初始平滑参数</div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#334155', marginBottom: '8px' }}>
                    相对误差限 (error)
                  </label>
                  <input 
                    type="number" 
                    name="error" 
                    value={params.error} 
                    onChange={handleChange}
                    step="0.01"
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }}
                  />
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>例如 0.03 代表 3%</div>
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#334155', marginBottom: '8px' }}>
                  地形文件（可选）
                </label>
                <input
                  type="file"
                  accept=".txt,.dat,.csv,.xyz"
                  onChange={handleTerrainFileChange}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none', boxSizing: 'border-box' }}
                />
                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                  {terrainFile ? `已选择：${terrainFile.name}` : '支持两列 x 高程，未选择时自动读取 DAT 内置地形块'}
                </div>
              </div>
            </div>
          )}

          {(status === 'loading' || status === 'in_progress') && (
            <div style={{ padding: '32px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <Loader size={48} color="#3b82f6" style={{ animation: 'spin 2s linear infinite', marginBottom: '24px' }} />
              {queueInfo && queueInfo.position > 1 && (
                <div style={{
                  width: '100%',
                  marginBottom: '16px',
                  padding: '10px 14px',
                  background: '#fffbeb',
                  border: '1px solid #fde68a',
                  borderRadius: '8px',
                  color: '#92400e',
                  fontSize: '13px',
                  textAlign: 'center'
                }}>
                  当前共 {queueInfo.total} 个反演任务在排队，您处于第 <strong>{queueInfo.position}</strong> 位，前面还有 <strong>{queueInfo.position - 1}</strong> 个任务，等待 GPU/计算节点空闲后自动开始。
                </div>
              )}
              <div style={{ width: '100%', maxWidth: '300px', height: '6px', background: '#e2e8f0', borderRadius: '999px', overflow: 'hidden', marginBottom: '12px' }}>
                <div style={{ height: '100%', background: '#3b82f6', width: `${progress}%`, transition: 'width 0.3s ease' }} />
              </div>
              <div style={{ fontSize: '0.875rem', color: '#64748b', fontWeight: 500 }}>
                {progressMessage || (status === 'loading' ? '正在准备数据...' : '正在进行反演计算，这可能需要几分钟...')} ({progress}%)
              </div>
              <div style={{ marginTop: '10px', fontSize: '12px', color: '#64748b', textAlign: 'center', lineHeight: 1.6 }}>
                任务已在后台运行，可以关闭窗口或切换到其他界面；重新打开二维反演界面会继续显示状态和结果。
              </div>
              <div style={{
                width: '100%',
                marginTop: '18px',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                background: '#0f172a',
                color: '#dbeafe',
                maxHeight: '210px',
                overflowY: 'auto',
                padding: '10px 12px',
                fontSize: '12px',
                lineHeight: 1.55,
                fontFamily: 'Consolas, "SFMono-Regular", monospace',
                textAlign: 'left',
                boxSizing: 'border-box'
              }}>
                {(iterationLogs.length ? iterationLogs : [`等待 ${params.inversionBackend === 'simpeg' ? 'SimPEG' : 'pyGIMLi'} 输出迭代信息...`]).map((line, index) => (
                  <div key={`${index}-${line}`} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}

          {status === 'success' && resultData && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ padding: '16px', background: '#f0fdf4', color: '#166534', borderRadius: '8px', border: '1px solid #bbf7d0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '8px' }}>反演计算完成</div>
                <div style={{ display: 'flex', gap: '24px', fontSize: '0.875rem' }}>
                  <span>Chi²: <strong>{resultData.chi2?.toFixed(2) || '--'}</strong></span>
                  <span>rRMS: <strong>{resultData.rrms?.toFixed(2) || '--'}%</strong></span>
                  <span>地形: <strong>{resultData.terrain_used ? `${resultData.terrain_point_count || 0} 点` : '未使用'}</strong></span>
                </div>
              </div>

              <FitComparisonChart fit={resultData.fit_comparison} />

              <div style={{ fontSize: '0.875rem', color: '#475569' }}>
                <p style={{ margin: '0 0 8px 0', fontWeight: 500 }}>输出文件已生成：</p>
                <div style={{
                  background: '#f8fafc',
                  padding: '12px',
                  borderRadius: '6px',
                  border: '1px solid #e2e8f0',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  maxHeight: '260px',
                  overflowY: 'auto',
                  overscrollBehavior: 'contain'
                }}>
                  {(resultData.output_files || resultData.files || []).map(f => (
                    <div key={f} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <FileText size={14} color="#64748b" />
                      <span style={{ flex: 1, fontFamily: 'monospace' }}>{f.split(/[\\/]/).pop()}</span>
                    </div>
                  ))}
                </div>
                <p style={{ margin: '12px 0 0 0', color: '#94a3b8', fontSize: '12px' }}>
                  * 后台同步生成 VTK、Surfer 网格 (.grd)、白化边界 (.bln)、色谱 (.clr)、Scripter 宏 (.bas) 与说明文件 (README_Surfer.txt)。
                </p>
                {(resultData.surfer_macro_script || resultData.surfer_readme) && (
                  <div style={{
                    marginTop: '10px',
                    padding: '10px 12px',
                    background: '#eff6ff',
                    border: '1px solid #bfdbfe',
                    borderRadius: '6px',
                    color: '#1e40af',
                    fontSize: '12px',
                    lineHeight: 1.55
                  }}>
                    <strong>生成 .srf 工程文件：</strong> 在本机 Surfer 中打开 <code>resistivity_surfer_export.bas</code>（或菜单 工具 → Scripter → 加载脚本），按 F5 运行宏即可在同目录生成 <code>resistivity_surfer.srf</code>。详情参见 <code>README_Surfer.txt</code>。
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid #e2e8f0',
          background: '#f8fafc',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '12px'
        }}>
          {(status === 'idle' || status === 'error') ? (
            <>
              <button 
                onClick={onClose}
                style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#fff', color: '#334155', fontWeight: 500, cursor: 'pointer' }}
              >
                取消
              </button>
              <button 
                onClick={startInversion}
                style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', background: '#3b82f6', color: '#fff', fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <Play size={16} /> 开始计算
              </button>
            </>
          ) : status === 'success' ? (
            <button 
              onClick={onClose}
              style={{ padding: '8px 24px', borderRadius: '6px', border: 'none', background: '#3b82f6', color: '#fff', fontWeight: 500, cursor: 'pointer' }}
            >
              完成
            </button>
          ) : (
            <button
              onClick={onClose}
              style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#fff', color: '#334155', fontWeight: 500, cursor: 'pointer' }}
            >
              后台运行
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ErtInversionModal;
