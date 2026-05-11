import React, { useEffect, useState, useMemo, useRef } from 'react';
import ReactECharts from './LazyECharts';
import * as XLSX from 'xlsx';
import proj4 from 'proj4';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { parseAtFile, parseZFile, parseXFile, writeEDIFile } from '../utils/eh4io';
import { Map, List, Layers, X, Loader2, Maximize2, Minimize2, FileText, Upload, Settings, Save, Trash2, Info, Download } from 'lucide-react';
import MTParser from './MTParser';
import XParser from './XParser';
import YParser from './YParser';
import { resolveDriveFileContent } from '../utils/driveFileContent';
import { buildAdminEmap1SimpegLine } from '../services/adminEmap1Api';
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { confirmDialog } from '../utils/message';

// 解决 leaflet 默认图标不显示的问题
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const normalizeLookupText = (value = '') => String(value ?? '').trim().toLowerCase();

const extractFileNameFromPath = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.split(/[\\/]/).filter(Boolean).pop() || text;
};

const isEh4FileOfType = (name = '', type = 'Z') => {
  const normalized = String(name || '').trim().toLowerCase();
  if (type === 'Z') return /^z/i.test(normalized) || /\.(edi|mt)$/i.test(normalized);
  if (type === 'X') return /^x/i.test(normalized) || /\.psd$/i.test(normalized);
  if (type === 'Y') return /^y/i.test(normalized) || /\.(fh|fm|fl)$/i.test(normalized);
  return false;
};

const EH4ProjectViewer = ({ fileObj, fileSystem, selectedProject, onUpdateFileSystem, onClose }) => {
  const [stations, setStations] = useState([]);
  const [designCoordLookup, setDesignCoordLookup] = useState({});
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState(null);
  const [maximized, setMaximized] = useState(false);
  const [viewMode, setViewMode] = useState('map'); // 'map' | 'table'
  const [previewFile, setPreviewFile] = useState(null);
  const [parsingZFile, setParsingZFile] = useState(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [simpegRunning, setSimpegRunning] = useState(false);
  const [simpegResult, setSimpegResult] = useState(null);
  const [simpegProcess, setSimpegProcess] = useState([]);
  const fileInputRef = useRef(null);

  const [showCoordDialog, setShowCoordDialog] = useState(false);
  const [coordParams, setCoordParams] = useState({
    coordType: 'lonlat', // 'lonlat' 或 'CGCS2000'
    lonlatFormat: 'degree', // 'degree' (度), 'degree_minute' (度分), 'dms' (度分秒)
    centralMeridian: 102,
    falseEasting: 500000,
    falseNorthing: 0,
    scale: 1,
    latOrigin: 0
  });

  const currentFolderFiles = useMemo(() => {
    const folderId = fileObj?.parentId ?? null;
    return (fileSystem || []).filter(item => {
      if (item.type !== 'file') return false;
      if (folderId !== null && item.parentId !== folderId) return false;
      return true;
    });
  }, [fileObj, fileSystem]);

  const designCoordFile = useMemo(() => {
    return currentFolderFiles.find(item => /设计坐标/.test(item.name || '') && /\.(xlsx|xls)$/i.test(item.name || '')) || null;
  }, [currentFolderFiles]);

  const designCoordParamFile = useMemo(() => {
    if (!designCoordFile?.name) return null;
    const sidecarName = `${designCoordFile.name}.coord_params.json`.toLowerCase();
    return currentFolderFiles.find(item => (item.name || '').toLowerCase() === sidecarName) || null;
  }, [currentFolderFiles, designCoordFile]);

  const makeCoordKey = (line, point) => `${String(line ?? '').trim().toLowerCase()}__${String(point ?? '').trim().toLowerCase()}`;

  useEffect(() => {
    const loadDesignCoords = async () => {
      if (!designCoordFile || !designCoordParamFile) {
        setDesignCoordLookup({});
        return;
      }
      try {
        const coordParamSource = await resolveDriveFileContent(designCoordParamFile, designCoordParamFile.name || 'coord_params.json');
        const designCoordSource = await resolveDriveFileContent(designCoordFile, designCoordFile.name || 'design.xlsx');
        if (!coordParamSource || !designCoordSource) {
          setDesignCoordLookup({});
          return;
        }
        const parsedConfig = JSON.parse(await coordParamSource.text());
        const designParams = parsedConfig?.coordParams;
        if (!designParams || typeof designParams !== 'object') {
          setDesignCoordLookup({});
          return;
        }
        const buffer = await designCoordSource.arrayBuffer();
        const workbook = XLSX.read(buffer);
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        const projString = `+proj=tmerc +lat_0=${designParams.latOrigin ?? 0} +lon_0=${designParams.centralMeridian ?? 102} +k=${designParams.scale ?? 1} +x_0=${designParams.falseEasting ?? 500000} +y_0=${designParams.falseNorthing ?? 0} +ellps=GRS80 +units=m +no_defs`;
        const nextLookup = {};
        rows.forEach((row, idx) => {
          if (!Array.isArray(row) || row.length < 5) return;
          if (idx === 0 && typeof row[0] === 'string' && (isNaN(parseFloat(row[0])) || isNaN(parseFloat(row[1])))) return;
          const line = row[0];
          const point = row[1];
          const x = row[2];
          const y = row[3];
          const z = parseFloat(row[4]);
          let lon = NaN;
          let lat = NaN;
          if (designParams.coordType === 'CGCS2000') {
            const px = Number.parseFloat(x);
            const py = Number.parseFloat(y);
            if (Number.isFinite(px) && Number.isFinite(py)) {
              [lon, lat] = proj4(projString, 'WGS84', [px, py]);
            }
          } else {
            lon = parseLonLat(x, designParams.lonlatFormat || 'degree');
            lat = parseLonLat(y, designParams.lonlatFormat || 'degree');
          }
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
          nextLookup[makeCoordKey(line, point)] = {
            line: Number.parseFloat(line),
            point: Number.parseFloat(point),
            designLongitude: lon,
            designLatitude: lat,
            designElevation: Number.isFinite(z) ? z : null,
            designX: x,
            designY: y
          };
        });
        setDesignCoordLookup(nextLookup);
      } catch {
        setDesignCoordLookup({});
      }
    };
    loadDesignCoords();
  }, [designCoordFile?.id, designCoordFile?.object_key, designCoordFile?.objectKey, designCoordParamFile?.id, designCoordParamFile?.object_key, designCoordParamFile?.objectKey]);

  const enrichedStations = useMemo(() => {
    return stations.map((s) => {
      const designCoords = designCoordLookup[makeCoordKey(s.y, s.x)] || null;
      const hasMeasuredCoords = Number.isFinite(Number(s.lon)) && Number.isFinite(Number(s.lat)) && !(Number(s.lon) === 0 && Number(s.lat) === 0);
      return {
        ...s,
        designLongitude: designCoords?.designLongitude,
        designLatitude: designCoords?.designLatitude,
        designElevation: designCoords?.designElevation,
        displayLongitude: hasMeasuredCoords ? s.lon : designCoords?.designLongitude,
        displayLatitude: hasMeasuredCoords ? s.lat : designCoords?.designLatitude,
        displayElevation: hasMeasuredCoords ? s.z : (designCoords?.designElevation ?? s.z),
        coordSource: hasMeasuredCoords ? '实测坐标' : (designCoords ? '设计坐标' : '')
      };
    });
  }, [stations, designCoordLookup]);

  const unfinishedStations = useMemo(() => {
    const existingKeys = new Set(stations.map(s => makeCoordKey(s.y, s.x)));
    return Object.entries(designCoordLookup)
      .filter((entry) => !existingKeys.has(entry[0]) && Number.isFinite(entry[1]?.designLatitude) && Number.isFinite(entry[1]?.designLongitude))
      .map(([, value], idx) => ({
        id: `未完成_${idx + 1}`,
        x: value.point,
        y: value.line,
        z: value.designElevation,
        displayLongitude: value.designLongitude,
        displayLatitude: value.designLatitude,
        displayElevation: value.designElevation,
        coordSource: '设计坐标（未完成测点）',
        isUnfinished: true
      }));
  }, [designCoordLookup, stations]);

  const allMapStations = useMemo(() => [...enrichedStations.filter(s =>
    Number.isFinite(s.displayLatitude) &&
    Number.isFinite(s.displayLongitude) &&
    !(Number(s.displayLatitude) === 0 && Number(s.displayLongitude) === 0)
  ), ...unfinishedStations], [enrichedStations, unfinishedStations]);

  const hasGeoCoords = useMemo(() => {
    return allMapStations.length > 0;
  }, [allMapStations]);



  // Map Bounds Calculation
  const mapBounds = useMemo(() => {
    if (!hasGeoCoords) return null;
    const validStations = allMapStations.filter(s => s.displayLatitude !== undefined && s.displayLongitude !== undefined);
    if (validStations.length === 0) return null;

    const lats = validStations.map(s => s.displayLatitude);
    const lons = validStations.map(s => s.displayLongitude);
    
    return [
      [Math.min(...lats) - 0.005, Math.min(...lons) - 0.005], // SouthWest
      [Math.max(...lats) + 0.005, Math.max(...lons) + 0.005]  // NorthEast
    ];
  }, [allMapStations, hasGeoCoords]);

  // 解析不同格式的经纬度，统一返回度 (Decimal Degrees)
  const parseLonLat = (valStr, format) => {
    if (!valStr && valStr !== 0) return NaN;
    const str = String(valStr).trim();
    
    if (format === 'degree') {
      return parseFloat(str);
    } else if (format === 'degree_minute') {
      // 解析格式：度.分 (如 102.30 -> 102度30分)
      // 也有可能是 度:分 (如 102:30)
      let d, m;
      if (str.includes(':') || str.includes('°')) {
         const parts = str.split(/[:°'"]/);
         d = parseFloat(parts[0] || 0);
         m = parseFloat(parts[1] || 0);
      } else {
         // 假设小数点前是度，小数点后两位是分
         const val = parseFloat(str);
         d = Math.floor(val);
         m = (val - d) * 100;
      }
      return d + m / 60;
    } else if (format === 'dms') {
      // 解析格式：度.分秒 (如 102.3015 -> 102度30分15秒) 或 102°30'15"
      let d, m, s;
      if (str.includes(':') || str.includes('°')) {
         const parts = str.split(/[:°'"]/);
         d = parseFloat(parts[0] || 0);
         m = parseFloat(parts[1] || 0);
         s = parseFloat(parts[2] || 0);
      } else {
         const val = parseFloat(str);
         d = Math.floor(val);
         m = Math.floor((val - d) * 100);
         s = ((val - d) * 100 - m) * 100;
      }
      return d + m / 60 + s / 3600;
    }
    return parseFloat(str);
  };

  const handleImportCoords = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const projString = `+proj=tmerc +lat_0=${coordParams.latOrigin} +lon_0=${coordParams.centralMeridian} +k=${coordParams.scale} +x_0=${coordParams.falseEasting} +y_0=${coordParams.falseNorthing} +ellps=GRS80 +units=m +no_defs`;

    try {
      let rows = [];
      const extension = file.name.split('.').pop().toLowerCase();
      
      if (['txt', 'dat', 'csv'].includes(extension)) {
        // Read as text for txt, dat, csv to handle space/tab separations properly
        const text = await file.text();
        const lines = text.split('\n').filter(l => l.trim().length > 0);
        
        rows = lines.map(line => {
          // split by comma or spaces/tabs
          const parts = line.trim().split(/[\s,]+/);
          return parts;
        });
      } else {
        // Use XLSX for .xls, .xlsx
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data);
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      }
      
      let newStations = [...stations];
      let matchCount = 0;
      
      rows.forEach((row, idx) => {
        if (idx === 0 && typeof row[0] === 'string') {
          // might be header, skip if it's definitely a header
          // checking if row[0] can be parsed as number
          if (isNaN(parseFloat(row[0])) || isNaN(parseFloat(row[1]))) return;
        }
        
        if (row.length >= 5) {
          const lineNum = parseFloat(row[0]);
          const pointNum = parseFloat(row[1]);
          const x = row[2]; // keep as string or number for parsing
          const y = row[3];
          const z = parseFloat(row[4]);

          if (!isNaN(lineNum) && !isNaN(pointNum) && x !== undefined && y !== undefined && !isNaN(z)) {
            // Match with stations (station.x is Point, station.y is Line)
            const stationIndex = newStations.findIndex(s => s.x === pointNum && s.y === lineNum);
            if (stationIndex !== -1) {
              let lonlat = null;
              
              if (coordParams.coordType === 'CGCS2000') {
                try {
                  const px = parseFloat(x);
                  const py = parseFloat(y);
                  if (!isNaN(px) && !isNaN(py)) {
                    // In proj4, the input is [easting, northing] -> [lon, lat]
                    // We assume X is Easting, Y is Northing by default based on format description
                    const easting = px;
                    const northing = py;
                    lonlat = proj4(projString, 'WGS84', [easting, northing]);
                  }
                } catch (e) {
                  console.error('Projection error:', e);
                }
              } else {
                // lonlat format
                const parsedLon = parseLonLat(x, coordParams.lonlatFormat);
                const parsedLat = parseLonLat(y, coordParams.lonlatFormat);
                if (!isNaN(parsedLon) && !isNaN(parsedLat)) {
                  lonlat = [parsedLon, parsedLat];
                }
              }
              
              newStations[stationIndex] = {
                ...newStations[stationIndex],
                realX: parseFloat(x),
                realY: parseFloat(y),
                lon: lonlat ? lonlat[0] : undefined,
                lat: lonlat ? lonlat[1] : undefined,
                z: z // Update z
              };
              matchCount++;
            }
          }
        }
      });

      if (matchCount > 0) {
        setStations(newStations);
        setHasUnsavedChanges(true); // Mark as unsaved
        alert(`成功导入并匹配了 ${matchCount} 个测点坐标，请点击“保存更改”以持久化数据。`);
      } else {
        alert('未能在导入文件中找到匹配的线号和点号数据。请确保导入文件的前5列为: 线号, 点号, X, Y, Z。');
      }
    } catch (err) {
      alert('导入失败: ' + err.message);
    }
    
    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  useEffect(() => {
    if (!fileObj) return;

    const processFile = async () => {
      try {
        setLoading(true);
        setErrorMsg(null);
        let text = '';
        const resolvedSourceFile = await resolveDriveFileContent(fileObj, fileObj?.name || '@');
        if (!resolvedSourceFile) throw new Error('文件内容不可用，请重新上传到 OSS。');
        text = await resolvedSourceFile.text();

        const parsedStations = parseAtFile(text);
        if (parsedStations.length === 0) {
          throw new Error('未解析到任何测点坐标数据，请检查 @ 文件格式。');
        }

        // Try to load saved coords from cloud drive
        if (fileObj && fileObj.parentId && fileSystem) {
          const coordsFileName = `${fileObj.name}_coords.json`;
          const coordsFile = fileSystem.find(f => f.parentId === fileObj.parentId && f.name === coordsFileName);
          if (coordsFile && coordsFile.content) {
             try {
                const coordsData = JSON.parse(coordsFile.content);
                parsedStations.forEach(s => {
                   if (coordsData[s.id]) {
                      s.realX = coordsData[s.id].realX;
                      s.realY = coordsData[s.id].realY;
                      s.lon = coordsData[s.id].lon;
                      s.lat = coordsData[s.id].lat;
                      s.z = coordsData[s.id].z;
                   }
                });
             } catch(e) {
                console.error("Failed to parse coords file", e);
             }
          }
        }

        setStations(parsedStations);
      } catch (err) {
        setErrorMsg(err.message || '读取工程索引文件失败');
      } finally {
        setLoading(false);
      }
    };

    processFile();
  }, [fileObj, fileSystem]);

  // 根据第一个测点 ID 提取项目名称，例如 a.001 -> a，gtp-1.001 -> gtp-1
  const projectName = useMemo(() => {
    if (stations.length > 0 && stations[0].id) {
      const parts = stations[0].id.split('.');
      if (parts.length > 1) {
        return parts.slice(0, -1).join('.');
      }
    }
    return fileObj?.name || 'EH4 Project';
  }, [stations, fileObj]);

  const mapOption = useMemo(() => {
    if (!enrichedStations.length) return {};

    const scatterData = enrichedStations.map(s => ({
      name: s.id,
      value: [s.x, s.y, s.z]
    }));

    return {
      title: {
        text: hasGeoCoords ? 'EH4 测点平面分布图 (逻辑坐标)' : 'EH4 测点平面分布图',
        left: 'center',
        top: 10,
        textStyle: { color: '#0f172a', fontSize: 16 }
      },
      tooltip: {
        trigger: 'item',
        formatter: (params) => {
          const s = enrichedStations[params.dataIndex];
          let coordInfo = '';
          if (s.displayLongitude !== undefined && s.displayLatitude !== undefined) {
            coordInfo = `坐标来源: ${s.coordSource || '--'}<br/>经度: ${s.displayLongitude.toFixed(6)}°<br/>纬度: ${s.displayLatitude.toFixed(6)}°<br/>`;
          }
          return `<b>测点: ${params.name}</b><br/>
                  点号: ${params.value[0].toFixed(0)}<br/>
                  线号: ${params.value[1].toFixed(0)}<br/>
                  ${coordInfo}高程: ${(s.displayElevation ?? params.value[2]).toFixed(0)} m`;
        }
      },
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'filter'
        },
        {
          type: 'inside',
          yAxisIndex: 0,
          filterMode: 'filter'
        },
        {
          type: 'slider',
          xAxisIndex: 0,
          bottom: 10,
          height: 20
        },
        {
          type: 'slider',
          yAxisIndex: 0,
          right: 10,
          width: 20
        }
      ],
      grid: {
        left: '10%',
        right: '10%',
        bottom: '15%',
        top: '15%'
      },
      toolbox: {
        feature: {
          dataZoom: { yAxisIndex: 'none' },
          restore: {},
          saveAsImage: {}
        },
        right: 20,
        top: 10
      },
      xAxis: {
        type: 'value',
        name: '点号',
        nameLocation: 'middle',
        nameGap: 30,
        scale: true,
        splitLine: { show: true, lineStyle: { type: 'dashed', color: '#e2e8f0' } }
      },
      yAxis: {
        type: 'value',
        name: '线号',
        nameLocation: 'middle',
        nameGap: 40,
        scale: true,
        splitLine: { show: true, lineStyle: { type: 'dashed', color: '#e2e8f0' } }
      },
      series: [
        {
          name: '测点分布',
          type: 'scatter',
          symbolSize: 8,
          data: scatterData,
          itemStyle: {
            color: '#3b82f6',
            borderColor: '#fff',
            borderWidth: 1
          }
        }
      ]
    };
  }, [enrichedStations, hasGeoCoords]);

  const modalStyle = maximized
    ? { position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', borderRadius: 0, display: 'flex', flexDirection: 'column' }
    : { width: '85vw', maxWidth: '1200px', height: '80vh', display: 'flex', flexDirection: 'column', position: 'relative' };

  // 加载并预览特定测点的数据文件
  const findFileByName = (fileName = '') => {
    const targetName = normalizeLookupText(fileName);
    if (!targetName) return null;
    return (fileSystem || []).find((file) => (
      file?.type === 'file'
      && (
        normalizeLookupText(file.name) === targetName
      )
    )) || null;
  };

  const findMatchedFileForStation = (station, type) => {
    if (!station) return null;
    const lineValues = new Set([
      station.ryValue,
      station.ry,
      station.y,
      station.line,
      station.lineNo
    ].map(normalizeLookupText).filter(Boolean));
    const pointValues = new Set([
      station.rxValue,
      station.rx,
      station.x,
      station.point,
      station.pointNo
    ].map(normalizeLookupText).filter(Boolean));
    const matchedEntry = (selectedProject?.plan?.designEntries || []).find((entry) => (
      normalizeLookupText(entry.instrument).includes('eh4')
      && lineValues.has(normalizeLookupText(entry.line))
      && pointValues.has(normalizeLookupText(entry.point))
    ));
    const matchedFileName = (matchedEntry?.matchedDataPaths || [])
      .map(extractFileNameFromPath)
      .find((name) => isEh4FileOfType(name, type));
    return matchedFileName ? findFileByName(matchedFileName) : null;
  };

  const handleFileClick = async (e, type, id) => {
    e.stopPropagation();
    
    // 获取当前测点的详细元数据信息（包含rx, ry, xl, yl）
    const currentStationMeta = stations.find(s => s.id === id);

    // 拼装前缀，例如 id = "gtp-1.001", type = "Z" -> "ZGTP-1.001"
    const fallbackFileName = `${type}${id}`.toUpperCase();
    let content = '加载中...';
    
    // 尝试在上传的 fileSystem 中寻找同名文件
    const uploadedFile = findMatchedFileForStation(currentStationMeta, type) || fileSystem?.find(
      f => f.name.toUpperCase() === fallbackFileName
    );
    const fileName = (uploadedFile?.name || fallbackFileName).toUpperCase();

    // 确保即使在本地获取时，stationMeta 也被正确赋值给 fileObj
    const targetFileObj = uploadedFile
      ? { ...uploadedFile, name: uploadedFile.name || fileName, stationMeta: currentStationMeta }
      : null;
    
    // 图形化渲染拦截
      const handleFileOpen = async (fileObjTarget, fileType) => {
          let textContent = null;
          const resolvedFile = await resolveDriveFileContent(fileObjTarget, fileName).catch(() => null);
          if (resolvedFile) textContent = await resolvedFile.text();
          
          if (!textContent) {
              alert(`未能找到对应的测点数据文件：${fileName}`);
              return false;
          }
  
          setParsingZFile({
            name: fileName,
            type: fileType,
            fileObj: fileObjTarget,
            stationId: currentStationMeta?.id || id
          });
          return true;
      };
  
      if (type === 'Z') {
        return handleFileOpen(targetFileObj, 'Z');
      } else if (type === 'X') {
        return handleFileOpen(targetFileObj, 'X');
      } else if (type === 'Y') {
        return handleFileOpen(targetFileObj, 'Y');
      }
      
      setPreviewFile({ name: fileName, content, type });
      return true;
    };

  // 切换上一点/下一点
  const handleSwitchStation = async (direction) => {
    if (!parsingZFile || stations.length === 0) return;
    
    // 从当前的 parsingZFile 中提取当前的 id
    // 例如 fileName 为 "ZGTP-1.001"，type 为 "Z"
    const currentId = String(parsingZFile.stationId || parsingZFile.name.substring(1)).toLowerCase(); // "gtp-1.001"
    
    const currentIndex = stations.findIndex(s => String(s.id || '').toLowerCase() === currentId);
    if (currentIndex === -1) return;

    for (let offset = 1; offset <= stations.length; offset++) {
      const nextIndex = (currentIndex + direction * offset + stations.length) % stations.length;
      if (nextIndex === currentIndex) continue;
      const nextStation = stations[nextIndex];
      const opened = await handleFileClick({ stopPropagation: () => {} }, parsingZFile.type, nextStation.id);
      if (opened) return;
    }
  };

  // 切换文件类型 (X, Y, Z)
  const handleSwitchType = (newType) => {
    if (!parsingZFile || stations.length === 0) return;
    const currentId = parsingZFile.stationId || parsingZFile.name.substring(1);
    handleFileClick({ stopPropagation: () => {} }, newType, currentId);
  };

  const handleDeleteStation = async (idx) => {
    if (await confirmDialog('确认操作', '确定要删除该测点吗？此操作不可逆。')) {
      const newStations = [...stations];
      newStations.splice(idx, 1);
      setStations(newStations);
      setHasUnsavedChanges(true);
    }
  };

  const handleEditStation = (idx, field, value) => {
    const val = parseFloat(value);
    if (isNaN(val)) return;

    const newStations = [...stations];
    newStations[idx] = { ...newStations[idx], [field]: val };
    setStations(newStations);
    setHasUnsavedChanges(true);
  };

  const handleSaveAll = () => {
    if (fileObj && fileObj.parentId && onUpdateFileSystem) {
      // 1. 保存坐标到 _coords.json
      const coordsFileName = `${fileObj.name}_coords.json`;
      const coordsData = {};
      stations.forEach(s => {
        if (s.lon !== undefined || s.realX !== undefined) {
          coordsData[s.id] = { realX: s.realX, realY: s.realY, lon: s.lon, lat: s.lat, z: s.z, x: s.x, y: s.y };
        }
      });

      const jsonContent = JSON.stringify(coordsData, null, 2);
      const existingFileIndex = fileSystem.findIndex(f => f.parentId === fileObj.parentId && f.name === coordsFileName);
      
      let newFs = [...fileSystem];
      const newFile = {
        id: existingFileIndex >= 0 ? fileSystem[existingFileIndex].id : 'fid_coords_' + Date.now(),
        parentId: fileObj.parentId,
        type: 'file',
        name: coordsFileName,
        date: new Date().toISOString().split('T')[0],
        size: (jsonContent.length / 1024).toFixed(1) + ' KB',
        ext: 'code',
        content: jsonContent
      };
      
      if (existingFileIndex >= 0) {
         newFs[existingFileIndex] = newFile;
      } else {
         newFs.push(newFile);
      }

      // 2. 更新原始的 @ 文件内容
      const atContent = stations.map(s => `${s.id} ${s.x.toFixed(1)} ${s.y.toFixed(1)} ${s.z.toFixed(1)}`).join('\n');
      const atFileIndex = fileSystem.findIndex(f => f.id === fileObj.id);
      if (atFileIndex >= 0) {
         newFs[atFileIndex] = { ...newFs[atFileIndex], content: atContent, rawFile: undefined }; // Drop rawFile to rely on content
      }
      
      onUpdateFileSystem(newFs);
      setHasUnsavedChanges(false);
      alert('所有修改已成功保存到云盘。');
    } else {
      alert('无法保存：缺少云盘文件系统环境上下文。');
    }
  };

  const handleRunSimpegLine = async () => {
    if (stations.length === 0) {
      alert('没有可计算的测点');
      return;
    }

    setSimpegRunning(true);
    setSimpegResult(null);
    setSimpegProcess(['开始采集当前测线 Z 文件']);
    try {
      const records = [];
      for (const [stationIndex, station] of stations.entries()) {
        setSimpegProcess(prev => [...prev, `读取测点 ${station.id || stationIndex + 1} 的 Z 文件`]);
        const fallbackFileName = `Z${station.id}`.toUpperCase();
        const zFile = findMatchedFileForStation(station, 'Z') || fileSystem?.find(
          f => f.name.toUpperCase() === fallbackFileName
        );
        const resolvedZFile = await resolveDriveFileContent(zFile, zFile?.name || fallbackFileName).catch(() => null);
        if (!resolvedZFile) continue;

        const zText = await resolvedZFile.text();
        const zRows = parseZFile(zText).filter(row => row.freq > 0 && (row.exhy_rho > 0 || row.eyhx_rho > 0));
        zRows.forEach((row) => {
          records.push({
            line_code: String(station.y ?? station.line ?? 'L1'),
            point_code: String(station.id ?? station.x ?? ''),
            distance_m: Number.isFinite(Number(station.x)) ? Number(station.x) : undefined,
            elevation_m: Number.isFinite(Number(station.z)) ? Number(station.z) : undefined,
            freq_hz: row.freq,
            rho_xy: row.exhy_rho,
            phase_xy_deg: row.exhy_phs,
            rho_yx: row.eyhx_rho,
            phase_yx_deg: row.eyhx_phs,
            zxy_real: row.zxy_r,
            zxy_imag: row.zxy_i,
            zyx_real: row.zyx_r,
            zyx_imag: row.zyx_i,
          });
        });
      }

      if (records.length === 0) {
        setSimpegProcess(prev => [...prev, '未找到可用的视电阻率数据']);
        alert('没有找到可用于 SimPEG 的 Z 文件视电阻率数据');
        return;
      }

      const lineCode = String(stations[0]?.y ?? stations[0]?.line ?? projectName ?? 'L1');
      setSimpegProcess(prev => [...prev, `整理完成：${records.length} 条观测，提交后端 SimPEG 接口`]);
      const response = await buildAdminEmap1SimpegLine({
        line_code: lineCode,
        components: ['xy', 'yx'],
        run_simpeg: true,
        background_resistivity_ohm_m: 100,
        records,
      });
      setSimpegResult(response);
      setSimpegProcess(prev => [
        ...prev,
        '后端已生成 SimPEG 输入文件',
        ...(response?.simpeg?.process || []),
        response?.simpeg?.status === 'skipped' ? 'SimPEG 计算未执行' : 'SimPEG 处理完成',
      ]);
      const exportInfo = response?.export;
      const simpegInfo = response?.simpeg;
      const message = [
        `已生成 SimPEG 输入：${exportInfo?.observation_count || 0} 条观测，${exportInfo?.station_count || 0} 个测点`,
        simpegInfo?.status === 'skipped'
          ? `SimPEG 计算跳过：${simpegInfo.reason}`
          : simpegInfo
            ? `SimPEG 计算完成：${simpegInfo.data_count || 0} 条预测数据`
            : '',
        exportInfo?.output_dir ? `输出目录：${exportInfo.output_dir}` : '',
      ].filter(Boolean).join('\n');
      alert(message);
    } catch (err) {
      alert(`SimPEG 处理失败：${err.message}`);
    } finally {
      setSimpegRunning(false);
    }
  };

  const handleExportEDI = async () => {
    if (stations.length === 0) {
      alert('没有可导出的数据');
      return;
    }

    try {
      const zip = new JSZip();
      const spectraFolder = zip.folder("功率谱");
      const impedanceFolder = zip.folder("阻抗");
      const resistivityFolder = zip.folder("电阻率");
      let exportCount = 0;
      
      for (const station of stations) {
        const pointName = station.x.toFixed(0);
        
        // 1. 处理 Z 文件 (包含阻抗与电阻率数据)
        const zFileName = `Z${station.id}`.toUpperCase();
        let zText = null;

        const uploadedZFile = fileSystem?.find(
          f => f.name.toUpperCase() === zFileName
        );
        const resolvedZFile = await resolveDriveFileContent(uploadedZFile, zFileName).catch(() => null);
        if (resolvedZFile) zText = await resolvedZFile.text();

        if (zText) {
          try {
            const zData = parseZFile(zText);
            const validData = zData.filter(d => d.freq > 0 && d.exhy_rho > 0 && d.eyhx_rho > 0);
            
            if (validData.length > 0) {
              const mtData = validData.map(d => ({
                frequency: d.freq,
                period: 1 / d.freq,
                rhoXY: d.exhy_rho,
                phaseXY: d.exhy_phs,
                cohXY: d.exhy_coh,
                rhoYX: d.eyhx_rho,
                phaseYX: d.eyhx_phs,
                cohYX: d.eyhz_coh,
                zxxR: d.zxx_r, zxxI: d.zxx_i,
                zxyR: d.zxy_r, zxyI: d.zxy_i,
                zyxR: d.zyx_r, zyxI: d.zyx_i,
                zyyR: d.zyy_r, zyyI: d.zyy_i
              }));
              
              // 导出阻抗文件
              const impContent = writeEDIFile(mtData, station, 'impedance');
              impedanceFolder.file(`${pointName}.edi`, impContent);
              
              // 导出电阻率文件
              const resContent = writeEDIFile(mtData, station, 'resistivity');
              resistivityFolder.file(`${pointName}.edi`, resContent);
              
              exportCount++;
            }
          } catch (err) {
            console.error(`解析 ${zFileName} 失败:`, err);
          }
        }
        
        // 2. 处理 X 文件 (包含交叉功率谱数据)
        const xFileName = `X${station.id}`.toUpperCase();
        let xText = null;

        const uploadedXFile = fileSystem?.find(
          f => f.name.toUpperCase() === xFileName
        );
        const resolvedXFile = await resolveDriveFileContent(uploadedXFile, xFileName).catch(() => null);
        if (resolvedXFile) xText = await resolvedXFile.text();
        
        if (xText) {
          try {
            const xData = parseXFile(xText);
            const validXData = xData.filter(d => d.freq > 0);
            
            if (validXData.length > 0) {
              // 导出功率谱文件
              const specContent = writeEDIFile(null, station, 'spectra', validXData);
              spectraFolder.file(`${pointName}.edi`, specContent);
              exportCount++;
            }
          } catch (err) {
             console.error(`解析 ${xFileName} 失败:`, err);
          }
        }
      }

      if (exportCount === 0) {
        alert('导出失败：未找到任何有效的 Z 或 X 文件数据。');
        return;
      }

      const content = await zip.generateAsync({ type: 'blob' });
      saveAs(content, `${projectName}_EDI_Data.zip`);
      
    } catch (err) {
      alert('导出 EDI 失败: ' + err.message);
    }
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: maximized ? 'transparent' : 'rgba(0,0,0,0.6)', backdropFilter: maximized ? 'none' : 'blur(4px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card glass" style={modalStyle}>
        
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: maximized ? '12px 20px' : '0 0 16px 0', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Layers size={24} color="#3b82f6" />
            <div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#0f172a' }}>
                {projectName}
              </h3>
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                EH4 大地电磁测点空间分布与工程总览
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: '6px', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
              <button 
                onClick={() => setViewMode('map')}
                style={{ background: viewMode === 'map' ? '#3b82f6' : 'transparent', color: viewMode === 'map' ? '#fff' : '#64748b', border: 'none', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: 500 }}
              >
                <Map size={14} /> {hasGeoCoords ? '测点平面布置' : '测点分布图'}
              </button>
              <button 
                onClick={() => setViewMode('table')}
                style={{ background: viewMode === 'table' ? '#3b82f6' : 'transparent', color: viewMode === 'table' ? '#fff' : '#64748b', border: 'none', borderLeft: '1px solid #e2e8f0', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: 500 }}
              >
                <List size={14} /> 数据列表
              </button>
            </div>
            <button onClick={() => setMaximized(!maximized)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}>
              {maximized ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
            </button>
            <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}>
              <X size={24} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', paddingTop: maximized ? '16px' : '16px' }}>
          {loading ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: '#3b82f6' }}>
              <Loader2 size={32} className="spin" />
              <span>正在解析 EH4 工程索引文件...</span>
            </div>
          ) : errorMsg ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: '#ef4444' }}>
              <X size={48} />
              <p style={{ fontWeight: 500 }}>{errorMsg}</p>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              
              {/* Stats Bar */}
              <div style={{ display: 'flex', gap: '20px', padding: '12px 20px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: '13px', alignItems: 'center' }}>
                <div>测点总数: <b style={{ color: '#0f172a' }}>{stations.length}</b> 个</div>
                <div style={{ color: '#cbd5e1' }}>|</div>
                <div>未完成测点: <b style={{ color: '#f59e0b' }}>{unfinishedStations.length}</b> 个</div>
                <div style={{ color: '#cbd5e1' }}>|</div>
                <div>点号跨度: <b style={{ color: '#0f172a' }}>{stations.length ? (Math.max(...stations.map(s => s.x)) - Math.min(...stations.map(s => s.x))).toFixed(0) : '--'}</b></div>
                <div style={{ flex: 1 }}></div>
                {hasUnsavedChanges && (
                  <button 
                    onClick={handleSaveAll}
                    style={{ background: '#10b981', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 500 }}
                  >
                    <Save size={14} /> 保存更改
                  </button>
                )}
                <button
                  onClick={handleRunSimpegLine}
                  disabled={simpegRunning}
                  style={{ background: simpegRunning ? '#94a3b8' : '#0f766e', color: '#fff', border: 'none', borderRadius: '4px', cursor: simpegRunning ? 'not-allowed' : 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 500 }}
                  title="导出当前测线视电阻率数据并调用 SimPEG 计算"
                >
                  {simpegRunning ? <Loader2 size={14} className="spin" /> : <Settings size={14} />}
                  SimPEG
                </button>
                <button 
                  onClick={handleExportEDI}
                  style={{ background: '#f59e0b', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 500 }}
                  title="将当前工程所有测点导出为 EDI 格式文件包"
                >
                  <Download size={14} /> 导出 EDI
                </button>
                <button 
                  onClick={() => setShowCoordDialog(true)}
                  style={{ background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 500 }}
                >
                  <Upload size={14} /> 导入坐标
                </button>
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  style={{ display: 'none' }} 
                  accept=".csv,.txt,.dat,.xls,.xlsx" 
                  onChange={handleImportCoords} 
                />
              </div>

              {simpegResult?.export && (
                <div style={{ padding: '8px 20px', background: '#ecfdf5', borderBottom: '1px solid #ccfbf1', color: '#0f766e', fontSize: '12px', display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>SimPEG 输入: <b>{simpegResult.export.observation_count}</b> 条观测 / <b>{simpegResult.export.station_count}</b> 个测点</span>
                  <span>频点: <b>{simpegResult.export.frequency_count}</b></span>
                  <span>{simpegResult.simpeg?.status === 'skipped' ? '计算未执行' : simpegResult.simpeg ? '计算完成' : '已导出'}</span>
                  <span style={{ color: '#475569' }}>{simpegResult.export.output_dir}</span>
                </div>
              )}

              {(simpegRunning || simpegProcess.length > 0 || simpegResult?.export) && (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 1fr) minmax(280px, 1.4fr)', gap: '12px', padding: '12px 20px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: '12px', color: '#334155' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: '#0f172a', marginBottom: '8px' }}>SimPEG 反演过程</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '118px', overflow: 'auto' }}>
                      {simpegProcess.map((step, index) => (
                        <div key={`${step}-${index}`} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                          <span style={{ width: '18px', height: '18px', borderRadius: '50%', background: index === simpegProcess.length - 1 && simpegRunning ? '#0f766e' : '#d1fae5', color: index === simpegProcess.length - 1 && simpegRunning ? '#fff' : '#047857', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', flexShrink: 0 }}>
                            {index + 1}
                          </span>
                          <span>{step}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: '#0f172a', marginBottom: '8px' }}>结果</div>
                    {simpegResult?.export ? (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px 12px' }}>
                        <span>观测: <b>{simpegResult.export.observation_count}</b></span>
                        <span>测点: <b>{simpegResult.export.station_count}</b></span>
                        <span>频点: <b>{simpegResult.export.frequency_count}</b></span>
                        <span>状态: <b>{simpegResult.simpeg?.status === 'skipped' ? '未执行' : simpegResult.simpeg ? '完成' : '已导出'}</b></span>
                        <span style={{ gridColumn: '1 / -1', color: '#64748b', wordBreak: 'break-all' }}>目录: {simpegResult.export.output_dir}</span>
                        {simpegResult.simpeg?.predicted_csv && (
                          <span style={{ gridColumn: '1 / -1', color: '#64748b', wordBreak: 'break-all' }}>预测: {simpegResult.simpeg.predicted_csv}</span>
                        )}
                        {simpegResult.simpeg?.reason && (
                          <span style={{ gridColumn: '1 / -1', color: '#b45309' }}>{simpegResult.simpeg.reason}</span>
                        )}
                        {simpegResult.simpeg?.predicted_preview?.length > 0 && (
                          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                            {simpegResult.simpeg.predicted_preview.slice(0, 12).map((item) => (
                              <span key={item.index} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '4px', padding: '3px 6px' }}>
                                #{item.index}: {Number(item.predicted).toExponential(3)}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ color: '#64748b' }}>{simpegRunning ? '正在准备数据...' : '暂无结果'}</div>
                    )}
                  </div>
                </div>
              )}

              {/* Views */}
              <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                {viewMode === 'map' ? (
                  hasGeoCoords ? (
                    <div style={{ width: '100%', height: '100%' }}>
                      <MapContainer bounds={mapBounds} style={{ height: '100%', width: '100%' }}>
                        <TileLayer
                          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                          attribution='Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
                        />
                        {allMapStations.map((s, idx) => (
                          <CircleMarker 
                            key={idx} 
                            center={[s.displayLatitude, s.displayLongitude]}
                            radius={4}
                            pathOptions={{ color: '#fff', weight: 1, fillColor: s.isUnfinished ? '#f59e0b' : '#3b82f6', fillOpacity: 0.85 }}
                            eventHandlers={{
                              click: (e) => {
                                if (!s.isUnfinished) handleFileClick(e.originalEvent, 'Z', s.id);
                              },
                            }}
                          >
                            <Tooltip direction="bottom" offset={[0, 5]} opacity={1}>
                              <div style={{ fontSize: '13px', lineHeight: '1.6', padding: '2px 4px' }}>
                                <b>测点: {s.id}</b><br/>
                                点号: {s.x.toFixed(0)}<br/>
                                线号: {s.y.toFixed(0)}<br/>
                                坐标来源: {s.coordSource || '--'}<br/>
                                经度: {s.displayLongitude.toFixed(6)}°<br/>
                                纬度: {s.displayLatitude.toFixed(6)}°<br/>
                                高程: {(s.displayElevation ?? s.z ?? 0).toFixed(2)} m<br/>
                                <span style={{ color: s.isUnfinished ? '#f59e0b' : '#3b82f6', marginTop: '4px', display: 'inline-block', fontSize: '12px' }}><i>{s.isUnfinished ? '设计坐标有、@ 文件无，视为未完成测点' : '点击打开数据'}</i></span>
                              </div>
                            </Tooltip>
                          </CircleMarker>
                        ))}
                      </MapContainer>
                    </div>
                  ) : (
                    <ReactECharts
                      option={mapOption}
                      style={{ width: '100%', height: '100%' }}
                      opts={{ renderer: 'canvas' }}
                      notMerge={true}
                      onEvents={{
                        click: (params) => {
                          if (params.componentType === 'series' && params.data && params.data.name) {
                            handleFileClick({ stopPropagation: () => {} }, 'Z', params.data.name);
                          }
                        }
                      }}
                    />
                  )
                ) : (
                  <div style={{ height: '100%', overflow: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                      <thead style={{ position: 'sticky', top: 0, background: '#f8fafc', zIndex: 10, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                        <tr>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>序号</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>测点</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>点号</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>线号</th>
                        <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>X极距 (m)</th>
                        <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>Y极距 (m)</th>
                        {hasGeoCoords && (
                          <>
                            <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>坐标来源</th>
                            <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>经度 (°)</th>
                            <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>纬度 (°)</th>
                            </>
                          )}
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>高程 Z (m)</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600, width: '60px' }}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {enrichedStations.map((s, idx) => (
                          <tr key={idx} style={{ borderBottom: '1px solid #e2e8f0', background: s.coordSource === '设计坐标' ? '#f8fafc' : '#fff' }}>
                            <td style={{ padding: '10px 20px', color: '#94a3b8' }}>{idx + 1}</td>
                            <td style={{ padding: '10px 20px', fontWeight: 600, color: '#0f172a' }}>
                              <span 
                                onClick={(e) => handleFileClick(e, 'Z', s.id)}
                                style={{ cursor: 'pointer', color: '#3b82f6', textDecoration: 'none', transition: 'color 0.2s' }}
                                onMouseOver={(e) => { e.currentTarget.style.textDecoration = 'underline'; e.currentTarget.style.color = '#2563eb'; }}
                                onMouseOut={(e) => { e.currentTarget.style.textDecoration = 'none'; e.currentTarget.style.color = '#3b82f6'; }}
                                title="点击查看测点数据"
                              >
                                {s.id}
                              </span>
                            </td>
                            <td style={{ padding: '10px 20px' }}>
                              <input 
                                type="number" 
                                value={s.x} 
                                onChange={(e) => handleEditStation(idx, 'x', e.target.value)}
                                style={{ width: '60px', padding: '4px', border: '1px solid #cbd5e1', borderRadius: '4px', outline: 'none' }}
                              />
                            </td>
                            <td style={{ padding: '10px 20px' }}>
                              <input 
                                type="number" 
                                value={s.y} 
                                onChange={(e) => handleEditStation(idx, 'y', e.target.value)}
                                style={{ width: '60px', padding: '4px', border: '1px solid #cbd5e1', borderRadius: '4px', outline: 'none' }}
                              />
                            </td>
                            <td style={{ padding: '10px 20px' }}>
                              <input 
                                type="number" 
                                value={s.xl || ''} 
                                onChange={(e) => handleEditStation(idx, 'xl', e.target.value)}
                                style={{ width: '60px', padding: '4px', border: '1px solid #cbd5e1', borderRadius: '4px', outline: 'none' }}
                              />
                            </td>
                            <td style={{ padding: '10px 20px' }}>
                              <input 
                                type="number" 
                                value={s.yl || ''} 
                                onChange={(e) => handleEditStation(idx, 'yl', e.target.value)}
                                style={{ width: '60px', padding: '4px', border: '1px solid #cbd5e1', borderRadius: '4px', outline: 'none' }}
                              />
                            </td>
                            {hasGeoCoords && (
                              <>
                                <td style={{ padding: '10px 20px' }}>{s.coordSource || '--'}</td>
                                <td style={{ padding: '10px 20px' }}>{s.displayLongitude !== undefined ? s.displayLongitude.toFixed(6) : '--'}</td>
                                <td style={{ padding: '10px 20px' }}>{s.displayLatitude !== undefined ? s.displayLatitude.toFixed(6) : '--'}</td>
                              </>
                            )}
                            <td style={{ padding: '10px 20px', color: '#0f172a' }}>
                              <input 
                                type="number" 
                                value={s.displayElevation ?? s.z} 
                                onChange={(e) => handleEditStation(idx, 'z', e.target.value)}
                                style={{ width: '60px', padding: '4px', border: '1px solid #cbd5e1', borderRadius: '4px', outline: 'none' }}
                              />
                            </td>
                            <td style={{ padding: '10px 20px' }}>
                              <button 
                                onClick={() => handleDeleteStation(idx)}
                                style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center' }}
                                title="删除该测点"
                              >
                                <Trash2 size={16} />
                              </button>
                            </td>
                          </tr>
                        ))}
                        {unfinishedStations.map((s, idx) => (
                          <tr key={`unfinished_${idx}`} style={{ borderBottom: '1px solid #e2e8f0', background: '#fff7ed' }}>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>--</td>
                            <td style={{ padding: '10px 20px', fontWeight: 600, color: '#f59e0b' }}>{s.id}</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>{s.x?.toFixed?.(0) ?? '--'}</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>{s.y?.toFixed?.(0) ?? '--'}</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>--</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>--</td>
                            {hasGeoCoords && (
                              <>
                                <td style={{ padding: '10px 20px', color: '#f59e0b' }}>{s.coordSource}</td>
                                <td style={{ padding: '10px 20px', color: '#f59e0b' }}>{s.displayLongitude?.toFixed?.(6) ?? '--'}</td>
                                <td style={{ padding: '10px 20px', color: '#f59e0b' }}>{s.displayLatitude?.toFixed?.(6) ?? '--'}</td>
                              </>
                            )}
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>{s.displayElevation?.toFixed?.(2) ?? '--'}</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>--</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      
      {/* 坐标系设置弹窗 */}
      {showCoordDialog && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }}>
          <div style={{ width: '450px', background: '#fff', borderRadius: '12px', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)', overflow: 'hidden' }}>
            <div style={{ padding: '16px 24px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc' }}>
              <h4 style={{ margin: 0, color: '#0f172a', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Settings size={18} color="#3b82f6" /> 导入坐标投影参数设置
              </h4>
              <button onClick={() => setShowCoordDialog(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><X size={20}/></button>
            </div>
            
            <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '13px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={{ color: '#475569', fontWeight: 500 }}>坐标类型</label>
                <select 
                  value={coordParams.coordType}
                  onChange={(e) => setCoordParams({...coordParams, coordType: e.target.value})}
                  style={{ width: '220px', padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }}
                >
                  <option value="lonlat">经纬度格式 (WGS84)</option>
                  <option value="CGCS2000">投影坐标 (CGCS2000)</option>
                </select>
              </div>

              {coordParams.coordType === 'lonlat' ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <label style={{ color: '#475569', fontWeight: 500 }}>经纬度单位</label>
                  <select 
                    value={coordParams.lonlatFormat}
                    onChange={(e) => setCoordParams({...coordParams, lonlatFormat: e.target.value})}
                    style={{ width: '220px', padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }}
                  >
                    <option value="degree">度 (如 102.502)</option>
                    <option value="degree_minute">度分 (如 102.301 或 102°30')</option>
                    <option value="dms">度分秒 (如 102.3007 或 102°30'07")</option>
                  </select>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ color: '#475569', fontWeight: 500 }}>中央经线 [°]</label>
                    <input 
                      type="number" 
                      value={coordParams.centralMeridian}
                      onChange={(e) => setCoordParams({...coordParams, centralMeridian: parseFloat(e.target.value) || 102})}
                      style={{ width: '220px', padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }} 
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ color: '#475569', fontWeight: 500 }}>纬度基线 [°]</label>
                    <input 
                      type="number" 
                      value={coordParams.latOrigin}
                      onChange={(e) => setCoordParams({...coordParams, latOrigin: parseFloat(e.target.value) || 0})}
                      style={{ width: '220px', padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }} 
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ color: '#475569', fontWeight: 500 }}>东偏移 [米]</label>
                    <input 
                      type="number" 
                      value={coordParams.falseEasting}
                      onChange={(e) => setCoordParams({...coordParams, falseEasting: parseFloat(e.target.value) || 500000})}
                      style={{ width: '220px', padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }} 
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ color: '#475569', fontWeight: 500 }}>北偏移 [米]</label>
                    <input 
                      type="number" 
                      value={coordParams.falseNorthing}
                      onChange={(e) => setCoordParams({...coordParams, falseNorthing: parseFloat(e.target.value) || 0})}
                      style={{ width: '220px', padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }} 
                    />
                  </div>
                </>
              )}

              <div style={{ padding: '10px 12px', background: '#eff6ff', borderRadius: '6px', display: 'flex', gap: '8px', color: '#1e3a8a', border: '1px solid #bfdbfe', marginTop: '8px' }}>
                <Info size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <div style={{ lineHeight: '1.5' }}>
                  <b>导入文件格式要求：</b><br/>
                  请确保文件 (如 .csv, .xlsx, .txt) 为 <b>5列</b> 数据，每列依次代表：<br/>
                  <b>第1列</b>：线号&nbsp;&nbsp;&nbsp;<b>第2列</b>：点号<br/>
                  <b>第3列</b>：X坐标 / 经度&nbsp;&nbsp;&nbsp;<b>第4列</b>：Y坐标 / 纬度<br/>
                  <b>第5列</b>：高程 Z (m)
                </div>
              </div>
            </div>

            <div style={{ padding: '16px 24px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', gap: '12px', background: '#f8fafc' }}>
              <button 
                onClick={() => setShowCoordDialog(false)}
                style={{ background: '#fff', color: '#475569', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '6px 16px', cursor: 'pointer', fontWeight: 500 }}
              >
                取消
              </button>
              <button 
                onClick={() => {
                  setShowCoordDialog(false);
                  fileInputRef.current?.click();
                }}
                style={{ background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 16px', cursor: 'pointer', fontWeight: 500 }}
              >
                确定并导入
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewFile && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }}>
          <div style={{ width: '80%', maxWidth: '800px', height: '70%', background: '#fff', borderRadius: '12px', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)', overflow: 'hidden' }}>
            <div style={{ padding: '16px 24px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <FileText size={20} color={previewFile.type === 'X' ? '#3b82f6' : previewFile.type === 'Y' ? '#10b981' : '#f59e0b'} />
                <h4 style={{ margin: 0, color: '#0f172a', fontSize: '15px' }}>{previewFile.name}</h4>
                <span style={{ fontSize: '12px', color: '#64748b', marginLeft: '8px', background: '#e2e8f0', padding: '2px 8px', borderRadius: '12px' }}>
                  {previewFile.type === 'X' ? '交叉功率谱' : previewFile.type === 'Y' ? '时间序列' : '阻抗与视电阻率'}
                </span>
              </div>
              <button onClick={() => setPreviewFile(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: '4px' }}><X size={20}/></button>
            </div>
            <div style={{ flex: 1, padding: '20px', overflow: 'auto', background: '#0f172a' }}>
              <pre style={{ margin: 0, fontFamily: '"Fira Code", monospace', fontSize: '13px', color: '#e2e8f0', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>
                {previewFile.content}
              </pre>
            </div>
          </div>
        </div>
      )}
      {/* 图形化渲染弹窗 */}
      {parsingZFile && (
        <>
          {(!parsingZFile.type || parsingZFile.type === 'Z') && (
            <MTParser 
               fileObj={parsingZFile.fileObj || { name: parsingZFile.name }} 
               fileSystem={fileSystem}
               onClose={() => setParsingZFile(null)} 
               onPrev={() => handleSwitchStation(-1)}
               onNext={() => handleSwitchStation(1)}
               onSwitchType={handleSwitchType}
            />
          )}
          {parsingZFile.type === 'X' && (
            <XParser 
               fileObj={parsingZFile.fileObj || { name: parsingZFile.name }} 
               fileSystem={fileSystem}
               onClose={() => setParsingZFile(null)} 
               onPrev={() => handleSwitchStation(-1)}
               onNext={() => handleSwitchStation(1)}
               onSwitchType={handleSwitchType}
            />
          )}
          {parsingZFile.type === 'Y' && (
            <YParser 
               fileObj={parsingZFile.fileObj || { name: parsingZFile.name }} 
               fileSystem={fileSystem}
               onClose={() => setParsingZFile(null)} 
               onPrev={() => handleSwitchStation(-1)}
               onNext={() => handleSwitchStation(1)}
               onSwitchType={handleSwitchType}
            />
          )}
        </>
      )}
    </div>
  );
};

export default EH4ProjectViewer;
