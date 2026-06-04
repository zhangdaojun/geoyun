import { useEffect, useRef, useState } from 'react';
import { isCoordWorkbookFile, isF3FileName, parseMTTSDisplayMeta } from '../driveFileRules';

const normalizeText = (value = '') => String(value || '').trim().toLowerCase();

const normalizeInstrumentType = (value = '') => {
  const normalized = normalizeText(value);
  if (normalized.includes('f3')) return 'f3';
  if (normalized.includes('emap')) return 'emap1';
  if (normalized.includes('eh4')) return 'eh4';
  if (normalized.includes('edi')) return 'edi';
  if (normalized.includes('mt')) return 'eh4';
  if (normalized.includes('高密度') || normalized.includes('电法') || normalized.includes('ert')) return 'ert';
  return normalized;
};

const extractFileNameFromPath = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.split(/[\\/]/).filter(Boolean).pop() || text;
};

const getF3FileSerial = (name = '') => {
  const match = String(name || '').trim().match(/^.+\.(\d+)\.(r|psd|fh|fm|fl)$/i);
  return match ? Number(match[1]) : Number.NaN;
};

const getEh4FileSerial = (name = '') => {
  const match = String(name || '').trim().match(/^[xyz]?[^.]*\.(\d{3,4})$/i);
  return match ? Number(match[1]) : Number.NaN;
};

const parseMttsPointNo = (name = '') => {
  const normalizedName = String(name || '').trim();
  if (!/\.mtts$/i.test(normalizedName)) return '';
  const baseName = normalizedName.replace(/\.[^.]+$/, '');
  return String(baseName.split('_')[0] || baseName).trim();
};

const isErtParserFile = (name = '', ext = '') => (
  ['dat', 'txt', 'csv', 'xyz', 'vtk', 'segy', 'grd', 'bln', 'clr', 'srf', 'bas', 'npz'].includes(String(ext || '').toLowerCase())
  || /\.(dat|txt|csv|xyz|vtk|segy|grd|bln|clr|srf|bas|npz)$/i.test(String(name || '').trim())
);

const buildExactPointTokens = (...values) => {
  const tokens = new Set();
  values.forEach((value) => {
    const raw = normalizeText(value);
    if (!raw) return;
    tokens.add(raw);
    const digits = raw.replace(/\D/g, '');
    if (digits) tokens.add(digits);
  });
  return Array.from(tokens);
};

const getFileNameTokens = (name = '') => {
  const normalized = normalizeText(name);
  const stem = normalized.replace(/\.(edi|mt|r|psd|\d{3,4})$/i, '').replace(/^[xyz]/i, '');
  const digits = normalized.replace(/\D/g, '');
  return new Set([normalized, stem, digits, digits.slice(-3), digits.slice(-4), digits.slice(-5)].filter(Boolean));
};

const matchesExactPointToken = (fileName = '', exactPointTokens = []) => {
  if (!exactPointTokens.length) return false;
  const normalizedName = normalizeText(fileName);
  const fileTokens = getFileNameTokens(normalizedName);
  return exactPointTokens.some((token) => fileTokens.has(token));
};

const buildPathNameSet = (...pathGroups) => new Set(
  pathGroups
    .flat()
    .map(extractFileNameFromPath)
    .map(normalizeText)
    .filter(Boolean)
);

const getEh4SiblingFilesBySerial = (seedFiles = [], files = []) => {
  const candidates = [];
  const seenIds = new Set();
  seedFiles.forEach((seedFile) => {
    const serial = getEh4FileSerial(seedFile?.name || '');
    if (!Number.isFinite(serial)) return;
    files
      .filter((file) => (
        file?.type === 'file'
        && (seedFile.parentId == null || file.parentId === seedFile.parentId)
        && getEh4FileSerial(file.name || '') === serial
        && (/^[xyz]/i.test(file.name || '') || file.ext?.toLowerCase() === 'mt' || /\.edi$/i.test(file.name || ''))
      ))
      .forEach((file) => {
        const key = file.id || `${file.parentId || ''}/${file.name || ''}`;
        if (seenIds.has(key)) return;
        seenIds.add(key);
        candidates.push(file);
      });
  });
  return candidates;
};

const choosePreferredParserFile = (files = []) => {
  const priority = [
    (file) => isErtParserFile(file.name, file.ext),
    (file) => /\.r$/i.test(file.name) || /\.edi$/i.test(file.name) || /^z/i.test(file.name) || (file.ext?.toLowerCase() === 'mt' && !/^[xy]/i.test(file.name)),
    (file) => /\.psd$/i.test(file.name) || /^x/i.test(file.name),
    (file) => /\.(fh|fm|fl|mtts)$/i.test(file.name) || /^y/i.test(file.name),
    (file) => /\.(index|idx)$/i.test(file.name)
  ];
  for (const matcher of priority) {
    const matched = files.find((file) => matcher(file));
    if (matched) return matched;
  }
  return files[0] || null;
};

export const useDriveParserRoute = ({
  fileSystem,
  currentItems,
  displayItems,
  navigateToFolder,
  logFileOperations,
  buildFileOperationPayload,
  selectedProject,
  pendingPointRequest
}) => {
  const [parsingFile, setParsingFile] = useState(null);
  const [parsingMTFile, setParsingMTFile] = useState(null);
  const [parsingXFile, setParsingXFile] = useState(null);
  const [parsingYFile, setParsingYFile] = useState(null);
  const [parsingEH4Project, setParsingEH4Project] = useState(null);
  const [parsingF3IndexProject, setParsingF3IndexProject] = useState(null);
  const [parsingDesignCoordFile, setParsingDesignCoordFile] = useState(null);
  const lastHandledPointRequestRef = useRef('');

  const clearDataParsers = () => {
    setParsingFile(null);
    setParsingMTFile(null);
    setParsingXFile(null);
    setParsingYFile(null);
    setParsingEH4Project(null);
    setParsingF3IndexProject(null);
    setParsingDesignCoordFile(null);
  };

  const findPointEntry = (request) => {
    const entries = selectedProject?.plan?.designEntries || [];
    const requestPointId = String(request?.pointId || '').trim();
    const requestLine = String(request?.lineKey || '').trim();
    const requestPointName = String(request?.pointName || '').trim();
    const requestInstrument = normalizeInstrumentType(request?.instrumentName);

    return entries.find((entry) => String(entry?.id || '').trim() === requestPointId)
      || entries.find((entry) => (
        String(entry?.line || '').trim() === requestLine
        && String(entry?.point || '').trim() === requestPointName
        && (!requestInstrument || normalizeInstrumentType(entry?.instrument) === requestInstrument)
      ))
      || null;
  };

  const findByBoundPaths = (request, entry, files) => {
    const names = buildPathNameSet(
      request?.matchedDataPaths || [],
      entry?.matchedDataPaths || [],
      entry?.fileNames || [],
      [entry?.sourceFileName, entry?.sourceCoordFileName]
    );
    if (!names.size) return null;
    const matchedFiles = files.filter((file) => names.has(normalizeText(file.name)));
    const instrumentType = normalizeInstrumentType(entry?.instrument || request?.instrumentName);
    if (instrumentType === 'eh4') {
      const siblingFiles = getEh4SiblingFilesBySerial(matchedFiles, files);
      return choosePreferredParserFile(siblingFiles.length ? siblingFiles : matchedFiles);
    }
    return choosePreferredParserFile(matchedFiles);
  };

  const findByPointOrdinal = (request, entry, files) => {
    const entries = selectedProject?.plan?.designEntries || [];
    const instrumentType = normalizeInstrumentType(entry?.instrument || request?.instrumentName);
    const lineKey = String(entry?.line || request?.lineKey || '').trim();
    const pointName = String(entry?.point || request?.pointName || '').trim();
    if (!instrumentType || !lineKey || !pointName) return null;

    if (instrumentType === 'emap1') {
      return choosePreferredParserFile(files.filter((file) => /\.mtts$/i.test(file.name) && parseMttsPointNo(file.name) === pointName));
    }

    if (instrumentType === 'ert') {
      const targetName = normalizeText(pointName);
      return choosePreferredParserFile(files.filter((file) => (
        isErtParserFile(file.name, file.ext)
        && normalizeText(file.name).replace(/\.[^.]+$/, '') === targetName
      )));
    }

    const sameLineEntries = entries
      .filter((item) => (
        normalizeInstrumentType(item?.instrument) === instrumentType
        && String(item?.line || '').trim() === lineKey
      ))
      .sort((a, b) => String(a?.point || '').localeCompare(String(b?.point || ''), 'zh-Hans-CN', { numeric: true }));
    const ordinal = sameLineEntries.findIndex((item) => (
      String(item?.id || '').trim() === String(entry?.id || request?.pointId || '').trim()
      || String(item?.point || '').trim() === pointName
    ));
    if (ordinal < 0) return null;

    if (instrumentType === 'f3') {
      const candidates = files
        .filter((file) => /\.r$/i.test(file.name))
        .map((file) => ({ file, serial: getF3FileSerial(file.name) }))
        .filter((item) => Number.isFinite(item.serial))
        .sort((a, b) => a.serial - b.serial);
      return candidates[ordinal]?.file || null;
    }

    const pointTokens = buildExactPointTokens(pointName);
    const exactMatch = files.find((file) => (
      ((file.ext?.toLowerCase() === 'mt' && !/^[xy]/i.test(file.name)) || /\.edi$/i.test(file.name) || /^z/i.test(file.name))
      && matchesExactPointToken(file.name, pointTokens)
    ));
    if (exactMatch) return exactMatch;

    const candidates = files
      .filter((file) => (file.ext?.toLowerCase() === 'mt' && !/^[xy]/i.test(file.name)) || /\.edi$/i.test(file.name) || /^z/i.test(file.name))
      .map((file) => ({ file, serial: getEh4FileSerial(file.name) }))
      .filter((item) => Number.isFinite(item.serial))
      .sort((a, b) => a.serial - b.serial);
    return candidates[ordinal]?.file || null;
  };

  const openParserForResolvedFile = (file) => {
    if (!file) return false;
    if (file.parentId) navigateToFolder(file.parentId);
    clearDataParsers();
    routeToParser(file);
    return true;
  };

  const routeToParser = (item) => {
    if (item.type === 'mtts-group') {
      setParsingYFile(item);
      return;
    }
    if (item.type === 'folder') {
      clearDataParsers();
      navigateToFolder(item.id);
      return;
    }
    if (isCoordWorkbookFile(item.name)) {
      setParsingDesignCoordFile(item);
    } else if (item.name.startsWith('@')) {
      setParsingEH4Project(item);
    } else if (/\.mtts$/i.test(item.name)) {
      setParsingYFile(item);
    } else if (/\.(index|idx)$/i.test(item.name)) {
      setParsingF3IndexProject(item);
    } else if (item.name.toLowerCase().endsWith('.psd')) {
      setParsingXFile(item);
    } else if (/\.(fh|fm|fl)$/i.test(item.name)) {
      setParsingYFile(item);
    } else if (isF3FileName(item.name)) {
      setParsingMTFile(item);
    } else if (isErtParserFile(item.name, item.ext)) {
      setParsingFile(item);
    } else if (/^x/i.test(item.name) && /\.\d{3}$/i.test(item.name)) {
      setParsingXFile(item);
    } else if (/^y/i.test(item.name) && /\.\d{3}$/i.test(item.name)) {
      setParsingYFile(item);
    } else if ((item.ext?.toLowerCase() === 'mt' && !/^[xy]/i.test(item.name)) || item.name.toLowerCase().endsWith('.edi') || (/^z/i.test(item.name) && /\.\d{3}$/i.test(item.name))) {
      setParsingMTFile(item);
    } else {
      alert(`正在提取预览：${item.name}\n当前文件暂不支持在线解析，请先下载后用桌面软件处理。`);
    }
  };

  const openDriveItem = (item) => {
    if (!item) return;
    if (item.type === 'folder' || item.type === 'mtts-group') {
      routeToParser(item);
      return;
    }

    let previewTarget = 'unsupported';
    let previewResult = 'success';

    if (isCoordWorkbookFile(item.name)) previewTarget = 'design-coord';
    else if (item.name.startsWith('@')) previewTarget = 'eh4-project';
    else if (/\.mtts$/i.test(item.name)) previewTarget = 'y-parser';
    else if (/\.(index|idx)$/i.test(item.name)) previewTarget = 'f3-index';
    else if (item.name.toLowerCase().endsWith('.psd')) previewTarget = 'x-parser';
    else if (/\.(fh|fm|fl)$/i.test(item.name)) previewTarget = 'y-parser';
    else if (isF3FileName(item.name)) previewTarget = 'mt-parser';
    else if (isErtParserFile(item.name, item.ext)) previewTarget = 'ert-parser';
    else if (/^x/i.test(item.name) && /\.\d{3}$/i.test(item.name)) previewTarget = 'x-parser';
    else if (/^y/i.test(item.name) && /\.\d{3}$/i.test(item.name)) previewTarget = 'y-parser';
    else if ((item.ext?.toLowerCase() === 'mt' && !/^[xy]/i.test(item.name)) || item.name.toLowerCase().endsWith('.edi') || (/^z/i.test(item.name) && /\.\d{3}$/i.test(item.name))) previewTarget = 'mt-parser';
    else previewResult = 'failed';

    void logFileOperations([
      buildFileOperationPayload(item, 'preview', { previewTarget }, previewResult)
    ]);
    routeToParser(item);
  };

  useEffect(() => {
    const stamp = String(pendingPointRequest?.stamp || '').trim();
    if (!stamp || stamp === lastHandledPointRequestRef.current) return;
    if (pendingPointRequest?.projectId && selectedProject?.id && pendingPointRequest.projectId !== selectedProject.id) return;

    const files = (fileSystem || []).filter((item) => item?.type === 'file');
    if (!files.length) return;

    const entry = findPointEntry(pendingPointRequest);
    const instrumentType = normalizeInstrumentType(entry?.instrument || pendingPointRequest?.instrumentName);
    const ordinalFile = findByPointOrdinal(pendingPointRequest, entry, files);
    const boundFile = findByBoundPaths(pendingPointRequest, entry, files);
    const targetFile = choosePreferredParserFile(
      instrumentType === 'f3'
        ? [ordinalFile, boundFile].filter(Boolean)
        : [boundFile, ordinalFile].filter(Boolean)
    );

    lastHandledPointRequestRef.current = stamp;
    const timeoutId = window.setTimeout(() => {
      if (!openParserForResolvedFile(targetFile)) {
      window.alert(`未找到测点 ${pendingPointRequest?.pointName || ''} 对应的可解析数据文件。`);
      }
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [fileSystem, pendingPointRequest, selectedProject]);

  const handleSwitchType = (currentFileObj, newType) => {
    if (!currentFileObj || !currentFileObj.name) return;

    const currentName = currentFileObj.name;
    const lowerName = currentName.toLowerCase();
    const f3Match = lowerName.match(/^(.+)\.(\d+)\.(r|psd|fh|fl|fm)$/i);
    if (f3Match) {
      const [, projectPart, serialRaw, currentExt] = f3Match;
      if (newType === 'Z' && currentExt.toLowerCase() === 'r') {
        const currentItem = fileSystem.find(f => (f.name || '').toLowerCase() === lowerName);
        setParsingMTFile(null);
        setParsingXFile(null);
        setParsingYFile(null);
        setParsingMTFile(currentItem || currentFileObj);
        return;
      }
      const extMap = { Z: ['r'], X: ['psd'], Y: ['fh', 'fl', 'fm'] };
      const serialVariants = Array.from(new Set([
        serialRaw,
        serialRaw.padStart(4, '0'),
        String(Number(serialRaw)).padStart(4, '0')
      ]));
      const targetExts = extMap[newType] || [];
      let targetFile = null;

      for (const ext of targetExts) {
        for (const serial of serialVariants) {
          const expectedName = `${projectPart}.${serial}.${ext}`.toLowerCase();
          targetFile = fileSystem.find(f => (f.name || '').toLowerCase() === expectedName);
          if (targetFile) break;
        }
        if (targetFile) break;
      }

      setParsingMTFile(null);
      setParsingXFile(null);
      setParsingYFile(null);
      if (newType === 'Z') setParsingMTFile(targetFile || currentFileObj);
      else if (newType === 'X') setParsingXFile(targetFile || currentFileObj);
      else if (newType === 'Y') setParsingYFile(targetFile || currentFileObj);
      return;
    }

    const baseName = currentFileObj.name.substring(1);
    const newName = newType + baseName;
    const targetFile = fileSystem.find(f => f.name.toUpperCase() === newName.toUpperCase());

    setParsingMTFile(null);
    setParsingXFile(null);
    setParsingYFile(null);

    if (!targetFile) return;
    if (newType === 'X') setParsingXFile(targetFile);
    else if (newType === 'Y') setParsingYFile(targetFile);
    else if (newType === 'Z') setParsingMTFile(targetFile);
  };

  const handleSwitchF3Band = (currentFileObj, band) => {
    if (!currentFileObj || !currentFileObj.name) return;
    const lowerName = currentFileObj.name.toLowerCase();
    const match = lowerName.match(/^(.+)\.(\d+)\.(fh|fm|fl)$/i);
    if (!match) return;

    const [, projectPart, serialRaw] = match;
    const targetExt = band === 'H' ? 'fh' : band === 'M' ? 'fm' : 'fl';
    const serialVariants = Array.from(new Set([
      serialRaw,
      serialRaw.padStart(4, '0'),
      String(Number(serialRaw)).padStart(4, '0')
    ]));

    let targetFile = null;
    for (const serial of serialVariants) {
      const expected = `${projectPart}.${serial}.${targetExt}`.toLowerCase();
      targetFile = fileSystem.find(f => (f.name || '').toLowerCase() === expected);
      if (targetFile) break;
    }
    if (targetFile) setParsingYFile(targetFile);
  };

  const handleSwitchFile = (direction, currentFileObj, type) => {
    if (!currentFileObj || !currentFileObj.name) return;

    const currentNameLower = (currentFileObj.name || '').toLowerCase();
    const currentMTTSMeta = parseMTTSDisplayMeta(currentFileObj.name || '');
    const isCurrentMTTSGroup = currentFileObj.type === 'mtts-group';
    const isCurrentMTTSFile = Boolean(currentMTTSMeta) || currentNameLower.endsWith('.mtts');

    if (type === 'Y' && (isCurrentMTTSGroup || isCurrentMTTSFile)) {
      const mttsGroups = displayItems.filter(item => item.type === 'mtts-group');
      if (mttsGroups.length <= 1) return;

      const currentPointNo = isCurrentMTTSGroup
        ? (currentFileObj.pointNo || currentFileObj.name)
        : (currentMTTSMeta?.pointNo || currentFileObj.name);

      const currentIndex = mttsGroups.findIndex(group => (group.pointNo || group.name) === currentPointNo);
      if (currentIndex === -1) return;

      let nextIndex = currentIndex + direction;
      if (nextIndex < 0) nextIndex = mttsGroups.length - 1;
      if (nextIndex >= mttsGroups.length) nextIndex = 0;
      setParsingYFile(mttsGroups[nextIndex]);
      return;
    }

    const sameTypeFiles = currentItems.filter(item => {
      if (item.type !== 'file') return false;
      if (type === 'Z') return item.name.toLowerCase().endsWith('.r') || (item.ext?.toLowerCase() === 'mt' && !/^[xy]/i.test(item.name)) || item.name.toLowerCase().endsWith('.edi') || (/^z/i.test(item.name) && /\.\d{3}$/i.test(item.name));
      if (type === 'X') return item.name.toLowerCase().endsWith('.psd') || (/^x/i.test(item.name) && /\.\d{3}$/i.test(item.name));
      if (type === 'Y') return /\.(fh|fm|fl|mtts)$/i.test(item.name) || (/^y/i.test(item.name) && /\.\d{3}$/i.test(item.name));
      return false;
    });

    if (sameTypeFiles.length <= 1) return;
    const currentIndex = sameTypeFiles.findIndex(f => f.name === currentFileObj.name || (currentFileObj.rawFile && f.name === currentFileObj.rawFile.name));
    if (currentIndex === -1) return;

    let nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = sameTypeFiles.length - 1;
    if (nextIndex >= sameTypeFiles.length) nextIndex = 0;

    const nextFile = sameTypeFiles[nextIndex];
    if (type === 'X') setParsingXFile(nextFile);
    else if (type === 'Y') setParsingYFile(nextFile);
    else if (type === 'Z') setParsingMTFile(nextFile);
  };

  return {
    parserState: {
      parsingFile,
      parsingMTFile,
      parsingXFile,
      parsingYFile,
      parsingEH4Project,
      parsingF3IndexProject,
      parsingDesignCoordFile
    },
    parserSetters: {
      setParsingFile,
      setParsingMTFile,
      setParsingXFile,
      setParsingYFile,
      setParsingEH4Project,
      setParsingF3IndexProject,
      setParsingDesignCoordFile
    },
    handleSwitchF3Band,
    handleSwitchFile,
    handleSwitchType,
    openDriveItem
  };
};
