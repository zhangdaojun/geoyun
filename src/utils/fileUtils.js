/**
 * Shared file-related utilities.
 * Extracted from Projects.jsx and DataDrive.jsx to eliminate duplication.
 */

/**
 * Parse a file size value to megabytes.
 * Accepts number (treated as MB) or string like "10 KB", "2.5 GB".
 */
export const parseFileSizeToMb = (sizeValue) => {
  if (typeof sizeValue === 'number' && Number.isFinite(sizeValue)) return sizeValue;
  const text = String(sizeValue || '').trim();
  if (!text) return 0;
  const match = text.match(/([\d.]+)\s*(kb|mb|gb|b)?/i);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = String(match[2] || 'mb').toLowerCase();
  if (unit === 'gb') return value * 1024;
  if (unit === 'kb') return value / 1024;
  if (unit === 'b') return value / (1024 * 1024);
  return value;
};

/**
 * Parse a file size value to bytes.
 * Accepts number (treated as raw bytes) or string like "10 KB", "2.5 MB".
 */
export const parseFileSizeBytes = (value) => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(Math.floor(value), 0);

  const text = String(value || '').trim();
  if (!text) return 0;

  const match = text.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
  if (!match) return 0;

  const numeric = Number(match[1] || 0);
  const unit = String(match[2] || 'B').toUpperCase();
  const factor = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
  }[unit] || 1;
  return Math.max(Math.round(numeric * factor), 0);
};

/**
 * Format raw bytes for display without rounding small files down to zero.
 */
export const formatFileSizeBytes = (value) => {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

/**
 * Extract a file extension from a filename.
 */
export const getFileExtension = (name = '') => {
  const parts = String(name || '').split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
};

/**
 * Parse MTTS file display metadata from a filename.
 * Returns { pointNo, channel, sampleRateTag } or null.
 */
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
    sampleRateTag: sampleRateTag || '--',
  };
};

/**
 * Parse MTTS point number from filename.
 */
export const parseMTTSPointNo = (name = '') => {
  const normalizedName = String(name || '').trim();
  if (!/\.mtts$/i.test(normalizedName)) return '';
  const baseName = normalizedName.replace(/\.[^.]+$/, '');
  const parts = baseName.split('_');
  return String(parts[0] || baseName).trim();
};

/**
 * Build the file path string by traversing parent items.
 */
export const buildFileItemPath = (item, items = []) => {
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

/**
 * Check if a file is an Excel workbook.
 */
export const isExcelWorkbookFile = (name = '') => /\.(xlsx|xls)$/i.test(String(name || '').trim());

/**
 * Check if a file is an EMAP1 calibration file.
 */
export const isEmap1CalibrationFile = (name = '') => /\.(tbl|txt|rsp|resp|cal)$/i.test(String(name || '').trim());
