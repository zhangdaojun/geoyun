import { parseYFile, writeXFile } from './eh4io.js';

const MU0 = 4 * Math.PI * 1e-7;
const DEFAULT_BASE_SAMPLE_RATE = 192000;
const DEFAULT_FFT_SIZE = 4096;
const HY_CHANNEL = 0;
const EX_CHANNEL = 1;
const HX_CHANNEL = 2;
const EY_CHANNEL = 3;
const ELECTRIC_MV_PER_M_TO_MV_PER_KM = 1000;
const HIGH_PASS_SENSOR_MASK = 0x80;
const HIGH_PASS_OFFSET_MASK = 0x140;
const ELECTRIC_GAIN_MASKS = [0x10, 0x4, 0x1, 0x2, 0x8];
const MAGNETIC_GAIN_MASKS = [0x0, 0x800, 0x200, 0x400, 0x1000];
const DEFAULT_COHERENCY_BINS = [0.8, 0.6, 0.3, 0.0];

const createComplex = (re = 0, im = 0) => ({ re, im });
const addComplex = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
const subComplex = (a, b) => ({ re: a.re - b.re, im: a.im - b.im });
const mulComplex = (a, b) => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re
});
const divComplex = (a, b) => {
  const denom = b.re * b.re + b.im * b.im;
  if (denom === 0) return createComplex(0, 0);
  return {
    re: (a.re * b.re + a.im * b.im) / denom,
    im: (a.im * b.re - a.re * b.im) / denom
  };
};
const conjComplex = (a) => ({ re: a.re, im: -a.im });
const absComplex = (a) => Math.hypot(a.re, a.im);
const absSquared = (a) => a.re * a.re + a.im * a.im;
const phaseDegrees = (a) => Math.atan2(a.im, a.re) * 180 / Math.PI;
const scaleComplex = (a, factor) => ({ re: a.re * factor, im: a.im * factor });
const clamp01 = (value) => Math.max(0, Math.min(1, value));

const nextPowerOfTwo = (value) => {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
};

const createHannWindow = (size) => {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
};

const fftRadix2 = (realInput) => {
  const n = nextPowerOfTwo(realInput.length);
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  real.set(realInput);

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    const wlenCos = Math.cos(angle);
    const wlenSin = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = real[i + j];
        const uIm = imag[i + j];
        const vRe = real[i + j + len / 2] * wr - imag[i + j + len / 2] * wi;
        const vIm = real[i + j + len / 2] * wi + imag[i + j + len / 2] * wr;

        real[i + j] = uRe + vRe;
        imag[i + j] = uIm + vIm;
        real[i + j + len / 2] = uRe - vRe;
        imag[i + j + len / 2] = uIm - vIm;

        const nextWr = wr * wlenCos - wi * wlenSin;
        wi = wr * wlenSin + wi * wlenCos;
        wr = nextWr;
      }
    }
  }

  return { real, imag, size: n };
};

const sliceSegments = (channelData, fftSize) => {
  const segmentCount = Math.floor(channelData.length / fftSize);
  const segments = [];
  for (let index = 0; index < segmentCount; index++) {
    segments.push(channelData.subarray(index * fftSize, (index + 1) * fftSize));
  }
  return segments;
};

const createCrosspowerAccumulator = (freq, bandwidth) => ({
  freq,
  bw: bandwidth,
  avg: 0,
  matrix: Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => createComplex()))
});

const createIdentityCalibration = () => createComplex(1, 0);

const getCalibration = (channelCalibration, channelIndex, frequency, context) => {
  if (typeof channelCalibration !== 'function') return createIdentityCalibration();
  const value = channelCalibration(channelIndex, frequency, context);
  if (!value) return createIdentityCalibration();
  return createComplex(value.re || 0, value.im || 0);
};

const crosspowerMatrixToRow = (entry) => {
  const m = entry.matrix;
  return {
    freq: entry.freq,
    bw: entry.bw,
    avg: entry.avg,
    crosspowers: [
      m[0][0].re,
      m[1][0].re, m[2][0].re, m[3][0].re,
      m[0][1].im, m[1][1].re, m[2][1].re, m[3][1].re,
      m[0][2].im, m[1][2].im, m[2][2].re, m[3][2].re,
      m[0][3].im, m[1][3].im, m[2][3].im, m[3][3].re
    ],
    matrix: m
  };
};

const rowToCrosspowerMatrix = (row) => {
  if (row.matrix) return row.matrix;
  const c = row.crosspowers || [];
  const m = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => createComplex()));
  m[0][0] = createComplex(c[0] || 0, 0);
  m[1][0] = createComplex(c[1] || 0, -(c[4] || 0));
  m[0][1] = conjComplex(m[1][0]);
  m[2][0] = createComplex(c[2] || 0, -(c[8] || 0));
  m[0][2] = conjComplex(m[2][0]);
  m[3][0] = createComplex(c[3] || 0, -(c[12] || 0));
  m[0][3] = conjComplex(m[3][0]);
  m[1][1] = createComplex(c[5] || 0, 0);
  m[2][1] = createComplex(c[6] || 0, -(c[9] || 0));
  m[1][2] = conjComplex(m[2][1]);
  m[3][1] = createComplex(c[7] || 0, -(c[13] || 0));
  m[1][3] = conjComplex(m[3][1]);
  m[2][2] = createComplex(c[10] || 0, 0);
  m[3][2] = createComplex(c[11] || 0, -(c[14] || 0));
  m[2][3] = conjComplex(m[3][2]);
  m[3][3] = createComplex(c[15] || 0, 0);
  return m;
};

const scaleCrosspowerMatrixUnits = (matrix, options = {}) => {
  const electricFieldScale = Number.isFinite(options.electricFieldScale)
    ? options.electricFieldScale
    : 1;
  const magneticFieldScale = Number.isFinite(options.magneticFieldScale)
    ? options.magneticFieldScale
    : 1;
  const isAmplitudeSpectralDensity = options.spectralDensity === 'asd';
  if (electricFieldScale === 1 && magneticFieldScale === 1) {
    return matrix;
  }

  return matrix.map((row, rowIndex) => row.map((value, columnIndex) => {
    const rowScale = rowIndex === EX_CHANNEL || rowIndex === EY_CHANNEL
      ? electricFieldScale
      : magneticFieldScale;
    const columnScale = columnIndex === EX_CHANNEL || columnIndex === EY_CHANNEL
      ? electricFieldScale
      : magneticFieldScale;
    const pairScale = isAmplitudeSpectralDensity && rowIndex === columnIndex
      ? Math.max(rowScale, columnScale)
      : rowScale * columnScale;
    return scaleComplex(value, pairScale);
  }));
};

const averageLogFrequencies = (entries, perDecade = 10, coherencyLimit = 0, options = {}) => {
  if (!entries.length) return [];
  const sorted = [...entries].sort((a, b) => a.freq - b.freq);
  const buckets = new Map();
  sorted.forEach((entry) => {
    const scalar = computeScalarApparentResistivityEntry(entry);
    const keep = Math.max(scalar.exHyCoherency, scalar.eyHxCoherency) >= coherencyLimit;
    if (!keep) return;
    const bucketKey = Math.round(Math.log10(entry.freq) * perDecade);
    const bucket = buckets.get(bucketKey) || [];
    bucket.push(entry);
    buckets.set(bucketKey, bucket);
  });

  return Array.from(buckets.values()).map((bucket) => {
    let selectedRows = bucket;
    if (options.useCoherencyBins) {
      const coherencyBins = options.coherencyBins || DEFAULT_COHERENCY_BINS;
      const groupedRows = new Map();
      bucket.forEach((entry) => {
        const scalar = computeScalarApparentResistivityEntry(entry);
        const coherency = Math.max(scalar.exHyCoherency, scalar.eyHxCoherency);
        const binIndex = resolveCoherencyBinIndex(coherency, coherencyBins);
        const rows = groupedRows.get(binIndex) || [];
        rows.push(entry);
        groupedRows.set(binIndex, rows);
      });
      const selectedBinIndex = Array.from(groupedRows.keys()).sort((a, b) => a - b)[0];
      selectedRows = groupedRows.get(selectedBinIndex) || bucket;
    }

    const base = createCrosspowerAccumulator(0, 0);
    selectedRows.forEach((entry) => {
      base.freq += entry.freq;
      base.bw += entry.bw || 0;
      base.avg += entry.avg || 0;
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          base.matrix[i][j] = addComplex(base.matrix[i][j], rowToCrosspowerMatrix(entry)[i][j]);
        }
      }
    });
    const divisor = selectedRows.length;
    const bucketKey = Math.round(Math.log10(selectedRows[0].freq) * perDecade);
    base.freq = options.useLogBucketCenter ? 10 ** (bucketKey / perDecade) : base.freq / divisor;
    base.bw /= divisor;
    base.avg /= divisor;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        base.matrix[i][j] = {
          re: base.matrix[i][j].re / divisor,
          im: base.matrix[i][j].im / divisor
        };
      }
    }
    return crosspowerMatrixToRow(base);
  });
};

const normalizeLookupKey = (value = '') => String(value || '').trim().toLowerCase();

const findMatchingFileText = (fileTexts, fileName) => {
  if (!fileTexts) return null;
  if (fileTexts instanceof Map) {
    return fileTexts.get(fileName) ?? fileTexts.get(normalizeLookupKey(fileName)) ?? null;
  }
  const direct = fileTexts[fileName] ?? fileTexts[normalizeLookupKey(fileName)];
  if (direct) return direct;
  const normalizedFileName = normalizeLookupKey(fileName);
  const matchedKey = Object.keys(fileTexts).find((key) => normalizeLookupKey(key) === normalizedFileName);
  return matchedKey ? fileTexts[matchedKey] : null;
};

const buildCalibrationBoundaries = (frequencies) => {
  const boundaries = [-Infinity];
  for (let i = 0; i < frequencies.length - 1; i++) {
    boundaries.push((frequencies[i] + frequencies[i + 1]) / 2);
  }
  boundaries.push(Infinity);
  return boundaries;
};

const resolveCoherencyBinIndex = (value, bins = DEFAULT_COHERENCY_BINS) => {
  for (let index = 0; index < bins.length; index++) {
    if (value >= bins[index]) return index;
  }
  return bins.length;
};

const getCalibrationComplex = (table, rowIndex, fallback = createComplex(1, 0)) =>
  table?.[rowIndex]?.complex || fallback;

const reciprocalMagnitude = (value) => {
  const magnitude = absComplex(value);
  return magnitude > 0 ? 1 / magnitude : 1;
};

const inverseByConjugate = (value) => {
  const denom = Math.max(absSquared(value), Number.EPSILON);
  return scaleComplex(conjComplex(value), 1 / denom);
};

const applyRegisterBit = (register, bitNumber, value, apply) => {
  const mask = 1 << (bitNumber - 1);
  return (register & mask) ? apply(value) : value;
};

const pickGainIndex = (register, masks, { preferLastMatch = false } = {}) => {
  let matchedIndex = -1;
  const numericRegister = Number(register) || 0;
  for (let index = 0; index < masks.length; index++) {
    const mask = masks[index];
    if (mask === 0) {
      if (masks.every((candidate, candidateIndex) => candidateIndex === 0 || (numericRegister & candidate) === 0)) {
        matchedIndex = index;
        if (!preferLastMatch) return index;
      }
      continue;
    }
    if ((numericRegister & mask) === mask) {
      matchedIndex = index;
      if (!preferLastMatch) return index;
    }
  }
  return matchedIndex >= 0 ? matchedIndex : 0;
};

const firstFiniteRegister = (...values) => {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
};

export const computeEh4CrosspowerSpectra = (blocks, options = {}) => {
  const fftSize = options.fftSize || DEFAULT_FFT_SIZE;
  const baseSampleRate = options.baseSampleRate || DEFAULT_BASE_SAMPLE_RATE;
  const electricFieldScale = options.electricFieldScale || ((frequency) => (frequency > 0 ? 1 / (5 * frequency) : 0));
  const channelCalibration = options.channelCalibration || null;
  const window = options.window === 'hann' ? createHannWindow(fftSize) : new Float64Array(fftSize).fill(1);
  const windowPower = window.reduce((sum, value) => sum + value * value, 0);
  const normalizeSpectralDensity = Boolean(options.normalizeSpectralDensity);
  const fftAmplitudeScale = Number.isFinite(options.fftAmplitudeScale)
    ? options.fftAmplitudeScale
    : 1 / fftSize;
  const accumulators = new Map();

  blocks.forEach((block, blockIndex) => {
    const sampleRate = baseSampleRate / (2 ** (block.header?.decimation || 0));
    const bandwidth = sampleRate / fftSize;
    const channelSegments = (block.data || []).map((channelSeries) => sliceSegments(channelSeries, fftSize));
    const segmentCount = Math.min(...channelSegments.map((segments) => segments.length));

    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
      const spectra = [];
      for (let channelIndex = 0; channelIndex < 4; channelIndex++) {
        const source = channelSegments[channelIndex]?.[segmentIndex];
        if (!source) throw new Error(`EH4 时间序列缺少通道 ${channelIndex + 1} 数据`);
        const windowed = new Float64Array(fftSize);
        for (let i = 0; i < fftSize; i++) windowed[i] = source[i] * window[i];
        const transformed = fftRadix2(windowed);
        spectra.push(transformed);
      }

      for (let bin = 1; bin <= fftSize / 2; bin++) {
        const frequency = bin * bandwidth;
        const key = frequency.toFixed(12);
        const accumulator = accumulators.get(key) || createCrosspowerAccumulator(frequency, bandwidth);
        const binSpectra = [];

        for (let channelIndex = 0; channelIndex < 4; channelIndex++) {
          const baseSpectrum = createComplex(
            spectra[channelIndex].real[bin],
            spectra[channelIndex].imag[bin]
          );
          const densityScale = normalizeSpectralDensity
            ? 1 / Math.max(sampleRate * windowPower, Number.EPSILON)
            : 1;
          const spectrumScale = fftAmplitudeScale * Math.sqrt(densityScale);
          let scaledSpectrum = {
            re: baseSpectrum.re * spectrumScale,
            im: baseSpectrum.im * spectrumScale
          };
          if (channelIndex === EX_CHANNEL || channelIndex === EY_CHANNEL) {
            const scale = electricFieldScale(frequency, {
              block,
              blockIndex,
              segmentIndex,
              channelIndex
            });
            scaledSpectrum = {
              re: scaledSpectrum.re * scale,
              im: scaledSpectrum.im * scale
            };
          }
          scaledSpectrum = mulComplex(
            scaledSpectrum,
            getCalibration(channelCalibration, channelIndex, frequency, { block, blockIndex, segmentIndex })
          );
          binSpectra.push(scaledSpectrum);
        }

        for (let i = 0; i < 4; i++) {
          for (let j = i; j < 4; j++) {
            const crosspower = mulComplex(binSpectra[i], conjComplex(binSpectra[j]));
            accumulator.matrix[i][j] = addComplex(accumulator.matrix[i][j], crosspower);
            accumulator.matrix[j][i] = i === j ? accumulator.matrix[i][j] : conjComplex(accumulator.matrix[i][j]);
          }
        }
        accumulator.avg += 1;
        accumulators.set(key, accumulator);
      }
    }
  });

  return Array.from(accumulators.values())
    .sort((a, b) => a.freq - b.freq)
    .map(crosspowerMatrixToRow);
};

export const computeEh4CrosspowerSpectraFromYFile = (arrayBuffer, options = {}) => {
  return computeEh4CrosspowerSpectra(parseYFile(arrayBuffer), options);
};

const resolveEh4Blocks = (arrayBuffer, options = {}) => {
  if (Array.isArray(options.blocks) && options.blocks.length) return options.blocks;
  return parseYFile(arrayBuffer);
};

export const parseEh4SensorsTable = (text) => {
  const fileNames = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (fileNames.length < 14) {
    throw new Error('SENSORS.TBL 至少需要包含 14 行标定文件名');
  }
  return {
    highPass: fileNames.slice(0, 4),
    lowPass: fileNames.slice(4, 8),
    gain: fileNames.slice(8, 14),
    fileNames
  };
};

export const parseEh4CalibrationFile = (text) => {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [freqStr, imagStr, realStr] = line.split(/\s+/);
      const freq = Number(freqStr);
      const imag = Number(imagStr);
      const real = Number(realStr);
      return {
        freq,
        imag,
        real,
        complex: createComplex(real, imag)
      };
    })
    .filter((item) => Number.isFinite(item.freq) && Number.isFinite(item.real) && Number.isFinite(item.imag));
};

export const loadEh4CalibrationBundle = ({ sensorsText, calibrationFileTexts }) => {
  const sensors = parseEh4SensorsTable(sensorsText);
  const loadFile = (fileName) => {
    const text = findMatchingFileText(calibrationFileTexts, fileName);
    if (!text) {
      throw new Error(`未找到标定文件：${fileName}`);
    }
    return parseEh4CalibrationFile(text);
  };
  return {
    sensors,
    sensor: [...sensors.highPass, ...sensors.lowPass].map(loadFile),
    highPass: sensors.highPass.map(loadFile),
    lowPass: sensors.lowPass.map(loadFile),
    gain: sensors.gain.map(loadFile)
  };
};

export const buildEh4ChineseHighFrequencyCalibrationTables = ({ register = 0, xlength = 0, ylength = 0, calibrationBundle }) => {
  if (!calibrationBundle) {
    throw new Error('缺少 calibrationBundle');
  }
  const sensorTables = calibrationBundle.sensor || [
    ...(calibrationBundle.highPass || []),
    ...(calibrationBundle.lowPass || [])
  ];
  const gainTables = calibrationBundle.gain;
  const calibrationFrequencies = sensorTables[0]?.map((row) => row.freq) || [];
  const entries = calibrationFrequencies.map((freq, rowIndex) => {
    const gainFactors = gainTables.map((table) => getCalibrationComplex(table, rowIndex));
    const f2 = gainFactors[1] || createComplex(1, 0);
    const f5 = gainFactors[4] || createComplex(1, 0);
    const f6 = gainFactors[5] || createComplex(1, 0);
    const f10 = gainFactors[0] || createComplex(1, 0);
    const f11 = gainFactors[1] || createComplex(1, 0);
    const f12 = gainFactors[2] || createComplex(1, 0);
    const f13 = gainFactors[3] || createComplex(1, 0);
    const f14 = gainFactors[5] || createComplex(1, 0);
    const f14Inverse = inverseByConjugate(f14);

    const coefficients = [HY_CHANNEL, EX_CHANNEL, HX_CHANNEL, EY_CHANNEL].map((channelIndex) => {
      const isElectric = channelIndex === EX_CHANNEL || channelIndex === EY_CHANNEL;
      const dipoleLength = channelIndex === EX_CHANNEL ? xlength : ylength;
      let coefficient = scaleComplex(f14Inverse, isElectric ? 135 * 1e-8 * dipoleLength : 135);

      if (isElectric) {
        coefficient = applyRegisterBit(register, 1, coefficient, (value) => mulComplex(value, conjComplex(f10)));
        coefficient = applyRegisterBit(register, 2, coefficient, (value) => mulComplex(value, conjComplex(f11)));
        coefficient = applyRegisterBit(register, 3, coefficient, (value) => mulComplex(value, conjComplex(f12)));
        coefficient = applyRegisterBit(register, 4, coefficient, (value) => mulComplex(value, conjComplex(f13)));
        coefficient = applyRegisterBit(register, 5, coefficient, (value) => scaleComplex(value, 0.1));
      } else {
        coefficient = applyRegisterBit(register, 10, coefficient, (value) => scaleComplex(value, 0.1));
        coefficient = applyRegisterBit(register, 11, coefficient, (value) => mulComplex(value, conjComplex(f11)));
        coefficient = applyRegisterBit(register, 12, coefficient, (value) => mulComplex(value, conjComplex(f12)));
        coefficient = applyRegisterBit(register, 13, coefficient, (value) => mulComplex(value, conjComplex(f10)));
      }

      coefficient = applyRegisterBit(register, 7, coefficient, (value) => scaleComplex(value, reciprocalMagnitude(f6)));
      coefficient = applyRegisterBit(register, 8, coefficient, (value) => scaleComplex(value, reciprocalMagnitude(f2)));
      coefficient = applyRegisterBit(register, 9, coefficient, (value) => mulComplex(value, scaleComplex(f5, 10)));
      return coefficient;
    });

    return { freq, coefficients };
  });

  return {
    register,
    xlength,
    ylength,
    method: 'chinese-manual',
    calibrationFrequencies,
    entries
  };
};

export const buildEh4EnglishHighFrequencyCalibrationTables = ({
  register = 0,
  filterRegister,
  electricGainRegister,
  magneticGainRegister,
  xlength = 0,
  ylength = 0,
  calibrationBundle
}) => {
  if (!calibrationBundle) {
    throw new Error('缺少 calibrationBundle');
  }
  const resolvedFilterRegister = firstFiniteRegister(filterRegister, register);
  const resolvedElectricGainRegister = firstFiniteRegister(electricGainRegister, register);
  const resolvedMagneticGainRegister = firstFiniteRegister(magneticGainRegister, register);
  const useHighPass = (resolvedFilterRegister & HIGH_PASS_SENSOR_MASK) === HIGH_PASS_SENSOR_MASK;
  const sensorOffset = (resolvedFilterRegister & HIGH_PASS_OFFSET_MASK) !== 0 ? 4 : 0;
  const referenceIndex = useHighPass ? 1 : 5;
  const sensorTables = calibrationBundle.sensor || [
    ...(calibrationBundle.highPass || []),
    ...(calibrationBundle.lowPass || [])
  ];
  const gainTables = calibrationBundle.gain;
  const calibrationFrequencies = sensorTables[0]?.map((row) => row.freq) || [];
  const electricGainIndex = pickGainIndex(resolvedElectricGainRegister, ELECTRIC_GAIN_MASKS);
  const magneticGainIndex = pickGainIndex(resolvedMagneticGainRegister, MAGNETIC_GAIN_MASKS, { preferLastMatch: true });

  const entries = calibrationFrequencies.map((freq, rowIndex) => {
    const referenceRow = sensorTables[referenceIndex]?.[rowIndex];
    const referenceMagnitudeSquared = Math.max(absSquared(referenceRow?.complex || createComplex(1, 0)), Number.EPSILON);
    const baseScale = 5.0 * Math.sqrt(72900 / referenceMagnitudeSquared);
    const electricGain = gainTables[Math.min(electricGainIndex, gainTables.length - 1)]?.[rowIndex]?.complex || createComplex(1, 0);
    const magneticGain = gainTables[Math.min(magneticGainIndex, gainTables.length - 1)]?.[rowIndex]?.complex || createComplex(1, 0);
    const gainReference = gainTables[5]?.[rowIndex]?.complex || createComplex(1, 0);
    const gainReferenceNorm = Math.max(absSquared(gainReference), Number.EPSILON);
    const gainNormalizer = divComplex(conjComplex(gainReference), createComplex(gainReferenceNorm, 0));

    const coefficients = [HY_CHANNEL, EX_CHANNEL, HX_CHANNEL, EY_CHANNEL].map((channelIndex) => {
      const sensorRow = sensorTables[channelIndex + sensorOffset]?.[rowIndex];
      let coefficient = scaleComplex(sensorRow?.complex || createComplex(1, 0), baseScale);
      if (channelIndex === EX_CHANNEL || channelIndex === EY_CHANNEL) {
        coefficient = mulComplex(mulComplex(coefficient, electricGain), gainNormalizer);
        const dipoleLength = channelIndex === EX_CHANNEL ? xlength : ylength;
        coefficient = scaleComplex(coefficient, 1e-8 * dipoleLength);
      } else {
        coefficient = mulComplex(mulComplex(coefficient, magneticGain), gainNormalizer);
      }
      return coefficient;
    });

    const amp = Array.from({ length: 4 }, () => Array(4).fill(0));
    const rr = Array.from({ length: 4 }, () => Array(4).fill(0));
    const aa = Array.from({ length: 4 }, () => Array(4).fill(0));
    for (let k = 0; k < 4; k++) {
      for (let l = 0; l < 4; l++) {
        amp[k][l] = absSquared(coefficients[k]) * absSquared(coefficients[l]);
        rr[k][l] = coefficients[k].re * coefficients[l].re + coefficients[k].im * coefficients[l].im;
        aa[k][l] = coefficients[k].re * coefficients[l].im - coefficients[k].im * coefficients[l].re;
      }
    }

    return { freq, coefficients, amp, rr, aa };
  });

  return {
    register,
    filterRegister: resolvedFilterRegister,
    electricGainRegister: resolvedElectricGainRegister,
    magneticGainRegister: resolvedMagneticGainRegister,
    xlength,
    ylength,
    method: 'english-manual',
    useHighPass,
    sensorOffset,
    referenceIndex,
    electricGainIndex,
    magneticGainIndex,
    calibrationFrequencies,
    entries
  };
};

export const buildEh4HighFrequencyCalibrationTables = (options = {}) => {
  return options.method === 'english-manual'
    ? buildEh4EnglishHighFrequencyCalibrationTables(options)
    : buildEh4ChineseHighFrequencyCalibrationTables(options);
};

export const sumEh4CrosspowersToCalibrationFrequencies = (crosspowerRows, calibrationFrequencies, options = {}) => {
  if (!calibrationFrequencies?.length) return [];
  const boundaries = buildCalibrationBoundaries(calibrationFrequencies);
  const coherencyBins = options.coherencyBins || DEFAULT_COHERENCY_BINS;

  return calibrationFrequencies.map((centerFreq, index) => {
    const bucketRows = crosspowerRows.filter((row) => row.freq >= boundaries[index] && row.freq < boundaries[index + 1]);
    const groupedRows = new Map();
    bucketRows.forEach((row) => {
      const scalar = computeScalarApparentResistivityEntry(row);
      const coherency = Math.max(scalar.exHyCoherency, scalar.eyHxCoherency);
      const binIndex = resolveCoherencyBinIndex(coherency, coherencyBins);
      const rows = groupedRows.get(binIndex) || [];
      rows.push(row);
      groupedRows.set(binIndex, rows);
    });

    const selectedBinIndex = Array.from(groupedRows.keys()).sort((a, b) => a - b)[0];
    const selectedRows = groupedRows.get(selectedBinIndex) || [];
    const summed = createCrosspowerAccumulator(centerFreq, selectedRows[0]?.bw || 0);
    selectedRows.forEach((row) => {
      summed.avg += row.avg || 0;
      summed.bw = row.bw || summed.bw;
      const matrix = rowToCrosspowerMatrix(row);
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          summed.matrix[i][j] = addComplex(summed.matrix[i][j], matrix[i][j]);
        }
      }
    });
    return crosspowerMatrixToRow(summed);
  });
};

export const applyEh4CalibrationToCrosspowers = (stackedCrosspowers, calibrationTables) => {
  return stackedCrosspowers
    .map((row, index) => {
      const tableEntry = calibrationTables.entries[index];
      if (!tableEntry || !row.avg) return null;
      const rawMatrix = rowToCrosspowerMatrix(row);
      const calibratedMatrix = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => createComplex()));
      for (let k = 0; k < 4; k++) {
        for (let l = 0; l < 4; l++) {
          const raw = rawMatrix[k][l];
          const denom = Math.max(row.bw || 0, Number.EPSILON) * Math.max(row.avg || 0, 1);
          if (tableEntry.amp && tableEntry.rr && tableEntry.aa) {
            const amp = Math.max(tableEntry.amp[k][l], Number.EPSILON);
            calibratedMatrix[k][l] = createComplex(
              (tableEntry.rr[k][l] * raw.re + tableEntry.aa[k][l] * raw.im) / (amp * denom),
              (tableEntry.rr[k][l] * raw.im - tableEntry.aa[k][l] * raw.re) / (amp * denom)
            );
          } else {
            const correction = mulComplex(tableEntry.coefficients[k], conjComplex(tableEntry.coefficients[l]));
            calibratedMatrix[k][l] = scaleComplex(mulComplex(raw, correction), 1 / denom);
          }
          const outputUnitScale = (k === EX_CHANNEL || k === EY_CHANNEL ? ELECTRIC_MV_PER_M_TO_MV_PER_KM : 1)
            * (l === EX_CHANNEL || l === EY_CHANNEL ? ELECTRIC_MV_PER_M_TO_MV_PER_KM : 1);
          calibratedMatrix[k][l] = scaleComplex(calibratedMatrix[k][l], outputUnitScale);
        }
      }
      return crosspowerMatrixToRow({
        freq: tableEntry.freq,
        bw: row.bw,
        avg: row.avg,
        matrix: calibratedMatrix
      });
    })
    .filter(Boolean);
};

export const computeEh4CalibratedCrosspowersFromYFile = (arrayBuffer, options = {}) => {
  const blocks = resolveEh4Blocks(arrayBuffer, options);
  const minBlockLength = blocks.reduce((min, block) => Math.min(min, Number(block?.header?.length) || Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  const requestedFftSize = options.fftSize || DEFAULT_FFT_SIZE;
  const effectiveFftSize = Number.isFinite(minBlockLength) && minBlockLength > 0 && minBlockLength < requestedFftSize
    ? Math.max(2, 2 ** Math.floor(Math.log2(minBlockLength)))
    : requestedFftSize;
  const rawCrosspowers = computeEh4CrosspowerSpectra(blocks, { ...options, fftSize: effectiveFftSize });
  const sensorsText = options.sensorsText || findMatchingFileText(options.calibrationFileTexts, 'SENSORS.TBL');
  if (!sensorsText) {
    return {
      rawCrosspowers,
      stackedCrosspowers: rawCrosspowers,
      calibratedCrosspowers: rawCrosspowers,
    calibrationTables: null
  };
  }
  const primaryHeader = blocks[0]?.header || {};
  const calibrationBundle = loadEh4CalibrationBundle({
    sensorsText,
    calibrationFileTexts: options.calibrationFileTexts
  });
  const legacyRegister = firstFiniteRegister(primaryHeader.registor, primaryHeader.uEh4Band);
  const baseCalibrationOptions = {
    register: legacyRegister,
    filterRegister: firstFiniteRegister(primaryHeader.uEh4Band, legacyRegister),
    electricGainRegister: firstFiniteRegister(primaryHeader.uEh4EGain, legacyRegister),
    magneticGainRegister: firstFiniteRegister(primaryHeader.uEh4MGain, legacyRegister),
    xlength: primaryHeader.xlength ?? 0,
    ylength: primaryHeader.ylength ?? 0,
    calibrationBundle
  };
  const chineseCalibrationTables = buildEh4HighFrequencyCalibrationTables({
    ...baseCalibrationOptions,
    method: 'chinese-manual'
  });
  const englishCalibrationTables = buildEh4HighFrequencyCalibrationTables({
    ...baseCalibrationOptions,
    method: 'english-manual'
  });
  const stackedCrosspowers = sumEh4CrosspowersToCalibrationFrequencies(
    rawCrosspowers,
    chineseCalibrationTables.calibrationFrequencies,
    options
  );
  const chineseCrosspowers = applyEh4CalibrationToCrosspowers(stackedCrosspowers, chineseCalibrationTables);
  const englishCrosspowers = applyEh4CalibrationToCrosspowers(stackedCrosspowers, englishCalibrationTables);
  return {
    rawCrosspowers,
    stackedCrosspowers,
    calibratedCrosspowers: chineseCrosspowers,
    calibrationTables: chineseCalibrationTables,
    algorithmResults: {
      chinese: {
        label: '中文说明书算法',
        method: 'chinese-manual',
        calibrationTables: chineseCalibrationTables,
        crosspowers: chineseCrosspowers
      },
      english: {
        label: '英文说明书算法',
        method: 'english-manual',
        calibrationTables: englishCalibrationTables,
        crosspowers: englishCrosspowers
      }
    },
    effectiveFftSize
  };
};

export const computeScalarApparentResistivityEntry = (row, options = {}) => {
  const matrix = scaleCrosspowerMatrixUnits(rowToCrosspowerMatrix(row), options);
  const freq = row.freq;
  const isAmplitudeSpectralDensity = options.spectralDensity === 'asd';
  const hyValue = Math.max(matrix[HY_CHANNEL][HY_CHANNEL].re, Number.EPSILON);
  const exValue = Math.max(matrix[EX_CHANNEL][EX_CHANNEL].re, Number.EPSILON);
  const hxValue = Math.max(matrix[HX_CHANNEL][HX_CHANNEL].re, Number.EPSILON);
  const eyValue = Math.max(matrix[EY_CHANNEL][EY_CHANNEL].re, Number.EPSILON);
  const hyPower = isAmplitudeSpectralDensity ? hyValue * hyValue : hyValue;
  const exPower = isAmplitudeSpectralDensity ? exValue * exValue : exValue;
  const hxPower = isAmplitudeSpectralDensity ? hxValue * hxValue : hxValue;
  const eyPower = isAmplitudeSpectralDensity ? eyValue * eyValue : eyValue;
  const exHy = matrix[EX_CHANNEL][HY_CHANNEL];
  const eyHx = matrix[EY_CHANNEL][HX_CHANNEL];

  const exHyCoherency = clamp01(absSquared(exHy) / Math.max(exPower * hyPower, Number.EPSILON));
  const eyHxCoherency = clamp01(absSquared(eyHx) / Math.max(eyPower * hxPower, Number.EPSILON));

  return {
    freq,
    exHyCoherency,
    eyHxCoherency,
    rhoX: (0.2 / freq) * (exPower / hyPower),
    rhoY: (0.2 / freq) * (eyPower / hxPower),
    phaseX: phaseDegrees(exHy),
    phaseY: phaseDegrees(eyHx)
  };
};

export const computeTensorImpedanceEntry = (row) => {
  const matrix = rowToCrosspowerMatrix(row);
  const hxhx = matrix[HX_CHANNEL][HX_CHANNEL];
  const hyhy = matrix[HY_CHANNEL][HY_CHANNEL];
  const hxhy = matrix[HX_CHANNEL][HY_CHANNEL];
  const hyhx = matrix[HY_CHANNEL][HX_CHANNEL];
  const exhx = matrix[EX_CHANNEL][HX_CHANNEL];
  const exhy = matrix[EX_CHANNEL][HY_CHANNEL];
  const eyhx = matrix[EY_CHANNEL][HX_CHANNEL];
  const eyhy = matrix[EY_CHANNEL][HY_CHANNEL];

  const determinant = subComplex(
    mulComplex(hxhx, hyhy),
    mulComplex(hxhy, hyhx)
  );

  const zxx = divComplex(
    subComplex(mulComplex(exhx, hyhy), mulComplex(exhy, hyhx)),
    determinant
  );
  const zxy = divComplex(
    subComplex(mulComplex(exhy, hxhx), mulComplex(exhx, hxhy)),
    determinant
  );
  const zyx = divComplex(
    subComplex(mulComplex(eyhx, hyhy), mulComplex(eyhy, hyhx)),
    determinant
  );
  const zyy = divComplex(
    subComplex(mulComplex(eyhy, hxhx), mulComplex(eyhx, hxhy)),
    determinant
  );

  const omegaMu = 2 * Math.PI * row.freq * MU0;
  const safeOmegaMu = Math.max(omegaMu, Number.EPSILON);
  const impedanceToRho = (value) => absSquared(value) / safeOmegaMu;

  return {
    freq: row.freq,
    zxx,
    zxy,
    zyx,
    zyy,
    rhoXX: impedanceToRho(zxx),
    rhoXY: impedanceToRho(zxy),
    rhoYX: impedanceToRho(zyx),
    rhoYY: impedanceToRho(zyy),
    phaseXX: phaseDegrees(zxx),
    phaseXY: phaseDegrees(zxy),
    phaseYX: phaseDegrees(zyx),
    phaseYY: phaseDegrees(zyy)
  };
};

export const computeEh4ImpedanceFromCrosspowers = (crosspowerRows, options = {}) => {
  const averagedRows = options.averagePerDecade
    ? averageLogFrequencies(crosspowerRows, options.averagePerDecade, options.coherencyLimit || 0, options)
    : crosspowerRows;

  return averagedRows.map((row) => {
    const scalar = computeScalarApparentResistivityEntry(row, options);
    const tensor = options.spectralDensity === 'asd' ? null : computeTensorImpedanceEntry(row);
    return {
      freq: row.freq,
      bw: row.bw,
      avg: row.avg,
      exHyCoherency: scalar.exHyCoherency,
      eyHxCoherency: scalar.eyHxCoherency,
      scalarRhoX: scalar.rhoX,
      scalarRhoY: scalar.rhoY,
      scalarPhaseX: scalar.phaseX,
      scalarPhaseY: scalar.phaseY,
      tensorRhoXX: tensor?.rhoXX ?? null,
      tensorRhoXY: tensor?.rhoXY ?? null,
      tensorRhoYX: tensor?.rhoYX ?? null,
      tensorRhoYY: tensor?.rhoYY ?? null,
      tensorPhaseXX: tensor?.phaseXX ?? null,
      tensorPhaseXY: tensor?.phaseXY ?? null,
      tensorPhaseYX: tensor?.phaseYX ?? null,
      tensorPhaseYY: tensor?.phaseYY ?? null,
      zxx: tensor?.zxx ?? null,
      zxy: tensor?.zxy ?? null,
      zyx: tensor?.zyx ?? null,
      zyy: tensor?.zyy ?? null,
      rhoXY: scalar.rhoX,
      rhoYX: scalar.rhoY,
      phaseXY: scalar.phaseX,
      phaseYX: scalar.phaseY
    };
  });
};

export const buildEh4ComputationProducts = (arrayBuffer, options = {}) => {
  const calibrated = computeEh4CalibratedCrosspowersFromYFile(arrayBuffer, options);
  const impedance = computeEh4ImpedanceFromCrosspowers(calibrated.calibratedCrosspowers, options);
  return {
    crosspowers: calibrated.calibratedCrosspowers,
    rawCrosspowers: calibrated.rawCrosspowers,
    stackedCrosspowers: calibrated.stackedCrosspowers,
    calibrationTables: calibrated.calibrationTables,
    algorithmResults: calibrated.algorithmResults,
    impedance
  };
};

export const buildEh4CorrectedXFileFromYFile = (arrayBuffer, options = {}) => {
  const products = buildEh4ComputationProducts(arrayBuffer, options);
  return {
    ...products,
    xRows: products.crosspowers,
    xFileText: writeXFile(products.crosspowers)
  };
};
