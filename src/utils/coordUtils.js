/**
 * Shared coordinate utilities.
 * Extracted from Projects.jsx to centralize geospatial helpers.
 */

export const DEFAULT_PROJECT_CENTER = [35.86166, 104.195397];

export const defaultCoordParams = {
  coordType: 'lonlat',
  lonlatFormat: 'degree',
  centralMeridian: 102,
  latOrigin: 0,
  falseEasting: 500000,
  falseNorthing: 0,
  scale: 1,
};

/**
 * Check if a value is a valid [lat, lng] pair with finite numbers.
 */
export const isFiniteLatLng = (value) => (
  Array.isArray(value)
  && value.length >= 2
  && Number.isFinite(Number(value[0]))
  && Number.isFinite(Number(value[1]))
);

/**
 * Coerce a value to a valid [lat, lng] pair, falling back to a default.
 */
export const coerceLatLng = (value, fallback = DEFAULT_PROJECT_CENTER) => (
  isFiniteLatLng(value) ? [Number(value[0]), Number(value[1])] : [...fallback]
);

/**
 * Normalize coordinate parameters with defaults.
 */
export const normalizeCoordParams = (params = {}) => ({
  ...defaultCoordParams,
  ...(params || {}),
  centralMeridian: Number(params?.centralMeridian ?? defaultCoordParams.centralMeridian),
  latOrigin: Number(params?.latOrigin ?? defaultCoordParams.latOrigin),
  falseEasting: Number(params?.falseEasting ?? defaultCoordParams.falseEasting),
  falseNorthing: Number(params?.falseNorthing ?? defaultCoordParams.falseNorthing),
  scale: Number(params?.scale ?? defaultCoordParams.scale),
});

/**
 * Parse a longitude/latitude value based on the specified format.
 * Supports 'degree', 'degree_minute', and 'dms' (degree-minute-second).
 */
export const parseLonLat = (value, format) => {
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  if (format === 'degree') return Number.parseFloat(text);
  if (format === 'degree_minute') {
    let degree;
    let minute;
    if (text.includes(':')) {
      const parts = text.split(/[:'"]/);
      degree = Number.parseFloat(parts[0] || 0);
      minute = Number.parseFloat(parts[1] || 0);
    } else {
      const rawValue = Number.parseFloat(text);
      degree = Math.floor(rawValue);
      minute = (rawValue - degree) * 100;
    }
    return degree + minute / 60;
  }
  const match = text.match(/(-?\d+)[^\d]+(\d+)[^\d]+(\d+(?:\.\d+)?)/);
  if (!match) return Number.parseFloat(text);
  const sign = Number(match[1]) < 0 ? -1 : 1;
  const degree = Math.abs(Number(match[1]));
  const minute = Number(match[2]);
  const second = Number(match[3]);
  return sign * (degree + minute / 60 + second / 3600);
};
