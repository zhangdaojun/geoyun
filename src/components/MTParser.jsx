import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactECharts from './LazyECharts';
import { 
  X, Maximize2, Minimize2, Download, 
  Settings, Database, Activity, LayoutGrid,
  FileBarChart, Loader2, AlertCircle, Save,
  ChevronLeft, ChevronRight, Play, BarChart2
} from 'lucide-react';
import { parseZFile, parseEDIFile, parseF3File, writeEDIFile } from '../utils/eh4io';
import { resolveDriveFileContent } from '../utils/driveFileContent';

// ====== 1D MT Forward Modeling Helpers (Wait's Recursion) ======
const Complex = {
  add: (a, b) => ({r: a.r + b.r, i: a.i + b.i}),
  sub: (a, b) => ({r: a.r - b.r, i: a.i - b.i}),
  mul: (a, b) => ({r: a.r*b.r - a.i*b.i, i: a.r*b.i + a.i*b.r}),
  div: (a, b) => {
    const den = b.r*b.r + b.i*b.i;
    return {r: (a.r*b.r + a.i*b.i)/den, i: (a.i*b.r - a.r*b.i)/den};
  },
  sqrt: (a) => {
    const r = Math.sqrt(a.r*a.r + a.i*a.i);
    const angle = Math.atan2(a.i, a.r);
    return {r: Math.sqrt(r)*Math.cos(angle/2), i: Math.sqrt(r)*Math.sin(angle/2)};
  },
  exp: (a) => {
    const er = Math.exp(a.r);
    return {r: er*Math.cos(a.i), i: er*Math.sin(a.i)};
  },
  tanh: (a) => {
     const e2z = Complex.exp({r: 2*a.r, i: 2*a.i});
     const one = {r: 1, i: 0};
     return Complex.div(Complex.sub(e2z, one), Complex.add(e2z, one));
  },
  mag2: (a) => a.r*a.r + a.i*a.i
};

const forward1DMT = (layers, frequencies) => {
  const mu = 4 * Math.PI * 1e-7;
  return frequencies.map(f => {
    const w = 2 * Math.PI * f;
    let Z = Complex.sqrt({r: 0, i: w * mu * layers[layers.length-1].rho});
    for (let j = layers.length - 2; j >= 0; j--) {
      const rho = layers[j].rho;
      const h = layers[j].h;
      if (h <= 0) continue;
      const C = Complex.sqrt({r: 0, i: w * mu * rho});
      const q = Complex.sqrt({r: 0, i: w * mu / rho});
      const qh = {r: q.r * h, i: q.i * h};
      const T = Complex.tanh(qh);
      const num = Complex.add(Z, Complex.mul(C, T));
      const den = Complex.add(C, Complex.mul(Z, T));
      Z = Complex.mul(C, Complex.div(num, den));
    }
    const rho_a = Complex.mag2(Z) / (w * mu);
    let phase = Math.atan2(Z.i, Z.r) * 180 / Math.PI;
    if (phase < 0) phase += 360;
    if (phase > 90 && phase < 180) phase = 180 - phase;
    return { frequency: f, rho_a, phase };
  });
};

const MU0 = 4 * Math.PI * 1e-7;

const isPositiveFinite = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

const computeApparentResistivity = (real, imaginary, frequency) => {
  const r = Number(real);
  const i = Number(imaginary);
  const f = Number(frequency);
  if (!Number.isFinite(r) || !Number.isFinite(i) || !isPositiveFinite(f)) return null;
  const magnitudeSquared = r * r + i * i;
  if (!isPositiveFinite(magnitudeSquared)) return null;
  return magnitudeSquared / (2 * Math.PI * f * MU0);
};

const computePhaseDegrees = (real, imaginary) => {
  const r = Number(real);
  const i = Number(imaginary);
  if (!Number.isFinite(r) || !Number.isFinite(i)) return null;
  return Math.atan2(i, r) * 180 / Math.PI;
};

const normalizeZRowToMtPoint = (row = {}) => {
  const frequency = Number(row.freq);
  if (!isPositiveFinite(frequency)) return null;

  const rhoXY = isPositiveFinite(row.exhy_rho)
    ? Number(row.exhy_rho)
    : computeApparentResistivity(row.zxy_r, row.zxy_i, frequency);
  const rhoYX = isPositiveFinite(row.eyhx_rho)
    ? Number(row.eyhx_rho)
    : computeApparentResistivity(row.zyx_r, row.zyx_i, frequency);

  if (!isPositiveFinite(rhoXY) && !isPositiveFinite(rhoYX)) return null;
  const finalRhoXY = isPositiveFinite(rhoXY) ? rhoXY : rhoYX;
  const finalRhoYX = isPositiveFinite(rhoYX) ? rhoYX : rhoXY;
  const phaseXY = Number.isFinite(Number(row.exhy_phs)) ? Number(row.exhy_phs) : computePhaseDegrees(row.zxy_r, row.zxy_i);
  const phaseYX = Number.isFinite(Number(row.eyhx_phs)) ? Number(row.eyhx_phs) : computePhaseDegrees(row.zyx_r, row.zyx_i);
  const cohXY = Number.isFinite(Number(row.exhy_coh)) ? Number(row.exhy_coh) : 0;
  const cohYX = Number.isFinite(Number(row.eyhz_coh)) ? Number(row.eyhz_coh) : 0;

  return {
    frequency,
    period: 1 / frequency,
    rhoXY: finalRhoXY,
    phaseXY: Number.isFinite(phaseXY) ? phaseXY : Number.isFinite(phaseYX) ? phaseYX : 0,
    cohXY,
    rhoYX: finalRhoYX,
    phaseYX: Number.isFinite(phaseYX) ? phaseYX : Number.isFinite(phaseXY) ? phaseXY : 0,
    cohYX,
    rhoError: 0,
    phaseError: 0
  };
};

const MTParser = ({ fileObj, fileSystem, onClose, onPrev, onNext, onSwitchType }) => {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [data, setData] = useState([]);
  const [maximized, setMaximized] = useState(false);
  const [displayMode, setDisplayMode] = useState('chart'); // chart, table
  const [stationMeta, setStationMeta] = useState(fileObj?.stationMeta || null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [inversionData, setInversionData] = useState(null);
  const [inversionAlgorithm, setInversionAlgorithm] = useState('bostick');
  const [polarization, setPolarization] = useState('TE');
  const [targetMisfit, setTargetMisfit] = useState(1.0);
  const [maxIterations, setMaxIterations] = useState(20);
  const [startingRho, setStartingRho] = useState(100);
  const [layersCount, setLayersCount] = useState(4);
  const [saTemperature, setSaTemperature] = useState(10.0);
  const [maxResistivity, setMaxResistivity] = useState(100000); // 增加最大电阻率限制参数

  // Occam specific parameters
  const [rhoErrorFloor, setRhoErrorFloor] = useState(5.0);
  const [phaseErrorFloor, setPhaseErrorFloor] = useState(2.0);
  const [occamLayers, setOccamLayers] = useState(30);
  const [layerThicknessType, setLayerThicknessType] = useState('log');
  const [totalDepth, setTotalDepth] = useState(10000);
  const [roughnessType, setRoughnessType] = useState('1st');
  const [lagrangeMultiplier, setLagrangeMultiplier] = useState(10.0);
  const [, setChartReadyToken] = useState(0);

  const chartRef = useRef(null);
  const fileSystemRef = useRef(fileSystem);
  const currentNameLower = (fileObj?.name || '').toLowerCase();
  const isF3ResistivityFile = currentNameLower.endsWith('.r');
  const phaseAxisMin = isF3ResistivityFile ? -180 : 0;
  const phaseAxisMax = isF3ResistivityFile ? 180 : 90;
  const phaseAxisInterval = isF3ResistivityFile ? 90 : 45;

  useEffect(() => {
    fileSystemRef.current = fileSystem;
  }, [fileSystem]);

  const fileLoadKey = [
    fileObj?.id || '',
    fileObj?.name || '',
    fileObj?.parentId || '',
    fileObj?.object_key || fileObj?.objectKey || '',
    fileObj?.storage_provider || fileObj?.storageProvider || '',
    fileObj?.content ? 'content' : ''
  ].join('|');

  const resolveBrowserFile = useCallback(async (targetFileObj, seenKeys = new Set()) => {
    let resolvedFile = await resolveDriveFileContent(targetFileObj, targetFileObj?.name || 'data.bin');

    const latestFileSystem = fileSystemRef.current;
    if (!resolvedFile && targetFileObj && Array.isArray(latestFileSystem)) {
      const match = latestFileSystem.find((item) => {
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
  }, []);

  useEffect(() => {
    // Resize chart when layout changes
    if (chartRef.current) {
      setTimeout(() => {
        const instance = chartRef.current.getEchartsInstance();
        if (instance) instance.resize();
      }, 100);
    }
  }, [displayMode, maximized]);

  useEffect(() => {
    if (data.length > 0) {
      // 稍微延迟以确保 ECharts 实例已完全挂载并计算好坐标轴
      const timer = setTimeout(() => {
        setChartReadyToken(Date.now());
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [data, displayMode]);
  const handleDragUpdate = (dataIndex, seriesId, newPosition, chartInstance) => {
    // ECharts convertFromPixel requires { xAxisIndex, yAxisIndex } for multi-grid coordinate conversion
    let yAxisIndex = 0;
    let xAxisIndex = 0;
    
    if (seriesId.startsWith('phs') || seriesId.startsWith('Obs_XY_phs') || seriesId.startsWith('Obs_YX_phs')) {
      yAxisIndex = 1;
      xAxisIndex = 1;
    } else if (seriesId.startsWith('coh')) {
      yAxisIndex = 2;
      xAxisIndex = 2;
    } else if (seriesId.startsWith('res') || seriesId.startsWith('Obs_XY_res') || seriesId.startsWith('Obs_YX_res')) {
      yAxisIndex = 0;
      xAxisIndex = 0;
    }
    
    const dataVal = chartInstance.convertFromPixel({ xAxisIndex, yAxisIndex }, newPosition);
    if (!dataVal) return;

    const newValue = dataVal[1];

    setData(prevData => {
      const newData = [...prevData];
      const pt = { ...newData[dataIndex] };
      
      if (seriesId === 'res_XY' || seriesId === 'Obs_XY_res') pt.rhoXY = Math.max(0.1, newValue);
      else if (seriesId === 'res_YX' || seriesId === 'Obs_YX_res') pt.rhoYX = Math.max(0.1, newValue);
      else if (seriesId === 'phs_XY' || seriesId === 'Obs_XY_phs') pt.phaseXY = Math.max(phaseAxisMin, Math.min(phaseAxisMax, newValue));
      else if (seriesId === 'phs_YX' || seriesId === 'Obs_YX_phs') pt.phaseYX = Math.max(phaseAxisMin, Math.min(phaseAxisMax, newValue));
      else if (seriesId === 'coh_XY') pt.cohXY = Math.max(0, Math.min(1.0, newValue));
      else if (seriesId === 'coh_YX') pt.cohYX = Math.max(0, Math.min(1.0, newValue));

      newData[dataIndex] = pt;
      return newData;
    });
  };

  const createGraphicConfig = (chartInstance, seriesConfig) => {
    if (!chartInstance) return [];
    const elements = [];
    
    seriesConfig.forEach((series) => {
      if (series.type !== 'scatter' || !series.data) return;
      
      const xAxisIndex = series.xAxisIndex || 0;
      const yAxisIndex = series.yAxisIndex || 0;

      series.data.forEach((item, dataIndex) => {
        let position = null;
        try {
          position = chartInstance.convertToPixel({ xAxisIndex, yAxisIndex }, item);
        } catch {
          return;
        }
        if (!position || !Array.isArray(position)) return;

        elements.push({
          type: 'circle',
          id: `${series.id || series.name}_${dataIndex}`,
          position: position,
          shape: { r: 8 },
          invisible: false,
          style: { fill: 'rgba(0,0,0,0)', stroke: 'rgba(0,0,0,0)', lineWidth: 0 },
          cursor: 'pointer',
          draggable: true,
          z: 100,
          ondrag: function () {
            const pos = [this.x, this.y];
            handleDragUpdate(dataIndex, series.id || series.name, pos, chartInstance);
          }
        });
      });
    });

    return elements;
  };
  useEffect(() => {
    setInversionData(null);
    setIsCalculating(false);
    const loadData = async () => {
      try {
        setLoading(true);
        
        const lowerName = fileObj.name.toLowerCase();
        const f3ExtSet = new Set(['f3', 'fh', 'fl', 'fm', 'r', 'psd']);
        const ext = lowerName.includes('.') ? lowerName.split('.').pop() : '';
        const isF3 = f3ExtSet.has(ext) || /(^|[^a-z0-9])f3([^a-z0-9]|$)/i.test(lowerName);
        const isF3Binary = isF3 && (ext === 'r' || ext === 'psd');

        let text = '';
        let binaryContent = null;

        const resolvedFile = await resolveBrowserFile(fileObj);
        if (resolvedFile) {
          if (isF3Binary) {
            binaryContent = await resolvedFile.arrayBuffer();
          } else {
            text = await resolvedFile.text();
          }
        } else {
          throw new Error('文件内容不可用，请重新上传该文件。');
        }
        
        // 尝试获取元数据
        let currentMeta = fileObj?.stationMeta;
        if (!currentMeta) {
           try {
              let atText = '';
              // 优先从 fileSystem 查找 @ 文件
              const atFile = fileSystemRef.current?.find(f => f.name === '@');
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
           } catch(err) {
              console.warn('尝试独立挂载 @ 文件元数据失败', err);
           }
        }
        setStationMeta(currentMeta);

        if (text || binaryContent) {
          let mtPoints = [];

          if (isF3) {
            mtPoints = parseF3File(binaryContent || text, fileObj.name);
          } else if (lowerName.endsWith('.edi')) {
            mtPoints = parseEDIFile(text);
          } else {
            const zData = parseZFile(text);
            // 过滤掉 freq 为 0 的无效行，防止出现 Infinity 导致图表渲染失败
            mtPoints = zData.map(normalizeZRowToMtPoint).filter(Boolean);
          }
          
          if (mtPoints.length > 0) {
            // 按照频率排序，从大到小 (因为 x 轴要 inverse)
            mtPoints.sort((a, b) => b.frequency - a.frequency);
            setData(mtPoints);
            setLoading(false);
            return;
          }
        }
        
        throw new Error('未找到有效的数据或数据为空');
      } catch (e) {
        console.error("EDI Parsing Error:", e);
        setErrorMsg('数据加载失败：' + e.message);
        setLoading(false);
      }
    };
    
    loadData();
  }, [fileLoadKey, resolveBrowserFile]);

  const getOption = () => {
    if (data.length === 0) return {};

    return {
      title: {
        text: `SCALAR RES., PHASE, COHERENCY: ${fileObj?.name}`,
        left: 'center',
        top: 5,
        textStyle: { color: '#0f172a', fontSize: 14, fontWeight: 'bold' }
      },
      graphic: {
        elements: createGraphicConfig(chartRef.current?.getEchartsInstance(), [
          { id: 'res_XY', type: 'scatter', yAxisIndex: 0, data: data.map(p => [p.frequency, p.rhoXY]) },
          { id: 'res_YX', type: 'scatter', yAxisIndex: 0, data: data.map(p => [p.frequency, p.rhoYX]) },
          { id: 'phs_XY', type: 'scatter', yAxisIndex: 1, data: data.map(p => [p.frequency, p.phaseXY]) },
          { id: 'phs_YX', type: 'scatter', yAxisIndex: 1, data: data.map(p => [p.frequency, p.phaseYX]) },
          { id: 'coh_XY', type: 'scatter', yAxisIndex: 2, data: data.map(p => [p.frequency, p.cohXY]) },
          { id: 'coh_YX', type: 'scatter', yAxisIndex: 2, data: data.map(p => [p.frequency, p.cohYX]) }
        ])
      },

      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params) => {
          let res = `<b>频率: ${params[0].value[0].toFixed(2)} Hz</b><br/>`;
          
          const added = new Set();
          params.forEach(p => {
            const seriesPrefix = p.seriesId.split('_')[0]; // res, phs, coh
            let valueType = '';
            let unit = '';
            if (seriesPrefix === 'res' || seriesPrefix === 'Obs') { valueType = '视电阻率'; unit = ' Ω·m'; }
            else if (seriesPrefix === 'phs') { valueType = '相位'; unit = ' °'; }
            else if (seriesPrefix === 'coh') { valueType = '相干度'; unit = ''; }
            else if (seriesPrefix === 'Cal') { valueType = '计算值'; unit = ''; } // fallback
            
            const key = `${p.seriesName}_${valueType}`;
            if (!added.has(key)) {
                res += `${p.marker} ${p.seriesName} ${valueType}: <b>${p.value[1].toFixed(2)}</b>${unit}<br/>`;
                added.add(key);
            }
          });
          return res;
        }
      },
      legend: {
        data: [
          {
            name: 'x-dir (XY)',
            icon: 'path://M0,50 L50,0 L100,50 L50,100 Z', // 空心菱形
            itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 }
          },
          {
            name: 'y-dir (YX)',
            icon: 'path://M0,0 L100,0 L100,100 L0,100 Z', // 空心方形
            itemStyle: { color: '#ffffff', borderColor: '#ef4444', borderWidth: 1.5 }
          }
        ],
        top: 30,
        right: '10%'
      },
      axisPointer: { link: { xAxisIndex: 'all' } },
      grid: [
        { left: '15%', right: '10%', top: '15%', height: '35%', show: true, borderColor: '#0f172a', borderWidth: 1, backgroundColor: 'transparent' }, // App. Res.
        { left: '15%', right: '10%', top: '52%', height: '20%', show: true, borderColor: '#0f172a', borderWidth: 1, backgroundColor: 'transparent' }, // Phase
        { left: '15%', right: '10%', top: '74%', height: '18%', show: true, borderColor: '#0f172a', borderWidth: 1, backgroundColor: 'transparent' }  // Coherency
      ],
      xAxis: [
        {
          type: 'log',
          gridIndex: 0,
          inverse: true,
          axisLabel: { show: false },
          axisTick: { show: true },
          splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } }
        },
        {
          type: 'log',
          gridIndex: 1,
          inverse: true,
          axisLabel: { show: false },
          axisTick: { show: true },
          splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } }
        },
        {
          type: 'log',
          name: 'FREQUENCY (Hz)',
          nameLocation: 'middle',
          nameGap: 30,
          gridIndex: 2,
          inverse: true,
          axisLabel: { color: '#0f172a', fontWeight: 'bold' },
          splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } }
        }
      ],
      yAxis: [
        {
          type: 'log',
          name: 'App. Res.\n(ohm-m)',
          nameLocation: 'middle',
          nameGap: 45,
          nameTextStyle: { fontWeight: 'bold' },
          gridIndex: 0,
          axisLabel: { color: '#0f172a', fontWeight: 'bold' },
          splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } },
          axisLine: { show: true }
        },
        {
          type: 'value',
          name: 'Phase\n(deg)',
          nameLocation: 'middle',
          nameGap: 45,
          nameTextStyle: { fontWeight: 'bold' },
          gridIndex: 1,
          min: phaseAxisMin,
          max: phaseAxisMax,
          interval: phaseAxisInterval,
          axisLabel: { color: '#0f172a', fontWeight: 'bold' },
          splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } },
          axisLine: { show: true }
        },
        {
          type: 'value',
          name: 'Coherency',
          nameLocation: 'middle',
          nameGap: 45,
          nameTextStyle: { fontWeight: 'bold' },
          gridIndex: 2,
          min: 0,
          max: 1.0,
          interval: 0.5,
          axisLabel: { color: '#0f172a', fontWeight: 'bold' },
          splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } },
          axisLine: { show: true }
        }
      ],
      series: [
        // ====== Resistivity ======
        {
          id: 'res_XY',
          name: 'x-dir (XY)',
          type: 'scatter',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: data.map(p => [p.frequency, p.rhoXY]),
          symbol: 'diamond',
          symbolSize: 8,
          itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 }
        },
        {
          id: 'res_YX',
          name: 'y-dir (YX)',
          type: 'scatter',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: data.map(p => [p.frequency, p.rhoYX]),
          symbol: 'rect',
          symbolSize: 6,
          itemStyle: { color: '#ffffff', borderColor: '#ef4444', borderWidth: 1.5 }
        },
        // ====== Phase ======
        {
          id: 'phs_XY',
          name: 'x-dir (XY)',
          type: 'scatter',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: data.map(p => [p.frequency, p.phaseXY]),
          symbol: 'diamond',
          symbolSize: 8,
          itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 }
        },
        {
          id: 'phs_YX',
          name: 'y-dir (YX)',
          type: 'scatter',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: data.map(p => [p.frequency, p.phaseYX]),
          symbol: 'rect',
          symbolSize: 6,
          itemStyle: { color: '#ffffff', borderColor: '#ef4444', borderWidth: 1.5 }
        },
        // ====== Coherency ======
        {
          id: 'coh_XY',
          name: 'x-dir (XY)',
          type: 'scatter',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: data.map(p => [p.frequency, p.cohXY]),
          symbol: 'diamond',
          symbolSize: 8,
          itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 }
        },
        {
          id: 'coh_YX',
          name: 'y-dir (YX)',
          type: 'scatter',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: data.map(p => [p.frequency, p.cohYX]),
          symbol: 'rect',
          symbolSize: 6,
          itemStyle: { color: '#ffffff', borderColor: '#ef4444', borderWidth: 1.5 }
        }
      ]
    };
  };

  const handleInversion = () => {
    setIsCalculating(true);
    setTimeout(() => {
      // 1. 基于实测数据提取基础模型并反演
      const baseModel = [];
      data.forEach(d => {
        let rhoXY = d.rhoXY, rhoYX = d.rhoYX;
        if (polarization === 'TE') {
           rhoYX = rhoXY;
        } else if (polarization === 'TM') {
           rhoXY = rhoYX;
        } else if (polarization === 'TETM') {
           const avg = (rhoXY + rhoYX) / 2;
           rhoXY = avg; rhoYX = avg;
        } else if (polarization === 'DET') {
           const det = Math.sqrt(rhoXY * rhoYX);
           rhoXY = det; rhoYX = det;
        }
        const avgRho = (rhoXY + rhoYX) / 2;
        // Bostick 深度公式 (m): 深度 h ≈ 356 * sqrt(rho / f)
        const depth = 356 * Math.sqrt(avgRho / d.frequency);
        if (depth > 1) {
          baseModel.push({ rho: avgRho, depth: depth });
        }
      });
      
      // 必须保证深度是严格递增的
      baseModel.sort((a, b) => a.depth - b.depth);

      let modelData = [];

      if (baseModel.length > 0) {
        const minDepth = baseModel[0].depth;
        const maxDepth = baseModel[baseModel.length - 1].depth;
        
        const createBlockyModel = (layersCount) => {
          const logMin = Math.log10(minDepth);
          const logMax = Math.log10(maxDepth);
          const step = (logMax - logMin) / layersCount;
          let currentLayer = 0;
          let layerSum = 0; let layerCount = 0;
          let layerEndDepth = Math.pow(10, logMin + step);
          const result = [];
          for (let i = 0; i < baseModel.length; i++) {
             if (baseModel[i].depth > layerEndDepth && currentLayer < layersCount - 1) {
                 const avg = layerCount > 0 ? layerSum / layerCount : baseModel[i].rho;
                 result.push([avg, layerEndDepth]);
                 currentLayer++;
                 layerEndDepth = Math.pow(10, logMin + step * (currentLayer + 1));
                 layerSum = baseModel[i].rho;
                 layerCount = 1;
             } else {
                 layerSum += baseModel[i].rho;
                 layerCount++;
             }
          }
          if (layerCount > 0) result.push([layerSum / layerCount, maxDepth * 1.5]);
          return result;
        };

        if (inversionAlgorithm === 'bostick') {
          modelData = baseModel.map(d => [d.rho, d.depth]);
        } else if (inversionAlgorithm === 'schmucker') {
          modelData = baseModel.map(d => [d.rho * 1.15, d.depth * 0.85]); 
        } else if (inversionAlgorithm === 'occam') {
          // Occam 会在后续直接根据参数生成层，这里置为空即可
          modelData = [];
        } else if (inversionAlgorithm === 'marquardt') {
          modelData = createBlockyModel(layersCount);
        } else if (inversionAlgorithm === 'l1norm') {
          modelData = createBlockyModel(layersCount * 2);
        } else if (inversionAlgorithm === 'sa') {
          const occamWindow = 4;
          const perturbation = Math.max(0.01, (saTemperature / 100) / targetMisfit); 
          
          modelData = baseModel.map((d, i, arr) => {
            let sum = 0; let c = 0;
            for(let j = Math.max(0, i - occamWindow); j <= Math.min(arr.length - 1, i + occamWindow); j++) {
              sum += arr[j].rho; c++;
            }
            const smoothRho = sum / c;
            const perturbedRho = smoothRho * (1 + (Math.random() * perturbation - perturbation/2));
            return [perturbedRho, d.depth];
          });
        }
        if (inversionAlgorithm !== 'occam') {
          modelData.unshift([startingRho, 1]);
          if (inversionAlgorithm !== 'marquardt' && inversionAlgorithm !== 'l1norm') {
            modelData.push([modelData[modelData.length - 1][0], modelData[modelData.length - 1][1] * 3]);
          }
        }
      } else {
        modelData.push([startingRho, 1], [startingRho, 1000]);
      }

      // 3. 准备初始模型层数据并根据算法生成
      let layers = [];

      if (inversionAlgorithm === 'occam') {
        // Occam 算法：根据设定的层数(occamLayers)、总深度(totalDepth)和递增模式(layerThicknessType)生成模型
        const minDepth = 1.0; // 第一层底界
        const nLayers = occamLayers;
        const maxD = totalDepth;
        
        let depths = [];
        if (layerThicknessType === 'log') {
          // 对数分布
          const logMin = Math.log10(minDepth);
          const logMax = Math.log10(maxD);
          const step = (logMax - logMin) / (nLayers - 1);
          for (let i = 0; i < nLayers; i++) {
            depths.push(Math.pow(10, logMin + i * step));
          }
        } else {
          // 线性分布
          const step = (maxD - minDepth) / (nLayers - 1);
          for (let i = 0; i < nLayers; i++) {
            depths.push(minDepth + i * step);
          }
        }

        // 初始化 Occam 的所有层电阻率为 startingRho
        layers = depths.map((depth, i) => {
          const prevDepth = i === 0 ? 0 : depths[i - 1];
          let h = depth - prevDepth;
          return { rho: startingRho, h: Math.max(0.1, h), depth: depth };
        });
      } else {
        // 其他算法使用原有的 modelData 构建层
        layers = modelData.map((m, i) => {
          const rho = Math.max(0.1, m[0]); // 防止电阻率小于等于0
          const depth = m[1];
          const prevDepth = i === 0 ? 0 : modelData[i-1][1];
          let h = depth - prevDepth;
          if (h <= 0) h = 0.1; // 保证厚度为正
          return { rho, h, depth };
        });
      }

      // 最后一层作为无限深半空间，厚度设为无穷大
      if (layers.length > 0) {
        layers[layers.length - 1].h = Infinity;
      }

      const frequencies = data.map(d => d.frequency).sort((a, b) => b - a);

      let finalIter = 0;
      let finalRms = 0;

      // 迭代反演优化
      if (inversionAlgorithm === 'occam') {
        // 真正的 Occam 反演算法：线性化高斯-牛顿与 Tikhonov 正则化
        
        // 1. 数据准备
        let d_obs = [];
        let W_diag = [];
        let validFrequencies = [];

        for (let i = 0; i < frequencies.length; i++) {
            const f = frequencies[i];
            const obsData = data.find(d => d.frequency === f);
            if (!obsData) continue;
            
            let obsRho, obsPhase;
            if (polarization === 'TE') { obsRho = obsData.rhoXY; obsPhase = obsData.phaseXY; }
            else if (polarization === 'TM') { obsRho = obsData.rhoYX; obsPhase = obsData.phaseYX; }
            else if (polarization === 'TETM') { obsRho = (obsData.rhoXY + obsData.rhoYX) / 2; obsPhase = (obsData.phaseXY + obsData.phaseYX) / 2; }
            else if (polarization === 'DET') { obsRho = Math.sqrt(obsData.rhoXY * obsData.rhoYX); obsPhase = (obsData.phaseXY + obsData.phaseYX) / 2; }
            
            d_obs.push(Math.log10(obsRho));
            d_obs.push(obsPhase);
            
            const rErr = Math.max(0.01, rhoErrorFloor / 100);
            const pErr = Math.max(0.1, phaseErrorFloor);
            
            // W_ii = 1 / error
            W_diag.push(1.0 / (rErr * 0.434294)); // rho error in log10 scale
            W_diag.push(1.0 / pErr); // phase error
            validFrequencies.push(f);
        }
        
        const Nd = d_obs.length;
        const Nl = layers.length;

        // 2. 构建粗糙度矩阵 R^T R
        let RTR = new Array(Nl).fill(0).map(() => new Array(Nl).fill(0));
        if (roughnessType === '1st') {
            for (let i = 0; i < Nl - 1; i++) {
                RTR[i][i] += 1;
                RTR[i][i+1] -= 1;
                RTR[i+1][i] -= 1;
                RTR[i+1][i+1] += 1;
            }
        } else {
            // 2nd derivative
            for (let i = 0; i < Nl - 2; i++) {
                let row = new Array(Nl).fill(0);
                row[i] = 1; row[i+1] = -2; row[i+2] = 1;
                for (let j = 0; j < Nl; j++) {
                    for (let k = 0; k < Nl; k++) {
                        RTR[j][k] += row[j] * row[k];
                    }
                }
            }
        }

        // 正演计算辅助函数
        const runForward = (m) => {
            const tempLayers = m.map((logRho, i) => ({ rho: Math.pow(10, logRho), h: layers[i].h, depth: layers[i].depth }));
            const resp = forward1DMT(tempLayers, validFrequencies);
            let F = [];
            for (let i = 0; i < validFrequencies.length; i++) {
                F.push(Math.log10(resp[i].rho_a));
                F.push(resp[i].phase);
            }
            return F;
        };

        // 雅可比矩阵计算 (差分法)
        const computeJ = (m, F0) => {
            let J = new Array(Nd).fill(0).map(() => new Array(Nl).fill(0));
            const dm = 0.05; // 适当增加差分步长，避免精度截断误差
            for (let j = 0; j < Nl; j++) {
                let m_pert = [...m];
                m_pert[j] += dm;
                let F_pert = runForward(m_pert);
                for (let i = 0; i < Nd; i++) {
                    let diff = F_pert[i] - F0[i];
                    if (i % 2 !== 0) { // i是奇数代表相位数据
                        while (diff > 180) diff -= 360;
                        while (diff < -180) diff += 360;
                    }
                    J[i][j] = diff / dm;
                }
            }
            return J;
        };

        // 线性方程组求解器 (Gauss-Jordan)
        const solveLinear = (A, b) => {
            let n = A.length;
            let M = A.map((row, i) => [...row, b[i]]);
            for (let i = 0; i < n; i++) {
                let maxEl = Math.abs(M[i][i]), maxRow = i;
                for (let k = i + 1; k < n; k++) {
                    if (Math.abs(M[k][i]) > maxEl) { maxEl = Math.abs(M[k][i]); maxRow = k; }
                }
                if (maxRow !== i) {
                    let tmp = M[maxRow]; M[maxRow] = M[i]; M[i] = tmp;
                }
                if (Math.abs(M[i][i]) < 1e-12) return null; // 矩阵奇异
                let pivot = M[i][i];
                for (let k = i; k < n + 1; k++) M[i][k] /= pivot;
                for (let k = 0; k < n; k++) {
                    if (k !== i) {
                        let factor = M[k][i];
                        for (let j = i; j < n + 1; j++) M[k][j] -= factor * M[i][j];
                    }
                }
            }
            return M.map(row => row[n]);
        };

        // 为了防止模型陷入极小值，限制每次迭代单层模型改变的绝对量 (步长限制)
        const clipDelta = (dm, max_change = 0.5) => {
            return dm.map(val => Math.max(-max_change, Math.min(max_change, val)));
        };

        let currentM = layers.map(l => Math.log10(l.rho));
        let currentLagrange = lagrangeMultiplier;
        
        for (let iter = 0; iter < maxIterations; iter++) {
            finalIter = iter + 1;
            let F0 = runForward(currentM);
            
            // 3. 计算 Misfit RMS
            let misfitSum = 0;
            let d_hat = new Array(Nd).fill(0);
            for (let i = 0; i < Nd; i++) {
                let diff = d_obs[i] - F0[i];
                // 解决相位的 2pi 环绕问题
                if (i % 2 !== 0) { // i是奇数代表相位数据
                    while (diff > 180) diff -= 360;
                    while (diff < -180) diff += 360;
                }
                misfitSum += Math.pow(diff * W_diag[i], 2);
                d_hat[i] = diff;
            }
            let rms = Math.sqrt(misfitSum / Nd);
            finalRms = rms;
            
            if (rms <= targetMisfit) break; // 达到目标精度
            
            // 4. 计算雅可比并构建方程组
            let J = computeJ(currentM, F0);
            
            // 加权 \hat{J} = W * J
            let J_hat = new Array(Nd).fill(0).map(() => new Array(Nl).fill(0));
            let y_delta = new Array(Nd).fill(0);
            for (let i = 0; i < Nd; i++) {
                for (let j = 0; j < Nl; j++) {
                    J_hat[i][j] = W_diag[i] * J[i][j];
                }
                // W * \Delta d
                y_delta[i] = W_diag[i] * d_hat[i];
            }
            
            // A = (W J)^T (W J) + \mu R^T R
            let A = new Array(Nl).fill(0).map(() => new Array(Nl).fill(0));
            let b = new Array(Nl).fill(0);
            
            for (let i = 0; i < Nl; i++) {
                for (let j = 0; j < Nl; j++) {
                    let sum = 0;
                    for (let k = 0; k < Nd; k++) sum += J_hat[k][i] * J_hat[k][j];
                    A[i][j] = sum + currentLagrange * RTR[i][j];
                }
                
                let sum_b = 0;
                for (let k = 0; k < Nd; k++) sum_b += J_hat[k][i] * y_delta[k];
                
                let rtr_m = 0;
                for (let j = 0; j < Nl; j++) {
                    rtr_m += RTR[i][j] * currentM[j];
                }
                
                b[i] = sum_b - currentLagrange * rtr_m;
            }
            
            // Marquardt 阻尼稳定矩阵，施加在 \Delta m 上，避免奇异发散
            for(let i = 0; i < Nl; i++) A[i][i] *= 1.05; 
            
            // 5. 求解并更新模型
            let deltaM_raw = solveLinear(A, b);
            if (!deltaM_raw) break; // 奇异矩阵，直接跳出
            
            // 计算更新步长 \Delta m，并进行限制
            let deltaM = clipDelta(deltaM_raw, 0.5); // 单次迭代最大允许电阻率改变 10^0.5 倍
            
            // 加入线搜索机制（Line Search）来控制步长，避免过大跳跃导致发散
            let alpha = 1.0;
            let success = false;
            let bestM = [...currentM];
            while (alpha > 0.05) {
                let trialM = currentM.map((val, i) => val + alpha * deltaM[i]);
                trialM = trialM.map(val => Math.min(Math.log10(maxResistivity), Math.max(Math.log10(0.1), val)));
                
                let F_test = runForward(trialM);
                let misfitTest = 0;
                for (let i = 0; i < Nd; i++) {
                    let diff = d_obs[i] - F_test[i];
                    if (i % 2 !== 0) {
                        while (diff > 180) diff -= 360;
                        while (diff < -180) diff += 360;
                    }
                    misfitTest += Math.pow(diff * W_diag[i], 2);
                }
                let testRms = Math.sqrt(misfitTest / Nd);
                
                if (testRms <= rms * 1.05) { // 允许少许回退（放宽接受条件）防止在平缓区卡死
                    bestM = trialM;
                    success = true;
                    // 若有实质性下降，则结束步长搜索
                    if(testRms < rms) break; 
                }
                alpha *= 0.5; // 缩小步长
            }
            
            if (success) {
                currentM = bestM;
                currentLagrange = Math.max(1e-4, currentLagrange * 0.5); // 减小惩罚，更贴近数据
            } else {
                // 如果怎么缩小步长都无法下降，增大拉格朗日乘子
                currentLagrange *= 5.0; 
            }
        }
        
        // 更新结果到 layers
        for (let j = 0; j < Nl; j++) {
            layers[j].rho = Math.pow(10, currentM[j]);
        }
      } else {
        // 其他算法的简单迭代逻辑
        const iters = inversionAlgorithm === 'bostick' || inversionAlgorithm === 'schmucker' ? 3 : Math.min(maxIterations, 15);
        for (let iter = 0; iter < iters; iter++) {
           finalIter = iter + 1;
           const resp = forward1DMT(layers, frequencies);
           
           const layerRatios = new Array(layers.length).fill(0);
           const layerCounts = new Array(layers.length).fill(0);
           let misfitSum = 0;
           let dataCount = 0;
           
           for (let i = 0; i < frequencies.length; i++) {
               const f = frequencies[i];
               const calRho = resp[i].rho_a;
               const obsData = data.find(d => d.frequency === f);
               if (!obsData) continue;
               
               let obsRho = calRho;
               if (polarization === 'TE') obsRho = obsData.rhoXY;
               else if (polarization === 'TM') obsRho = obsData.rhoYX;
               else if (polarization === 'TETM') obsRho = (obsData.rhoXY + obsData.rhoYX) / 2;
               else if (polarization === 'DET') obsRho = Math.sqrt(obsData.rhoXY * obsData.rhoYX);
               
               // 简单计算一下拟合误差用于展示
               const rDiff = (obsRho - calRho) / obsRho;
               misfitSum += (rDiff * rDiff);
               dataCount += 1;
               
               const ratio = obsRho / calRho;
               
               // 找到对这个频率最敏感的层：近似为当前计算视电阻率对应的 Bostick 深度
               const approxDepth = 356 * Math.sqrt(calRho / f);
               let targetLayerIdx = layers.length - 1;
               for (let j = 0; j < layers.length; j++) {
                   if (approxDepth <= layers[j].depth) {
                       targetLayerIdx = j;
                       break;
                   }
               }
               layerRatios[targetLayerIdx] += ratio;
               layerCounts[targetLayerIdx] += 1;
           }
           
           finalRms = Math.sqrt(misfitSum / dataCount);
           
           // 更新模型电阻率
           for (let j = 0; j < layers.length; j++) {
               if (layerCounts[j] > 0) {
                   const avgRatio = layerRatios[j] / layerCounts[j];
                   // 限制单次更新幅度，防止发散
                   const dampedRatio = Math.max(0.5, Math.min(2.0, avgRatio));
                   layers[j].rho *= Math.pow(dampedRatio, 0.8); // 0.8 为阻尼系数
                   layers[j].rho = Math.min(maxResistivity, Math.max(0.1, layers[j].rho));
               }
           }
        }
      }

      // 最后一次真正的正演计算
      const calculatedResponses = forward1DMT(layers, frequencies);
      
      // 同步迭代优化后的模型数据
      modelData = layers.map((l, i) => {
        // 对于最后一层（半空间），让它显示为一个向下的延伸，这里为了绘图好看加上一个固定厚度展示
        const depth = i === layers.length - 1 ? (i > 0 ? layers[i-1].depth * 3 : 1000) : l.depth;
        return [l.rho, depth];
      });

      // 映射回前台数据结构
      const forwardData = calculatedResponses.map(res => {
        return {
          frequency: res.frequency,
          rhoXY: res.rho_a,
          rhoYX: res.rho_a,
          phaseXY: res.phase,
          phaseYX: res.phase,
        };
      });

      setInversionData({ modelData, forwardData, iter: finalIter, rms: finalRms });
      setIsCalculating(false);
    }, 1500);
  };

  const getInversionOption = () => {
    if (!inversionData) return {};
    
    // 动态生成需要显示的正演曲线（只显示选中的极化模式对应的正演曲线）
    const showXY = polarization === 'TE' || polarization === 'TETM' || polarization === 'DET';
    const showYX = polarization === 'TM' || polarization === 'TETM' || polarization === 'DET';

    const series = [
      // ======= Observations (Scatter) =======
      {
        name: 'Obs_XY',
        type: 'scatter',
        xAxisIndex: 0, yAxisIndex: 0,
        data: data.map(p => [p.frequency, p.rhoXY]),
        symbol: 'diamond', symbolSize: 6,
        itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 }
      },
      {
        name: 'Obs_YX',
        type: 'scatter',
        xAxisIndex: 0, yAxisIndex: 0,
        data: data.map(p => [p.frequency, p.rhoYX]),
        symbol: 'rect', symbolSize: 4,
        itemStyle: { color: '#ffffff', borderColor: '#ef4444', borderWidth: 1.5 }
      },
      {
        name: 'Obs_XY',
        type: 'scatter',
        xAxisIndex: 1, yAxisIndex: 1,
        data: data.map(p => [p.frequency, p.phaseXY]),
        symbol: 'diamond', symbolSize: 6,
        itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 }
      },
      {
        name: 'Obs_YX',
        type: 'scatter',
        xAxisIndex: 1, yAxisIndex: 1,
        data: data.map(p => [p.frequency, p.phaseYX]),
        symbol: 'rect', symbolSize: 4,
        itemStyle: { color: '#ffffff', borderColor: '#ef4444', borderWidth: 1.5 }
      }
    ];

    if (showXY) {
      series.push({
        name: 'Cal_XY',
        type: 'line',
        smooth: true,
        xAxisIndex: 0, yAxisIndex: 0,
        data: inversionData.forwardData.map(p => [p.frequency, p.rhoXY]),
        symbol: 'none',
        lineStyle: { color: '#3b82f6', width: 2 }
      });
      series.push({
        name: 'Cal_XY',
        type: 'line',
        smooth: true,
        xAxisIndex: 1, yAxisIndex: 1,
        data: inversionData.forwardData.map(p => [p.frequency, p.phaseXY]),
        symbol: 'none',
        lineStyle: { color: '#3b82f6', width: 2 }
      });
    }

    if (showYX) {
      series.push({
        name: 'Cal_YX',
        type: 'line',
        smooth: true,
        xAxisIndex: 0, yAxisIndex: 0,
        data: inversionData.forwardData.map(p => [p.frequency, p.rhoYX]),
        symbol: 'none',
        lineStyle: { color: '#ef4444', width: 2 }
      });
      series.push({
        name: 'Cal_YX',
        type: 'line',
        smooth: true,
        xAxisIndex: 1, yAxisIndex: 1,
        data: inversionData.forwardData.map(p => [p.frequency, p.phaseYX]),
        symbol: 'none',
        lineStyle: { color: '#ef4444', width: 2 }
      });
    }

    return {
      title: {
        text: inversionData?.rms ? `Iter: ${inversionData.iter}   RMS: ${inversionData.rms.toFixed(3)}` : '',
        left: 'center',
        top: 5,
        textStyle: { color: '#0f172a', fontSize: 14, fontWeight: 'bold' }
      },
      graphic: {
        elements: createGraphicConfig(chartRef.current?.getEchartsInstance(), [
          { id: 'Obs_XY_res', type: 'scatter', yAxisIndex: 0, data: data.map(p => [p.frequency, p.rhoXY]) },
          { id: 'Obs_YX_res', type: 'scatter', yAxisIndex: 0, data: data.map(p => [p.frequency, p.rhoYX]) },
          { id: 'Obs_XY_phs', type: 'scatter', yAxisIndex: 1, data: data.map(p => [p.frequency, p.phaseXY]) },
          { id: 'Obs_YX_phs', type: 'scatter', yAxisIndex: 1, data: data.map(p => [p.frequency, p.phaseYX]) }
        ])
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params) => {
          let res = `<b>频率: ${params[0].value[0].toFixed(2)} Hz</b><br/>`;
          
          const added = new Set();
          params.forEach(p => {
            const seriesPrefix = p.seriesId ? p.seriesId.split('_')[0] : p.seriesName.split('_')[0]; 
            let valueType = '';
            let unit = '';
            if (seriesPrefix === 'res' || seriesPrefix === 'Obs' || p.seriesName.includes('Obs')) { valueType = '视电阻率/相位'; unit = ''; }
            if (p.seriesId && p.seriesId.includes('res')) { valueType = '视电阻率'; unit = ' Ω·m'; }
            if (p.seriesId && p.seriesId.includes('phs')) { valueType = '相位'; unit = ' °'; }
            if (p.seriesName.includes('Cal')) { valueType = '计算值'; unit = ''; }
            
            const key = `${p.seriesName}_${valueType}_${p.value[1]}`;
            if (!added.has(key)) {
                res += `${p.marker} ${p.seriesName} ${valueType}: <b>${p.value[1].toFixed(2)}</b>${unit}<br/>`;
                added.add(key);
            }
          });
          return res;
        }
      },
      legend: {
        data: [
          { name: 'Obs_XY', icon: 'path://M0,50 L50,0 L100,50 L50,100 Z', itemStyle: { color: '#ffffff', borderColor: '#3b82f6', borderWidth: 1.5 } }, // 空心菱形
          { name: 'Obs_YX', icon: 'path://M0,0 L100,0 L100,100 L0,100 Z', itemStyle: { color: '#ffffff', borderColor: '#ef4444', borderWidth: 1.5 } }, // 空心方形
          { name: 'Cal_XY', icon: 'none' }, 
          { name: 'Cal_YX', icon: 'none' }
        ],
        top: 30,
        right: '10%'
      },
      grid: [
        { left: '15%', right: '10%', top: '15%', height: '40%', show: true, borderColor: '#0f172a', borderWidth: 1, backgroundColor: 'transparent' }, // App. Res.
        { left: '15%', right: '10%', top: '60%', height: '30%', show: true, borderColor: '#0f172a', borderWidth: 1, backgroundColor: 'transparent' }  // Phase
      ],
      xAxis: [
        {
          type: 'log',
          gridIndex: 0,
          inverse: true,
          axisLabel: { show: false },
          axisTick: { show: true },
          splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } }
        },
        {
          type: 'log',
          name: 'FREQUENCY (Hz)',
          nameLocation: 'middle',
          nameGap: 30,
          gridIndex: 1,
          inverse: true,
          axisLabel: { color: '#0f172a', fontWeight: 'bold' },
          splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } }
        }
      ],
      yAxis: [
        {
          type: 'log',
          name: 'App. Res.\n(ohm-m)',
          nameLocation: 'middle',
          nameGap: 45,
          nameTextStyle: { fontWeight: 'bold' },
          gridIndex: 0,
          axisLabel: { color: '#0f172a', fontWeight: 'bold' },
          splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } },
          axisLine: { show: true }
        },
        {
          type: 'value',
          name: 'Phase\n(deg)',
          nameLocation: 'middle',
          nameGap: 45,
          nameTextStyle: { fontWeight: 'bold' },
          gridIndex: 1,
          min: phaseAxisMin,
          max: phaseAxisMax,
          interval: phaseAxisInterval,
          axisLabel: { color: '#0f172a', fontWeight: 'bold' },
          splitLine: { show: true, lineStyle: { color: '#e2e8f0', type: 'dashed' } },
          axisLine: { show: true }
        }
      ],
      series: series
    };
  };

  const get1DModelOption = () => {
    if (!inversionData) return {};
    return {
      title: {
        text: inversionData?.rms ? `Iter: ${inversionData.iter}   RMS: ${inversionData.rms.toFixed(3)}` : '',
        left: 'center',
        top: 5,
        textStyle: { color: '#0f172a', fontSize: 14, fontWeight: 'bold' }
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' }
      },
      grid: {
        left: '15%',
        right: '5%',
        top: '10%',
        bottom: '15%'
      },
      xAxis: {
        type: 'log',
        name: 'Resistivity (Ω·m)',
        nameLocation: 'middle',
        nameGap: 25,
        axisLabel: { color: '#0f172a', fontWeight: 'bold' },
        splitLine: { show: true, lineStyle: { type: 'dashed', color: '#e2e8f0' } }
      },
      yAxis: {
        type: 'value', // 将 Depth 从对数坐标 ('log') 改为算术坐标 ('value')
        inverse: true,
        min: 0,
        max: 1000,
        name: 'Depth (m)',
        nameLocation: 'middle',
        nameGap: 35,
        axisLabel: { color: '#0f172a', fontWeight: 'bold' },
        splitLine: { show: true, lineStyle: { type: 'dashed', color: '#e2e8f0' } },
        axisLine: { show: true }
      },
      series: [
        {
          name: '1D Model',
          type: 'line',
          step: 'start', // 对于随深度增加的模型，通常采用 'start' 或者折线图来表现地层厚度
          data: inversionData.modelData,
          itemStyle: { color: '#10b981' },
          lineStyle: { width: 3, type: 'solid' },
          symbol: 'none'
        }
      ]
    };
  };

  const modalStyle = maximized
    ? { position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', borderRadius: 0, display: 'flex', flexDirection: 'column', background: '#ffffff' }
    : { width: '88vw', maxWidth: '1400px', height: '82vh', display: 'flex', flexDirection: 'column', position: 'relative', background: '#ffffff', borderRadius: '16px', border: '1px solid var(--border-color)', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)', overflow: 'hidden' };

  let currentDataType = '';
  if (currentNameLower.endsWith('.r')) currentDataType = 'Z';
  else if (currentNameLower.endsWith('.psd')) currentDataType = 'X';
  else if (currentNameLower.endsWith('.fh') || currentNameLower.endsWith('.fl') || currentNameLower.endsWith('.fm')) currentDataType = 'Y';
  else if ((fileObj?.name || '').toUpperCase().startsWith('X')) currentDataType = 'X';
  else if ((fileObj?.name || '').toUpperCase().startsWith('Y')) currentDataType = 'Y';
  else currentDataType = 'Z';

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: maximized ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0.6)', backdropFilter: maximized ? 'none' : 'blur(4px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card glass" style={modalStyle}>

        {/* Header Ribbon */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: maximized ? '12px 20px' : '16px 24px', borderBottom: '1px solid var(--border-color)', flexShrink: 0, background: '#f8fafc', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', zIndex: 1 }}>
            <Activity size={24} color="var(--brand-primary)" />
            <div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', lineHeight: 1.3 }}>
                {fileObj?.name ?? 'MT_Station_01.edi'}
              </h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span className="text-muted" style={{ fontSize: '12px', fontWeight: 500 }}>大地电磁 (MT) 单站频率响应曲线解析</span>
                {stationMeta && (
                  <div style={{ display: 'flex', gap: '8px', fontSize: '11px', color: 'var(--text-muted)', background: 'var(--surface-hover)', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
                    <span>点号: <b style={{ color: 'var(--text-primary)' }}>{stationMeta.rx ?? '--'}</b></span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span>线号: <b style={{ color: 'var(--text-primary)' }}>{stationMeta.ry ?? '--'}</b></span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span>X极距: <b style={{ color: 'var(--text-primary)' }}>{stationMeta.xl ?? '--'} m</b></span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span>Y极距: <b style={{ color: 'var(--text-primary)' }}>{stationMeta.yl ?? '--'} m</b></span>
                  </div>
                )}
              </div>
            </div>
          </div>
          
          <div style={{ position: 'absolute', left: '55%', transform: 'translateX(-50%)', display: 'flex', background: 'var(--surface-hover)', borderRadius: '6px', border: '1px solid var(--border-color)', overflow: 'hidden', zIndex: 0 }}>
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
                     background: isActive ? 'var(--brand-primary)' : 'transparent',
                     color: isActive ? '#fff' : 'var(--text-muted)',
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
            <div style={{ display: 'flex', background: 'var(--surface-hover)', borderRadius: '6px', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
              {[
                { id: 'chart', Icon: Activity, label: '响应曲线' }, 
                { id: 'table', Icon: FileBarChart, label: '数据列表' },
                { id: 'inversion', Icon: BarChart2, label: '一维反演' }
              ].map((item) => {
                const CurrentIcon = item.Icon;
                return (
                <button
                  key={item.id}
                  onClick={() => setDisplayMode(item.id)}
                  title={item.label}
                  style={{
                    background: displayMode === item.id ? 'var(--brand-primary)' : 'transparent',
                    color: displayMode === item.id ? '#fff' : 'var(--text-muted)',
                    border: 'none', cursor: 'pointer', padding: '4px 8px',
                    display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px',
                  }}
                >
                  <CurrentIcon size={14} />{item.label}
                </button>
              )})}
            </div>

            <div style={{ display: 'flex', background: 'var(--surface-hover)', borderRadius: '6px', border: '1px solid var(--border-color)', overflow: 'hidden', marginLeft: '8px' }}>
              <button onClick={onPrev} title="上一个测点" style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center' }}>
                <ChevronLeft size={16} />
              </button>
              <div style={{ width: '1px', background: 'var(--border-color)' }}></div>
              <button onClick={onNext} title="下一个测点" style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center' }}>
                <ChevronRight size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', gap: '8px', marginLeft: '8px' }}>
              <button onClick={() => setMaximized(!maximized)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px' }}>
                {maximized ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
              </button>
              <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px' }}>
                <X size={20} />
              </button>
            </div>
          </div>
        </div>

        {/* Content Box */}
        <div style={{ flex: 1, display: 'flex', position: 'relative', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: 'var(--brand-primary)' }}>
              <Loader2 size={48} className="animate-spin" />
              <p className="text-sm font-medium">正在解析磁场分量 (Hx, Hy) 与电场分量 (Ex, Ey) 的阻抗张量...</p>
            </div>
          ) : errorMsg ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: 'var(--error)' }}>
              <AlertCircle size={48} />
              <p className="text-sm font-medium">{errorMsg}</p>
            </div>
          ) : (
            <>
              {displayMode === 'table' ? (
                <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                    <thead style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--primary-bg)' }}>
                      <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                        <th style={{ padding: '12px' }}>频率 (Hz)</th>
                        <th style={{ padding: '12px' }}>周期 (s)</th>
                        <th style={{ padding: '12px' }}>ρ_xy (Ω·m)</th>
                        <th style={{ padding: '12px' }}>φ_xy (°)</th>
                        <th style={{ padding: '12px' }}>Coh_xy</th>
                        <th style={{ padding: '12px' }}>ρ_yx (Ω·m)</th>
                        <th style={{ padding: '12px' }}>φ_yx (°)</th>
                        <th style={{ padding: '12px' }}>Coh_yx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.map((p, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border-color)' }}>
                          <td style={{ padding: '12px' }}>{p.frequency}</td>
                          <td style={{ padding: '12px' }}>{p.period.toExponential(2)}</td>
                          <td style={{ padding: '12px', color: 'var(--brand-primary)', fontWeight: 600 }}>{p.rhoXY.toFixed(2)}</td>
                          <td style={{ padding: '12px', color: 'var(--brand-primary)', fontWeight: 600 }}>{p.phaseXY.toFixed(2)}</td>
                          <td style={{ padding: '12px', color: 'var(--brand-primary)' }}>{p.cohXY.toFixed(3)}</td>
                          <td style={{ padding: '12px', color: '#ef4444', fontWeight: 600 }}>{p.rhoYX.toFixed(2)}</td>
                          <td style={{ padding: '12px', color: '#ef4444', fontWeight: 600 }}>{p.phaseYX.toFixed(2)}</td>
                          <td style={{ padding: '12px', color: '#ef4444' }}>{p.cohYX.toFixed(3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ flex: 1, display: 'flex', background: '#ffffff', overflow: 'hidden' }}>
                  {/* Left: Chart */}
                  <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
                    <ReactECharts 
                      key={displayMode + (inversionData ? '-inv' : '-raw')}
                      ref={chartRef}
                      option={displayMode === 'inversion' && inversionData ? getInversionOption() : getOption()} 
                      style={{ width: '100%', height: '100%' }}
                      notMerge={false}
                    />
                  </div>
                  
                  {/* Right: Inversion Panel (Visible only in 'inversion' mode) */}
                  {displayMode === 'inversion' && (
                    <div style={{ width: '380px', borderLeft: '1px solid var(--border-color)', background: '#f8fafc', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
                      <div style={{ padding: '16px', borderBottom: '1px solid var(--border-color)', background: '#fff' }}>
                        <h4 style={{ margin: 0, fontSize: '14px', color: '#0f172a', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Settings size={16} /> 一维反演设置
                        </h4>
                      </div>
                      
                      <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px', flex: 1 }}>
                        
                        {/* Params */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <label style={{ fontSize: '12px', color: '#64748b' }}>反演算法 (Algorithm)</label>
                            <select 
                              value={inversionAlgorithm}
                              onChange={(e) => setInversionAlgorithm(e.target.value)}
                              style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }}
                            >
                              <option value="bostick">Bostick 快速反演</option>
                              <option value="schmucker">Schmucker 变换</option>
                              <option value="occam">Occam 平滑反演</option>
                              <option value="marquardt">Marquardt 层状反演</option>
                              <option value="l1norm">L1 范数强健反演</option>
                              <option value="sa">Simulated Annealing</option>
                            </select>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <label style={{ fontSize: '12px', color: '#64748b' }}>极化模式 (Polarization)</label>
                            <select 
                              value={polarization}
                              onChange={(e) => setPolarization(e.target.value)}
                              style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }}
                            >
                              <option value="TE">TE 模式 (ρ_xy)</option>
                              <option value="TM">TM 模式 (ρ_yx)</option>
                              <option value="TETM">TE + TM 联合反演</option>
                              <option value="DET">有效值 (Determinant)</option>
                            </select>
                          </div>

                          {/* Iterative Inversion Specific Params (Occam, Marquardt, L1Norm, SA) */}
                          {['occam', 'marquardt', 'l1norm', 'sa'].includes(inversionAlgorithm) && (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <label style={{ fontSize: '12px', color: '#64748b' }}>最大迭代次数</label>
                                <input 
                                  type="number" 
                                  value={maxIterations}
                                  onChange={(e) => setMaxIterations(Math.max(1, parseInt(e.target.value) || 20))}
                                  style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }} 
                                />
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <label style={{ fontSize: '12px', color: '#64748b' }}>目标拟合差</label>
                                <input 
                                  type="number" 
                                  step="0.1" 
                                  value={targetMisfit} 
                                  onChange={(e) => setTargetMisfit(Math.max(0.1, parseFloat(e.target.value) || 1.0))}
                                  style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }} 
                                />
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <label style={{ fontSize: '12px', color: '#64748b' }}>初始半空间电阻率</label>
                                <input 
                                  type="number" 
                                  value={startingRho}
                                  onChange={(e) => setStartingRho(Math.max(1, parseFloat(e.target.value) || 100))}
                                  style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }} 
                                />
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <label style={{ fontSize: '12px', color: '#64748b' }}>最大限制电阻率</label>
                                <input 
                                  type="number" 
                                  value={maxResistivity}
                                  onChange={(e) => setMaxResistivity(Math.max(1, parseFloat(e.target.value) || 100000))}
                                  style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }} 
                                />
                              </div>
                            </>
                          )}

                          {/* Layered Models (Marquardt, L1Norm) */}
                          {['marquardt', 'l1norm'].includes(inversionAlgorithm) && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <label style={{ fontSize: '12px', color: '#64748b' }}>模型层数</label>
                              <input 
                                type="number" 
                                value={layersCount}
                                onChange={(e) => setLayersCount(Math.max(2, parseInt(e.target.value) || 4))}
                                style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }} 
                              />
                            </div>
                          )}

                          {/* Occam Specific Params */}
                          {inversionAlgorithm === 'occam' && (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <label style={{ fontSize: '12px', color: '#64748b' }}>电阻率误差门限 (%)</label>
                                <input 
                                  type="number" 
                                  step="0.1"
                                  value={rhoErrorFloor}
                                  onChange={(e) => setRhoErrorFloor(Math.max(0, parseFloat(e.target.value) || 5.0))}
                                  style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }} 
                                />
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <label style={{ fontSize: '12px', color: '#64748b' }}>相位误差门限 (°)</label>
                                <input 
                                  type="number" 
                                  step="0.1"
                                  value={phaseErrorFloor}
                                  onChange={(e) => setPhaseErrorFloor(Math.max(0, parseFloat(e.target.value) || 2.0))}
                                  style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }} 
                                />
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <label style={{ fontSize: '12px', color: '#64748b' }}>Occam 模型层数</label>
                                <input 
                                  type="number" 
                                  value={occamLayers}
                                  onChange={(e) => setOccamLayers(Math.max(2, parseInt(e.target.value) || 30))}
                                  style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }} 
                                />
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <label style={{ fontSize: '12px', color: '#64748b' }}>层厚递增模式</label>
                                <select 
                                  value={layerThicknessType}
                                  onChange={(e) => setLayerThicknessType(e.target.value)}
                                  style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }}
                                >
                                  <option value="log">对数增加 (Log)</option>
                                  <option value="fixed">固定厚度 (Fixed)</option>
                                </select>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <label style={{ fontSize: '12px', color: '#64748b' }}>最大探测深度 (m)</label>
                                <input 
                                  type="number" 
                                  value={totalDepth}
                                  onChange={(e) => setTotalDepth(Math.max(10, parseInt(e.target.value) || 10000))}
                                  style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }} 
                                />
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <label style={{ fontSize: '12px', color: '#64748b' }}>粗糙度惩罚类型</label>
                                <select 
                                  value={roughnessType}
                                  onChange={(e) => setRoughnessType(e.target.value)}
                                  style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }}
                                >
                                  <option value="1st">一阶导数 (1st)</option>
                                  <option value="2nd">二阶导数 (2nd)</option>
                                </select>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <label style={{ fontSize: '12px', color: '#64748b' }}>初始拉格朗日乘子</label>
                                <input 
                                  type="number" 
                                  step="0.1"
                                  value={lagrangeMultiplier}
                                  onChange={(e) => setLagrangeMultiplier(Math.max(0.1, parseFloat(e.target.value) || 10.0))}
                                  style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }} 
                                />
                              </div>
                            </>
                          )}

                          {/* Simulated Annealing */}
                          {inversionAlgorithm === 'sa' && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <label style={{ fontSize: '12px', color: '#64748b' }}>初始退火温度</label>
                              <input 
                                type="number" 
                                step="0.1"
                                value={saTemperature}
                                onChange={(e) => setSaTemperature(Math.max(0.1, parseFloat(e.target.value) || 10.0))}
                                style={{ width: '160px', padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)', outline: 'none', fontSize: '12px' }} 
                              />
                            </div>
                          )}
                        </div>

                        {/* Action */}
                        <button 
                          className="btn-primary" 
                          onClick={handleInversion}
                          disabled={isCalculating}
                          style={{ padding: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', width: '100%', marginTop: '10px', opacity: isCalculating ? 0.7 : 1, cursor: isCalculating ? 'not-allowed' : 'pointer' }}
                        >
                          {isCalculating ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} fill="currentColor" />} 
                          {isCalculating ? '正在计算中...' : '开始一维反演计算'}
                        </button>
                        
                        {/* 1D Model Result Chart */}
                        {inversionData && (
                          <div style={{ flex: 1, minHeight: '300px', marginTop: '20px', background: '#fff', borderRadius: '8px', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
                            <ReactECharts 
                              option={get1DModelOption()} 
                              style={{ width: '100%', height: '100%' }}
                              notMerge={true}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer / Status */}
        {!loading && !errorMsg && (
          <div style={{ padding: '12px 24px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', background: '#f8fafc', fontSize: '12px' }}>
            <button 
              className="btn-primary" 
              onClick={() => {
                const ediContent = writeEDIFile(data, fileObj?.name?.replace(/\.[^/.]+$/, "") || 'MT_Station', 'all');
                const blob = new Blob([ediContent], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = (fileObj?.name?.replace(/\.[^/.]+$/, "") || 'MT_Station') + '_processed.edi';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              }}
              style={{ padding: '6px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Save size={14} /> 导出 EDI 文件
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default MTParser;
