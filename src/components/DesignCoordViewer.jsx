/* eslint-disable react-hooks/exhaustive-deps */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import * as XLSX from 'xlsx';
import proj4 from 'proj4';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { parseAtFile, parseEDIFile, parseF3IndexFile, parseF3PsdFile, parseF3ResistivityFile, parseXFile, parseZFile, writeEDIFile } from '../utils/eh4io';
import { X, Map as MapIcon, List, Loader2, Settings, Info, Maximize2, Minimize2, Trash2, Download } from 'lucide-react';
import { msg, confirmDialog } from '../utils/message';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const defaultCoordParams = {
  coordType: 'lonlat',
  lonlatFormat: 'degree',
  centralMeridian: 102,
  latOrigin: 0,
  falseEasting: 500000,
  falseNorthing: 0,
  scale: 1
};

const instrumentPalette = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#ec4899'];

const DesignCoordViewer = ({ fileObj, fileSystem = [], onClose, onOpenDataFile, onUpdateFileSystem }) => {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [loadingData, setLoadingData] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [viewMode, setViewMode] = useState('map');
  const [showCoordDialog, setShowCoordDialog] = useState(true);
  const [rawRows, setRawRows] = useState([]);
  const [entries, setEntries] = useState([]);
  const [activeDataset, setActiveDataset] = useState('design');
  const [f3Stations, setF3Stations] = useState([]);
  const [eh4Stations, setEh4Stations] = useState([]);
  const [ediStations, setEdiStations] = useState([]);
  const [coordParams, setCoordParams] = useState(defaultCoordParams);
  const [hasSavedCoordParams, setHasSavedCoordParams] = useState(false);
  const [hasAutoParsed, setHasAutoParsed] = useState(false);
  const hasAutoLoadedOverviewRef = useRef(false);

  useEffect(() => {
    setShowCoordDialog(true);
    setEntries([]);
    setF3Stations([]);
    setEh4Stations([]);
    setEdiStations([]);
    setActiveDataset('design');
    setCoordParams(defaultCoordParams);
    setHasSavedCoordParams(false);
    setHasAutoParsed(false);
    hasAutoLoadedOverviewRef.current = false;
  }, [fileObj?.id, fileObj?.name]);

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        setErrorMsg('');
        let buffer = null;
        if (fileObj instanceof File) {
          buffer = await fileObj.arrayBuffer();
        } else if (fileObj?.rawFile instanceof File) {
          buffer = await fileObj.rawFile.arrayBuffer();
        } else {
          throw new Error('设计坐标文件内容不可用，请重新上传该文件');
        }
        const workbook = XLSX.read(buffer);
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        if (!rows.length) {
          throw new Error('设计坐标文件未解析到有效数据');
        }
        setRawRows(rows);
      } catch (e) {
        setErrorMsg(e.message || '设计坐标文件解析失败');
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [fileObj]);

  const parseLonLat = (valStr, format) => {
    if (!valStr && valStr !== 0) return NaN;
    const str = String(valStr).trim();
    if (format === 'degree') return parseFloat(str);
    if (format === 'degree_minute') {
      let d, m;
      if (str.includes(':') || str.includes('°')) {
        const parts = str.split(/[:°'"]/);
        d = parseFloat(parts[0] || 0);
        m = parseFloat(parts[1] || 0);
      } else {
        const val = parseFloat(str);
        d = Math.floor(val);
        m = (val - d) * 100;
      }
      return d + m / 60;
    }
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
  };

  const persistCoordParams = (nextParams) => {
    if (!onUpdateFileSystem) return;
    const content = JSON.stringify({ coordParams: nextParams }, null, 2);
    const folderId = fileObj?.parentId ?? null;
    const nextFile = {
      id: coordParamSidecarFile?.id || `design_param_${Date.now()}`,
      parentId: folderId,
      type: 'file',
      name: coordParamSidecarName,
      date: new Date().toISOString().split('T')[0],
      size: `${content.length} B`,
      ext: 'json',
      content
    };
    const nextFs = coordParamSidecarFile
      ? (fileSystem || []).map(file => (file.id === coordParamSidecarFile.id ? { ...file, ...nextFile } : file))
      : [...(fileSystem || []), nextFile];
    onUpdateFileSystem(nextFs);
  };

  const handleParseDesignCoords = (options = {}) => {
    try {
      const projString = `+proj=tmerc +lat_0=${coordParams.latOrigin} +lon_0=${coordParams.centralMeridian} +k=${coordParams.scale} +x_0=${coordParams.falseEasting} +y_0=${coordParams.falseNorthing} +ellps=GRS80 +units=m +no_defs`;
      const parsedEntries = [];
      rawRows.forEach((row, idx) => {
        if (!Array.isArray(row) || row.length < 5) return;
        if (idx === 0 && typeof row[0] === 'string' && (isNaN(parseFloat(row[0])) || isNaN(parseFloat(row[1])))) return;

        const line = row[0];
        const point = row[1];
        const x = row[2];
        const y = row[3];
        const z = Number(row[4]);
        const instrument = row[5] ?? '';

        let lon = NaN;
        let lat = NaN;
        if (coordParams.coordType === 'CGCS2000') {
          const px = Number.parseFloat(x);
          const py = Number.parseFloat(y);
          if (Number.isFinite(px) && Number.isFinite(py)) {
            [lon, lat] = proj4(projString, 'WGS84', [px, py]);
          }
        } else {
          lon = parseLonLat(x, coordParams.lonlatFormat);
          lat = parseLonLat(y, coordParams.lonlatFormat);
        }

        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        parsedEntries.push({
          idx,
          line: String(line ?? '').trim(),
          point: String(point ?? '').trim(),
          x,
          y,
          z: Number.isFinite(z) ? z : null,
          instrument: String(instrument ?? '').trim(),
          gpsLongitude: lon,
          gpsLatitude: lat
        });
      });

      if (!parsedEntries.length) {
        msg.warn('未从设计坐标文件中解析到有效点位，请检查六列格式：测线、测点、X、Y、高程、仪器。');
        return;
      }
      persistCoordParams(coordParams);
      setHasSavedCoordParams(true);
      setEntries(parsedEntries);
      setShowCoordDialog(false);
      if (options.auto) {
        setHasAutoParsed(true);
      }
    } catch (err) {
      msg.warn(`设计坐标解析失败：${err.message}`);
    }
  };

  useEffect(() => {
    if (!rawRows.length || !hasSavedCoordParams || hasAutoParsed || entries.length > 0) return;
    handleParseDesignCoords({ auto: true });
  }, [rawRows, hasSavedCoordParams, hasAutoParsed, entries.length, handleParseDesignCoords]);

  const instrumentColorMap = useMemo(() => {
    const uniqueInstruments = Array.from(new Set(
      entries.map(entry => (entry.instrument || '').trim()).filter(Boolean)
    ));
    return uniqueInstruments.reduce((acc, instrument, idx) => {
      acc[instrument] = instrumentPalette[idx % instrumentPalette.length];
      return acc;
    }, {});
  }, [entries]);

  const getInstrumentColor = (instrument) => {
    const key = String(instrument || '').trim();
    if (!key) return '#64748b';
    return instrumentColorMap[key] || '#64748b';
  };

  const workspaceFolderFiles = useMemo(() => {
    const folderId = fileObj?.parentId ?? null;
    return (fileSystem || []).filter(item => {
      if (item.type !== 'file') return false;
      if (folderId !== null && item.parentId !== folderId) return false;
      return true;
    });
  }, [fileObj, fileSystem]);

  const dataFolderFiles = useMemo(() => {
    const folderId = fileObj?.linkedSourceFolderId ?? fileObj?.parentId ?? null;
    return (fileSystem || []).filter(item => {
      if (item.type !== 'file') return false;
      if (folderId !== null && item.parentId !== folderId) return false;
      return true;
    });
  }, [fileObj, fileSystem]);

  const coordParamSidecarName = useMemo(() => {
    const name = fileObj?.name || '设计坐标文件';
    return `${name}.coord_params.json`;
  }, [fileObj]);

  const coordParamSidecarFile = useMemo(() => {
    return workspaceFolderFiles.find(item => (item.name || '').toLowerCase() === coordParamSidecarName.toLowerCase()) || null;
  }, [workspaceFolderFiles, coordParamSidecarName]);

  useEffect(() => {
    if (!coordParamSidecarFile?.content) {
      setHasSavedCoordParams(false);
      return;
    }
    try {
      const parsed = JSON.parse(coordParamSidecarFile.content);
      const nextParams = parsed?.coordParams;
      if (!nextParams || typeof nextParams !== 'object') {
        setHasSavedCoordParams(false);
        return;
      }
      setCoordParams(prev => ({ ...prev, ...nextParams }));
      setHasSavedCoordParams(true);
      setShowCoordDialog(false);
    } catch {
      setHasSavedCoordParams(false);
    }
  }, [coordParamSidecarFile?.content]);

  const normalizeInstrumentType = (instrument) => {
    const value = String(instrument || '').trim().toLowerCase();
    if (!value) return '';
    if (value.includes('f3')) return 'f3';
    if (value.includes('emap')) return 'eh4';
    if (value.includes('eh4')) return 'eh4';
    if (value.includes('edi')) return 'edi';
    return value;
  };

  const isEMAPInstrument = (instrument) => String(instrument || '').trim().toLowerCase().includes('emap');
  const parseMTTSPointNo = (name = '') => {
    const normalizedName = String(name || '').trim();
    if (!/\.mtts$/i.test(normalizedName)) return '';
    const baseName = normalizedName.replace(/\.[^.]+$/, '');
    return String(baseName.split('_')[0] || '').trim();
  };

  const normalizeCoordKey = (value) => String(value ?? '').trim().toLowerCase();

  const findDesignMatch = (designEntries, { line, point }) => {
    const normalizedLine = normalizeCoordKey(line);
    const normalizedPoint = normalizeCoordKey(point);

    return designEntries.find(entry =>
      normalizeCoordKey(entry.line) === normalizedLine &&
      normalizeCoordKey(entry.point) === normalizedPoint
    ) || null;
  };

  const parseAngleText = (value) => {
    const text = String(value || '').trim();
    if (!text) return NaN;
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    const parts = text.split(/[:°'"]/).filter(Boolean).map(Number);
    if (!parts.length || parts.some(v => Number.isNaN(v))) return NaN;
    const sign = parts[0] < 0 ? -1 : 1;
    const d = Math.abs(parts[0]);
    const m = parts[1] || 0;
    const s = parts[2] || 0;
    return sign * (d + m / 60 + s / 3600);
  };

  const parseEdiMetadata = (text, fileName) => {
    const lines = String(text || '').split(/\r?\n/);
    const getField = (key) => {
      const line = lines.find(item => new RegExp(`^\\s*${key}\\s*=`, 'i').test(item));
      if (!line) return '';
      return line.split('=').slice(1).join('=').trim();
    };
    const dataId = getField('DATAID') || fileName.replace(/\.edi$/i, '');
    const point = getField('STN') || dataId;
    const line = getField('LINE');
    const lat = parseAngleText(getField('LAT'));
    const lon = parseAngleText(getField('LONG') || getField('LON'));
    const elevText = getField('ELEV');
    const elev = elevText === '' ? NaN : Number(elevText);
    return {
      dataId,
      point,
      line,
      lat,
      lon,
      elev
    };
  };

  const datasetStations = activeDataset === 'edi' ? ediStations : activeDataset === 'f3' ? f3Stations : activeDataset === 'eh4' ? eh4Stations : entries;
  const missingDesignEntries = useMemo(() => {
    if (activeDataset !== 'edi' && activeDataset !== 'f3' && activeDataset !== 'eh4') return [];
    const targetInstrument = activeDataset;
    const designEntries = entries.filter(entry => normalizeInstrumentType(entry.instrument) === targetInstrument);
    const existingKeys = new Set(
      datasetStations.map(entry => `${normalizeCoordKey(entry.line)}__${normalizeCoordKey(entry.point)}`)
    );
    return designEntries
      .filter(entry => !existingKeys.has(`${normalizeCoordKey(entry.line)}__${normalizeCoordKey(entry.point)}`))
      .map((entry, idx) => ({
        ...entry,
        idx: `design_only_${targetInstrument}_${idx}`,
        sourceEntryIdx: entry.idx,
        fileName: '--',
        coordSource: '设计坐标（未完成测点）',
        isDesignOnly: true
      }));
  }, [activeDataset, datasetStations, entries]);

  const displayEntries = useMemo(() => (
    activeDataset === 'edi' || activeDataset === 'f3' || activeDataset === 'eh4'
      ? [...datasetStations, ...missingDesignEntries]
      : entries
  ), [activeDataset, datasetStations, missingDesignEntries, entries]);

  const displayInstrumentColor = (entry) => {
    if (entry?.isDesignOnly) return '#f59e0b';
    if (activeDataset === 'f3') {
      return resolveDataFileForEntry(entry) ? '#3b82f6' : '#94a3b8';
    }
    return (activeDataset === 'edi' || activeDataset === 'eh4') ? '#3b82f6' : getInstrumentColor(entry.instrument);
  };
  const mapBounds = useMemo(() => (
    displayEntries.filter(entry => Number.isFinite(entry.gpsLatitude) && Number.isFinite(entry.gpsLongitude)).length
      ? displayEntries.filter(entry => Number.isFinite(entry.gpsLatitude) && Number.isFinite(entry.gpsLongitude)).map(entry => [entry.gpsLatitude, entry.gpsLongitude])
      : null
  ), [displayEntries]);

  const handleLoadData = useCallback(async () => {
    try {
      setLoadingData(true);
      const instrumentTypes = Array.from(new Set(entries.map(entry => normalizeInstrumentType(entry.instrument)).filter(Boolean)));
      if (!instrumentTypes.length) {
        msg.warn('设计坐标文件中未识别到仪器类型。');
        return;
      }

      if (instrumentTypes.includes('f3')) {
        const f3IndexFiles = dataFolderFiles.filter(item => /\.(index|idx)$/i.test(item.name) && !/设计坐标/i.test(item.name));
        if (!f3IndexFiles.length) {
          msg.warn('未在当前文件夹中找到 F3 的 INDEX 或 IDX 文件。');
          return;
        }

        const designEntries = entries.filter(entry => normalizeInstrumentType(entry.instrument) === 'f3');
        const stations = [];
        for (const file of f3IndexFiles) {
          const buffer = file?.rawFile instanceof File ? await file.rawFile.arrayBuffer() : null;
          if (!buffer) continue;
          try {
            const parsedEntries = parseF3IndexFile(buffer);
            parsedEntries.forEach((item) => {
              stations.push(buildF3StationRecord(item, file, designEntries));
            });
          } catch {
            void 0;
          }
        }
        if (!stations.length) {
          msg.warn('未能从 INDEX/IDX 文件中读取到有效 F3 总览信息。');
          return;
        }
        setF3Stations(mergeF3Stations(stations));
        setActiveDataset('f3');
        setViewMode('map');
        return;
      }

      if (instrumentTypes.includes('eh4')) {
        const emapDesignEntries = entries.filter(entry => isEMAPInstrument(entry.instrument));
        if (emapDesignEntries.length) {
          const mttsFiles = dataFolderFiles.filter(item => /\.mtts$/i.test(item.name || ''));
          if (!mttsFiles.length) {
            msg.warn('未在当前文件夹中找到 EMAP-1 的 MTTS 文件。');
            return;
          }
          const stations = [];
          emapDesignEntries.forEach((designEntry) => {
            const pointNo = String(designEntry.point || '').trim();
            if (!pointNo) return;
            const matchedFiles = mttsFiles.filter(file => parseMTTSPointNo(file.name) === pointNo);
            if (!matchedFiles.length) return;
            stations.push({
              idx: stations.length,
              fileId: matchedFiles[0]?.id,
              fileName: matchedFiles[0]?.name || '--',
              stationId: pointNo,
              id: pointNo,
              point: designEntry.point || '--',
              line: designEntry.line || '--',
              instrument: 'eh4',
              coordSource: '设计坐标',
              z: designEntry.z ?? null,
              gpsLongitude: designEntry.gpsLongitude,
              gpsLatitude: designEntry.gpsLatitude,
              x: designEntry.x ?? '--',
              y: designEntry.y ?? '--',
              dataMode: 'emap-mtts',
              mttsFiles: matchedFiles
            });
          });
          if (!stations.length) {
            msg.warn('未能按点号匹配到有效的 EMAP-1 MTTS 数据。');
            return;
          }
          setEh4Stations(stations.map((station, idx) => ({ ...station, idx })));
          setActiveDataset('eh4');
          setViewMode('map');
          return;
        }

        const atFiles = dataFolderFiles.filter(item => (item.name || '').startsWith('@'));
        if (!atFiles.length) {
          msg.warn('未在当前文件夹中找到 EH4 的 @ 文件。');
          return;
        }
        const designEntries = entries.filter(entry => normalizeInstrumentType(entry.instrument) === 'eh4');
        const stations = [];
        for (const file of atFiles) {
          const text = file?.content ?? (file?.rawFile instanceof File ? await file.rawFile.text() : '');
          if (!text) continue;
          try {
            const parsedStations = parseAtFile(text);
            let coordMap = {};
            const coordSidecarName = `${file.name}_coords.json`.toLowerCase();
            const coordSidecar = dataFolderFiles.find(item => (item.name || '').toLowerCase() === coordSidecarName);
            if (coordSidecar?.content) {
              try {
                const coordRows = JSON.parse(coordSidecar.content);
                coordMap = Array.isArray(coordRows)
                  ? coordRows.reduce((acc, row) => {
                      acc[String(row.id)] = row;
                      return acc;
                    }, {})
                  : {};
              } catch {
                void 0;
              }
            }
            parsedStations.forEach((station) => {
              stations.push(buildEH4StationRecord(station, file, coordMap, designEntries));
            });
          } catch {
            void 0;
          }
        }
        if (!stations.length) {
          msg.warn('未能从 @ 文件中读取到有效 EH4 总览信息。');
          return;
        }
        setEh4Stations(stations.map((station, idx) => ({ ...station, idx })));
        setActiveDataset('eh4');
        setViewMode('map');
        return;
      }

      if (instrumentTypes.includes('edi')) {
        const ediFiles = dataFolderFiles.filter(item => (item.name || '').toLowerCase().endsWith('.edi'));
        if (!ediFiles.length) {
          msg.warn('未在当前文件夹中找到 EDI 文件。');
          return;
        }
        const designEntries = entries.filter(entry => normalizeInstrumentType(entry.instrument) === 'edi');
        const stations = [];
        for (const file of ediFiles) {
          const text = file?.content ?? (file?.rawFile instanceof File ? await file.rawFile.text() : '');
          if (!text) continue;
          try {
            const mtData = parseEDIFile(text);
            const meta = parseEdiMetadata(text, file.name || '');
            const designMatch = findDesignMatch(designEntries, {
              line: meta.line,
              point: meta.point
            });
            const hasMeasuredGeo = (
              Number.isFinite(Number(meta.lon)) &&
              Number.isFinite(Number(meta.lat)) &&
              !(Number(meta.lon) === 0 && Number(meta.lat) === 0)
            );
            stations.push({
              idx: stations.length,
              fileId: file.id,
              fileName: file.name,
              point: meta.point || designMatch?.point || meta.dataId || '--',
              line: meta.line || designMatch?.line || '--',
              instrument: 'edi',
              coordSource: hasMeasuredGeo ? '实测坐标' : (designMatch ? '设计坐标' : ''),
              z: hasMeasuredGeo ? (Number.isFinite(meta.elev) ? meta.elev : (designMatch?.z ?? null)) : (designMatch?.z ?? (Number.isFinite(meta.elev) ? meta.elev : null)),
              gpsLongitude: hasMeasuredGeo ? meta.lon : (designMatch?.gpsLongitude ?? (Number.isFinite(meta.lon) ? meta.lon : undefined)),
              gpsLatitude: hasMeasuredGeo ? meta.lat : (designMatch?.gpsLatitude ?? (Number.isFinite(meta.lat) ? meta.lat : undefined)),
              x: designMatch?.x ?? '--',
              y: designMatch?.y ?? '--',
              freqCount: mtData.length
            });
          } catch {
            void 0;
          }
        }
        if (!stations.length) {
          msg.warn('未能从 EDI 文件中读取到有效头信息。');
          return;
        }
        setEdiStations(stations);
        setActiveDataset('edi');
        setViewMode('map');
        return;
      }

      msg.warn(`暂不支持该仪器类型加载总览：${instrumentTypes.join('、')}`);
    } catch (err) {
      msg.warn(`加载数据失败：${err.message}`);
    } finally {
      setLoadingData(false);
    }
  }, [dataFolderFiles, entries, buildEH4StationRecord, buildF3StationRecord, findDesignMatch, mergeF3Stations, parseEdiMetadata]);

  useEffect(() => {
    if (loading || errorMsg || loadingData) return;
    if (showCoordDialog || !entries.length) return;
    if (activeDataset !== 'design') return;
    if (hasAutoLoadedOverviewRef.current) return;

    hasAutoLoadedOverviewRef.current = true;
    handleLoadData();
  }, [activeDataset, entries.length, errorMsg, handleLoadData, loading, loadingData, showCoordDialog]);

  const handleDeleteEdiFile = async (entry) => {
    if (activeDataset !== 'edi' || !entry?.fileName || !onUpdateFileSystem) return;
    if (!await confirmDialog('确认操作', `确定删除 EDI 文件吗？\n${entry.fileName}`)) return;
    onUpdateFileSystem((fileSystem || []).filter(file => file.id !== entry.fileId));
    setEdiStations(prev => prev.filter(item => item.fileId !== entry.fileId));
  };

  const handleOverviewFieldChange = (entry, field, value) => {
    if (!entry || !['line', 'point'].includes(field)) return;
    if (activeDataset === 'design' || entry.isDesignOnly) {
      const targetIdx = entry.sourceEntryIdx ?? entry.idx;
      setEntries(prev => prev.map(item => item.idx === targetIdx ? { ...item, [field]: value } : item));
      return;
    }
    if (activeDataset === 'f3') {
      setF3Stations(prev => prev.map(item => item.idx === entry.idx ? { ...item, [field]: value } : item));
      return;
    }
    if (activeDataset === 'eh4') {
      setEh4Stations(prev => prev.map(item => item.idx === entry.idx ? { ...item, [field]: value } : item));
      return;
    }
    if (activeDataset === 'edi') {
      setEdiStations(prev => prev.map(item => item.idx === entry.idx ? { ...item, [field]: value } : item));
    }
  };

  const handleDeleteOverviewEntry = (entry) => {
    if (!entry) return;
    if (activeDataset === 'design' || entry.isDesignOnly) {
      const targetIdx = entry.sourceEntryIdx ?? entry.idx;
      setEntries(prev => prev.filter(item => item.idx !== targetIdx));
      return;
    }
    if (activeDataset === 'f3') {
      setF3Stations(prev => prev.filter(item => item.idx !== entry.idx));
      return;
    }
    if (activeDataset === 'eh4') {
      setEh4Stations(prev => prev.filter(item => item.idx !== entry.idx));
      return;
    }
    if (activeDataset === 'edi') {
      handleDeleteEdiFile(entry);
    }
  };

  const readFileText = async (file) => {
    if (!file) return '';
    if (typeof file.content === 'string') return file.content;
    if (file.rawFile instanceof File) return file.rawFile.text();
    return '';
  };

  const readFileBuffer = async (file) => {
    if (!file) return null;
    if (file.rawFile instanceof File) return file.rawFile.arrayBuffer();
    return null;
  };

  const handleExportEDI = async () => {
    if (activeDataset === 'design') {
      msg.warn('请先加载 F3、EH4 或 EDI 数据后再导出 EDI。');
      return;
    }
    try {
      const zip = new JSZip();
      const spectraFolder = zip.folder('功率谱');
      const impedanceFolder = zip.folder('阻抗');
      const resistivityFolder = zip.folder('电阻率');
      let exportCount = 0;

      if (activeDataset === 'edi') {
        for (const entry of ediStations.filter(item => !item.isDesignOnly && item.fileId)) {
          const file = dataFolderFiles.find(item => item.id === entry.fileId);
          const text = await readFileText(file);
          if (!text) continue;
          const fileName = `${String(entry.point || entry.fileName || exportCount + 1).trim() || `edi_${exportCount + 1}`}.edi`;
          impedanceFolder.file(fileName, text);
          exportCount++;
        }
      }

      if (activeDataset === 'f3') {
        for (const entry of f3Stations.filter(item => !item.isDesignOnly)) {
          const pointName = String(entry.point || entry.serial || exportCount + 1);
          const stationInfo = {
            id: pointName,
            x: Number(entry.point) || 0,
            y: Number(entry.line) || 0,
            lon: entry.gpsLongitude,
            lat: entry.gpsLatitude,
            z: entry.z ?? 0
          };
          const { rFile, psdFile } = resolveF3DataFilesForEntry(entry);
          let exportedThisPoint = false;

          if (rFile) {
            const buffer = await readFileBuffer(rFile);
            if (!buffer) continue;
            try {
              const mtData = parseF3ResistivityFile(buffer);
              if (mtData.length > 0) {
                impedanceFolder.file(`${pointName}.edi`, writeEDIFile(mtData, stationInfo, 'impedance'));
                resistivityFolder.file(`${pointName}.edi`, writeEDIFile(mtData, stationInfo, 'resistivity'));
                exportedThisPoint = true;
              }
            } catch {
              void 0;
            }
          }

          if (psdFile) {
            const buffer = await readFileBuffer(psdFile);
            if (!buffer) continue;
            try {
              const psdRows = parseF3PsdFile(buffer);
              const xData = psdRows.map(row => ({
                freq: row.frequency,
                crosspowers: [
                  row.ch1Ch1 || 0, row.ch1Ch2Imag || 0, row.ch1Ch3Imag || 0, row.ch1Ch4Imag || 0,
                  row.ch2Ch1Real || 0, row.ch2Ch2 || 0, row.ch2Ch3Imag || 0, row.ch2Ch4Imag || 0,
                  row.ch3Ch1Real || 0, row.ch3Ch2Real || 0, row.ch3Ch3 || 0, row.ch3Ch4Imag || 0,
                  row.ch4Ch1Real || 0, row.ch4Ch2Real || 0, row.ch4Ch3Real || 0, row.ch4Ch4 || 0
                ]
              }));
              if (xData.length > 0) {
                spectraFolder.file(`${pointName}.edi`, writeEDIFile(null, stationInfo, 'spectra', xData));
                exportedThisPoint = true;
              }
            } catch {
              void 0;
            }
          }

          if (exportedThisPoint) {
            exportCount++;
          }
        }
      }

      if (activeDataset === 'eh4') {
        for (const entry of eh4Stations.filter(item => !item.isDesignOnly)) {
          const pointName = String(entry.point || entry.stationId || exportCount + 1);
          const stationInfo = {
            id: entry.stationId || pointName,
            x: Number(entry.point) || 0,
            y: Number(entry.line) || 0,
            lon: entry.gpsLongitude,
            lat: entry.gpsLatitude,
            z: entry.z ?? 0
          };
          const stationId = String(entry.stationId || '').trim().toLowerCase();
          if (!stationId) continue;
          const zFile = dataFolderFiles.find(file => {
            const name = (file.name || '').toLowerCase();
            return name === `z${stationId}` || name.startsWith(`z${stationId}.`) || name.startsWith(`z${stationId}_`);
          });
          const xFile = dataFolderFiles.find(file => {
            const name = (file.name || '').toLowerCase();
            return name === `x${stationId}` || name.startsWith(`x${stationId}.`) || name.startsWith(`x${stationId}_`);
          });

          if (zFile) {
            const zText = await readFileText(zFile);
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
                  impedanceFolder.file(`${pointName}.edi`, writeEDIFile(mtData, stationInfo, 'impedance'));
                  resistivityFolder.file(`${pointName}.edi`, writeEDIFile(mtData, stationInfo, 'resistivity'));
                  exportCount++;
                }
              } catch {
                void 0;
              }
            }
          }

          if (xFile) {
            const xText = await readFileText(xFile);
            if (xText) {
              try {
                const xData = parseXFile(xText).filter(d => d.freq > 0);
                if (xData.length > 0) {
                  spectraFolder.file(`${pointName}.edi`, writeEDIFile(null, stationInfo, 'spectra', xData));
                }
              } catch {
                void 0;
              }
            }
          }
        }
      }

      if (exportCount === 0) {
        msg.warn('导出失败：未找到可导出的有效数据。');
        return;
      }

      const content = await zip.generateAsync({ type: 'blob' });
      saveAs(content, `${overviewProjectName || '项目'}_EDI_Data.zip`);
    } catch (err) {
      msg.warn(`导出 EDI 失败：${err.message}`);
    }
  };

  const resolveDataFileForEntry = (entry) => {
    if (!entry || entry.isDesignOnly) return null;
    if (activeDataset === 'edi') {
      return dataFolderFiles.find(file => file.id === entry.fileId) || null;
    }
    if (activeDataset === 'eh4') {
      if (entry.dataMode === 'emap-mtts' && Array.isArray(entry.mttsFiles) && entry.mttsFiles.length) {
        return {
          id: `mtts-group:${entry.stationId || entry.point || entry.idx}`,
          type: 'mtts-group',
          name: entry.stationId || entry.point || '--',
          pointNo: entry.stationId || entry.point || '--',
          files: entry.mttsFiles
        };
      }
      const stationId = String(entry.stationId || entry.id || entry.point || '').trim().toLowerCase();
      if (!stationId) return null;
      return dataFolderFiles.find(file => {
        const name = (file.name || '').toLowerCase();
        return name === `z${stationId}` || name.startsWith(`z${stationId}.`) || name.startsWith(`z${stationId}_`);
      }) || null;
    }
    if (activeDataset === 'f3') {
      const exactBases = Array.from(new Set([
        ...(Array.isArray(entry.dataBaseCandidates) ? entry.dataBaseCandidates : []),
        String(entry.dataBaseName || ''),
        String(entry.projectName && entry.serialText ? `${entry.projectName}.${entry.serialText}` : ''),
        String(entry.fileName || '').replace(/\.(idx|index)$/i, '')
      ].map(v => String(v || '').trim()).filter(Boolean)));
      const pointDigits = String(entry.point || '').replace(/\D/g, '');
      const fuzzySerials = Array.from(new Set([
        ...(Array.isArray(entry.serialCandidates) ? entry.serialCandidates : []),
        String(entry.serialText || '').trim(),
        pointDigits ? pointDigits.slice(-4).padStart(4, '0') : ''
      ].map(v => String(v || '').trim()).filter(Boolean)));
      const preferredNames = exactBases.flatMap(base => [
        `${base}.r`,
        `${base}.psd`,
        `${base}.fh`,
        `${base}.fm`,
        `${base}.fl`
      ]).map(name => name.toLowerCase());
      const exactMatch = dataFolderFiles.find(file => preferredNames.includes((file.name || '').toLowerCase()));
      if (exactMatch) return exactMatch;
      return dataFolderFiles.find(file => {
        const name = (file.name || '').toLowerCase();
        if (!/\.(r|psd|fh|fm|fl)$/i.test(file.name || '')) return false;
        return fuzzySerials.some(serial => name.includes(`.${serial}.`));
      }) || null;
    }
    return null;
  };

  const resolveF3DataFilesForEntry = (entry) => {
    if (!entry) return {};
    const exactBases = Array.from(new Set([
      ...(Array.isArray(entry.dataBaseCandidates) ? entry.dataBaseCandidates : []),
      String(entry.dataBaseName || ''),
      String(entry.projectName && entry.serialText ? `${entry.projectName}.${entry.serialText}` : ''),
      String(entry.fileName || '').replace(/\.(idx|index)$/i, '')
    ].map(v => String(v || '').trim()).filter(Boolean)));
    const pointDigits = String(entry.point || '').replace(/\D/g, '');
    const fuzzySerials = Array.from(new Set([
      ...(Array.isArray(entry.serialCandidates) ? entry.serialCandidates : []),
      String(entry.serialText || '').trim(),
      pointDigits ? pointDigits.slice(-4).padStart(4, '0') : ''
    ].map(v => String(v || '').trim()).filter(Boolean)));

    const findByExt = (ext) => {
      const exactNames = exactBases.map(base => `${base}.${ext}`.toLowerCase());
      const exactMatch = dataFolderFiles.find(file => exactNames.includes((file.name || '').toLowerCase()));
      if (exactMatch) return exactMatch;
      return dataFolderFiles.find(file => {
        const name = (file.name || '').toLowerCase();
        if (!name.endsWith(`.${ext}`)) return false;
        return fuzzySerials.some(serial => name.includes(`.${serial}.`));
      }) || null;
    };

    return {
      rFile: findByExt('r'),
      psdFile: findByExt('psd'),
      fhFile: findByExt('fh'),
      fmFile: findByExt('fm'),
      flFile: findByExt('fl')
    };
  };

  const handleOpenEntryData = (entry) => {
    const targetFile = resolveDataFileForEntry(entry);
    if (!targetFile) return;
    onOpenDataFile?.(targetFile);
  };

  const getEntryDisplayFileName = (entry) => {
    if (!entry) return '--';
    if (activeDataset === 'f3') {
      return entry.dataBaseName || (Array.isArray(entry.dataBaseCandidates) ? entry.dataBaseCandidates[0] : '') || '--';
    }
    if (activeDataset === 'eh4') {
      if (entry.dataMode === 'emap-mtts') {
        return entry.stationId || entry.point || '--';
      }
      return entry.stationId || entry.id || '--';
    }
    return entry.fileName || '--';
  };

  const buildF3StationRecord = (item, file, designEntries) => {
    const designMatch = findDesignMatch(designEntries, {
      line: item.line,
      point: item.point
    });
    const hasMeasuredGeo = (
      Number.isFinite(Number(item.gpsLongitude)) &&
      Number.isFinite(Number(item.gpsLatitude)) &&
      !(Number(item.gpsLongitude) === 0 && Number(item.gpsLatitude) === 0)
    );
    const serial = Number(item.index);
    const serialText = Number.isFinite(serial) ? String(Math.max(0, Math.trunc(serial))).padStart(4, '0') : '';
    const projectText = String(item.project || '').trim();
    const dataBaseName = projectText && serialText ? `${projectText}.${serialText}` : String(file.name || '').replace(/\.(idx|index)$/i, '');
    const dataBaseCandidates = Array.from(new Set([
      dataBaseName,
      projectText && serialText ? `${projectText}.${serialText}` : '',
      String(file.name || '').replace(/\.(idx|index)$/i, '')
    ].map(v => String(v || '').trim()).filter(Boolean)));

    return {
      idx: 0,
      fileId: file.id,
      fileName: file.name,
      dataBaseName,
      dataBaseCandidates,
      projectName: projectText,
      serialText,
      serialCandidates: Array.from(new Set([serialText].filter(Boolean))),
      point: item.point || designMatch?.point || '--',
      line: item.line || designMatch?.line || '--',
      instrument: 'f3',
      coordSource: hasMeasuredGeo ? '实测坐标' : '设计坐标',
      z: hasMeasuredGeo ? (Number.isFinite(Number(item.gpsElevation)) ? item.gpsElevation : (designMatch?.z ?? null)) : (designMatch?.z ?? (Number.isFinite(Number(item.gpsElevation)) ? item.gpsElevation : null)),
      gpsLongitude: hasMeasuredGeo ? item.gpsLongitude : (designMatch?.gpsLongitude ?? (Number.isFinite(Number(item.gpsLongitude)) ? item.gpsLongitude : undefined)),
      gpsLatitude: hasMeasuredGeo ? item.gpsLatitude : (designMatch?.gpsLatitude ?? (Number.isFinite(Number(item.gpsLatitude)) ? item.gpsLatitude : undefined)),
      x: designMatch?.x ?? '--',
      y: designMatch?.y ?? '--',
      serial: item.index,
      startTimeMillis: item.startTimeMillis,
      fileType: /\.index$/i.test(file.name || '') ? 'index' : 'idx'
    };
  };

  const buildEH4StationRecord = (station, file, coordMap, designEntries) => {
    const coordEntry = coordMap?.[String(station.id)] || {};
    const designMatch = findDesignMatch(designEntries, {
      line: station.y,
      point: station.x
    });
    const hasMeasuredGeo = (
      Number.isFinite(Number(coordEntry.lon)) &&
      Number.isFinite(Number(coordEntry.lat)) &&
      !(Number(coordEntry.lon) === 0 && Number(coordEntry.lat) === 0)
    );
    return {
      idx: 0,
      fileId: file.id,
      fileName: file.name,
      atFileName: file.name,
      stationId: station.id,
      id: station.id,
      point: designMatch?.point ?? station.x,
      line: designMatch?.line ?? station.y,
      instrument: 'eh4',
      coordSource: hasMeasuredGeo ? '实测坐标' : (designMatch ? '设计坐标' : ''),
      z: hasMeasuredGeo ? (Number.isFinite(Number(coordEntry.z)) ? coordEntry.z : (designMatch?.z ?? station.z)) : (designMatch?.z ?? station.z),
      gpsLongitude: hasMeasuredGeo ? coordEntry.lon : designMatch?.gpsLongitude,
      gpsLatitude: hasMeasuredGeo ? coordEntry.lat : designMatch?.gpsLatitude,
      x: designMatch?.x ?? station.x,
      y: designMatch?.y ?? station.y,
      rx: station.rx,
      ry: station.ry,
      xl: station.xl,
      yl: station.yl
    };
  };

  const mergeF3Stations = (stations) => {
    const merged = new Map();
    stations.forEach((station) => {
      const key = `${normalizeCoordKey(station.line)}__${normalizeCoordKey(station.point)}`;
      if (!key || key === '__') {
        merged.set(`${station.fileName}__${station.serial ?? station.idx}`, station);
        return;
      }
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, station);
        return;
      }
      const existingMeasured = existing.coordSource === '实测坐标';
      const currentMeasured = station.coordSource === '实测坐标';
      const mergedStation = {
        ...existing,
        dataBaseCandidates: Array.from(new Set([...(existing.dataBaseCandidates || []), ...(station.dataBaseCandidates || [])])),
        serialCandidates: Array.from(new Set([...(existing.serialCandidates || []), ...(station.serialCandidates || [])]))
      };
      if (!existingMeasured && currentMeasured) {
        merged.set(key, { ...mergedStation, ...station, dataBaseCandidates: mergedStation.dataBaseCandidates, serialCandidates: mergedStation.serialCandidates });
        return;
      }
      if (existingMeasured === currentMeasured) {
        const existingIsIndex = existing.fileType === 'index';
        const currentIsIndex = station.fileType === 'index';
        if (!existingIsIndex && currentIsIndex) {
          merged.set(key, { ...mergedStation, ...station, dataBaseCandidates: mergedStation.dataBaseCandidates, serialCandidates: mergedStation.serialCandidates });
        } else {
          merged.set(key, mergedStation);
        }
      } else {
        merged.set(key, mergedStation);
      }
    });
    return Array.from(merged.values()).map((station, idx) => ({ ...station, idx }));
  };

  const modalStyle = maximized
    ? { width: '100vw', height: '100vh', borderRadius: 0, border: 'none', boxShadow: 'none', background: '#fff', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
    : { width: '95vw', maxWidth: '1500px', height: '88vh', borderRadius: '16px', border: '1px solid var(--border-color)', boxShadow: '0 20px 40px rgba(0,0,0,0.2)', background: '#fff', display: 'flex', flexDirection: 'column', overflow: 'hidden' };

  const coordLabelPrefix = activeDataset === 'design' ? '设计' : '坐标';
  const pageTitle = activeDataset === 'edi'
    ? 'EDI 数据总览'
    : activeDataset === 'f3'
      ? 'F3 数据总览'
      : activeDataset === 'eh4'
        ? 'EH4 数据总览'
      : fileObj?.name || '设计坐标文件';
  const pageSubtitle = activeDataset === 'edi'
    ? 'EDI 数据总览与测点分布图'
    : activeDataset === 'f3'
      ? 'F3 数据总览与测点分布图'
      : activeDataset === 'eh4'
        ? 'EH4 数据总览与测点分布图'
      : '设计坐标点位布置图';
  const fileTypeLabel = activeDataset === 'edi'
    ? 'EDI'
    : activeDataset === 'f3'
      ? 'F3'
      : activeDataset === 'eh4'
        ? 'EH4'
      : '设计坐标';
  const mapTabLabel = activeDataset === 'design' ? '点位布置图' : '测点布置图';
  const tableTabLabel = activeDataset === 'design' ? '数据列表' : '测点列表';
  const overviewProjectName = useMemo(() => {
    const rawName = String(fileObj?.name || '').replace(/\.[^.]+$/, '');
    const cleaned = rawName.replace(/设计坐标/gi, '').trim();
    return cleaned || rawName || '--';
  }, [fileObj]);
  const designTotalCount = useMemo(() => {
    if (activeDataset === 'design') return entries.length;
    return entries.filter(entry => normalizeInstrumentType(entry.instrument) === activeDataset).length;
  }, [activeDataset, entries]);
  const dataPointCount = useMemo(() => {
    return activeDataset === 'design' ? displayEntries.length : datasetStations.length;
  }, [activeDataset, displayEntries.length, datasetStations.length]);

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: maximized ? 'transparent' : 'rgba(0,0,0,0.6)', backdropFilter: maximized ? 'none' : 'blur(4px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card glass" style={modalStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: maximized ? '12px 20px' : '0 0 16px 0', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <MapIcon size={24} color="#3b82f6" />
            <div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#0f172a' }}>{pageTitle}</h3>
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>{pageSubtitle}</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: '6px', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
              <button onClick={() => setViewMode('map')} style={{ background: viewMode === 'map' ? '#3b82f6' : 'transparent', color: viewMode === 'map' ? '#fff' : '#64748b', border: 'none', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: 500 }}>
                <MapIcon size={14} /> {mapTabLabel}
              </button>
              <button onClick={() => setViewMode('table')} style={{ background: viewMode === 'table' ? '#3b82f6' : 'transparent', color: viewMode === 'table' ? '#fff' : '#64748b', border: 'none', borderLeft: '1px solid #e2e8f0', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: 500 }}>
                <List size={14} /> {tableTabLabel}
              </button>
            </div>
            <button onClick={() => setMaximized(v => !v)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}>
              {maximized ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
            </button>
            <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#64748b' }}>
              <X size={24} />
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', paddingTop: '16px' }}>
          {loading && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: '#3b82f6' }}>
              <Loader2 size={32} className="spin" />
              <span>正在解析设计坐标文件...</span>
            </div>
          )}

          {!loading && errorMsg && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: '#ef4444' }}>
              <X size={48} />
              <p style={{ fontWeight: 500 }}>{errorMsg}</p>
            </div>
          )}

          {!loading && !errorMsg && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', gap: '20px', padding: '12px 20px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: '13px', alignItems: 'center' }}>
                {activeDataset === 'design' ? (
                  <>
                    <div>点位总数: <b style={{ color: '#0f172a' }}>{displayEntries.length}</b> 个</div>
                    <div style={{ color: '#cbd5e1' }}>|</div>
                    <div>文件类型: <b style={{ color: '#0f172a' }}>{fileTypeLabel}</b></div>
                    <div style={{ color: '#cbd5e1' }}>|</div>
                    <div>文件名: <b style={{ color: '#0f172a' }}>{fileObj?.name || '--'}</b></div>
                  </>
                ) : (
                  <>
                    <div>项目名称: <b style={{ color: '#0f172a' }}>{overviewProjectName}</b></div>
                    <div style={{ color: '#cbd5e1' }}>|</div>
                    <div>设计总数: <b style={{ color: '#0f172a' }}>{designTotalCount}</b> 个</div>
                    <div style={{ color: '#cbd5e1' }}>|</div>
                    <div>数据点数: <b style={{ color: '#0f172a' }}>{dataPointCount}</b> 个</div>
                  </>
                )}
                {activeDataset === 'design' && entries.length > 0 && (
                  <>
                    <div style={{ color: '#cbd5e1' }}>|</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <span style={{ color: '#64748b' }}>仪器图例:</span>
                      {Object.keys(instrumentColorMap).length > 0 ? Object.entries(instrumentColorMap).map(([instrument, color]) => (
                        <span key={instrument} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#0f172a' }}>
                          <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: color, display: 'inline-block' }} />
                          {instrument}
                        </span>
                      )) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#0f172a' }}>
                          <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: '#64748b', display: 'inline-block' }} />
                          未标注
                        </span>
                      )}
                    </div>
                  </>
                )}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                  {activeDataset !== 'design' && (
                    <button onClick={handleExportEDI} style={{ background: '#10b981', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 500 }}>
                      <Download size={14} /> 导出EDI
                    </button>
                  )}
                  <button onClick={handleLoadData} disabled={loadingData || entries.length === 0} style={{ background: loadingData ? '#94a3b8' : '#3b82f6', color: '#fff', border: 'none', borderRadius: '4px', cursor: loadingData || entries.length === 0 ? 'not-allowed' : 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 500 }}>
                    {loadingData ? <Loader2 size={14} className="animate-spin" /> : <Settings size={14} />} 加载数据
                  </button>
                </div>
              </div>

              <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                {displayEntries.length === 0 ? (
                  <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: '15px' }}>
                    {activeDataset === 'design' ? '请先确认坐标类型并解析设计坐标文件' : '未加载到数据总览'}
                  </div>
                ) : viewMode === 'map' ? (
                  <MapContainer bounds={mapBounds} style={{ height: '100%', width: '100%' }}>
                    <TileLayer
                      url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                      attribution='Tiles &copy; Esri'
                    />
                    {displayEntries.filter(entry => Number.isFinite(entry.gpsLatitude) && Number.isFinite(entry.gpsLongitude)).map((entry) => (
                      <CircleMarker
                        key={`${entry.line}_${entry.point}_${entry.idx}`}
                        center={[entry.gpsLatitude, entry.gpsLongitude]}
                        radius={4}
                        pathOptions={{ color: '#fff', weight: 1, fillColor: displayInstrumentColor(entry), fillOpacity: 0.85 }}
                        eventHandlers={{
                          click: () => handleOpenEntryData(entry)
                        }}
                      >
                        <Tooltip direction="bottom" offset={[0, 5]} opacity={1}>
                          <div style={{ fontSize: '13px', lineHeight: '1.6', padding: '2px 4px' }}>
                            <b>测点: {entry.point || '--'}</b><br/>
                            测线: {entry.line || '--'}<br/>
                            仪器: {entry.instrument || '--'}<br/>
                            {getEntryDisplayFileName(entry) !== '--' ? <>文件名: {getEntryDisplayFileName(entry)}<br/></> : null}
                            {activeDataset === 'f3' && entry.serial !== undefined ? <>序号: {entry.serial}<br/></> : null}
                            {activeDataset === 'eh4' && entry.stationId ? <>测点编号: {entry.stationId}<br/></> : null}
                            {entry.coordSource ? <>坐标来源: {entry.coordSource}<br/></> : null}
                            {coordLabelPrefix}经度: {entry.gpsLongitude?.toFixed?.(6) ?? '--'}°<br/>
                            {coordLabelPrefix}纬度: {entry.gpsLatitude?.toFixed?.(6) ?? '--'}°<br/>
                            {coordLabelPrefix}高程: {entry.z ?? '--'} m<br/>
                            <span style={{ color: resolveDataFileForEntry(entry) ? '#3b82f6' : '#94a3b8' }}>
                              {resolveDataFileForEntry(entry) ? '点击打开数据' : '无可打开数据'}
                            </span>
                          </div>
                        </Tooltip>
                      </CircleMarker>
                    ))}
                  </MapContainer>
                ) : (
                  <div style={{ height: '100%', overflow: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
                      <thead style={{ position: 'sticky', top: 0, background: '#f8fafc', zIndex: 10, boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                        <tr>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>序号</th>
                          {(activeDataset === 'edi' || activeDataset === 'f3' || activeDataset === 'eh4') && <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>文件名</th>}
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>{activeDataset === 'eh4' ? '线号' : '测线'}</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>{activeDataset === 'eh4' ? '点号' : '测点'}</th>
                          {activeDataset !== 'edi' && activeDataset !== 'eh4' && <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>X</th>}
                          {activeDataset !== 'edi' && activeDataset !== 'eh4' && <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>Y</th>}
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>{coordLabelPrefix}经度</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>{coordLabelPrefix}纬度</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>{coordLabelPrefix}高程</th>
                          {activeDataset !== 'edi' && activeDataset !== 'eh4' && <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>仪器</th>}
                          {activeDataset === 'eh4' && <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>坐标来源</th>}
                          {activeDataset === 'edi' && <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>坐标来源</th>}
                          {activeDataset === 'f3' && <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>坐标来源</th>}
                          {activeDataset === 'f3' && <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>序号</th>}
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>删除</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayEntries.map((entry, idx) => (
                          <tr key={`${entry.line}_${entry.point}_${idx}`} style={{ borderBottom: '1px solid #e2e8f0', background: entry.isDesignOnly ? '#fff7ed' : '#fff' }}>
                            <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#94a3b8' }}>{idx + 1}</td>
                            {(activeDataset === 'edi' || activeDataset === 'f3' || activeDataset === 'eh4') && (
                              <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>
                                <span
                                  onClick={() => handleOpenEntryData(entry)}
                                  style={{
                                    cursor: resolveDataFileForEntry(entry) ? 'pointer' : 'default',
                                    color: resolveDataFileForEntry(entry) ? '#3b82f6' : (entry.isDesignOnly ? '#f59e0b' : '#0f172a'),
                                    fontWeight: resolveDataFileForEntry(entry) ? 600 : 400
                                  }}
                                  title={resolveDataFileForEntry(entry) ? '点击打开数据' : undefined}
                                >
                                  {getEntryDisplayFileName(entry)}
                                </span>
                              </td>
                            )}
                            <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>
                              <input
                                type="text"
                                value={entry.line ?? ''}
                                onChange={(e) => handleOverviewFieldChange(entry, 'line', e.target.value)}
                                style={{ width: '84px', padding: '4px 8px', borderRadius: '6px', border: '1px solid #dbeafe', outline: 'none', color: entry.isDesignOnly ? '#c2410c' : '#0f172a', background: entry.isDesignOnly ? '#fff7ed' : '#fff' }}
                              />
                            </td>
                            <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>
                              <input
                                type="text"
                                value={entry.point ?? ''}
                                onChange={(e) => handleOverviewFieldChange(entry, 'point', e.target.value)}
                                style={{ width: '84px', padding: '4px 8px', borderRadius: '6px', border: '1px solid #dbeafe', outline: 'none', color: entry.isDesignOnly ? '#c2410c' : '#0f172a', background: entry.isDesignOnly ? '#fff7ed' : '#fff' }}
                              />
                            </td>
                            {activeDataset !== 'edi' && activeDataset !== 'eh4' && <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>{entry.x ?? '--'}</td>}
                            {activeDataset !== 'edi' && activeDataset !== 'eh4' && <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>{entry.y ?? '--'}</td>}
                            <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>{entry.gpsLongitude?.toFixed?.(6) ?? '--'}</td>
                            <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>{entry.gpsLatitude?.toFixed?.(6) ?? '--'}</td>
                            <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>{entry.z ?? '--'}</td>
                            {activeDataset !== 'edi' && activeDataset !== 'eh4' && <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: displayInstrumentColor(entry), display: 'inline-block' }} />
                                {entry.instrument || '--'}
                              </span>
                            </td>}
                            {activeDataset === 'eh4' && <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>{entry.coordSource || '--'}</td>}
                            {activeDataset === 'edi' && <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>{entry.coordSource || '--'}</td>}
                            {activeDataset === 'f3' && <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>{entry.coordSource || '--'}</td>}
                            {activeDataset === 'f3' && <td style={{ padding: '10px 20px', color: entry.isDesignOnly ? '#f59e0b' : '#0f172a' }}>{entry.serial ?? '--'}</td>}
                            <td style={{ padding: '10px 20px' }}>
                              <button
                                onClick={() => handleDeleteOverviewEntry(entry)}
                                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: entry.isDesignOnly ? '#f59e0b' : '#ef4444', display: 'flex', alignItems: 'center', padding: 0 }}
                                title={activeDataset === 'edi' && !entry.isDesignOnly ? '删除该 EDI 文件' : '删除该测点'}
                              >
                                <Trash2 size={16} />
                              </button>
                            </td>
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

        {showCoordDialog && !loading && !errorMsg && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }}>
            <div style={{ width: '450px', background: '#fff', borderRadius: '12px', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)', overflow: 'hidden' }}>
              <div style={{ padding: '16px 24px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc' }}>
                <h4 style={{ margin: 0, color: '#0f172a', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Settings size={18} color="#3b82f6" /> 导入坐标投影参数设置
                </h4>
                <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><X size={20} /></button>
              </div>

              <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '13px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <label style={{ color: '#475569', fontWeight: 500 }}>坐标类型</label>
                  <select
                    value={coordParams.coordType}
                    onChange={(e) => setCoordParams({ ...coordParams, coordType: e.target.value })}
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
                      onChange={(e) => setCoordParams({ ...coordParams, lonlatFormat: e.target.value })}
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
                      <input type="number" value={coordParams.centralMeridian} onChange={(e) => setCoordParams({ ...coordParams, centralMeridian: parseFloat(e.target.value) || 102 })} style={{ width: '220px', padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <label style={{ color: '#475569', fontWeight: 500 }}>纬度基线 [°]</label>
                      <input type="number" value={coordParams.latOrigin} onChange={(e) => setCoordParams({ ...coordParams, latOrigin: parseFloat(e.target.value) || 0 })} style={{ width: '220px', padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <label style={{ color: '#475569', fontWeight: 500 }}>东偏移 [米]</label>
                      <input type="number" value={coordParams.falseEasting} onChange={(e) => setCoordParams({ ...coordParams, falseEasting: parseFloat(e.target.value) || 500000 })} style={{ width: '220px', padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <label style={{ color: '#475569', fontWeight: 500 }}>北偏移 [米]</label>
                      <input type="number" value={coordParams.falseNorthing} onChange={(e) => setCoordParams({ ...coordParams, falseNorthing: parseFloat(e.target.value) || 0 })} style={{ width: '220px', padding: '6px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }} />
                    </div>
                  </>
                )}

                <div style={{ padding: '10px 12px', background: '#eff6ff', borderRadius: '6px', display: 'flex', gap: '8px', color: '#1e3a8a', border: '1px solid #bfdbfe', marginTop: '8px' }}>
                  <Info size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                  <div style={{ lineHeight: '1.5' }}>
                    <b>设计坐标文件格式要求：</b><br />
                    请确保 Excel 文件为 <b>6列</b> 数据，每列依次代表：<br />
                    <b>第1列</b>：测线&nbsp;&nbsp;&nbsp;<b>第2列</b>：测点<br />
                    <b>第3列</b>：X&nbsp;&nbsp;&nbsp;<b>第4列</b>：Y<br />
                    <b>第5列</b>：高程 Z (m)&nbsp;&nbsp;&nbsp;<b>第6列</b>：仪器
                  </div>
                </div>
              </div>

              <div style={{ padding: '16px 24px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', gap: '12px', background: '#f8fafc' }}>
                <button onClick={onClose} style={{ background: '#fff', color: '#475569', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '6px 16px', cursor: 'pointer', fontWeight: 500 }}>
                  取消
                </button>
                <button
                  onClick={handleParseDesignCoords}
                  style={{ background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 16px', cursor: 'pointer', fontWeight: 500 }}
                >
                  确定并显示
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DesignCoordViewer;
