import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import ReactECharts from './LazyECharts';
import { X, Maximize2, Minimize2, Activity, FileBarChart, Loader2, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { parseXFile, parseF3PsdFile } from '../utils/eh4io';
import { resolveDriveFileContent } from '../utils/driveFileContent';

void useMemo;
void useRef;

const XParser = ({ fileObj, fileSystem, onClose, onPrev, onNext, onSwitchType }) => {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [data, setData] = useState([]);
  const [maximized, setMaximized] = useState(false);
  const [displayMode, setDisplayMode] = useState('chart');
  const [stationMeta, setStationMeta] = useState(fileObj?.stationMeta || null);
  const currentNameLower = (fileObj?.name || '').toLowerCase();
  let currentDataType = '';
  if (currentNameLower.endsWith('.r')) currentDataType = 'Z';
  else if (currentNameLower.endsWith('.psd')) currentDataType = 'X';
  else if (currentNameLower.endsWith('.fh') || currentNameLower.endsWith('.fm') || currentNameLower.endsWith('.fl')) currentDataType = 'Y';
  else if ((fileObj?.name || '').toUpperCase().startsWith('X')) currentDataType = 'X';
  else if ((fileObj?.name || '').toUpperCase().startsWith('Y')) currentDataType = 'Y';
  else currentDataType = 'Z';

  const resolveBrowserFile = useCallback(async (targetFileObj, seenKeys = new Set()) => {
    let resolvedFile = await resolveDriveFileContent(targetFileObj, targetFileObj?.name || 'data.bin');

    if (!resolvedFile && targetFileObj && Array.isArray(fileSystem)) {
      const match = fileSystem.find((item) => {
        if (!item || item === targetFileObj || item.type !== 'file') return false;
        if (targetFileObj.id && item.id === targetFileObj.id) return true;
        return item.name === targetFileObj.name && (item.parentId || null) === (targetFileObj.parentId || null);
      });
      const matchKey = match?.id || match?.name;
      if (match && matchKey && !seenKeys.has(matchKey)) {
        seenKeys.add(matchKey);
        resolvedFile = await resolveBrowserFile(match, seenKeys);
      }
    }

    return resolvedFile;
  }, [fileSystem]);

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        
        let text = '';
        let binaryContent = null;
        const lowerName = (fileObj?.name || '').toLowerCase();
        const isF3Psd = lowerName.endsWith('.psd');
        const resolvedFile = await resolveBrowserFile(fileObj);
        if (resolvedFile) {
          if (isF3Psd) {
            binaryContent = await resolvedFile.arrayBuffer();
          } else {
            text = await resolvedFile.text();
          }
        }
        
        let currentMeta = fileObj?.stationMeta;
        if (!currentMeta) {
           try {
              let atText = '';
              const atFile = fileSystem?.find(f => f.name === '@');
              const resolvedAtFile = await resolveBrowserFile(atFile);
              if (resolvedAtFile) atText = await resolvedAtFile.text();
              
              if (atText) {
                 const { parseAtFile } = await import('../utils/eh4io');
                 const allStations = parseAtFile(atText);
                 const possibleId = fileObj.name.replace(/^[ZXY]/i, '').toLowerCase();
                 const matchedMeta = allStations.find(s => s.id.toLowerCase() === possibleId || s.id.toLowerCase() === fileObj.name.toLowerCase());
                 if (matchedMeta) {
                    currentMeta = matchedMeta;
                 }
              }
           } catch {
              // Station metadata is optional; keep parsing the X file when it is unavailable.
           }
        }
        setStationMeta(currentMeta);

        const parseFromCrosspowers = (d) => {
          const cp = d.crosspowers;
          const hy_amp = Math.sqrt(Math.max(0, cp[0]));
          const ex_amp = Math.sqrt(Math.max(0, cp[5]));
          const hx_amp = Math.sqrt(Math.max(0, cp[10]));
          const ey_amp = Math.sqrt(Math.max(0, cp[15]));
          const phs_hyex = Math.atan2(-(cp[4] || 0), cp[1] || 0) * 180 / Math.PI;
          const phs_hxey = Math.atan2(-(cp[14] || 0), cp[11] || 0) * 180 / Math.PI;
          const clamp01 = (value) => Math.max(0, Math.min(1, value));
          const safeCoherency = (real, imag, a, b) => {
            const denominator = a * b;
            return denominator > 0 ? clamp01((real ** 2 + imag ** 2) / denominator) : 0;
          };
          const coh_hyex = safeCoherency(cp[1], cp[4], cp[0], cp[5]);
          const coh_hxhy = safeCoherency(cp[2], cp[8], cp[10], cp[0]);
          const coh_hxey = safeCoherency(cp[11], cp[14], cp[10], cp[15]);
          const coh_exey = safeCoherency(cp[7], cp[13], cp[15], cp[5]);
          return {
            freq: d.freq,
            avg: d.avg,
            hy_amp, ex_amp, hx_amp, ey_amp,
            phs_hyex, phs_hxey,
            coh_hyex, coh_hxhy, coh_hxey, coh_exey
          };
        };

        if (isF3Psd && binaryContent) {
          const psdRows = parseF3PsdFile(binaryContent);
          const parsedData = psdRows.filter(d => d.frequency > 0).map(d => {
            const norm = d.numOfAvg < 1e-3 || Math.abs(d.bandwidth) <= Number.EPSILON ? 0 : 1 / d.numOfAvg / d.bandwidth;
            const hy_amp = Math.sqrt(Math.max(0, d.ch1Ch1 * norm));
            const ex_amp = Math.sqrt(Math.max(0, d.ch2Ch2 * d.frequency * 0.000005 * norm));
            const hx_amp = Math.sqrt(Math.max(0, d.ch3Ch3 * norm));
            const ey_amp = Math.sqrt(Math.max(0, d.ch4Ch4 * d.frequency * 0.000005 * norm));
            const phs_hyex = Math.atan2(d.ch1Ch2Imag, d.ch2Ch1Real) * 180 / Math.PI;
            const phs_hxey = Math.atan2(d.ch3Ch4Imag, d.ch4Ch3Real) * 180 / Math.PI;
            const coh_hyex = d.cohXY;
            const coh_hxey = d.cohYX;
            const coh_hxhy = 0;
            const coh_exey = 0;
            return {
              freq: d.frequency,
              avg: d.numOfAvg,
              hy_amp,
              ex_amp,
              hx_amp,
              ey_amp,
              phs_hyex,
              phs_hxey,
              coh_hyex,
              coh_hxhy,
              coh_hxey,
              coh_exey
            };
          });
          if (parsedData.length > 0) {
            parsedData.sort((a, b) => b.freq - a.freq);
            setData(parsedData);
            setLoading(false);
            return;
          }
        } else if (text) {
          const xData = parseXFile(text);
          const validData = xData.filter(d => d.freq > 0 && d.avg > 0);
          if (validData.length > 0) {
            const parsedData = validData.map(parseFromCrosspowers);
            parsedData.sort((a, b) => b.freq - a.freq);
            setData(parsedData);
            setLoading(false);
            return;
          }
        }
        throw new Error('未找到有效的 X 文件数据');
      } catch (e) {
        console.warn(e);
        setErrorMsg('数据加载失败：无法解析交叉功率谱数据');
        setLoading(false);
      }
    };
    
    loadData();
  }, [fileObj, fileSystem, resolveBrowserFile]);

  const getOption = () => {
    if (data.length === 0) return {};

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params) => {
          let res = `<b>频率: ${params[0].value[0].toFixed(2)} Hz</b><br/>`;
          
          const added = new Set();
          params.forEach(p => {
            const key = p.seriesName;
            if (!added.has(key)) {
                let unit = '';
                if (key.includes('Phase')) unit = ' °';
                res += `${p.marker} ${key}: <b>${p.value[1].toFixed(3)}</b>${unit}<br/>`;
                added.add(key);
            }
          });
          return res;
        }
      },
      axisPointer: { link: { xAxisIndex: 'all' } },
      title: [
        {
          text: 'Hy {diamond|◇} - Ex {rect|□}',
          left: '9%',
          top: '2%',
          textStyle: { 
            fontSize: 14, 
            fontWeight: 'bold', 
            color: '#0f172a',
            rich: {
              diamond: {
                fontSize: 16,
                color: '#3b82f6', // 蓝色空心菱形
                fontWeight: 'bold'
              },
              rect: {
                fontSize: 16,
                color: '#ef4444', // 红色空心方形
                fontWeight: 'bold'
              }
            }
          }
        },
        {
          text: 'Hx {diamond|◇} - Ey {rect|□}',
          left: '9%',
          top: '50%',
          textStyle: { 
            fontSize: 14, 
            fontWeight: 'bold', 
            color: '#0f172a',
            rich: {
              diamond: {
                fontSize: 16,
                color: '#3b82f6',
                fontWeight: 'bold'
              },
              rect: {
                fontSize: 16,
                color: '#ef4444',
                fontWeight: 'bold'
              }
            }
          }
        }
      ],
      grid: [
        // Upper group: Hy - Ex
        { left: '10%', right: '10%', top: '6%', height: '18%', show: true, borderColor: '#0f172a', borderWidth: 1, backgroundColor: 'transparent' },
        { left: '10%', right: '10%', top: '24%', height: '10%', show: true, borderColor: '#0f172a', borderWidth: 1, backgroundColor: 'transparent' },
        { left: '10%', right: '10%', top: '34%', height: '10%', show: true, borderColor: '#0f172a', borderWidth: 1, backgroundColor: 'transparent' },
        // Lower group: Hx - Ey
        { left: '10%', right: '10%', top: '54%', height: '18%', show: true, borderColor: '#0f172a', borderWidth: 1, backgroundColor: 'transparent' },
        { left: '10%', right: '10%', top: '72%', height: '10%', show: true, borderColor: '#0f172a', borderWidth: 1, backgroundColor: 'transparent' },
        { left: '10%', right: '10%', top: '82%', height: '10%', show: true, borderColor: '#0f172a', borderWidth: 1, backgroundColor: 'transparent' }
      ],
      xAxis: [
        { type: 'log', gridIndex: 0, inverse: true, axisLabel: { show: false }, axisTick: { show: true }, splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } } },
        { type: 'log', gridIndex: 1, inverse: true, axisLabel: { show: false }, axisTick: { show: true }, splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } } },
        { type: 'log', gridIndex: 2, inverse: true, axisLabel: { show: false }, axisTick: { show: true }, splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } } },
        { type: 'log', gridIndex: 3, inverse: true, axisLabel: { show: false }, axisTick: { show: true }, splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } } },
        { type: 'log', gridIndex: 4, inverse: true, axisLabel: { show: false }, axisTick: { show: true }, splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } } },
        { type: 'log', gridIndex: 5, inverse: true, name: 'FREQUENCY (Hz)', nameLocation: 'middle', nameGap: 25, axisLabel: { color: '#0f172a', fontWeight: 'bold' }, splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } } }
      ],
      yAxis: [
        { type: 'log', gridIndex: 0, name: 'AMPLITUDE', nameLocation: 'middle', nameGap: 45, nameTextStyle: { fontWeight: 'bold' }, axisLabel: { color: '#0f172a', fontWeight: 'bold' }, splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } }, axisLine: { show: true } },
        { type: 'value', gridIndex: 1, name: 'PHASE', nameLocation: 'middle', nameGap: 45, nameTextStyle: { fontWeight: 'bold' }, min: -180, max: 180, interval: 90, axisLabel: { color: '#0f172a', fontWeight: 'bold' }, splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } }, axisLine: { show: true } },
        { type: 'value', gridIndex: 2, name: 'COHERENCY', nameLocation: 'middle', nameGap: 45, nameTextStyle: { fontWeight: 'bold' }, min: 0, max: 1, interval: 0.5, axisLabel: { color: '#0f172a', fontWeight: 'bold' }, splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } }, axisLine: { show: true } },
        { type: 'log', gridIndex: 3, name: 'AMPLITUDE', nameLocation: 'middle', nameGap: 45, nameTextStyle: { fontWeight: 'bold' }, axisLabel: { color: '#0f172a', fontWeight: 'bold' }, splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } }, axisLine: { show: true } },
        { type: 'value', gridIndex: 4, name: 'PHASE', nameLocation: 'middle', nameGap: 45, nameTextStyle: { fontWeight: 'bold' }, min: -180, max: 180, interval: 90, axisLabel: { color: '#0f172a', fontWeight: 'bold' }, splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } }, axisLine: { show: true } },
        { type: 'value', gridIndex: 5, name: 'COHERENCY', nameLocation: 'middle', nameGap: 45, nameTextStyle: { fontWeight: 'bold' }, min: 0, max: 1, interval: 0.5, axisLabel: { color: '#0f172a', fontWeight: 'bold' }, splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } }, axisLine: { show: true } }
      ],
      series: [
        // ====== Upper Group: Hy - Ex ======
        // Amplitude
        { name: 'Hy Amp', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: data.map(p => [p.freq, p.hy_amp]), symbol: 'diamond', symbolSize: 6, itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 } }, // Blue
        { name: 'Ex Amp', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, data: data.map(p => [p.freq, p.ex_amp]), symbol: 'rect', symbolSize: 5, itemStyle: { color: '#ffffff', borderColor: '#ef4444', borderWidth: 1.5 } }, // Red
        // Phase
        { name: 'Hy-Ex Phase', type: 'scatter', xAxisIndex: 1, yAxisIndex: 1, data: data.map(p => [p.freq, p.phs_hyex]), symbol: 'diamond', symbolSize: 6, itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 } },
        // Coherency (diamond for cross, square for auto)
        { name: 'Hy-Ex Coh', type: 'scatter', xAxisIndex: 2, yAxisIndex: 2, data: data.map(p => [p.freq, p.coh_hyex]), symbol: 'diamond', symbolSize: 6, itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 } },
        { name: 'Hx-Hy Coh', type: 'scatter', xAxisIndex: 2, yAxisIndex: 2, data: data.map(p => [p.freq, p.coh_hxhy]), symbol: 'rect', symbolSize: 5, itemStyle: { color: '#ffffff', borderColor: '#10b981', borderWidth: 1.5 } }, // Green

        // ====== Lower Group: Hx - Ey ======
        // Amplitude
        { name: 'Hx Amp', type: 'scatter', xAxisIndex: 3, yAxisIndex: 3, data: data.map(p => [p.freq, p.hx_amp]), symbol: 'diamond', symbolSize: 6, itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 } }, // Blue
        { name: 'Ey Amp', type: 'scatter', xAxisIndex: 3, yAxisIndex: 3, data: data.map(p => [p.freq, p.ey_amp]), symbol: 'rect', symbolSize: 5, itemStyle: { color: '#ffffff', borderColor: '#ef4444', borderWidth: 1.5 } }, // Red
        // Phase
        { name: 'Hx-Ey Phase', type: 'scatter', xAxisIndex: 4, yAxisIndex: 4, data: data.map(p => [p.freq, p.phs_hxey]), symbol: 'diamond', symbolSize: 6, itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 } },
        // Coherency
        { name: 'Hx-Ey Coh', type: 'scatter', xAxisIndex: 5, yAxisIndex: 5, data: data.map(p => [p.freq, p.coh_hxey]), symbol: 'diamond', symbolSize: 6, itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 } },
        { name: 'Ex-Ey Coh', type: 'scatter', xAxisIndex: 5, yAxisIndex: 5, data: data.map(p => [p.freq, p.coh_exey]), symbol: 'rect', symbolSize: 5, itemStyle: { color: '#ffffff', borderColor: '#10b981', borderWidth: 1.5 } } // Green
      ]
    };
  };

  const modalStyle = maximized
    ? { position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', borderRadius: 0, display: 'flex', flexDirection: 'column', background: '#ffffff' }
    : { width: '88vw', maxWidth: '1400px', height: '82vh', display: 'flex', flexDirection: 'column', position: 'relative', background: '#ffffff', borderRadius: '16px', border: '1px solid var(--border-color)', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)', overflow: 'hidden' };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: maximized ? 'transparent' : 'rgba(0,0,0,0.6)', backdropFilter: maximized ? 'none' : 'blur(4px)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card glass" style={modalStyle}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: maximized ? '12px 20px' : '16px 24px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', zIndex: 1 }}>
            <Activity size={24} color="#3b82f6" />
            <div>
              <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{fileObj?.name}</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '12px', color: '#64748b' }}>交叉功率谱 (X_file) 解析</span>
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
                     if (currentDataType === type) return;
                     onSwitchType(type);
                   }}
                   style={{
                     background: isActive ? '#3b82f6' : 'transparent',
                     color: isActive ? '#fff' : '#64748b',
                     border: 'none', cursor: 'pointer', padding: '6px 16px',
                     display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: isActive ? 600 : 400
                   }}
                 >
                   {label}
                 </button>
               );
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', zIndex: 1 }}>
            <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: '6px', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
              <button onClick={() => setDisplayMode('chart')} style={{ background: displayMode === 'chart' ? '#3b82f6' : 'transparent', color: displayMode === 'chart' ? '#fff' : '#64748b', border: 'none', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}><Activity size={14} />曲线</button>
              <button onClick={() => setDisplayMode('table')} style={{ background: displayMode === 'table' ? '#3b82f6' : 'transparent', color: displayMode === 'table' ? '#fff' : '#64748b', border: 'none', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}><FileBarChart size={14} />数据</button>
            </div>

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

        {/* Content */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: '#3b82f6' }}>
              <Loader2 size={48} className="animate-spin" />
              <p>正在解析交叉功率谱数据...</p>
            </div>
          ) : errorMsg ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: '#ef4444' }}>
              <AlertCircle size={48} />
              <p>{errorMsg}</p>
            </div>
          ) : displayMode === 'table' ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                <thead style={{ position: 'sticky', top: 0, background: '#f8fafc', zIndex: 10 }}>
                  <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                    <th style={{ padding: '12px' }}>频率 (Hz)</th>
                    <th style={{ padding: '12px' }}>Hy Amp</th>
                    <th style={{ padding: '12px' }}>Ex Amp</th>
                    <th style={{ padding: '12px' }}>Hx Amp</th>
                    <th style={{ padding: '12px' }}>Ey Amp</th>
                    <th style={{ padding: '12px' }}>Hy-Ex 相位</th>
                    <th style={{ padding: '12px' }}>Hx-Ey 相位</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((p, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '12px' }}>{p.freq.toExponential(2)}</td>
                      <td style={{ padding: '12px', color: '#0f172a' }}>{p.hy_amp.toFixed(4)}</td>
                      <td style={{ padding: '12px', color: '#0f172a' }}>{p.ex_amp.toFixed(4)}</td>
                      <td style={{ padding: '12px', color: '#0f172a' }}>{p.hx_amp.toFixed(4)}</td>
                      <td style={{ padding: '12px', color: '#0f172a' }}>{p.ey_amp.toFixed(4)}</td>
                      <td style={{ padding: '12px', color: '#3b82f6' }}>{p.phs_hyex.toFixed(2)}</td>
                      <td style={{ padding: '12px', color: '#3b82f6' }}>{p.phs_hxey.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ flex: 1, background: '#ffffff' }}>
              <ReactECharts option={getOption()} style={{ width: '100%', height: '100%' }} notMerge={true} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default XParser;
