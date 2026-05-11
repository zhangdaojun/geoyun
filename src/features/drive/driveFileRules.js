export const parseMTTSDisplayMeta = (name = '') => {
  const normalizedName = String(name || '').trim();
  if (!/\.mtts$/i.test(normalizedName)) return null;
  const baseName = normalizedName.replace(/\.[^.]+$/, '');
  const parts = baseName.split('_');
  const pointNo = (parts[0] || baseName).trim();
  const channel = (parts.length >= 3 ? parts[parts.length - 2] : '').trim().toUpperCase();
  const sampleRateTag = (parts.length >= 2 ? parts[parts.length - 1] : '').trim().toUpperCase();
  return {
    pointNo: pointNo || normalizedName,
    channel: channel || '--',
    sampleRateTag: sampleRateTag || '--'
  };
};

export const isExcelWorkbookFile = (name = '') => /\.(xlsx|xls)$/i.test(String(name || '').trim());

export const isCoordWorkbookFile = (name = '') => {
  const normalizedName = String(name || '').trim().toLowerCase();
  if (!/\.(xlsx|xls)$/i.test(normalizedName)) return false;
  return /设计坐标|坐标设计|coord|emap|emap-1|eh4|f3/.test(normalizedName);
};

export const normalizeInstrumentType = (instrument) => {
  const value = String(instrument || '').trim().toLowerCase();
  if (!value) return '';
  if (value.includes('f3')) return 'f3';
  if (value.includes('eh4') && value.includes('emap')) return 'eh4-emap1';
  if (value.includes('emap')) return 'emap1';
  if (value.includes('eh4')) return 'eh4';
  if (value === 'edi' || value.includes('edi')) return 'edi';
  if (value.includes('mt')) return 'mt';
  if (value.includes('高密度') || value.includes('电法')) return 'ert';
  if (value.includes('高密度') || value.includes('电法') || value.includes('ert')) return 'ert';
  return value;
};

export const formatInstrumentLabel = (instrumentType, fallback = '') => {
  const normalizedType = normalizeInstrumentType(instrumentType || fallback);
  if (normalizedType === 'f3') return 'F3';
  if (normalizedType === 'eh4') return 'EH4';
  if (normalizedType === 'emap1') return 'EMAP-1';
  if (normalizedType === 'eh4-emap1') return 'EH4 / EMAP-1';
  if (normalizedType === 'edi') return 'EDI';
  if (normalizedType === 'mt') return 'MT(Z/X/Y)';
  if (normalizedType === 'ert') return '高密度电法';
  if (normalizedType === 'ert') return '高密度电法';
  return String(fallback || instrumentType || '').trim();
};

export const normalizeSurveyMethod = (method) => {
  const value = String(method || '').trim();
  if (!value) return '';
  if (value.includes('大地电磁')) return '大地电磁法';
  if (value.includes('高密度')) return '高密度电法';
  return '';
};

export const isF3FileName = (name = '') => {
  const lowerName = String(name || '').toLowerCase();
  const ext = lowerName.includes('.') ? lowerName.split('.').pop() : '';
  return ['f3', 'fh', 'fl', 'fm', 'r', 'psd', 'index', 'idx'].includes(ext) || /(^|[^a-z0-9])f3([^a-z0-9]|$)/i.test(lowerName);
};

export const classifyFileInstrument = (fileName = '') => {
  const normalizedName = String(fileName || '').trim();
  const lowerName = normalizedName.toLowerCase();
  if (!lowerName) return '';
  if (normalizedName.startsWith('@')) return 'eh4';
  if (lowerName === 'sensors.tbl' || /^afev/i.test(normalizedName)) return 'eh4';
  if (/\.(50h|60h|hf)$/i.test(normalizedName)) return 'eh4';
  if (lowerName.endsWith('.xyz')) return 'eh4';
  if (lowerName.endsWith('.mtts')) return 'emap1';
  if (/\.(index|idx|psd|fh|fm|fl)$/i.test(normalizedName) || isF3FileName(normalizedName)) return 'f3';
  if (lowerName.endsWith('.edi')) return 'edi';
  if (lowerName.endsWith('.mt')) return 'mt';
  if ((normalizedName.startsWith('X') || normalizedName.startsWith('Y') || normalizedName.startsWith('Z')) && /\.\d{3}$/i.test(normalizedName)) return 'eh4';
  if (/\.(dat|segy|vtk|txt|csv|xyz|grd|bln|clr|srf|bas)$/i.test(normalizedName)) return 'ert';
  return '';
};

export const getMappedDriveExt = (fileName = '') => {
  const parts = String(fileName || '').split('.');
  const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : 'unknown';
  if (['dat', 'segy', 'vtk', 'txt', 'csv', 'grd', 'bln', 'clr', 'srf', 'bas'].includes(ext)) return 'dat';
  if (['edi', 'mt', 'mtts'].includes(ext)) return 'mt';
  if (isF3FileName(fileName)) return 'mt';
  if (['jpg', 'png', 'tif', 'tiff'].includes(ext)) return 'image';
  if (['doc', 'docx', 'pdf', 'ppt'].includes(ext)) return 'doc';
  if (String(fileName || '').startsWith('X') || String(fileName || '').startsWith('Y') || String(fileName || '').startsWith('Z')) return 'mt';
  return 'code';
};
