/**
 * Shared instrument-type utilities.
 */

export const normalizeInstrumentType = (instrument = '') => {
  const value = String(instrument || '').trim().toLowerCase();
  if (!value) return '';
  if (value.includes('f3')) return 'f3';
  if (value.includes('emap')) return 'emap1';
  if (value.includes('eh4') || value.includes('mt') || value.includes('大地电磁')) return 'eh4';
  if (value.includes('edi')) return 'edi';
  if (value.includes('高密度') || value.includes('电法') || value.includes('ert')) return 'ert';
  return value;
};

export const formatInstrumentLabel = (instrumentType, fallback = '') => {
  const normalizedType = normalizeInstrumentType(instrumentType || fallback);
  if (normalizedType === 'f3') return 'F3';
  if (normalizedType === 'eh4') return 'EH4';
  if (normalizedType === 'emap1') return 'EMAP-1';
  if (normalizedType === 'edi') return 'EDI';
  if (normalizedType === 'mt') return 'MT(Z/X/Y)';
  if (normalizedType === 'ert') return '高密度电法';
  return String(fallback || instrumentType || '').trim();
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
  if (/\.(dat|segy|vtk|txt|csv|xyz|grd|bln|clr|srf|bas|npz)$/i.test(normalizedName)) return 'ert';
  return '';
};

export const isSpreadsheetFile = (name = '') => /\.(xlsx|xls)$/i.test(String(name || '').trim());

export const isCoordWorkbookFile = (name = '') => {
  const normalizedName = String(name || '').trim().toLowerCase();
  if (!isSpreadsheetFile(normalizedName)) return false;
  return /coord|coordinate|lonlat|cgcs|design|plan|survey|layout|point|station|eh4|f3|emap|edi|坐标|点位|测点|设计|方案|布设|测线|物探/.test(normalizedName);
};

export const inferInstrumentFromWorkbookName = (name = '') => {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('edi')) return 'EDI';
  if (normalized.includes('f3')) return 'F3';
  if (normalized.includes('emap')) return 'EMAP-1';
  if (normalized.includes('eh4')) return 'EH4';
  if (/(^|[^a-z])mt([^a-z]|$)/i.test(normalized) || normalized.includes('大地电磁')) return 'EH4';
  return '';
};

export const normalizeImportedInstrument = (value = '') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('edi')) return 'EDI';
  if (normalized.includes('f3')) return 'F3';
  if (normalized.includes('emap')) return 'EMAP-1';
  if (normalized.includes('eh4')) return 'EH4';
  if (/(^|[^a-z])mt([^a-z]|$)/i.test(normalized) || normalized.includes('大地电磁')) return 'EH4';
  return '';
};

export const getInstrumentPalette = (instrument = '') => {
  const instrumentType = normalizeInstrumentType(instrument);
  if (instrumentType === 'f3') {
    return { stroke: '#0f766e', fill: '#14b8a6', lightFill: '#99f6e4' };
  }
  if (instrumentType === 'edi') {
    return { stroke: '#7c3aed', fill: '#8b5cf6', lightFill: '#ddd6fe' };
  }
  if (instrumentType === 'emap1') {
    return { stroke: '#dc2626', fill: '#ef4444', lightFill: '#fecaca' };
  }
  return { stroke: '#2563eb', fill: '#60a5fa', lightFill: '#bfdbfe' };
};

export const normalizeSurveyMethod = (method) => {
  const value = String(method || '').trim();
  if (!value) return '';
  if (value.includes('大地电磁')) return '大地电磁法';
  if (value.includes('高密度')) return '高密度电法';
  return '';
};

export const SURVEY_METHOD_OPTIONS = ['大地电磁法', '高密度电法'];

export const INSTRUMENT_OPTIONS_BY_METHOD = {
  大地电磁法: ['F3', 'EH4', 'EDI', 'EMAP-1'],
  高密度电法: ['高密度电法'],
};
