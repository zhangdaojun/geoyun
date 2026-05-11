import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactECharts from './LazyECharts';
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import * as XLSX from 'xlsx';
import proj4 from 'proj4';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { X, Maximize2, Minimize2, Loader2, FileSearch, Map as MapIcon, List, Layers, Upload, Download, Settings, Info, Trash2 } from 'lucide-react';
import { parseF3IndexFile, parseF3PsdFile, parseF3ResistivityFile, writeEDIFile, writeF3IndexFile } from '../utils/eh4io';
import { msg, confirmDialog } from '../utils/message';
import { resolveDriveFileContent } from '../utils/driveFileContent';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const F3IndexViewer = ({ fileObj, fileSystem, onClose, onOpenFile, onUpdateFileSystem, isBackground = false }) => {
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [readingMeasured, setReadingMeasured] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [viewMode, setViewMode] = useState('map');
  const [entries, setEntries] = useState([]);
  const [designCoordLookup, setDesignCoordLookup] = useState({});
  const [showCoordDialog, setShowCoordDialog] = useState(false);
  const [coordParams, setCoordParams] = useState({
    coordType: 'lonlat',
    lonlatFormat: 'degree',
    centralMeridian: 102,
    latOrigin: 0,
    falseEasting: 500000,
    falseNorthing: 0,
    scale: 1
  });
  const coordFileInputRef = useRef(null);

  const applyMeasuredCoords = (entry, measured = {}) => ({
    ...entry,
    measuredLongitude: Number.isFinite(Number(measured.measuredLongitude)) ? Number(measured.measuredLongitude) : entry.measuredLongitude,
    measuredLatitude: Number.isFinite(Number(measured.measuredLatitude)) ? Number(measured.measuredLatitude) : entry.measuredLatitude,
    measuredElevation: Number.isFinite(Number(measured.measuredElevation)) ? Number(measured.measuredElevation) : entry.measuredElevation,
    measuredX: Number.isFinite(Number(measured.measuredX)) ? Number(measured.measuredX) : entry.measuredX,
    measuredY: Number.isFinite(Number(measured.measuredY)) ? Number(measured.measuredY) : entry.measuredY,
    gpsLongitude: Number.isFinite(Number(measured.measuredLongitude)) ? Number(measured.measuredLongitude) : entry.gpsLongitude,
    gpsLatitude: Number.isFinite(Number(measured.measuredLatitude)) ? Number(measured.measuredLatitude) : entry.gpsLatitude,
    gpsElevation: Number.isFinite(Number(measured.measuredElevation)) ? Number(measured.measuredElevation) : entry.gpsElevation,
    realX: Number.isFinite(Number(measured.measuredX)) ? Number(measured.measuredX) : entry.realX,
    realY: Number.isFinite(Number(measured.measuredY)) ? Number(measured.measuredY) : entry.realY
  });

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        setErrorMsg('');

        const buffer = await readBinaryFile(fileObj);
        if (!buffer) {
          throw new Error('INDEX 文件内容不可用，请重新上传该文件');
        }

        const parsed = parseF3IndexFile(buffer);
        if (!parsed.length) {
          throw new Error('INDEX/IDX 文件未解析到有效测点');
        }

        const sortedParsed = [...parsed].sort((a, b) => {
          const av = Number.isFinite(a.index) ? a.index : 0;
          const bv = Number.isFinite(b.index) ? b.index : 0;
          return av - bv;
        });
        setEntries(sortedParsed.map(entry => applyMeasuredCoords(entry, {
          measuredLongitude: entry.gpsLongitude,
          measuredLatitude: entry.gpsLatitude,
          measuredElevation: entry.gpsElevation,
          measuredX: entry.realX,
          measuredY: entry.realY
        })));
      } catch (e) {
        setErrorMsg(e.message || 'INDEX/IDX 解析失败');
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [fileObj]);

  const projectName = useMemo(() => entries[0]?.project || fileObj?.name || 'F3项目', [entries, fileObj]);

  const stationFiles = useMemo(() => {
    const folderId = fileObj?.parentId ?? null;
    return (fileSystem || []).filter(item => {
      if (item.type !== 'file') return false;
      if (folderId !== null && item.parentId !== folderId) return false;
      return true;
    });
  }, [fileSystem, fileObj]);

  const designCoordFile = useMemo(() => {
    return stationFiles.find(item => /设计坐标/.test(item.name || '') && /\.(xlsx|xls)$/i.test(item.name || '')) || null;
  }, [stationFiles]);

  const designCoordParamFile = useMemo(() => {
    if (!designCoordFile?.name) return null;
    const sidecarName = `${designCoordFile.name}.coord_params.json`.toLowerCase();
    return stationFiles.find(item => (item.name || '').toLowerCase() === sidecarName) || null;
  }, [stationFiles, designCoordFile]);

  const makeCoordKey = (line, point) => `${String(line ?? '').trim().toLowerCase()}__${String(point ?? '').trim().toLowerCase()}`;

  const pointIdxFiles = useMemo(() => {
    return stationFiles.filter(item =>
      item.id !== fileObj?.id &&
      (item.name || '').toLowerCase().endsWith('.idx')
    );
  }, [stationFiles, fileObj]);

  const hasValidGeo = (entry) => (
    Number.isFinite(Number(entry?.gpsLongitude)) &&
    Number.isFinite(Number(entry?.gpsLatitude)) &&
    !(Number(entry?.gpsLongitude) === 0 && Number(entry?.gpsLatitude) === 0)
  );

  const getEntrySerialCandidates = (entry) => {
    const candidates = [];
    const pushSerial = (raw) => {
      if (raw === undefined || raw === null) return;
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      candidates.push(String(Math.max(0, Math.trunc(n))).padStart(4, '0'));
      candidates.push(String(Math.max(0, Math.trunc(n % 10000))).padStart(4, '0'));
    };
    pushSerial(entry?.index);
    return Array.from(new Set(candidates.filter(Boolean)));
  };

  const resolvePointIdxFile = (entry) => {
    const projectRaw = (entry.project || '').trim();
    const serialCandidates = getEntrySerialCandidates(entry);
    for (const serial of serialCandidates) {
      const expected = `${projectRaw}.${serial}.idx`.toLowerCase();
      const exact = stationFiles.find(f =>
        f.id !== fileObj?.id &&
        (f.name || '').toLowerCase() === expected
      );
      if (exact) return exact;
    }
    return null;
  };

  const hydrateEntriesFromPointIdxFiles = async (sourceEntries, onlyMissing = false) => {
    let nextEntries = Array.isArray(sourceEntries) ? sourceEntries.map(entry => ({ ...entry })) : [];
    let updated = false;
    const parsedIdxFileCache = new Map();

    const getParsedIdxEntries = async (idxFile) => {
      if (!idxFile) return [];
      if (parsedIdxFileCache.has(idxFile.id)) return parsedIdxFileCache.get(idxFile.id);
      const idxBuffer = await readBinaryFile(idxFile);
      if (!idxBuffer) {
        parsedIdxFileCache.set(idxFile.id, []);
        return [];
      }
      const parsed = parseF3IndexFile(idxBuffer);
      parsedIdxFileCache.set(idxFile.id, parsed);
      return parsed;
    };

    for (const idxFile of pointIdxFiles) {
      await getParsedIdxEntries(idxFile);
    }

    for (let i = 0; i < nextEntries.length; i++) {
      const entry = nextEntries[i];
      if (onlyMissing && hasValidGeo(entry)) continue;

      const exactIdxFile = resolvePointIdxFile(entry);
      const exactIdxEntries = exactIdxFile ? await getParsedIdxEntries(exactIdxFile) : [];
      const allIdxEntries = [
        ...exactIdxEntries.map(item => ({ ...item, __sourceFileName: exactIdxFile?.name || '' })),
        ...pointIdxFiles
          .filter(file => !exactIdxFile || file.id !== exactIdxFile.id)
          .flatMap(file => (parsedIdxFileCache.get(file.id) || []).map(item => ({ ...item, __sourceFileName: file.name || '' })))
      ];

      const matchedIdxEntry = allIdxEntries.find(item =>
        hasValidGeo(item) && (
          Number(item.index) === Number(entry.index) ||
          (String(item.point || '').trim() === String(entry.point || '').trim() && String(item.line || '').trim() === String(entry.line || '').trim()) ||
          (String(item.point || '').trim() === String(entry.point || '').trim())
        )
      ) || allIdxEntries.find(item =>
        hasValidGeo(item) && getEntrySerialCandidates(entry).some(serial =>
          String(item.__sourceFileName || '').toLowerCase() === `${String(entry.project || '').trim().toLowerCase()}.${serial}.idx`
        )
      ) || allIdxEntries.find(item => hasValidGeo(item));

      if (!matchedIdxEntry) continue;

      nextEntries[i] = applyMeasuredCoords(nextEntries[i], {
        measuredLongitude: matchedIdxEntry.gpsLongitude,
        measuredLatitude: matchedIdxEntry.gpsLatitude,
        measuredElevation: matchedIdxEntry.gpsElevation
      });
      updated = true;
    }

    return { entries: nextEntries, updated };
  };

  const coordSidecarName = useMemo(() => {
    const project = (entries[0]?.project || '').trim();
    return project ? `${project}_coords.json` : null;
  }, [entries]);

  const coordSidecarFile = useMemo(() => {
    if (!coordSidecarName) return null;
    return stationFiles.find(f => (f.name || '').toLowerCase() === coordSidecarName.toLowerCase()) || null;
  }, [stationFiles, coordSidecarName]);

  useEffect(() => {
    if (!coordSidecarFile?.content || entries.length === 0) return;
    try {
      const parsed = JSON.parse(coordSidecarFile.content);
      const rows = Array.isArray(parsed?.coords) ? parsed.coords : [];
      if (rows.length === 0) return;
      setEntries(prev => prev.map(entry => {
        const match = rows.find(row => Number(row.line) === Number(entry.line) && Number(row.point) === Number(entry.point));
        if (!match) return entry;
        return applyMeasuredCoords(entry, {
          measuredLongitude: match.measuredLon ?? match.lon,
          measuredLatitude: match.measuredLat ?? match.lat,
          measuredElevation: match.measuredZ ?? match.z,
          measuredX: match.measuredX ?? match.realX,
          measuredY: match.measuredY ?? match.realY
        });
      }));
    } catch {
      void 0;
    }
  }, [coordSidecarFile?.content, entries.length]);

  const findRelated = useCallback((entry, ext) => {
    const projectRaw = (entry.project || '').trim();
    const indexNum = Number(entry.index);
    if (projectRaw && Number.isFinite(indexNum)) {
      const serial = String(Math.max(0, Math.trunc(indexNum))).padStart(4, '0');
      const expected = `${projectRaw}.${serial}.${ext}`.toLowerCase();
      const exact = stationFiles.find(f => ((f.name || '').toLowerCase() === expected));
      if (exact) return exact;
    }
    return null;
  }, [stationFiles]);

  const dateText = (ms) => {
    if (!Number.isFinite(ms)) return '--';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '--';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  };

  const parseLonLat = (valStr, format) => {
    if (!valStr && valStr !== 0) return NaN;
    const str = String(valStr).trim();
    if (format === 'degree') {
      return parseFloat(str);
    } else if (format === 'degree_minute') {
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
    } else if (format === 'dms') {
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

  useEffect(() => {
    const loadDesignCoords = async () => {
      if (!designCoordFile || !designCoordParamFile?.content) {
        setDesignCoordLookup({});
        return;
      }
      try {
        const parsedConfig = JSON.parse(designCoordParamFile.content);
        const designParams = parsedConfig?.coordParams;
        if (!designParams || typeof designParams !== 'object') {
          setDesignCoordLookup({});
          return;
        }
        const buffer = await readBinaryFile(designCoordFile);
        if (!buffer) {
          setDesignCoordLookup({});
          return;
        }
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
          const z = Number(row[4]);

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
            line: String(line ?? '').trim(),
            point: String(point ?? '').trim(),
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
  }, [designCoordFile?.id, designCoordFile?.rawFile, designCoordParamFile?.content]);

  const enrichedEntries = useMemo(() => {
    return entries.map((entry, idx) => {
      const rFile = findRelated(entry, 'r');
      const psdFile = findRelated(entry, 'psd');
      const fhFile = findRelated(entry, 'fh');
      const fmFile = findRelated(entry, 'fm');
      const flFile = findRelated(entry, 'fl');
      const lineNum = Number(entry.line);
      const pointNum = Number(entry.point);
      const fileNames = [rFile?.name, psdFile?.name, fhFile?.name, fmFile?.name, flFile?.name].filter(Boolean);
      const displayFileNames = Array.from(new Set(
        fileNames.map(name => String(name).replace(/\.[^.]+$/, ''))
      ));
      const designCoords = designCoordLookup[makeCoordKey(entry.line, entry.point)] || null;
      const hasMeasuredCoords = Number.isFinite(Number(entry.measuredLongitude ?? entry.gpsLongitude)) &&
        Number.isFinite(Number(entry.measuredLatitude ?? entry.gpsLatitude)) &&
        !(Number(entry.measuredLongitude ?? entry.gpsLongitude) === 0 && Number(entry.measuredLatitude ?? entry.gpsLatitude) === 0);
      const displayLongitude = hasMeasuredCoords ? (entry.measuredLongitude ?? entry.gpsLongitude) : designCoords?.designLongitude;
      const displayLatitude = hasMeasuredCoords ? (entry.measuredLatitude ?? entry.gpsLatitude) : designCoords?.designLatitude;
      const displayElevation = hasMeasuredCoords ? (entry.measuredElevation ?? entry.gpsElevation) : designCoords?.designElevation;
      const coordSource = hasMeasuredCoords ? '实测坐标' : (designCoords ? '设计坐标' : '');
      return {
        ...entry,
        idx,
        rFile,
        psdFile,
        fhFile,
        fmFile,
        flFile,
        fileNames,
        displayFileNames,
        designLongitude: designCoords?.designLongitude,
        designLatitude: designCoords?.designLatitude,
        designElevation: designCoords?.designElevation,
        displayLongitude,
        displayLatitude,
        displayElevation,
        coordSource,
        lineNum: Number.isFinite(lineNum) ? lineNum : null,
        pointNum: Number.isFinite(pointNum) ? pointNum : null
      };
    });
  }, [entries, designCoordLookup, findRelated]);

  const mapData = useMemo(() => {
    return enrichedEntries
      .filter(e => e.lineNum !== null && e.pointNum !== null)
      .map(e => ({
        value: [e.lineNum, e.pointNum],
        rowIndex: e.idx,
        hasDataFile: Boolean(e.rFile || e.psdFile)
      }));
  }, [enrichedEntries]);

  const resolveRFileForEntry = (entry) => {
    if (!entry) return null;
    if (entry.rFile) return entry.rFile;
    const projectRaw = (entry.project || '').trim();
    const candidates = [];
    const pushSerial = (raw) => {
      if (raw === undefined || raw === null) return;
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      candidates.push(String(Math.max(0, Math.trunc(n))).padStart(4, '0'));
      candidates.push(String(Math.max(0, Math.trunc(n % 10000))).padStart(4, '0'));
    };
    pushSerial(entry.index);
    const unique = Array.from(new Set(candidates));
    for (const serial of unique) {
      const expected = `${projectRaw}.${serial}.r`.toLowerCase();
      const exact = stationFiles.find(f => ((f.name || '').toLowerCase() === expected));
      if (exact) return exact;
    }
    return null;
  };

  const handleDeleteEntryFiles = async (entry) => {
    if (!entry || !onUpdateFileSystem) return;
    const targets = [entry.rFile, entry.psdFile, entry.fhFile, entry.fmFile, entry.flFile].filter(Boolean);
    if (targets.length === 0) {
      msg.warn('该测点没有可删除的数据文件。');
      return;
    }
    const displayNames = targets.map(file => file.name).join('、');
    if (!await confirmDialog('确认操作', `确定删除该测点关联的数据文件吗？\n${displayNames}`)) {
      return;
    }
    const targetIds = new Set(targets.map(file => file.id));
    onUpdateFileSystem((fileSystem || []).filter(file => !targetIds.has(file.id)));
  };

  const persistEntriesCoords = (nextEntries) => {
    persistIndexToFileSystem(nextEntries);
    persistCoordsToFileSystem(nextEntries.map(entry => ({
      line: entry.line,
      point: entry.point,
      measuredLon: entry.measuredLongitude ?? entry.gpsLongitude,
      measuredLat: entry.measuredLatitude ?? entry.gpsLatitude,
      measuredZ: entry.measuredElevation ?? entry.gpsElevation,
      measuredX: entry.measuredX ?? entry.realX,
      measuredY: entry.measuredY ?? entry.realY
    })));
  };

  const handleEntryFieldChange = (entryIdx, field, value) => {
    const nextEntries = entries.map((entry, idx) => (
      idx === entryIdx ? { ...entry, [field]: value } : entry
    ));
    setEntries(nextEntries);
    persistEntriesCoords(nextEntries);
  };

  const openEntry = (entry, preferred = 'R') => {
    if (!entry) return;

    if (preferred === 'PSD') {
      if (entry.psdFile) onOpenFile?.(entry.psdFile);
      return;
    }
    const file = resolveRFileForEntry(entry);
    if (file) {
      onOpenFile?.(file);
      return;
    }
    msg.warn(`未找到该测点对应的R文件。\n建议命名：${(entry.project || projectName).trim()}.${String(Math.max(0, Math.trunc(Number(entry.index) || 0))).padStart(4, '0')}.R`);
  };

  const persistCoordsToFileSystem = (coordsRows) => {
    if (!onUpdateFileSystem || !coordSidecarName) return;
    const content = JSON.stringify({ coords: coordsRows }, null, 2);
    const folderId = fileObj?.parentId ?? null;
    const nextFile = {
      id: coordSidecarFile?.id || `fid_${Date.now()}`,
      parentId: folderId,
      type: 'file',
      name: coordSidecarName,
      date: new Date().toISOString().split('T')[0],
      size: `${content.length} B`,
      ext: 'json',
      content
    };
    const nextFs = coordSidecarFile
      ? (fileSystem || []).map(f => (f.id === coordSidecarFile.id ? { ...f, ...nextFile } : f))
      : [...(fileSystem || []), nextFile];
    onUpdateFileSystem(nextFs);
  };

  const persistIndexToFileSystem = (nextEntries) => {
    if (!onUpdateFileSystem || !fileObj?.id) return;
    const buffer = writeF3IndexFile(nextEntries);
    const nextRawFile = new File([buffer], fileObj.name, { type: 'application/octet-stream' });
    const nextFs = (fileSystem || []).map(file => (
      file.id === fileObj.id
        ? {
            ...file,
            rawFile: nextRawFile,
            size: `${buffer.byteLength} B`,
            content: undefined
          }
        : file
    ));
    onUpdateFileSystem(nextFs);
  };

  const handleImportCoords = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const projString = `+proj=tmerc +lat_0=${coordParams.latOrigin} +lon_0=${coordParams.centralMeridian} +k=${coordParams.scale} +x_0=${coordParams.falseEasting} +y_0=${coordParams.falseNorthing} +ellps=GRS80 +units=m +no_defs`;
      let rows = [];
      const extension = file.name.split('.').pop().toLowerCase();
      if (['txt', 'dat', 'csv'].includes(extension)) {
        const text = await file.text();
        rows = text.split('\n').filter(l => l.trim().length > 0).map(line => line.trim().split(/[\s,]+/));
      } else {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data);
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      }

      let matchCount = 0;
      let nextEntries = entries.map(entry => ({ ...entry }));
      rows.forEach((row, idx) => {
        if (idx === 0 && typeof row[0] === 'string' && (isNaN(parseFloat(row[0])) || isNaN(parseFloat(row[1])))) return;
        if (row.length < 5) return;
        const lineNum = Number(row[0]);
        const pointNum = Number(row[1]);
        const x = row[2];
        const y = row[3];
        const z = Number(row[4]);
        if (![lineNum, pointNum, z].every(Number.isFinite) || x === undefined || y === undefined) return;
        const entryIndex = nextEntries.findIndex(item => Number(item.line) === lineNum && Number(item.point) === pointNum);
        if (entryIndex === -1) return;

        let lonlat = null;
        let realX = Number.parseFloat(x);
        let realY = Number.parseFloat(y);

        if (coordParams.coordType === 'CGCS2000') {
          try {
            const px = Number.parseFloat(x);
            const py = Number.parseFloat(y);
            if (Number.isFinite(px) && Number.isFinite(py)) {
              lonlat = proj4(projString, 'WGS84', [px, py]);
            }
          } catch {
            void 0;
          }
        } else {
          const parsedLon = parseLonLat(x, coordParams.lonlatFormat);
          const parsedLat = parseLonLat(y, coordParams.lonlatFormat);
          if (Number.isFinite(parsedLon) && Number.isFinite(parsedLat)) {
            lonlat = [parsedLon, parsedLat];
          }
        }

        if (!lonlat) return;
        nextEntries[entryIndex] = applyMeasuredCoords(nextEntries[entryIndex], {
          measuredLongitude: lonlat[0],
          measuredLatitude: lonlat[1],
          measuredElevation: z,
          measuredX: Number.isFinite(realX) ? realX : nextEntries[entryIndex].measuredX,
          measuredY: Number.isFinite(realY) ? realY : nextEntries[entryIndex].measuredY
        });
        matchCount++;
      });

      if (matchCount <= 0) {
        msg.warn('未能在导入文件中找到匹配的线号和点号数据。请确保导入文件的前5列为: 线号, 点号, X, Y, Z。');
      } else {
        setEntries(nextEntries);
        persistEntriesCoords(nextEntries);
        msg.success(`成功导入并匹配了 ${matchCount} 个测点坐标，已自动保存到工程坐标文件。`);
      }
    } catch (err) {
      msg.warn('导入失败: ' + err.message);
    }
    if (coordFileInputRef.current) coordFileInputRef.current.value = '';
  };

  const handleReadMeasuredCoords = async () => {
    try {
      setReadingMeasured(true);
      const { entries: nextEntries, updated } = await hydrateEntriesFromPointIdxFiles(entries, false);
      if (!updated) {
        msg.warn('未从单点 idx 文件中读取到有效坐标。');
        return;
      }
      setEntries(nextEntries);
      persistEntriesCoords(nextEntries);
      msg.success('已从单点 idx 文件读取实测坐标，并写回当前 INDEX/IDX 文件。');
    } catch (err) {
      msg.warn(`读取实测坐标失败：${err.message}`);
    } finally {
      setReadingMeasured(false);
    }
  };

  const readBinaryFile = async (fileItem) => {
    if (!fileItem) return null;
    if (fileItem instanceof File) return fileItem.arrayBuffer();
    if (fileItem.rawFile instanceof File) return fileItem.rawFile.arrayBuffer();
    const resolvedFile = await resolveDriveFileContent(fileItem, fileItem.name || 'data.bin');
    if (resolvedFile && typeof resolvedFile.arrayBuffer === 'function') {
      return resolvedFile.arrayBuffer();
    }
    return null;
  };

  const handleExportEDI = async () => {
    if (enrichedEntries.length === 0) {
      msg.warn('没有可导出的测点数据。');
      return;
    }
    try {
      const zip = new JSZip();
      const spectraFolder = zip.folder('功率谱');
      const impedanceFolder = zip.folder('阻抗');
      const resistivityFolder = zip.folder('电阻率');
      let exportCount = 0;

      for (const entry of enrichedEntries) {
        const rFile = resolveRFileForEntry(entry);
        const psdFile = entry.psdFile || findRelated(entry, 'psd');
        const pointName = String(entry.point || entry.index || exportCount + 1);
        const stationInfo = {
          id: pointName,
          x: Number(entry.point) || 0,
          y: Number(entry.line) || 0,
          lon: entry.gpsLongitude,
          lat: entry.gpsLatitude,
          z: entry.gpsElevation ?? 0
        };

        if (rFile) {
          const rBuffer = await readBinaryFile(rFile);
          if (rBuffer) {
            try {
              const mtData = parseF3ResistivityFile(rBuffer);
              if (mtData.length > 0) {
                impedanceFolder.file(`${pointName}.edi`, writeEDIFile(mtData, stationInfo, 'impedance'));
                resistivityFolder.file(`${pointName}.edi`, writeEDIFile(mtData, stationInfo, 'resistivity'));
                exportCount++;
              }
            } catch {
              void 0;
            }
          }
        }

        if (psdFile) {
          const psdBuffer = await readBinaryFile(psdFile);
          if (psdBuffer) {
            try {
              const psdRows = parseF3PsdFile(psdBuffer);
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
              }
            } catch {
              void 0;
            }
          }
        }
      }

      if (exportCount === 0) {
        msg.warn('导出失败：未找到有效的F3 R文件数据。');
        return;
      }

      const content = await zip.generateAsync({ type: 'blob' });
      saveAs(content, `${projectName}_EDI_Data.zip`);
    } catch (err) {
      msg.warn(`导出 EDI 失败：${err.message}`);
    }
  };

  const mapOption = useMemo(() => {
    if (mapData.length === 0) {
      return {
        title: { text: '无可绘制测点坐标', left: 'center', top: 'middle', textStyle: { color: '#94a3b8', fontSize: 16, fontWeight: 500 } },
        xAxis: { show: false },
        yAxis: { show: false },
        series: []
      };
    }
    const lineValues = mapData.map(d => d.value[0]);
    const pointValues = mapData.map(d => d.value[1]);
    const minLine = Math.min(...lineValues);
    const maxLine = Math.max(...lineValues);
    const minPoint = Math.min(...pointValues);
    const maxPoint = Math.max(...pointValues);
    const padLine = Math.max(1, (maxLine - minLine) * 0.05);
    const padPoint = Math.max(1, (maxPoint - minPoint) * 0.05);

    return {
      tooltip: {
        trigger: 'item',
        formatter: (params) => {
          const e = enrichedEntries[params?.data?.rowIndex];
          if (!e) return '测点信息不可用';
          const tip = e.rFile || e.psdFile ? '点击打开测点结果' : '未匹配到数据文件';
          const tipColor = e.rFile || e.psdFile ? '#3b82f6' : '#94a3b8';
          return `<b>测点: ${e.point || '--'}</b><br/>测线: ${e.line || '--'}<br/>时间: ${dateText(e.startTimeMillis)}<br/>坐标来源: ${e.coordSource || '--'}<br/>经度: ${e.displayLongitude?.toFixed?.(6) ?? '--'}<br/>纬度: ${e.displayLatitude?.toFixed?.(6) ?? '--'}<br/><span style="color:${tipColor};">${tip}</span>`;
        }
      },
      grid: { left: '8%', right: '4%', top: '8%', bottom: '10%' },
      xAxis: {
        type: 'value',
        min: minLine - padLine,
        max: maxLine + padLine,
        name: '测线',
        nameLocation: 'middle',
        nameGap: 28,
        axisLine: { lineStyle: { color: '#94a3b8' } },
        splitLine: { lineStyle: { color: '#e2e8f0' } }
      },
      yAxis: {
        type: 'value',
        min: minPoint - padPoint,
        max: maxPoint + padPoint,
        name: '测点',
        nameLocation: 'middle',
        nameGap: 35,
        axisLine: { lineStyle: { color: '#94a3b8' } },
        splitLine: { lineStyle: { color: '#e2e8f0' } }
      },
      series: [
        {
          type: 'scatter',
          cursor: 'pointer',
          symbolSize: 10,
          itemStyle: {
            color: (params) => params?.data?.hasDataFile ? '#3b82f6' : '#94a3b8',
            borderColor: '#ffffff',
            borderWidth: 1
          },
          emphasis: {
            itemStyle: {
              color: (params) => params?.data?.hasDataFile ? '#2563eb' : '#64748b'
            }
          },
          data: mapData
        }
      ]
    };
  }, [mapData, enrichedEntries]);

  const lineSpan = useMemo(() => {
    const lines = enrichedEntries.map(e => e.lineNum).filter(v => v !== null);
    if (!lines.length) return '--';
    return (Math.max(...lines) - Math.min(...lines)).toFixed(0);
  }, [enrichedEntries]);

  const geoEntries = useMemo(() => {
    return enrichedEntries.filter(entry =>
      Number.isFinite(entry.displayLatitude) &&
      Number.isFinite(entry.displayLongitude) &&
      !(Number(entry.displayLatitude) === 0 && Number(entry.displayLongitude) === 0)
    );
  }, [enrichedEntries]);

  const unfinishedEntries = useMemo(() => {
    const existingKeys = new Set(enrichedEntries.map(entry => makeCoordKey(entry.line, entry.point)));
    return Object.entries(designCoordLookup)
      .filter(([key, value]) => !existingKeys.has(key) && Number.isFinite(value?.designLatitude) && Number.isFinite(value?.designLongitude))
      .map(([key, value], idx) => ({
        idx: `unfinished_${idx}`,
        line: value.line || key.split('__')[0] || '--',
        point: value.point || key.split('__')[1] || '--',
        coordSource: '设计坐标（未完成测点）',
        displayLongitude: value.designLongitude,
        displayLatitude: value.designLatitude,
        displayElevation: value.designElevation,
        isUnfinished: true,
        hasDataFile: false
      }));
  }, [designCoordLookup, enrichedEntries]);

  const allMapEntries = useMemo(() => [...geoEntries, ...unfinishedEntries], [geoEntries, unfinishedEntries]);

  const hasGeoCoords = allMapEntries.length > 0;

  const mapBounds = useMemo(() => {
    if (!hasGeoCoords) return null;
    return allMapEntries.map(entry => [entry.displayLatitude, entry.displayLongitude]);
  }, [allMapEntries, hasGeoCoords]);

  const modalStyle = maximized
    ? {
        width: '100vw',
        height: '100vh',
        borderRadius: 0,
        border: 'none',
        boxShadow: 'none',
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }
    : {
        width: '95vw',
        maxWidth: '1500px',
        height: '88vh',
        borderRadius: '16px',
        border: '1px solid var(--border-color)',
        boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: isBackground ? 'rgba(0,0,0,0)' : (maximized ? 'transparent' : 'rgba(0,0,0,0.6)'), backdropFilter: isBackground ? 'none' : (maximized ? 'none' : 'blur(4px)'), zIndex: isBackground ? 9998 : 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: isBackground ? 'none' : 'auto' }}>
      <div className="card glass" style={modalStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: maximized ? '12px 20px' : '0 0 16px 0', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Layers size={24} color="#3b82f6" />
            <div>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#0f172a' }}>{projectName}</h3>
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>F3 大地电磁工程索引与测点总览</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: '6px', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
              <button onClick={() => setViewMode('map')} style={{ background: viewMode === 'map' ? '#3b82f6' : 'transparent', color: viewMode === 'map' ? '#fff' : '#64748b', border: 'none', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: 500 }}>
                <MapIcon size={14} /> 测点分布图
              </button>
              <button onClick={() => setViewMode('table')} style={{ background: viewMode === 'table' ? '#3b82f6' : 'transparent', color: viewMode === 'table' ? '#fff' : '#64748b', border: 'none', borderLeft: '1px solid #e2e8f0', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: 500 }}>
                <List size={14} /> 数据列表
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

        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', paddingTop: maximized ? '16px' : '16px' }}>
          {loading && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', color: '#3b82f6' }}>
              <Loader2 size={32} className="spin" />
              <span>正在解析 F3 工程索引文件...</span>
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
                <div>测点总数: <b style={{ color: '#0f172a' }}>{enrichedEntries.length}</b> 个</div>
                <div style={{ color: '#cbd5e1' }}>|</div>
                <div>未完成测点: <b style={{ color: '#f59e0b' }}>{unfinishedEntries.length}</b> 个</div>
                <div style={{ color: '#cbd5e1' }}>|</div>
                <div>线号跨度: <b style={{ color: '#0f172a' }}>{lineSpan}</b></div>
                <div style={{ color: '#cbd5e1' }}>|</div>
                <div>工程名: <b style={{ color: '#0f172a' }}>{projectName}</b></div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                  <input ref={coordFileInputRef} type="file" accept=".csv,.txt,.dat,.xls,.xlsx" style={{ display: 'none' }} onChange={handleImportCoords} />
                  <button
                    onClick={handleReadMeasuredCoords}
                    disabled={readingMeasured}
                    style={{ background: readingMeasured ? '#94a3b8' : '#64748b', color: '#fff', border: 'none', borderRadius: '4px', cursor: readingMeasured ? 'not-allowed' : 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 500 }}
                    title="遍历单点 idx 文件并读取实测坐标"
                  >
                    {readingMeasured ? <Loader2 size={14} className="animate-spin" /> : <MapIcon size={14} />}
                    读取实测
                  </button>
                  <button
                    onClick={() => setShowCoordDialog(true)}
                    style={{ background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 500 }}
                  >
                    <Upload size={14} /> 导入坐标
                  </button>
                  <button
                    onClick={handleExportEDI}
                    style={{ background: '#f59e0b', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 500 }}
                    title="将当前工程所有测点导出为 EDI 格式文件包"
                  >
                    <Download size={14} /> 导出 EDI
                  </button>
                </div>
              </div>

              <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                {viewMode === 'map' ? (
                  hasGeoCoords ? (
                    <div style={{ width: '100%', height: '100%' }}>
                      <MapContainer bounds={mapBounds} style={{ height: '100%', width: '100%' }}>
                        <TileLayer
                          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                          attribution='Tiles &copy; Esri'
                        />
                        {allMapEntries.map((entry) => (
                          <CircleMarker
                            key={`${entry.point}_${entry.idx}`}
                            center={[entry.displayLatitude, entry.displayLongitude]}
                            radius={4}
                            pathOptions={{ color: '#fff', weight: 1, fillColor: entry.isUnfinished ? '#f59e0b' : (entry.rFile || entry.psdFile ? '#3b82f6' : '#94a3b8'), fillOpacity: 0.85 }}
                            eventHandlers={{
                              click: () => {
                                if (!entry.isUnfinished && (entry.rFile || entry.psdFile)) openEntry(entry, 'R');
                              }
                            }}
                          >
                            <Tooltip direction="bottom" offset={[0, 5]} opacity={1}>
                              <div style={{ fontSize: '13px', lineHeight: '1.6', padding: '2px 4px' }}>
                                <b>测点: {entry.point || '--'}</b><br/>
                                点号: {entry.point || '--'}<br/>
                                线号: {entry.line || '--'}<br/>
                                坐标来源: {entry.coordSource || '--'}<br/>
                                经度: {entry.displayLongitude?.toFixed?.(6) ?? '--'}°<br/>
                                纬度: {entry.displayLatitude?.toFixed?.(6) ?? '--'}°<br/>
                                高程: {entry.displayElevation?.toFixed?.(2) ?? '--'} m<br/>
                                <span style={{ color: entry.isUnfinished ? '#f59e0b' : (entry.rFile || entry.psdFile ? '#3b82f6' : '#94a3b8'), marginTop: '4px', display: 'inline-block', fontSize: '12px' }}><i>{entry.isUnfinished ? '设计坐标有、索引文件无，视为未完成测点' : (entry.rFile || entry.psdFile ? '点击打开视电阻率' : '未匹配到数据文件')}</i></span>
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
                          const rowIndex = params?.data?.rowIndex;
                          const entry = Number.isInteger(rowIndex) ? enrichedEntries[rowIndex] : null;
                          if (entry) openEntry(entry, 'R');
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
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>文件名</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>测点</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>测线</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>起始时间</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>坐标来源</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>经度 (°)</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>纬度 (°)</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>高程 (m)</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>操作</th>
                          <th style={{ padding: '12px 20px', borderBottom: '2px solid #e2e8f0', color: '#64748b', fontWeight: 600 }}>删除</th>
                        </tr>
                      </thead>
                      <tbody>
                        {enrichedEntries.map((entry) => {
                          const hasDataFile = Boolean(entry.rFile || entry.psdFile);
                          const rowTextColor = hasDataFile ? '#0f172a' : '#94a3b8';
                          return (
                          <tr key={`${entry.point}_${entry.idx}`} style={{ borderBottom: '1px solid #e2e8f0', background: hasDataFile ? '#fff' : '#fcfcfd' }}>
                            <td style={{ padding: '10px 20px', color: '#94a3b8' }}>{entry.idx + 1}</td>
                            <td style={{ padding: '10px 20px', color: rowTextColor, maxWidth: '280px' }}>
                              <div
                                onClick={() => hasDataFile && openEntry(entry, 'R')}
                                style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: hasDataFile ? 'pointer' : 'default', color: entry.rFile ? '#3b82f6' : rowTextColor, fontWeight: 600 }}
                                title={entry.displayFileNames?.join(' / ') || '--'}
                              >
                                {entry.displayFileNames?.length ? entry.displayFileNames.join(' / ') : '--'}
                              </div>
                            </td>
                            <td style={{ padding: '10px 20px', fontWeight: 600, color: rowTextColor }}>
                              <input
                                type="text"
                                value={entry.point ?? ''}
                                onChange={(e) => handleEntryFieldChange(entry.idx, 'point', e.target.value)}
                                style={{ width: '84px', padding: '4px 8px', borderRadius: '6px', border: '1px solid #dbeafe', outline: 'none', color: '#0f172a', background: '#fff' }}
                              />
                            </td>
                            <td style={{ padding: '10px 20px', color: rowTextColor }}>
                              <input
                                type="text"
                                value={entry.line ?? ''}
                                onChange={(e) => handleEntryFieldChange(entry.idx, 'line', e.target.value)}
                                style={{ width: '84px', padding: '4px 8px', borderRadius: '6px', border: '1px solid #dbeafe', outline: 'none', color: '#0f172a', background: '#fff' }}
                              />
                            </td>
                            <td style={{ padding: '10px 20px', color: rowTextColor }}>{dateText(entry.startTimeMillis)}</td>
                            <td style={{ padding: '10px 20px', color: rowTextColor }}>{entry.coordSource || '--'}</td>
                            <td style={{ padding: '10px 20px', color: rowTextColor }}>{entry.displayLongitude?.toFixed?.(6) ?? '--'}</td>
                            <td style={{ padding: '10px 20px', color: rowTextColor }}>{entry.displayLatitude?.toFixed?.(6) ?? '--'}</td>
                            <td style={{ padding: '10px 20px', color: rowTextColor }}>{entry.displayElevation?.toFixed?.(2) ?? '--'}</td>
                            <td style={{ padding: '10px 20px' }}>
                              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                <button disabled={!entry.rFile} onClick={() => openEntry(entry, 'R')} style={{ background: entry.rFile ? '#fff' : '#f8fafc', color: entry.rFile ? '#3b82f6' : '#94a3b8', border: '1px solid #dbeafe', borderRadius: '8px', cursor: entry.rFile ? 'pointer' : 'not-allowed', padding: '5px 10px' }}>
                                  打开R
                                </button>
                                <button disabled={!entry.psdFile} onClick={() => openEntry(entry, 'PSD')} style={{ background: entry.psdFile ? '#fff' : '#f8fafc', color: entry.psdFile ? '#3b82f6' : '#94a3b8', border: '1px solid #dbeafe', borderRadius: '8px', cursor: entry.psdFile ? 'pointer' : 'not-allowed', padding: '5px 10px' }}>
                                  打开PSD
                                </button>
                                {!entry.rFile && !entry.psdFile && (
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#94a3b8' }}>
                                    <FileSearch size={14} /> 未匹配到该测点结果文件
                                  </span>
                                )}
                              </div>
                            </td>
                            <td style={{ padding: '10px 20px' }}>
                              <button
                                disabled={!hasDataFile && !entry.fhFile && !entry.fmFile && !entry.flFile}
                                onClick={() => handleDeleteEntryFiles(entry)}
                                style={{ background: 'transparent', border: 'none', cursor: hasDataFile || entry.fhFile || entry.fmFile || entry.flFile ? 'pointer' : 'not-allowed', color: hasDataFile || entry.fhFile || entry.fmFile || entry.flFile ? '#ef4444' : '#cbd5e1', display: 'flex', alignItems: 'center', padding: 0 }}
                                title="删除该测点关联文件"
                              >
                                <Trash2 size={16} />
                              </button>
                            </td>
                          </tr>
                        )})}
                        {unfinishedEntries.map((entry, idx) => (
                          <tr key={`unfinished_row_${entry.line}_${entry.point}_${idx}`} style={{ borderBottom: '1px solid #e2e8f0', background: '#fff7ed' }}>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>--</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b', maxWidth: '280px' }}>未完成测点</td>
                            <td style={{ padding: '10px 20px', fontWeight: 600, color: '#f59e0b' }}>{entry.point || '--'}</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>{entry.line || '--'}</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>--</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>{entry.coordSource}</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>{entry.displayLongitude?.toFixed?.(6) ?? '--'}</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>{entry.displayLatitude?.toFixed?.(6) ?? '--'}</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>{entry.displayElevation?.toFixed?.(2) ?? '--'}</td>
                            <td style={{ padding: '10px 20px', color: '#f59e0b' }}>--</td>
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

        {showCoordDialog && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }}>
            <div style={{ width: '450px', background: '#fff', borderRadius: '12px', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)', overflow: 'hidden' }}>
              <div style={{ padding: '16px 24px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc' }}>
                <h4 style={{ margin: 0, color: '#0f172a', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Settings size={18} color="#3b82f6" /> 导入坐标投影参数设置
                </h4>
                <button onClick={() => setShowCoordDialog(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><X size={20} /></button>
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
                    <b>导入文件格式要求：</b><br />
                    请确保文件 (如 .csv, .xlsx, .txt) 为 <b>5列</b> 数据，每列依次代表：<br />
                    <b>第1列</b>：线号&nbsp;&nbsp;&nbsp;<b>第2列</b>：点号<br />
                    <b>第3列</b>：X坐标 / 经度&nbsp;&nbsp;&nbsp;<b>第4列</b>：Y坐标 / 纬度<br />
                    <b>第5列</b>：高程 Z (m)
                  </div>
                </div>
              </div>

              <div style={{ padding: '16px 24px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', gap: '12px', background: '#f8fafc' }}>
                <button onClick={() => setShowCoordDialog(false)} style={{ background: '#fff', color: '#475569', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '6px 16px', cursor: 'pointer', fontWeight: 500 }}>
                  取消
                </button>
                <button
                  onClick={() => {
                    setShowCoordDialog(false);
                    coordFileInputRef.current?.click();
                  }}
                  style={{ background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 16px', cursor: 'pointer', fontWeight: 500 }}
                >
                  确定并导入
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default F3IndexViewer;
