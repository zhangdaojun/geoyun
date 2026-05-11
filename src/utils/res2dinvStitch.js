/**
 * RES2DINV 多排列拼接工具
 * ============================================================================
 *
 * 把同一条测线上多个排列（spread）的 RES2DINV `.DAT` 文件拼成一份单一文件。
 *
 * 语义参照 RES2DINV 官方 "Concatenate the data files into one file" 工具：
 *   - 每个排列文件都视为局部坐标系；用户为每个排列指定一个 `targetStartX`，
 *     表示该排列**首个地表电极**在全局坐标里的位置。
 *   - lineSign=1 表示该排列实际采集方向与全局方向相反，需在拼接前先沿排列
 *     中线作镜像。
 *   - 不做重叠区去重 / 平均 —— 全部记录原样保留，由后续反演软件处理。
 *
 * 与原先 (Projects.jsx 内嵌) 实现的关键差异：
 *
 *   1. **首电极位置取自 Surface electrodes 块**：当 `.DAT` 头里写了
 *      `Surface electrodes` 块（GPS / 地形坐标）时，直接用块内最左 X 作为
 *      `firstElectrodeX`，不再回头猜每条数据行的电极位置。
 *
 *   2. **xLocationType=2（供电偶极中点）单独处理**：原代码与 xLocationType=1
 *      (全阵中点) 共用 `localMin = x - span/2` 公式，对偶极–偶极这类不对称
 *      装置（arrayType=3）会产生 ~ (n+1)/2 * a 的系统性偏移；新实现按各
 *      arrayType 的几何关系给出准确的 leftmost / rightmost。
 *
 *   3. **arrayType=11/12/13 (非常规电极排布)**：拼接时把每个排列的 Surface
 *      electrodes 块也合并到输出文件，并按全局 X 重新排序去重。原实现只
 *      复用第一个文件的 header，丢失了后续排列的电极坐标。
 *
 *   4. **跨排列一致性校验**：arrayType / unit-spacing / IP flag /
 *      xLocationType 不一致时直接抛错，避免静默把字段不同的文件混在一起。
 *
 * 测试见 `res2dinvStitch.test.js`。
 */

const ARRAY_TYPES_WITH_EXPLICIT_ELECTRODES = new Set([11, 12, 13]);

/**
 * 单条数据记录的总跨度（最左电极到最右电极）。
 * 不同 arrayType 的几何约定参考 Loke 的 RES2DINV 用户手册附录。
 *
 * 注意：arrayType=6/8 的官方语义在不同版本手册里有差异，这里保持与项目
 * 其它代码（getStandardRes2dinvRecordRange）相同的公式以避免回归；如果
 * 你的源数据是那两种装置且发现拼接后位置不对，请提供示例文件来更正。
 */
export const getRes2dinvRecordSpan = (arrayType, a, n) => {
  if (!Number.isFinite(a) || a <= 0) return 0;
  const safeN = Number.isFinite(n) && n > 0 ? n : 1;
  switch (Number(arrayType)) {
    case 1: case 4: case 5: return 3 * a;          // Wenner α / β / γ
    case 2: return a;                              // Pole-pole
    case 3: return (safeN + 2) * a;                // Inline dipole-dipole
    case 6: return (safeN + 2) * a;                // (按现有约定保留)
    case 7: return (2 * safeN + 1) * a;            // Schlumberger
    case 8: return Math.max(a, safeN * a);         // Equatorial dipole-dipole (近似)
    default: return 0;
  }
};

/**
 * 给定一条记录的 (parts[0]=x, parts[1]=a, parts[2]=n)，计算该记录在局部
 * 坐标系下最左 / 最右电极位置。返回 null 表示无法解析。
 */
export const getRes2dinvRecordExtent = ({ arrayType, xLocationType = 0, values = [] } = {}) => {
  const x = Number(values[0]);
  const a = Number(values[1]);
  if (!Number.isFinite(x) || !Number.isFinite(a) || a <= 0) return null;
  const n = Number.isFinite(Number(values[2])) ? Math.max(1, Number(values[2])) : 1;
  const span = getRes2dinvRecordSpan(arrayType, a, n);
  if (!Number.isFinite(span) || span <= 0) return null;

  const arrayTypeNum = Number(arrayType);
  const xLocNum = Number(xLocationType);

  // xLocationType=0：x 即记录的最左电极位置
  if (xLocNum !== 1 && xLocNum !== 2) {
    return { leftmost: x, rightmost: x + span, span };
  }

  // xLocationType=1：x 是记录的全阵中点（=记录跨度的几何中心）
  if (xLocNum === 1) {
    return { leftmost: x - span / 2, rightmost: x + span / 2, span };
  }

  // xLocationType=2：x 是供电偶极中点。仅对**不对称**装置与对称装置不一致。
  // 对称装置：xLocationType=2 与 xLocationType=1 等价（中线即对称轴）。
  // 不对称装置：偶极–偶极、单极–偶极 等需单独处理。
  let leftmostOffset; // 从 x 到记录最左电极的距离（正值表 leftmost = x - offset）
  switch (arrayTypeNum) {
    case 3: {
      // C2-C1-P1-P2: x = mid(C2,C1) = xC2 + a/2; leftmost = xC2 = x - a/2
      leftmostOffset = a / 2;
      const rightmost = x - leftmostOffset + span;
      return { leftmost: x - leftmostOffset, rightmost, span };
    }
    case 6: {
      // 单极–偶极假设 C2 在无穷远，"mid of current dipole" 退化为 C1 位置；
      // 与 xLocationType=0 同义。
      return { leftmost: x, rightmost: x + span, span };
    }
    case 1: case 4: case 5: case 7: case 8: case 2:
    default: {
      // 对称装置 / pole-pole：等价于 xLocationType=1
      leftmostOffset = span / 2;
      return { leftmost: x - leftmostOffset, rightmost: x - leftmostOffset + span, span };
    }
  }
};

const splitNumbers = (line = '') => String(line || '')
  .replace(/,/g, ' ')
  .trim()
  .split(/\s+/)
  .map(Number)
  .filter(Number.isFinite);

const lineToInt = (line = '') => {
  const v = String(line || '').trim();
  return /^[-+]?\d+$/.test(v) ? Number.parseInt(v, 10) : Number.NaN;
};

const matchFirstFiniteNumber = (line = '') => {
  const m = String(line || '').match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/);
  return m ? Number(m[0]) : Number.NaN;
};

const isLikelyExplicitElectrodeRecord = (line = '') => {
  const parts = String(line || '').trim().split(/\s+/).filter(Boolean);
  const electrodeCount = Number.parseInt(parts[0], 10);
  return [2, 3, 4].includes(electrodeCount) && parts.length >= electrodeCount * 2 + 2;
};

/**
 * 解析 `.DAT` 头部布局：dataCount / dataStartIndex / xLocationType / ipFlag。
 * arrayType=11/12/13 时 dataCount 行可能不在固定位置（前面会有 "Type of measurement"
 * 等附加行），需要在前 ~18 行内启发式定位。
 */
export const resolveRes2dinvLayout = (lines = [], arrayType = 0) => {
  if (ARRAY_TYPES_WITH_EXPLICIT_ELECTRODES.has(Number(arrayType))) {
    for (let index = 4; index < Math.min(lines.length - 2, 18); index += 1) {
      const dataCount = lineToInt(lines[index]);
      if (!Number.isFinite(dataCount) || dataCount < 0) continue;
      const xLocationType = lineToInt(lines[index + 1]);
      const ipFlag = lineToInt(lines[index + 2]);
      const dataStartIndex = index + 3;
      if (![0, 1, 2].includes(xLocationType) || ![0, 1].includes(ipFlag)) continue;
      if (dataCount > 0 && !isLikelyExplicitElectrodeRecord(lines[dataStartIndex] || '')) continue;
      return { dataCount, dataStartIndex, dataCountIndex: index, xLocationType, ipFlag };
    }
  }

  const dataCount = lineToInt(lines[3]);
  const xLocationType = lineToInt(lines[4]);
  const ipFlag = lineToInt(lines[5]);
  if (Number.isFinite(dataCount) && dataCount >= 0) {
    return {
      dataCount,
      dataStartIndex: 6,
      dataCountIndex: 3,
      xLocationType: Number.isFinite(xLocationType) ? xLocationType : 0,
      ipFlag: Number.isFinite(ipFlag) ? ipFlag : 0,
    };
  }
  return null;
};

/**
 * 解析 Surface electrodes / Topography 块，返回 [{ x, z }, ...]。块不存在
 * 时返回 null。geoyun 这边只关心电极的 X，因为我们不做地形拼接的纵向校
 * 正——但保留 z 字段方便后续扩展。
 */
const parseSurfaceElectrodes = (lines = []) => {
  const idx = lines.findIndex((line) => /surface\s+electrodes/i.test(line));
  if (idx < 0) return null;
  const electrodeCount = Number.parseInt(String(lines[idx + 1] || '').trim(), 10);
  if (!Number.isFinite(electrodeCount) || electrodeCount < 2) return null;
  const electrodes = [];
  for (let i = idx + 2; i < lines.length && electrodes.length < electrodeCount; i += 1) {
    const numbers = splitNumbers(lines[i]);
    if (numbers.length >= 1) {
      electrodes.push({ x: numbers[0], z: numbers.length >= 2 ? numbers[1] : 0 });
    }
  }
  if (electrodes.length < 2) return null;
  return {
    blockStartIndex: idx,
    blockEndIndex: idx + 1 + electrodes.length,
    electrodes,
  };
};

export const parseRes2dinvTopographyBlock = (lines = [], startIndex = 0) => {
  let cursor = Math.max(Number(startIndex) || 0, 0);
  while (cursor < lines.length && !String(lines[cursor] || '').trim()) cursor += 1;
  const flag = lineToInt(lines[cursor]);
  if (![1, 2].includes(flag)) return null;

  let countIndex = cursor + 1;
  while (countIndex < lines.length && !String(lines[countIndex] || '').trim()) countIndex += 1;
  const pointCount = lineToInt(lines[countIndex]);
  if (!Number.isFinite(pointCount) || pointCount <= 0 || pointCount > 4000) return null;

  const points = [];
  let lineIndex = countIndex + 1;
  while (lineIndex < lines.length && points.length < pointCount) {
    const numbers = splitNumbers(lines[lineIndex]);
    if (numbers.length >= 2) {
      points.push({ x: numbers[0], elevation: numbers[1], z: numbers[1] });
    }
    lineIndex += 1;
  }
  if (points.length !== pointCount) return null;

  let firstElectrodePointIndex = 1;
  while (lineIndex < lines.length && !String(lines[lineIndex] || '').trim()) lineIndex += 1;
  const parsedFirstIndex = lineToInt(lines[lineIndex]);
  if (Number.isFinite(parsedFirstIndex) && parsedFirstIndex > 0) {
    firstElectrodePointIndex = parsedFirstIndex;
    lineIndex += 1;
  }

  return {
    flag,
    pointCount,
    points,
    firstElectrodePointIndex,
    blockStartIndex: cursor,
    blockEndIndex: lineIndex - 1
  };
};

/**
 * 计算单个排列的 (firstElectrodeX, lastElectrodeX, spreadLength) 局部范围。
 * 优先级：Surface electrodes 块 > arrayType 11/12/13 显式电极坐标 > 按 arrayType
 * + xLocationType 推算的 per-record extents。
 */
export const computeSpreadElectrodeRange = ({ lines, arrayType, layout, dataLines }) => {
  const surfaceBlock = parseSurfaceElectrodes(lines);
  if (surfaceBlock) {
    const xs = surfaceBlock.electrodes.map((e) => e.x).filter(Number.isFinite);
    if (xs.length >= 2) {
      return {
        firstElectrodeX: Math.min(...xs),
        lastElectrodeX: Math.max(...xs),
        source: 'surface-electrodes',
      };
    }
  }

  if (ARRAY_TYPES_WITH_EXPLICIT_ELECTRODES.has(Number(arrayType))) {
    const xs = [];
    dataLines.forEach((line) => {
      const parts = line.trim().split(/\s+/).filter(Boolean);
      const count = Number.parseInt(parts[0], 10);
      if ([2, 3, 4].includes(count)) {
        for (let i = 1; i <= count * 2 - 1; i += 2) {
          const x = Number(parts[i]);
          if (Number.isFinite(x)) xs.push(x);
        }
      }
    });
    if (xs.length >= 2) {
      return {
        firstElectrodeX: Math.min(...xs),
        lastElectrodeX: Math.max(...xs),
        source: 'explicit-records',
      };
    }
  }

  let firstX = Number.POSITIVE_INFINITY;
  let lastX = Number.NEGATIVE_INFINITY;
  dataLines.forEach((line) => {
    const values = splitNumbers(line);
    if (values.length < 3) return;
    const extent = getRes2dinvRecordExtent({
      arrayType,
      xLocationType: layout.xLocationType,
      values,
    });
    if (!extent) return;
    if (extent.leftmost < firstX) firstX = extent.leftmost;
    if (extent.rightmost > lastX) lastX = extent.rightmost;
  });

  if (Number.isFinite(firstX) && Number.isFinite(lastX) && lastX > firstX) {
    return {
      firstElectrodeX: firstX,
      lastElectrodeX: lastX,
      source: 'record-extent',
    };
  }
  return null;
};

/**
 * 解析单个排列文件，返回拼接需要的所有元数据。
 * 失败返回 null（调用方应当报"该排列无法解析"）。
 */
export const parseRes2dinvSource = (text = '') => {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 6) return null;
  const arrayType = Number.parseInt(String(lines[2] || '').trim(), 10);
  if (!Number.isFinite(arrayType)) return null;
  const layout = resolveRes2dinvLayout(lines, arrayType);
  if (!layout) return null;

  const unitSpacing = matchFirstFiniteNumber(lines[1]);

  const dataLines = [];
  for (let i = layout.dataStartIndex; i < lines.length && dataLines.length < layout.dataCount; i += 1) {
    const line = String(lines[i] || '').trim();
    if (line) dataLines.push(line);
  }

  const tailLines = lines
    .slice(layout.dataStartIndex + dataLines.length)
    .filter((line) => String(line || '').trim());

  const range = computeSpreadElectrodeRange({ lines, arrayType, layout, dataLines });
  const topographyBlock = parseRes2dinvTopographyBlock(lines, layout.dataStartIndex + dataLines.length);

  return {
    lines,
    arrayType,
    layout,
    unitSpacing,
    headerLines: lines.slice(0, layout.dataStartIndex),
    dataLines,
    tailLines,
    surfaceBlock: parseSurfaceElectrodes(lines),
    topographyBlock,
    firstElectrodeX: range ? range.firstElectrodeX : 0,
    lastElectrodeX: range ? range.lastElectrodeX : 0,
    spreadLength: range ? range.lastElectrodeX - range.firstElectrodeX : 0,
    rangeSource: range ? range.source : null,
  };
};

export const formatRes2dinvCoordinate = (value) => {
  const v = Number(value);
  if (!Number.isFinite(v)) return String(value ?? '');
  const rounded = Math.abs(v) < 1e-9 ? 0 : v;
  return Number.isInteger(rounded) ? String(rounded) : String(Number(rounded.toFixed(6)));
};

/**
 * 把单条数据行从局部坐标系平移到全局坐标系。
 *
 * @param {object} args
 * @param {string} args.line              原始数据行
 * @param {number} args.arrayType
 * @param {number} args.xLocationType
 * @param {number} args.targetStartX      该排列首电极在全局坐标的位置
 * @param {number} args.firstElectrodeX   该排列首电极在局部坐标的位置
 * @param {number} args.lastElectrodeX    该排列末电极在局部坐标的位置
 * @param {boolean} args.reverse          lineSign=1 时为 true
 */
export const transformRes2dinvDataLine = ({
  line = '',
  arrayType,
  xLocationType = 0,
  targetStartX = 0,
  firstElectrodeX = 0,
  lastElectrodeX = 0,
  reverse = false,
} = {}) => {
  const parts = String(line || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const arrayTypeNum = Number(arrayType);
  const sumOfEnds = firstElectrodeX + lastElectrodeX;

  /**
   * 将局部 x 平移到全局 x。
   * - 正向：x_global = (x_local - firstElectrodeX) + targetStartX
   * - 反向：先把 x 沿 [firstElectrodeX, lastElectrodeX] 镜像，再走正向公式
   *   - 反向时 isLeftmost=true 表示 x_local 实际指向"记录的最左电极"，
   *     镜像后该电极变成最右电极，记录的"最左电极"则变成原来的最右电极，
   *     需要再减去本记录跨度（recordSpan）。
   */
  const shift = (rawValue, { isLeftmost = false, recordSpan = 0 } = {}) => {
    const sourceX = Number(rawValue);
    if (!Number.isFinite(sourceX)) return rawValue;
    let local = sourceX;
    if (reverse) {
      local = sumOfEnds - sourceX;
      if (isLeftmost && recordSpan > 0) local -= recordSpan;
    }
    return formatRes2dinvCoordinate(targetStartX + (local - firstElectrodeX));
  };

  if (ARRAY_TYPES_WITH_EXPLICIT_ELECTRODES.has(arrayTypeNum)) {
    const electrodeCount = Number.parseInt(parts[0], 10);
    if ([2, 3, 4].includes(electrodeCount)) {
      // 每个电极都是显式 (x, z)；x 走 shift（不需 recordSpan，因为每个电极单独算位置）。
      // 注意：反向时仅"对每个 x 镜像"是不够的，C/P 电极的标号顺序也会颠倒；
      // 但 RES2DINV 数据行格式不在意标号顺序，只看几何，所以保持原顺序输出即可。
      for (let i = 1; i < parts.length && i <= electrodeCount * 2 - 1; i += 2) {
        parts[i] = shift(parts[i]);
      }
      return parts.join(' ');
    }
  }

  const a = Number(parts[1]);
  const n = parts.length > 2 && Number.isFinite(Number(parts[2]))
    ? Math.max(1, Number(parts[2]))
    : 1;
  const span = getRes2dinvRecordSpan(arrayTypeNum, a, n);

  // parts[0] 是否表示该记录的"最左电极"位置——只有 xLocationType=0 是
  // (xLocationType=1 是全阵中点；xLocationType=2 是供电偶极中点)。
  const isLeftmost = Number(xLocationType) === 0;

  parts[0] = shift(parts[0], { isLeftmost, recordSpan: span });
  return parts.join(' ');
};

const ensureConsistentSources = (sources) => {
  if (!sources.length) {
    throw new Error('未读取到可拼接的 RES2DINV 数据文件。');
  }
  const first = sources[0];
  for (let i = 1; i < sources.length; i += 1) {
    const cur = sources[i];
    if (cur.arrayType !== first.arrayType) {
      throw new Error(
        `第 ${i + 1} 个排列的 arrayType=${cur.arrayType} 与第 1 个排列的 arrayType=${first.arrayType} 不一致，无法拼接。`,
      );
    }
    if (cur.layout.xLocationType !== first.layout.xLocationType) {
      throw new Error(
        `第 ${i + 1} 个排列的 xLocationType=${cur.layout.xLocationType} 与第 1 个 (${first.layout.xLocationType}) 不一致，无法拼接。`,
      );
    }
    if (cur.layout.ipFlag !== first.layout.ipFlag) {
      throw new Error(
        `第 ${i + 1} 个排列的 IP flag=${cur.layout.ipFlag} 与第 1 个 (${first.layout.ipFlag}) 不一致，无法拼接（IP 列数不同）。`,
      );
    }
    if (
      Number.isFinite(cur.unitSpacing)
      && Number.isFinite(first.unitSpacing)
      && Math.abs(cur.unitSpacing - first.unitSpacing) > 1e-6
    ) {
      throw new Error(
        `第 ${i + 1} 个排列的电极间距 a=${cur.unitSpacing} 与第 1 个 (${first.unitSpacing}) 不一致，无法拼接。`,
      );
    }
  }
};

const buildMergedSurfaceBlock = (sources, rows) => {
  if (!sources.some((s) => s.surfaceBlock)) return null;
  const electrodes = [];
  sources.forEach((source, index) => {
    if (!source.surfaceBlock) return;
    const row = rows[index] || {};
    const targetStartX = Number.isFinite(Number(row.xLocation)) ? Number(row.xLocation) : 0;
    const reverse = row.lineSign === 1 || row.lineSign === '1';
    const sumOfEnds = source.firstElectrodeX + source.lastElectrodeX;
    source.surfaceBlock.electrodes.forEach(({ x, z }) => {
      const localX = reverse ? (sumOfEnds - x) : x;
      const globalX = targetStartX + (localX - source.firstElectrodeX);
      electrodes.push({ x: globalX, z });
    });
  });
  if (!electrodes.length) return null;
  electrodes.sort((p, q) => p.x - q.x);
  // 去重：相邻 x 距离小于 1e-6 视为同一个电极（取后者的 z）
  const dedup = [];
  electrodes.forEach((e) => {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.x - e.x) < 1e-6) {
      last.z = e.z;
    } else {
      dedup.push({ ...e });
    }
  });
  return dedup;
};

const buildMergedTopographyBlock = (sources, rows) => {
  if (!sources.some((s) => s.topographyBlock?.points?.length)) return null;
  const points = [];
  let flag = 2;
  sources.forEach((source, index) => {
    if (!source.topographyBlock?.points?.length) return;
    flag = source.topographyBlock.flag || flag;
    const row = rows[index] || {};
    const targetStartX = Number.isFinite(Number(row.xLocation)) ? Number(row.xLocation) : 0;
    const reverse = row.lineSign === 1 || row.lineSign === '1';
    const sumOfEnds = source.firstElectrodeX + source.lastElectrodeX;
    source.topographyBlock.points.forEach(({ x, elevation, z }) => {
      const sourceX = Number(x);
      const sourceElevation = Number(elevation ?? z);
      if (!Number.isFinite(sourceX) || !Number.isFinite(sourceElevation)) return;
      const localX = reverse ? (sumOfEnds - sourceX) : sourceX;
      const globalX = targetStartX + (localX - source.firstElectrodeX);
      points.push({ x: globalX, elevation: sourceElevation });
    });
  });
  if (!points.length) return null;
  points.sort((p, q) => p.x - q.x);
  const dedup = [];
  points.forEach((point) => {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.x - point.x) < 1e-6) {
      last.elevation = point.elevation;
    } else {
      dedup.push({ ...point });
    }
  });
  return { flag, points: dedup, firstElectrodePointIndex: 1 };
};

const normalizeOverlapMode = (mode) => (
  ['previous', 'next', 'average'].includes(mode) ? mode : 'previous'
);

const getRes2dinvRhoIndex = ({ line = '', arrayType = 0 } = {}) => {
  const parts = String(line || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return -1;
  const explicitElectrodeCount = Number.parseInt(parts[0], 10);
  if (ARRAY_TYPES_WITH_EXPLICIT_ELECTRODES.has(Number(arrayType)) && [2, 3, 4].includes(explicitElectrodeCount)) {
    const index = 1 + explicitElectrodeCount * 2;
    return parts.length > index ? index : -1;
  }
  if ([1, 2, 4, 5].includes(Number(arrayType))) return parts.length > 2 ? 2 : -1;
  return parts.length > 3 ? 3 : 2;
};

const normalizeOverlapKeyValue = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? formatRes2dinvCoordinate(Number(numeric.toFixed(6))) : String(value);
};

const buildOverlapRecord = ({ line, sourceIndex, arrayType }) => {
  const parts = String(line || '').trim().split(/\s+/).filter(Boolean);
  const rhoIndex = getRes2dinvRhoIndex({ line, arrayType });
  const rho = rhoIndex >= 0 ? Number(parts[rhoIndex]) : Number.NaN;
  if (rhoIndex < 0 || !Number.isFinite(rho)) {
    return { line, sourceIndex, key: null, rhoIndex: -1, rho: Number.NaN, averageCount: 1 };
  }
  const key = parts.slice(0, rhoIndex).map(normalizeOverlapKeyValue).join('|');
  return { line, sourceIndex, key, rhoIndex, rho, averageCount: 1 };
};

const replaceOverlapRecordRho = (record, rho) => {
  const parts = String(record.line || '').trim().split(/\s+/).filter(Boolean);
  parts[record.rhoIndex] = formatRes2dinvCoordinate(rho);
  return { ...record, line: parts.join(' '), rho };
};

const mergeOverlappingDataRecords = (records = [], mode = 'previous') => {
  const overlapMode = normalizeOverlapMode(mode);
  const merged = [];
  const firstIndexByKey = new Map();

  records.forEach((record) => {
    if (!record.key) {
      merged.push(record);
      return;
    }
    const existingIndex = firstIndexByKey.get(record.key);
    if (existingIndex === undefined) {
      firstIndexByKey.set(record.key, merged.length);
      merged.push(record);
      return;
    }

    const existing = merged[existingIndex];
    if (!existing || existing.sourceIndex === record.sourceIndex) {
      merged.push(record);
      return;
    }

    if (overlapMode === 'previous') return;
    if (overlapMode === 'next') {
      merged[existingIndex] = record;
      return;
    }

    const count = existing.averageCount || 1;
    const average = ((existing.rho * count) + record.rho) / (count + 1);
    merged[existingIndex] = {
      ...replaceOverlapRecordRho(existing, average),
      averageCount: count + 1,
    };
  });

  return merged.map((record) => record.line);
};

/**
 * 拼接多个 RES2DINV 排列文件。
 *
 * @param {object} args
 * @param {Array<{ text: string }>} args.sources 每个排列的源文件文本
 * @param {Array<{ xLocation:number, lineSign?:'0'|'1'|0|1 }>} args.rows 与 sources 一一对应
 * @param {string} [args.outputName] 输出文件名（不含路径）
 * @returns {string} 拼接后的 .DAT 文本
 */
export const buildStitchedRes2dinvDat = ({
  sources = [],
  rows = [],
  outputName = '',
  overlapMode = 'previous',
} = {}) => {
  const parsed = sources.map((s) => parseRes2dinvSource(s?.text)).filter(Boolean);
  if (parsed.length !== sources.length) {
    throw new Error('部分排列数据文件无法读取或格式不符合 RES2DINV。');
  }
  ensureConsistentSources(parsed);

  const first = parsed[0];
  const headerLines = [...first.headerLines];
  if (outputName) headerLines[0] = outputName.replace(/\.[^.]+$/, '');

  const transformedRecords = parsed.flatMap((source, index) => {
    const row = rows[index] || {};
    const reverse = row.lineSign === 1 || row.lineSign === '1';
    const targetStartX = Number.isFinite(Number(row.xLocation)) ? Number(row.xLocation) : 0;
    return source.dataLines.map((line) => {
      const transformedLine = transformRes2dinvDataLine({
        line,
        arrayType: source.arrayType,
        xLocationType: source.layout.xLocationType,
        targetStartX,
        firstElectrodeX: source.firstElectrodeX,
        lastElectrodeX: source.lastElectrodeX,
        reverse,
      });
      return buildOverlapRecord({
        line: transformedLine,
        sourceIndex: index,
        arrayType: source.arrayType,
      });
    });
  });
  const stitchedDataLines = mergeOverlappingDataRecords(transformedRecords, overlapMode);

  headerLines[first.layout.dataCountIndex] = String(stitchedDataLines.length);

  // arrayType=11/12/13 + 出现 Surface electrodes 块时，重写表面电极块到 tail
  // 之前。其它 arrayType 即使有 Surface electrodes 块也保留各自的，因为
  // 第一个排列的 header 已经包含原始的；这里不重写以避免破坏原数据。
  let tailLines = first.tailLines;
  const mergedTopography = buildMergedTopographyBlock(parsed, rows);
  if (mergedTopography) {
    const filteredTail = stripTopographyBlock(tailLines);
    const topographyBlockLines = [
      String(mergedTopography.flag),
      String(mergedTopography.points.length),
      ...mergedTopography.points.map((point) => `${formatRes2dinvCoordinate(point.x)} ${formatRes2dinvCoordinate(point.elevation)}`),
      String(mergedTopography.firstElectrodePointIndex),
    ];
    tailLines = [...topographyBlockLines, ...filteredTail];
  }
  const mergedSurface = buildMergedSurfaceBlock(parsed, rows);
  if (mergedSurface && ARRAY_TYPES_WITH_EXPLICIT_ELECTRODES.has(Number(first.arrayType))) {
    const filteredTail = stripSurfaceElectrodeBlock(tailLines);
    const surfaceBlockLines = [
      'Surface electrodes',
      String(mergedSurface.length),
      ...mergedSurface.map((e) => `${formatRes2dinvCoordinate(e.x)} ${formatRes2dinvCoordinate(e.z)}`),
    ];
    tailLines = [...surfaceBlockLines, ...filteredTail];
  }

  return [...headerLines, ...stitchedDataLines, ...tailLines].join('\r\n');
};

const stripTopographyBlock = (tailLines = []) => {
  const parsed = parseRes2dinvTopographyBlock(tailLines, 0);
  if (!parsed) return tailLines;
  return tailLines.slice(parsed.blockEndIndex + 1);
};

const stripSurfaceElectrodeBlock = (tailLines = []) => {
  const idx = tailLines.findIndex((line) => /surface\s+electrodes/i.test(line));
  if (idx < 0) return tailLines;
  const count = Number.parseInt(String(tailLines[idx + 1] || '').trim(), 10);
  if (!Number.isFinite(count) || count < 0) return tailLines;
  const blockEnd = idx + 1 + count;
  return [...tailLines.slice(0, idx), ...tailLines.slice(blockEnd + 1)];
};

/**
 * 生成 RES2DINV 内置 "CONCATENATE.dat" 控制脚本（与原 buildRes2dinvConcatenateCommand
 * 一致），方便用户手动跑 RES2DINV 的官方拼接工具。
 */
export const buildRes2dinvConcatenateCommand = ({ rows = [], outputPath = '' } = {}) => {
  const usefulRows = (rows || []).filter((row) => row?.dataPath);
  if (!usefulRows.length) return '';
  return [
    'Concatenation of several data files in RES2DINV format to one file in RES2DINV format',
    'Number of files to concatenate',
    String(usefulRows.length),
    ...usefulRows.flatMap((row, index) => [
      `File ${index + 1} parameters`,
      'Name of data file in RES2DINV format',
      row.dataPath,
      'X location of first electrode along this line',
      String(Number.isFinite(Number(row.xLocation)) ? Number(row.xLocation) : 0),
      'Line sign (0=positive, 1=negative)',
      String(row.lineSign === '1' || row.lineSign === 1 ? 1 : 0),
    ]),
    'Name of Output file in RES2DINV format',
    outputPath || 'c:\\data\\res2dinv_concatenated.DAT',
    'End of file',
  ].join('\r\n');
};

/**
 * 兼容旧 API：返回排列总长度（首–末电极距离）。
 */
export const parseRes2dinvArrangementLength = (text = '') => {
  const parsed = parseRes2dinvSource(text);
  if (!parsed) return null;
  return parsed.spreadLength > 0 ? parsed.spreadLength : null;
};
