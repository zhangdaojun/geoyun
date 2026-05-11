const DEFAULT_PALETTE = ['#0017c8', '#0066ff', '#00d9ff', '#22e35b', '#f7f85b', '#ff7a1a', '#a30000'];
const IMAGE_CACHE_LIMIT = 16;
const imageCache = new Map();

const hexToRgb = (hex) => {
  const normalized = String(hex || '').replace('#', '').trim();
  const full = normalized.length === 3
    ? normalized.split('').map((char) => char + char).join('')
    : normalized;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return [0, 0, 0];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

const sampleColor = (value, min, max, colors) => {
  const palette = colors.length >= 2 ? colors : DEFAULT_PALETTE;
  const span = max - min || 1;
  const t = Math.max(0, Math.min(1, (value - min) / span));
  const scaled = t * (palette.length - 1);
  const index = Math.min(Math.floor(scaled), palette.length - 2);
  const localT = scaled - index;
  const c0 = hexToRgb(palette[index]);
  const c1 = hexToRgb(palette[index + 1]);
  return [
    Math.round(c0[0] + (c1[0] - c0[0]) * localT),
    Math.round(c0[1] + (c1[1] - c0[1]) * localT),
    Math.round(c0[2] + (c1[2] - c0[2]) * localT),
  ];
};

const normalizePolygon = (polygon) => (
  Array.isArray(polygon)
    ? polygon
        .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    : []
);

const getRasterSize = (xSpan, ySpan, pointCount) => {
  const aspect = Math.max(xSpan / Math.max(ySpan, 1e-9), 0.25);
  const pixelBudget = pointCount > 5000
    ? 18000
    : pointCount > 2000
      ? 24000
      : pointCount > 800
        ? 30000
        : 36000;
  const maxWidth = pointCount > 800 ? 360 : 420;
  const maxHeight = pointCount > 800 ? 180 : 220;
  let width = Math.round(Math.sqrt(pixelBudget * aspect));
  let height = Math.round(width / aspect);

  if (width > maxWidth) {
    width = maxWidth;
    height = Math.round(width / aspect);
  }
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(height * aspect);
  }

  width = Math.max(180, width);
  height = Math.max(80, height);
  const pixels = width * height;
  if (pixels > pixelBudget) {
    const scale = Math.sqrt(pixelBudget / pixels);
    width = Math.max(160, Math.round(width * scale));
    height = Math.max(72, Math.round(height * scale));
  }

  return { width, height };
};

const rounded = (value, digits = 3) => Number(Number(value).toFixed(digits));

const makeImageCacheKey = ({ points, polygon, minVal, maxVal, colors, width, height, flipY = false }) => {
  const pointStep = Math.max(1, Math.floor(points.length / 80));
  const pointSignature = points
    .filter((_, index) => index % pointStep === 0)
    .map((point) => `${rounded(point.x)},${rounded(point.y)},${rounded(point.rho, 2)}`)
    .join('|');
  const polygonSignature = polygon
    .map((point) => `${rounded(point.x)},${rounded(point.y)}`)
    .join('|');
  return [
    width,
    height,
    rounded(minVal, 2),
    rounded(maxVal, 2),
    flipY ? 'flip-y' : 'normal-y',
    colors.join(','),
    pointSignature,
    polygonSignature
  ].join('::');
};

const getCachedImage = (key) => {
  if (!imageCache.has(key)) return null;
  const value = imageCache.get(key);
  imageCache.delete(key);
  imageCache.set(key, value);
  return value;
};

const setCachedImage = (key, value) => {
  imageCache.set(key, value);
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldestKey = imageCache.keys().next().value;
    imageCache.delete(oldestKey);
  }
};

const buildSpatialIndex = (points, xMin, xSpan, yMin, ySpan) => {
  const bucketCount = Math.max(8, Math.min(64, Math.ceil(Math.sqrt(points.length))));
  const buckets = Array.from({ length: bucketCount * bucketCount }, () => []);
  const clampIndex = (value) => Math.max(0, Math.min(bucketCount - 1, value));
  const getXIndex = (x) => clampIndex(Math.floor(((x - xMin) / xSpan) * bucketCount));
  const getYIndex = (y) => clampIndex(Math.floor(((y - yMin) / ySpan) * bucketCount));

  points.forEach((point) => {
    buckets[getYIndex(point.y) * bucketCount + getXIndex(point.x)].push(point);
  });

  return {
    bucketCount,
    buckets,
    getXIndex,
    getYIndex
  };
};

const getNearbyPoints = (index, x, y, maxSamples) => {
  if (!index || maxSamples <= 0) return [];
  const { bucketCount, buckets, getXIndex, getYIndex } = index;
  const cx = getXIndex(x);
  const cy = getYIndex(y);
  const candidates = [];

  for (let radius = 0; radius < bucketCount && candidates.length < maxSamples * 2; radius += 1) {
    const minX = Math.max(0, cx - radius);
    const maxX = Math.min(bucketCount - 1, cx + radius);
    const minY = Math.max(0, cy - radius);
    const maxY = Math.min(bucketCount - 1, cy + radius);

    for (let by = minY; by <= maxY; by += 1) {
      for (let bx = minX; bx <= maxX; bx += 1) {
        if (radius > 0 && bx > minX && bx < maxX && by > minY && by < maxY) continue;
        candidates.push(...buckets[by * bucketCount + bx]);
      }
    }
  }

  if (candidates.length <= maxSamples) return candidates;
  return candidates
    .map((point) => ({ point, distance: (point.x - x) ** 2 + (point.y - y) ** 2 }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxSamples)
    .map((item) => item.point);
};

const getScanlineIntervals = (polygon, y, tolerance) => {
  const intersections = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (Math.abs(a.y - b.y) < 1e-9) continue;
    if ((a.y > y) === (b.y > y)) continue;
    const t = (y - a.y) / (b.y - a.y);
    intersections.push(a.x + (b.x - a.x) * t);
  }

  intersections.sort((a, b) => a - b);
  const intervals = [];
  for (let i = 0; i + 1 < intersections.length; i += 2) {
    intervals.push([intersections[i] - tolerance, intersections[i + 1] + tolerance]);
  }
  return intervals;
};

const isXInIntervals = (x, intervals) => intervals.some(([left, right]) => x >= left && x <= right);

export const createInterpolatedFieldImage = ({ points, boundaryPolygon = [], minVal, maxVal, colors = DEFAULT_PALETTE, flipY = false }) => {
  if (typeof document === 'undefined' || points.length < 3) return null;
  const boundary = normalizePolygon(boundaryPolygon);
  const polygon = boundary.length >= 3 ? boundary : [];
  if (polygon.length < 3) return null;

  const polygonXValues = polygon.map((point) => point.x);
  const polygonYValues = polygon.map((point) => point.y);
  const xMin = Math.min(...polygonXValues);
  const xMax = Math.max(...polygonXValues);
  const yMin = Math.min(...polygonYValues);
  const yMax = Math.max(...polygonYValues);
  const xSpan = Math.max(xMax - xMin, 1);
  const ySpan = Math.max(yMax - yMin, 1);
  const { width, height } = getRasterSize(xSpan, ySpan, points.length);
  const cacheKey = makeImageCacheKey({ points, polygon, minVal, maxVal, colors, width, height, flipY });
  const cached = getCachedImage(cacheKey);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const imageData = ctx.createImageData(width, height);
  const pixels = imageData.data;
  const pixelTolerance = Math.max(xSpan / width, ySpan / height) * 1.25;
  const spatialIndex = points.length > 96 ? buildSpatialIndex(points, xMin, xSpan, yMin, ySpan) : null;
  const maxSamplesPerPixel = points.length > 1500 ? 14 : points.length > 500 ? 18 : 22;
  for (let py = 0; py < height; py += 1) {
    const ratioY = py / Math.max(height - 1, 1);
    const y = flipY
      ? yMax - ratioY * ySpan
      : yMin + ratioY * ySpan;
    const intervals = getScanlineIntervals(polygon, y, pixelTolerance);
    if (!intervals.length) continue;
    for (let px = 0; px < width; px += 1) {
      const x = xMin + (px / Math.max(width - 1, 1)) * xSpan;
      if (!isXInIntervals(x, intervals)) continue;

      let weightedValue = 0;
      let totalWeight = 0;
      const sources = spatialIndex ? getNearbyPoints(spatialIndex, x, y, maxSamplesPerPixel) : points;
      for (let i = 0; i < sources.length; i += 1) {
        const source = sources[i];
        const distance = Math.hypot(x - source.x, y - source.y);
        if (distance < 1e-6) {
          weightedValue = source.rho;
          totalWeight = 1;
          break;
        }
        const weight = 1 / (distance ** 2);
        weightedValue += source.rho * weight;
        totalWeight += weight;
      }
      if (!totalWeight) continue;

      const color = sampleColor(weightedValue / totalWeight, minVal, maxVal, colors);
      const dataIndex = (py * width + px) * 4;
      pixels[dataIndex] = color[0];
      pixels[dataIndex + 1] = color[1];
      pixels[dataIndex + 2] = color[2];
      pixels[dataIndex + 3] = 250;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  const result = {
    image: canvas.toDataURL('image/png'),
    bounds: { xMin, xMax, yMin, yMax }
  };
  setCachedImage(cacheKey, result);
  return result;
};
