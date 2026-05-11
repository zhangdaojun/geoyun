// Render a SimPEG TensorMesh (or any rectangular cell raster) directly to a
// PNG without any interpolation. Each input cell is painted as a single
// rectangle, matching the npz model exactly. This bypasses IDW smearing — the
// previous behaviour where ~80% of TensorMesh padding cells (locked at the
// background ρ) dominated the IDW weights and washed every pixel into the same
// colour.
//
// Input contract:
//   cells:    array of [x_left, z_bottom, dx, dz, rho]
//   minVal/maxVal: linear color domain
//   colors:   palette of hex strings, length >= 2
//   bounds:   { xMin, xMax, yMin, yMax } — the rendered raster's coordinate window
//   flipY:    true when the Y axis is elevation (top = high z)

const DEFAULT_PALETTE = ['#0017c8', '#0066ff', '#00d9ff', '#22e35b', '#f7f85b', '#ff7a1a', '#a30000'];
const IMAGE_CACHE_LIMIT = 16;
const imageCache = new Map();

const hexToRgb = (hex) => {
  const normalized = String(hex || '').replace('#', '').trim();
  const full = normalized.length === 3
    ? normalized.split('').map((c) => c + c).join('')
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

const rounded = (value, digits = 3) => Number(Number(value).toFixed(digits));

const makeCacheKey = ({ cells, bounds, minVal, maxVal, colors, width, height, flipY }) => {
  const step = Math.max(1, Math.floor(cells.length / 80));
  const cellSig = cells
    .filter((_, idx) => idx % step === 0)
    .map((c) => `${rounded(c[0])},${rounded(c[1])},${rounded(c[4], 2)}`)
    .join('|');
  return [
    width,
    height,
    rounded(bounds.xMin), rounded(bounds.xMax), rounded(bounds.yMin), rounded(bounds.yMax),
    rounded(minVal, 2), rounded(maxVal, 2),
    flipY ? 'flip' : 'normal',
    colors.join(','),
    cellSig,
  ].join('::');
};

const getRasterSize = (xSpan, ySpan, cellCount) => {
  const aspect = Math.max(xSpan / Math.max(ySpan, 1e-9), 0.25);
  const pixelBudget = cellCount > 4000 ? 60000 : cellCount > 1500 ? 90000 : 120000;
  let width = Math.round(Math.sqrt(pixelBudget * aspect));
  let height = Math.round(width / aspect);
  width = Math.max(240, Math.min(960, width));
  height = Math.max(120, Math.min(540, height));
  return { width, height };
};

export const createCellGridFieldImage = ({
  cells = [],
  minVal,
  maxVal,
  colors = DEFAULT_PALETTE,
  bounds,
  flipY = false,
}) => {
  if (typeof document === 'undefined') return null;
  if (!Array.isArray(cells) || cells.length === 0) return null;
  if (!bounds || !Number.isFinite(bounds.xMin) || !Number.isFinite(bounds.xMax)
    || !Number.isFinite(bounds.yMin) || !Number.isFinite(bounds.yMax)) return null;
  const xSpan = Math.max(bounds.xMax - bounds.xMin, 1e-6);
  const ySpan = Math.max(bounds.yMax - bounds.yMin, 1e-6);
  const { width, height } = getRasterSize(xSpan, ySpan, cells.length);

  const cacheKey = makeCacheKey({ cells, bounds, minVal, maxVal, colors, width, height, flipY });
  const cached = imageCache.get(cacheKey);
  if (cached) {
    imageCache.delete(cacheKey);
    imageCache.set(cacheKey, cached);
    return cached;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // Transparent background — rectangles paint only where cells exist.
  ctx.clearRect(0, 0, width, height);

  const xToPx = (x) => ((x - bounds.xMin) / xSpan) * width;
  const yToPx = (y) => flipY
    ? ((bounds.yMax - y) / ySpan) * height
    : ((y - bounds.yMin) / ySpan) * height;

  // ImageSmoothingEnabled would blur cell edges; keep it crisp.
  ctx.imageSmoothingEnabled = false;
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (!Array.isArray(cell) || cell.length < 5) continue;
    const xLeft = Number(cell[0]);
    const zBot = Number(cell[1]);
    const dx = Number(cell[2]);
    const dz = Number(cell[3]);
    const rho = Number(cell[4]);
    if (!Number.isFinite(xLeft + zBot + dx + dz + rho)) continue;
    if (dx <= 0 || dz <= 0) continue;

    const rect = flipY
      ? {
          x: xToPx(xLeft),
          y: yToPx(zBot + dz),
          w: xToPx(xLeft + dx) - xToPx(xLeft),
          h: yToPx(zBot) - yToPx(zBot + dz),
        }
      : {
          x: xToPx(xLeft),
          y: yToPx(zBot),
          w: xToPx(xLeft + dx) - xToPx(xLeft),
          h: yToPx(zBot + dz) - yToPx(zBot),
        };
    const color = sampleColor(rho, minVal, maxVal, colors);
    ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
    // Add 0.5px padding to avoid hairline gaps from rounding
    ctx.fillRect(rect.x - 0.5, rect.y - 0.5, rect.w + 1, rect.h + 1);
  }

  const result = {
    image: canvas.toDataURL('image/png'),
    bounds: { xMin: bounds.xMin, xMax: bounds.xMax, yMin: bounds.yMin, yMax: bounds.yMax },
  };
  imageCache.set(cacheKey, result);
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    imageCache.delete(oldest);
  }
  return result;
};
