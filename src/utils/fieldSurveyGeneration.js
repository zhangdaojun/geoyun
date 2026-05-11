import { resolveDriveFileContent } from './driveFileContent.js';
import { loadEh4Io } from './lazyModules.js';

const RAW_TASK_NAMES = new Set(['野外采集', '02_野外采集']);
const EXCEL_PATTERN = /\.(xlsx|xls)$/i;

const normalizeInstrumentType = (value = '') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('emap')) return 'emap1';
  if (normalized.includes('eh4')) return 'eh4';
  if (normalized.includes('f3')) return 'f3';
  if (normalized.includes('edi')) return 'edi';
  if (normalized.includes('mt')) return 'edi';
  if (normalized.includes('高密度') || normalized.includes('电法') || normalized.includes('ert')) return 'ert';
  return normalized;
};

const getInstrumentLabel = (instrumentType = '') => {
  if (instrumentType === 'eh4') return 'EH4';
  if (instrumentType === 'f3') return 'F3';
  if (instrumentType === 'edi') return 'EDI';
  if (instrumentType === 'emap1') return 'EMAP-1';
  if (instrumentType === 'ert') return '高密度电法';
  return String(instrumentType || '').trim().toUpperCase() || '未标注仪器';
};

const isRawFolder = (item = {}) =>
  item?.type === 'folder' && (
    item.category === 'raw'
    || RAW_TASK_NAMES.has(String(item.taskName || '').trim())
    || RAW_TASK_NAMES.has(String(item.name || '').trim())
  );

const classifyFileInstrument = (fileName = '') => {
  const normalizedName = String(fileName || '').trim();
  const lowerName = normalizedName.toLowerCase();
  if (!lowerName) return '';
  if (normalizedName.startsWith('@')) return 'eh4';
  if (lowerName === 'sensors.tbl' || /^afev/i.test(normalizedName)) return 'eh4';
  if (/\.(50h|60h|hf)$/i.test(normalizedName)) return 'eh4';
  if (lowerName.endsWith('.xyz')) return 'eh4';
  if (/\.(index|idx|psd|fh|fm|fl)$/i.test(normalizedName) || /(^|[^a-z0-9])f3([^a-z0-9]|$)/i.test(lowerName)) return 'f3';
  if (lowerName.endsWith('.edi')) return 'edi';
  if (lowerName.endsWith('.mtts')) return 'emap1';
  if ((normalizedName.startsWith('X') || normalizedName.startsWith('Y') || normalizedName.startsWith('Z')) && /\.\d{3,4}$/i.test(normalizedName)) return 'eh4';
  if (/\.(dat|txt|csv|xyz|vtk|segy)$/i.test(normalizedName)) return 'ert';
  return '';
};

const buildEntryKey = (instrument, line, point) => `${normalizeInstrumentType(instrument)}__${String(line || '').trim()}__${String(point || '').trim()}`;

const buildGeneratedEntryId = (instrument, line, point) => `drive_${normalizeInstrumentType(instrument)}_${String(line || '').trim()}_${String(point || '').trim()}`;

const buildProjectItemPath = (item, items = []) => {
  if (!item) return '';
  const itemMap = new Map((items || []).map((entry) => [entry.id, entry]));
  const segments = [];
  let cursor = item;
  while (cursor) {
    if (cursor.name) segments.unshift(String(cursor.name).trim());
    if (!cursor.parentId) break;
    cursor = itemMap.get(cursor.parentId) || null;
  }
  return segments.filter(Boolean).join('/');
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

const isEh4ZLikeFile = (name = '') => /^z/i.test(String(name || '').trim());
const isEh4XLikeFile = (name = '') => /^x/i.test(String(name || '').trim());
const isEh4YLikeFile = (name = '') => /^y/i.test(String(name || '').trim());
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
const isF3PointIndexFile = (name = '') => /^.+\.\d+\.idx$/i.test(String(name || '').trim());
const isF3ProjectIndexFile = (name = '') => {
  const normalized = String(name || '').trim();
  return /\.index$/i.test(normalized) || (/\.idx$/i.test(normalized) && !isF3PointIndexFile(normalized));
};
const parseMttsPointNo = (name = '') => {
  const normalizedName = String(name || '').trim();
  if (!/\.mtts$/i.test(normalizedName)) return '';
  const baseName = normalizedName.replace(/\.[^.]+$/, '');
  const parts = baseName.split('_');
  return String(parts[0] || baseName).trim();
};

const parseLineCodeFromFolderName = (name = '') => {
  const text = String(name || '').trim();
  const match = text.match(/(?:测线|line|survey\s*line)\s*([a-z0-9_.-]+)/i);
  return match ? match[1] : '';
};

const isErtDataFile = (name = '') => /\.(dat|txt|csv|xyz|vtk|segy)$/i.test(String(name || '').trim());

const parseArrangementName = (name = '') => {
  const normalizedName = String(name || '').trim();
  return normalizedName.replace(/\.[^.]+$/, '') || normalizedName;
};

const parseErtLineArrangement = (file = {}) => {
  const baseName = parseArrangementName(file.name);
  const separatorIndex = baseName.search(/[_-]/);
  if (separatorIndex > 0) {
    const line = baseName.slice(0, separatorIndex).trim();
    const arrangement = baseName.slice(separatorIndex + 1).trim() || '1';
    return { line, arrangement };
  }
  return { line: baseName.trim(), arrangement: '1' };
};

const getMatchedCategory = (instrumentType, name = '') => {
  const normalized = String(name || '').trim().toLowerCase();
  if (instrumentType === 'f3') {
    if (/\.r$/i.test(normalized)) return 'z';
    if (/\.psd$/i.test(normalized)) return 'x';
    if (/\.(fh|fm|fl)$/i.test(normalized)) return 'y';
    return '';
  }
  if (instrumentType === 'edi') {
    return /\.edi$/i.test(normalized) ? 'z' : '';
  }
  if (instrumentType === 'emap1') {
    return /\.mtts$/i.test(normalized) ? 'y' : '';
  }
  if (/^z/i.test(normalized)) return 'z';
  if (/^x/i.test(normalized)) return 'x';
  if (/^y/i.test(normalized)) return 'y';
  return '';
};

const normalizePointStatus = (matchedDataCount) => (matchedDataCount > 0 ? 'matched' : 'pending');

const normalizeNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const parseAngleText = (value) => {
  const text = String(value || '').trim();
  if (!text) return Number.NaN;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(/[:掳'"]/).filter(Boolean).map(Number);
  if (!parts.length || parts.some((item) => Number.isNaN(item))) return Number.NaN;
  const sign = parts[0] < 0 ? -1 : 1;
  const d = Math.abs(parts[0]);
  const m = parts[1] || 0;
  const s = parts[2] || 0;
  return sign * (d + m / 60 + s / 3600);
};

const parseEdiMetadata = (text, fileName = '') => {
  const lines = String(text || '').split(/\r?\n/);
  const getField = (key) => {
    const line = lines.find((item) => new RegExp(`^\\s*${key}\\s*=`, 'i').test(item));
    if (!line) return '';
    return line.split('=').slice(1).join('=').trim();
  };
  const dataId = getField('DATAID') || String(fileName || '').replace(/\.edi$/i, '');
  const point = getField('STN') || dataId;
  const line = getField('LINE');
  const lat = parseAngleText(getField('LAT'));
  const lon = parseAngleText(getField('LONG') || getField('LON'));
  const elev = normalizeNumber(getField('ELEV'));
  return {
    dataId,
    point,
    line,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    elev
  };
};

const isItemWithinFolder = (item, folderId, itemMap) => {
  if (!item || !folderId) return false;
  let cursor = item;
  while (cursor) {
    if (String(cursor.id || '') === String(folderId)) return true;
    cursor = itemMap.get(cursor.parentId) || null;
  }
  return false;
};

const resolveParentFolderLineCode = (file, itemMap) => {
  let cursor = itemMap?.get(file?.parentId) || null;
  while (cursor) {
    const line = parseLineCodeFromFolderName(cursor.name) || String(cursor.name || '').trim().match(/(?:测线|line|survey\s*line)\s*([a-z0-9_.-]+)/i)?.[1] || '';
    if (line) return line;
    cursor = itemMap.get(cursor.parentId) || null;
  }
  return '';
};

const resolveErtLineCode = (file, itemMap) => (
  resolveExplicitLineCode(
    parseErtLineArrangement(file).line,
    resolveParentFolderLineCode(file, itemMap),
    String(file?.name || '').trim().match(/(?:测线|line|survey\s*line)\s*([a-z0-9_.-]+)/i)?.[1],
    '0'
  )
);

const resolveExplicitLineCode = (...values) => {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
};

const resolveDriveFile = async (item, blobLoader = resolveDriveFileContent) => {
  if (!item) return null;
  if (typeof blobLoader === 'function') {
    try {
      return await blobLoader(item, item.name || 'data.bin');
    } catch {
      return null;
    }
  }
  return null;
};

const resolveFileText = async (item, blobLoader = resolveDriveFileContent) => {
  const file = await resolveDriveFile(item, blobLoader);
  if (file && typeof file.text === 'function') return file.text();
  return '';
};

const resolveFileBuffer = async (item, blobLoader = resolveDriveFileContent) => {
  const file = await resolveDriveFile(item, blobLoader);
  if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return null;
};

const buildComparableSignature = (entries = []) => JSON.stringify(
  (entries || [])
    .map((entry) => ({
      id: String(entry?.id || '').trim(),
      line: String(entry?.line || '').trim(),
      point: String(entry?.point || '').trim(),
      instrument: String(entry?.instrument || '').trim(),
      gpsLongitude: normalizeNumber(entry?.gpsLongitude),
      gpsLatitude: normalizeNumber(entry?.gpsLatitude),
      z: normalizeNumber(entry?.z),
      pointStatus: entry?.pointStatus || 'pending',
      matchedDataCount: Number(entry?.matchedDataCount || 0),
      hasExistingData: Boolean(entry?.hasExistingData),
      sourceCoordFileId: entry?.sourceCoordFileId || entry?.sourceFileId || '',
      sourceCoordFileName: entry?.sourceCoordFileName || entry?.sourceFileName || '',
      entryKind: entry?.entryKind || '',
      matchedDataPaths: Array.isArray(entry?.matchedDataPaths) ? [...entry.matchedDataPaths].sort() : []
    }))
    .sort((a, b) => buildEntryKey(a.instrument, a.line, a.point).localeCompare(buildEntryKey(b.instrument, b.line, b.point), 'zh-Hans-CN', { numeric: true }))
);

const createBaseEntry = ({ instrument, line, point, sourceFile, longitude = null, latitude = null, elevation = null, entryKind = 'point' }) => ({
  id: buildGeneratedEntryId(instrument, line, point),
  line: String(line || '').trim(),
  point: String(point || '').trim(),
  instrument: getInstrumentLabel(instrument),
  entryKind,
  gpsLongitude: normalizeNumber(longitude),
  gpsLatitude: normalizeNumber(latitude),
  z: normalizeNumber(elevation),
  source: '野外采集上传',
  sourceFileId: sourceFile?.id || '',
  sourceFileName: sourceFile?.name || '',
  sourceCoordFileId: sourceFile?.id || '',
  sourceCoordFileName: sourceFile?.name || '',
  matchedDataPaths: [],
  matchedDataCount: 0,
  hasExistingData: false,
  pointStatus: 'pending',
  generatedFromDrive: true
});

const mergeEntry = (current, incoming) => {
  const mergedPaths = Array.from(new Set([
    ...(Array.isArray(current?.matchedDataPaths) ? current.matchedDataPaths : []),
    ...(Array.isArray(incoming?.matchedDataPaths) ? incoming.matchedDataPaths : [])
  ].filter(Boolean)));
  return {
    ...current,
    ...incoming,
    id: current?.id || incoming?.id,
    entryKind: incoming?.entryKind || current?.entryKind || 'point',
    gpsLongitude: normalizeNumber(current?.gpsLongitude ?? incoming?.gpsLongitude),
    gpsLatitude: normalizeNumber(current?.gpsLatitude ?? incoming?.gpsLatitude),
    z: normalizeNumber(current?.z ?? incoming?.z),
    sourceFileId: current?.sourceFileId || incoming?.sourceFileId || '',
    sourceFileName: current?.sourceFileName || incoming?.sourceFileName || '',
    sourceCoordFileId: current?.sourceCoordFileId || incoming?.sourceCoordFileId || '',
    sourceCoordFileName: current?.sourceCoordFileName || incoming?.sourceCoordFileName || '',
    matchedDataPaths: mergedPaths,
    matchedDataCount: mergedPaths.length,
    hasExistingData: mergedPaths.length > 0,
    pointStatus: normalizePointStatus(mergedPaths.length),
    generatedFromDrive: true
  };
};

const upsertGeneratedEntry = (map, entry) => {
  const key = buildEntryKey(entry.instrument, entry.line, entry.point);
  const existing = map.get(key);
  map.set(key, existing ? mergeEntry(existing, entry) : mergeEntry(null, entry));
};

const chooseScopedFiles = (sourceFile, instrumentRootId, files, itemMap) => {
  const sameFolderFiles = (files || []).filter((file) => file?.type === 'file' && isItemWithinFolder(file, sourceFile?.parentId, itemMap));
  if (sameFolderFiles.length) return sameFolderFiles;
  if (!instrumentRootId) return files;
  const instrumentScoped = (files || []).filter((file) => file?.type === 'file' && isItemWithinFolder(file, instrumentRootId, itemMap));
  return instrumentScoped.length ? instrumentScoped : files;
};

const findMatchesByCategories = ({ instrumentType, entry, lineEntries, scopedFiles, allFiles }) => {
  const exactPointTokens = buildExactPointTokens(entry.point);
  const ordinal = (lineEntries || []).findIndex((item) => buildEntryKey(item.instrument, item.line, item.point) === buildEntryKey(entry.instrument, entry.line, entry.point));
  const categories = instrumentType === 'f3'
    ? ['z', 'x', 'y']
    : instrumentType === 'emap1'
      ? ['y']
      : instrumentType === 'edi'
        ? ['z']
        : ['z', 'x', 'y'];
  const matcherByCategory = (category, name) => {
    if (instrumentType === 'f3') {
      if (category === 'z') return isF3ZLikeFile(name);
      if (category === 'x') return isF3XLikeFile(name);
      if (category === 'y') return isF3YLikeFile(name);
      return false;
    }
    if (instrumentType === 'edi') return /\.edi$/i.test(String(name || '').trim());
    if (instrumentType === 'emap1') return /\.mtts$/i.test(String(name || '').trim());
    if (category === 'z') return isEh4ZLikeFile(name);
    if (category === 'x') return isEh4XLikeFile(name);
    if (category === 'y') return isEh4YLikeFile(name);
    return false;
  };

  const bestByCategory = new Map();
  categories.forEach((category) => {
    if (instrumentType !== 'f3') {
      for (const filePool of [scopedFiles, allFiles]) {
        const exactMatch = (filePool || []).find((file) => (
          file?.type === 'file'
          && matcherByCategory(category, file.name)
          && (
            instrumentType === 'emap1'
              ? parseMttsPointNo(file.name) === String(entry.point || '').trim()
              : matchesExactPointToken(file.name, exactPointTokens)
          )
        ));
        if (exactMatch) {
          bestByCategory.set(category, exactMatch);
          break;
        }
      }
    }

    if (bestByCategory.has(category) || instrumentType === 'emap1' || ordinal < 0) return;

    for (const filePool of [scopedFiles, allFiles]) {
      const seenSerials = new Set();
      const serialCandidates = (filePool || [])
        .filter((file) => file?.type === 'file' && matcherByCategory(category, file.name))
        .map((file) => ({
          file,
          serial: instrumentType === 'f3' ? getF3FileSerial(file.name) : getEh4FileSerial(file.name)
        }))
        .filter((item) => Number.isFinite(item.serial))
        .sort((a, b) => a.serial - b.serial)
        .filter((item) => {
          if (seenSerials.has(item.serial)) return false;
          seenSerials.add(item.serial);
          return true;
        });
      if (ordinal >= serialCandidates.length) continue;
      const fallbackMatch = serialCandidates[ordinal]?.file || null;
      if (fallbackMatch) {
        bestByCategory.set(category, fallbackMatch);
        break;
      }
    }
  });

  return Array.from(bestByCategory.values());
};

const hydrateMatchedPaths = (entry, matchedFiles, allItems) => {
  const matchedDataPaths = (matchedFiles || []).map((file) => buildProjectItemPath(file, allItems)).filter(Boolean);
  return {
    ...entry,
    matchedDataPaths,
    matchedDataCount: matchedDataPaths.length,
    hasExistingData: matchedDataPaths.length > 0,
    pointStatus: normalizePointStatus(matchedDataPaths.length)
  };
};

const isExcelSourcedEntry = (entry = {}) => {
  const sourceName = String(entry?.sourceCoordFileName || entry?.sourceFileName || '').trim().toLowerCase();
  return Boolean(sourceName && EXCEL_PATTERN.test(sourceName));
};

const isDriveGeneratedEntry = (entry = {}) => {
  if (entry.generatedFromDrive) return true;
  const sourceName = String(entry?.sourceCoordFileName || entry?.sourceFileName || '').trim().toLowerCase();
  if (!sourceName) return false;
  return !EXCEL_PATTERN.test(sourceName);
};

const clearEntryMatchedData = (entry = {}) => ({
  ...entry,
  matchedDataPaths: [],
  matchedDataCount: 0,
  hasExistingData: false,
  pointStatus: normalizePointStatus(0)
});

const countSurveyPoints = (entries = []) => (
  (entries || []).filter((entry) => entry?.entryKind !== 'array').length
);

const mergeGeneratedEntriesIntoExisting = (existingEntries = [], generatedMap = new Map(), options = {}) => {
  const nextEntries = [];
  const consumedKeys = new Set();
  const preserveInstrumentTypes = options.preserveInstrumentTypes || new Set();

  (existingEntries || []).forEach((entry, index) => {
    const instrument = getInstrumentLabel(entry?.instrument || '');
    const line = String(entry?.line || '').trim();
    const point = String(entry?.point || '').trim();
    if (!line || !point) {
      nextEntries.push(entry);
      return;
    }

    const key = buildEntryKey(instrument, line, point);
    const generated = generatedMap.get(key);
    if (generated) {
      consumedKeys.add(key);
      const nextMatchedPaths = Array.isArray(generated?.matchedDataPaths)
        ? generated.matchedDataPaths.filter(Boolean)
        : [];
      nextEntries.push({
        ...entry,
        id: entry.id || generated.id || `entry_${index + 1}`,
        instrument: generated.instrument || entry.instrument,
        entryKind: generated.entryKind || entry.entryKind || 'point',
        gpsLongitude: normalizeNumber(entry?.gpsLongitude ?? generated?.gpsLongitude),
        gpsLatitude: normalizeNumber(entry?.gpsLatitude ?? generated?.gpsLatitude),
        z: normalizeNumber(entry?.z ?? generated?.z),
        sourceFileId: generated.sourceFileId || entry.sourceFileId || '',
        sourceFileName: generated.sourceFileName || entry.sourceFileName || '',
        sourceCoordFileId: generated.sourceCoordFileId || entry.sourceCoordFileId || entry.sourceFileId || '',
        sourceCoordFileName: generated.sourceCoordFileName || entry.sourceCoordFileName || entry.sourceFileName || '',
        matchedDataPaths: nextMatchedPaths,
        matchedDataCount: nextMatchedPaths.length,
        hasExistingData: nextMatchedPaths.length > 0,
        pointStatus: normalizePointStatus(nextMatchedPaths.length)
      });
      return;
    }

    if (isDriveGeneratedEntry(entry)) {
      if (preserveInstrumentTypes.has(normalizeInstrumentType(entry.instrument))) {
        nextEntries.push(entry);
      }
      return;
    }

    if (isExcelSourcedEntry(entry)) {
      return;
    }

    nextEntries.push(clearEntryMatchedData(entry));
  });

  generatedMap.forEach((entry, key) => {
    if (consumedKeys.has(key)) return;
    nextEntries.push(entry);
  });

  return nextEntries.sort((a, b) => {
    const lineCompare = String(a.line || '').localeCompare(String(b.line || ''), 'zh-Hans-CN', { numeric: true });
    if (lineCompare !== 0) return lineCompare;
    const instrumentCompare = String(a.instrument || '').localeCompare(String(b.instrument || ''), 'zh-Hans-CN', { numeric: true });
    if (instrumentCompare !== 0) return instrumentCompare;
    return String(a.point || '').localeCompare(String(b.point || ''), 'zh-Hans-CN', { numeric: true });
  });
};

const collectRawContext = (items = []) => {
  const itemMap = new Map((items || []).map((item) => [item.id, item]));
  const rawRoots = (items || []).filter(isRawFolder);
  if (!rawRoots.length) {
    return { itemMap, rawRoots, rawFiles: [] };
  }
  const rawRootIds = new Set(rawRoots.map((item) => String(item.id)));
  const isWithinRawTree = (item) => {
    let cursor = item;
    while (cursor) {
      if (rawRootIds.has(String(cursor.id || ''))) return true;
      cursor = itemMap.get(cursor.parentId) || null;
    }
    return false;
  };
  const rawFiles = (items || []).filter((item) => (
    item?.type === 'file'
    && isWithinRawTree(item)
    && !String(item.generatedBy || '').startsWith('res2dinv-stitch')
  ));
  return {
    itemMap,
    rawRoots,
    rawFiles
  };
};

const resolveInstrumentRootId = (file, itemMap) => {
  let cursor = itemMap.get(file?.parentId) || null;
  while (cursor) {
    const instrumentType = normalizeInstrumentType(cursor.instrumentType || cursor.instrumentLabel || '');
    if (instrumentType) return cursor.id;
    cursor = itemMap.get(cursor.parentId) || null;
  }
  return null;
};

const buildEh4GeneratedEntries = async ({ files, itemMap, allItems, blobLoader }) => {
  const { parseAtFile } = await loadEh4Io();
  const generatedMap = new Map();
  const sourceFiles = (files || []).filter((file) => file?.type === 'file' && String(file.name || '').startsWith('@'));
  for (const sourceFile of sourceFiles) {
    const text = await resolveFileText(sourceFile, blobLoader);
    if (!text) continue;
    let stations = [];
    try {
      stations = parseAtFile(text);
    } catch {
      stations = [];
    }
    if (!stations.length) continue;

    const instrumentRootId = resolveInstrumentRootId(sourceFile, itemMap);
    const scopedFiles = chooseScopedFiles(sourceFile, instrumentRootId, files, itemMap);
    const lineEntries = stations
      .map((station) => {
        const line = resolveExplicitLineCode(
          station.line,
          station.lineCode,
          station.lineNo,
          station.surveyLine,
          station.ryValue,
          station.ry
        );
        const point = resolveExplicitLineCode(station.rxValue, station.rx, station.point, station.pointNo, station.id);
        if (!line) return null;
        if (!point) return null;
        return createBaseEntry({
          instrument: 'eh4',
          line,
          point,
          sourceFile,
          elevation: station.z
        });
      })
      .filter(Boolean);

    lineEntries.forEach((entry) => {
      const matchedFiles = findMatchesByCategories({
        instrumentType: 'eh4',
        entry,
        lineEntries,
        scopedFiles,
        allFiles: files
      });
      upsertGeneratedEntry(generatedMap, hydrateMatchedPaths(entry, matchedFiles, allItems));
    });
  }
  return generatedMap;
};

const buildF3GeneratedEntries = async ({ files, itemMap, allItems, blobLoader }) => {
  const { parseF3IndexFile } = await loadEh4Io();
  const generatedMap = new Map();
  const sourceFiles = (files || []).filter((file) => file?.type === 'file' && isF3ProjectIndexFile(file.name));
  const lineGroups = new Map();
  for (const sourceFile of sourceFiles) {
    const buffer = await resolveFileBuffer(sourceFile, blobLoader);
    if (!buffer) continue;
    let records = [];
    try {
      records = parseF3IndexFile(buffer);
    } catch {
      records = [];
    }
    if (!records.length) continue;

    const instrumentRootId = resolveInstrumentRootId(sourceFile, itemMap);
    const scopedFiles = chooseScopedFiles(sourceFile, instrumentRootId, files, itemMap);
    records.forEach((record) => {
      const line = resolveExplicitLineCode(record.line, record.lineCode, record.lineNo, record.surveyLine);
      const point = String(record.point || '').trim();
      if (!line || !point) return;
      const groupKey = `${instrumentRootId || sourceFile.parentId || 'f3'}__${line}`;
      if (!lineGroups.has(groupKey)) {
        lineGroups.set(groupKey, {
          line,
          entries: new Map(),
          scopedFiles: new Map()
        });
      }
      const group = lineGroups.get(groupKey);
      scopedFiles.forEach((file) => group.scopedFiles.set(file.id || buildProjectItemPath(file, allItems) || file.name, file));
      const entry = createBaseEntry({
        instrument: 'f3',
        line,
        point,
        sourceFile,
        longitude: record.gpsLongitude,
        latitude: record.gpsLatitude,
        elevation: record.gpsElevation
      });
      const entryKey = buildEntryKey(entry.instrument, entry.line, entry.point);
      group.entries.set(entryKey, group.entries.has(entryKey) ? mergeEntry(group.entries.get(entryKey), entry) : entry);
    });
  }

  lineGroups.forEach((group) => {
    const lineEntries = Array.from(group.entries.values())
      .sort((a, b) => String(a.point || '').localeCompare(String(b.point || ''), 'zh-Hans-CN', { numeric: true }));
    lineEntries.forEach((entry) => {
      const matchedFiles = findMatchesByCategories({
        instrumentType: 'f3',
        entry,
        lineEntries,
        scopedFiles: Array.from(group.scopedFiles.values()),
        allFiles: files
      });
      upsertGeneratedEntry(generatedMap, hydrateMatchedPaths(entry, matchedFiles, allItems));
    });
  });
  return generatedMap;
};

const buildEdiGeneratedEntries = async ({ files, allItems, blobLoader }) => {
  const generatedMap = new Map();
  const sourceFiles = (files || []).filter((file) => file?.type === 'file' && /\.edi$/i.test(String(file.name || '').trim()));
  for (const sourceFile of sourceFiles) {
    const text = await resolveFileText(sourceFile, blobLoader);
    if (!text) continue;
    const metadata = parseEdiMetadata(text, sourceFile.name);
    const point = String(metadata.point || metadata.dataId || sourceFile.name.replace(/\.[^.]+$/, '')).trim();
    if (!point) continue;
    const line = resolveExplicitLineCode(metadata.line);
    if (!line) continue;
    const entry = createBaseEntry({
      instrument: 'edi',
      line,
      point,
      sourceFile,
      longitude: metadata.lon,
      latitude: metadata.lat,
      elevation: metadata.elev
    });
    upsertGeneratedEntry(generatedMap, hydrateMatchedPaths(entry, [sourceFile], allItems));
  }
  return generatedMap;
};

const buildEmapGeneratedEntries = async ({ files, itemMap, allItems, blobLoader }) => {
  const { parseMTTSHeader } = await loadEh4Io();
  const grouped = new Map();
  const sourceFiles = (files || []).filter((file) => file?.type === 'file' && /\.mtts$/i.test(String(file.name || '').trim()));
  for (const sourceFile of sourceFiles) {
    const buffer = await resolveFileBuffer(sourceFile, blobLoader);
    let header = null;
    if (buffer) {
      try {
        header = parseMTTSHeader(buffer, sourceFile.name);
      } catch {
        header = null;
      }
    }
    const point = String(header?.pointNo || parseMttsPointNo(sourceFile.name) || '').trim();
    if (!point) continue;
    const line = resolveExplicitLineCode(
      header?.line,
      header?.lineCode,
      header?.lineNo,
      header?.surveyLine,
      resolveParentFolderLineCode(sourceFile, itemMap),
      '0'
    );
    if (!line) continue;
    const key = buildEntryKey('emap1', line, point);
    if (!grouped.has(key)) {
      grouped.set(key, createBaseEntry({
        instrument: 'emap1',
        line,
        point,
        sourceFile,
        elevation: header?.elevation
      }));
    }
    const entry = grouped.get(key);
    entry.matchedDataPaths = Array.from(new Set([
      ...(entry.matchedDataPaths || []),
      buildProjectItemPath(sourceFile, allItems)
    ].filter(Boolean)));
    entry.matchedDataCount = entry.matchedDataPaths.length;
    entry.hasExistingData = entry.matchedDataCount > 0;
    entry.pointStatus = normalizePointStatus(entry.matchedDataCount);
  }
  const generatedMap = new Map();
  grouped.forEach((entry) => upsertGeneratedEntry(generatedMap, entry));
  return generatedMap;
};

const buildErtGeneratedEntries = async ({ files, itemMap, allItems }) => {
  const generatedMap = new Map();
  const sourceFiles = (files || []).filter((file) => file?.type === 'file' && isErtDataFile(file.name));

  sourceFiles.forEach((sourceFile) => {
    const line = resolveErtLineCode(sourceFile, itemMap);
    const arrangement = parseErtLineArrangement(sourceFile).arrangement;
    if (!line || !arrangement) return;
    const entry = createBaseEntry({
      instrument: 'ert',
      line,
      point: arrangement,
      sourceFile,
      entryKind: 'array'
    });
    upsertGeneratedEntry(generatedMap, hydrateMatchedPaths(entry, [sourceFile], allItems));
  });

  return generatedMap;
};

const combineGeneratedMaps = (...maps) => {
  const combined = new Map();
  maps.forEach((map) => {
    map?.forEach((entry) => upsertGeneratedEntry(combined, entry));
  });
  return combined;
};

const shouldPreserveInstrumentOnEmptyGeneration = (files = [], generatedMap = new Map()) => (
  (files || []).some((file) => file?.type === 'file')
  && generatedMap.size === 0
);

export const syncDriveSurveyEntries = async (project, items = [], options = {}) => {
  const existingEntries = Array.isArray(project?.plan?.designEntries) ? project.plan.designEntries : [];
  const { itemMap, rawFiles } = collectRawContext(items);
  if (!rawFiles.length) {
    const nextEntries = mergeGeneratedEntriesIntoExisting(existingEntries, new Map());
    return {
      designEntries: nextEntries,
      changed: buildComparableSignature(existingEntries) !== buildComparableSignature(nextEntries),
      lineCount: new Set(nextEntries.map((entry) => `${String(entry.line || '').trim()}__${normalizeInstrumentType(entry.instrument)}`)).size,
      pointCount: countSurveyPoints(nextEntries)
    };
  }

  const instrumentFiles = rawFiles.reduce((acc, file) => {
    const folderInstrument = resolveInstrumentRootId(file, itemMap)
      ? normalizeInstrumentType(itemMap.get(resolveInstrumentRootId(file, itemMap))?.instrumentType || itemMap.get(resolveInstrumentRootId(file, itemMap))?.instrumentLabel || '')
      : '';
    const instrumentType = normalizeInstrumentType(file.instrumentType || file.instrumentLabel || folderInstrument || classifyFileInstrument(file.name));
    if (!instrumentType) return acc;
    if (!acc[instrumentType]) acc[instrumentType] = [];
    acc[instrumentType].push(file);
    return acc;
  }, {});

  const blobLoader = options.blobLoader || resolveDriveFileContent;
  const [eh4Map, f3Map, ediMap, emapMap, ertMap] = await Promise.all([
    buildEh4GeneratedEntries({ files: instrumentFiles.eh4 || [], itemMap, allItems: items, blobLoader }),
    buildF3GeneratedEntries({ files: instrumentFiles.f3 || [], itemMap, allItems: items, blobLoader }),
    buildEdiGeneratedEntries({ files: instrumentFiles.edi || [], allItems: items, blobLoader }),
    buildEmapGeneratedEntries({ files: instrumentFiles.emap1 || [], itemMap, allItems: items, blobLoader }),
    buildErtGeneratedEntries({ files: instrumentFiles.ert || [], itemMap, allItems: items })
  ]);

  const generatedMap = combineGeneratedMaps(eh4Map, f3Map, ediMap, emapMap, ertMap);
  const preserveInstrumentTypes = new Set();
  if (shouldPreserveInstrumentOnEmptyGeneration(instrumentFiles.eh4 || [], eh4Map)) preserveInstrumentTypes.add('eh4');
  if (shouldPreserveInstrumentOnEmptyGeneration(instrumentFiles.f3 || [], f3Map)) preserveInstrumentTypes.add('f3');
  if (shouldPreserveInstrumentOnEmptyGeneration(instrumentFiles.edi || [], ediMap)) preserveInstrumentTypes.add('edi');
  if (shouldPreserveInstrumentOnEmptyGeneration(instrumentFiles.emap1 || [], emapMap)) preserveInstrumentTypes.add('emap1');
  if (shouldPreserveInstrumentOnEmptyGeneration(instrumentFiles.ert || [], ertMap)) preserveInstrumentTypes.add('ert');
  const nextEntries = mergeGeneratedEntriesIntoExisting(existingEntries, generatedMap, { preserveInstrumentTypes });
  const lineCount = new Set(nextEntries.map((entry) => `${String(entry.line || '').trim()}__${normalizeInstrumentType(entry.instrument)}`)).size;

  return {
    designEntries: nextEntries,
    changed: buildComparableSignature(existingEntries) !== buildComparableSignature(nextEntries),
    lineCount,
    pointCount: countSurveyPoints(nextEntries)
  };
};

export const buildPointDataSuffix = (entry = {}) => {
  const instrumentType = normalizeInstrumentType(entry.instrument);
  const categories = new Set(
    (Array.isArray(entry?.matchedDataPaths) ? entry.matchedDataPaths : [])
      .map((path) => String(path || '').split('/').pop() || '')
      .map((name) => getMatchedCategory(instrumentType, name))
      .filter(Boolean)
  );
  return ['x', 'y', 'z'].filter((category) => categories.has(category)).join('');
};
