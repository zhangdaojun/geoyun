import { describe, expect, it } from 'vitest';
import {
  computeEh4CrosspowerSpectra,
  computeEh4CalibratedCrosspowersFromYFile,
  buildEh4ComputationProducts,
  applyEh4CalibrationToCrosspowers,
  computeScalarApparentResistivityEntry,
  computeTensorImpedanceEntry,
  buildEh4HighFrequencyCalibrationTables,
  loadEh4CalibrationBundle,
  parseEh4SensorsTable,
  sumEh4CrosspowersToCalibrationFrequencies,
  computeEh4ImpedanceFromCrosspowers
} from './eh4Computation.js';
import { parseF3PsdFile, parseF3TimeSeriesFile, writeF3PsdFile, writeYFile } from './eh4io.js';

const buildRealSignalFromPhasor = (phasor, sampleRate, frequency, sampleCount) => {
  const data = new Int16Array(sampleCount);
  for (let n = 0; n < sampleCount; n++) {
    const angle = 2 * Math.PI * frequency * n / sampleRate;
    const value = phasor.re * Math.cos(angle) - phasor.im * Math.sin(angle);
    data[n] = Math.round(value * 1000);
  }
  return data;
};

const buildBlock = (channels, decimation = 0) => ({
  header: {
    decimation,
    counts: 0,
    registor: 0,
    xlength: 100,
    ylength: 100,
    length: channels[0].length,
    channel: channels.length
  },
  data: channels
});

const findFrequencyRow = (rows, target, tolerance = 1e-6) =>
  rows.find((row) => Math.abs(row.freq - target) < tolerance);

const buildCalibrationText = (frequencies, real = 1, imag = 0) =>
  frequencies.map((freq) => `${freq.toExponential(7)} ${imag.toExponential(7)} ${real.toExponential(7)}`).join('\n');

const buildF3TimeSeriesBuffer = () => {
  const buffer = new ArrayBuffer(512 + 4 * 4 * 2);
  const view = new DataView(buffer);
  const headerBase = 256;
  view.setUint8(headerBase + 32, 4);
  view.setUint8(headerBase + 33, 4);
  view.setUint8(headerBase + 34, 4);
  view.setUint8(headerBase + 35, 0);
  view.setUint8(headerBase + 36, 0);
  view.setUint8(headerBase + 37, 0);
  view.setUint8(headerBase + 38, 1);
  view.setUint8(headerBase + 39, 3);
  view.setUint8(headerBase + 41, 2);
  view.setUint8(headerBase + 42, 0);
  view.setUint32(headerBase + 52, 2, true);
  view.setFloat32(headerBase + 56, 64, true);
  view.setFloat32(headerBase + 60, 0.001, true);
  view.setFloat32(headerBase + 64, 2, true);
  view.setFloat32(headerBase + 76, 100, true);
  view.setFloat32(headerBase + 80, 200, true);
  view.setUint32(headerBase + 192, 0, true);
  const values = [10, 20, 30, 40, -11, -22, -33, -44];
  values.forEach((value, index) => view.setInt32(512 + index * 4, value, true));
  return buffer;
};

const buildF3TimeSeriesBufferOneBasedChannels = () => {
  const buffer = new ArrayBuffer(512 + 4 * 4 * 2);
  const view = new DataView(buffer);
  const headerBase = 256;
  view.setUint8(headerBase + 32, 4);
  view.setUint8(headerBase + 33, 4);
  view.setUint8(headerBase + 34, 4);
  view.setUint8(headerBase + 35, 0);
  view.setUint8(headerBase + 36, 0);
  view.setUint8(headerBase + 37, 0);
  view.setUint8(headerBase + 38, 2);
  view.setUint8(headerBase + 39, 4);
  view.setUint8(headerBase + 41, 3);
  view.setUint8(headerBase + 42, 1);
  view.setUint32(headerBase + 52, 2, true);
  view.setFloat32(headerBase + 56, 64, true);
  view.setFloat32(headerBase + 60, 0.001, true);
  view.setFloat32(headerBase + 64, 2, true);
  const values = [10, 20, 30, 40, -11, -22, -33, -44];
  values.forEach((value, index) => view.setInt32(512 + index * 4, value, true));
  return buffer;
};

describe('eh4Computation', () => {
  it('F3 ??????? EH4 ???? ADC ????', () => {
    const blocks = parseF3TimeSeriesFile(buildF3TimeSeriesBuffer());

    expect(blocks).toHaveLength(1);
    expect(blocks[0].header.sampleUnit).toBe('mV');
    expect(blocks[0].header.rawSampleUnit).toBe('adc-count');
    expect(blocks[0].header.sampleScaleMillivolts).toBeCloseTo(2, 6);
    expect(blocks[0].header.xlength).toBeCloseTo(10000, 6);
    expect(blocks[0].header.ylength).toBeCloseTo(20000, 6);
    expect(blocks[0].data[0][0]).toBeCloseTo(20, 5);
    expect(blocks[0].data[0][1]).toBeCloseTo(-22, 5);
    expect(blocks[0].data[1][0]).toBeCloseTo(40, 5);
    expect(blocks[0].data[1][1]).toBeCloseTo(-44, 5);
    expect(blocks[0].data[2][0]).toBeCloseTo(60, 5);
    expect(blocks[0].data[2][1]).toBeCloseTo(-66, 5);
    expect(blocks[0].data[3][0]).toBeCloseTo(80, 5);
    expect(blocks[0].data[3][1]).toBeCloseTo(-88, 5);
    expect(blocks[0].rawData[0]).toEqual([10, -11]);
    expect(blocks[0].rawData[1]).toEqual([20, -22]);
    expect(blocks[0].rawData[2]).toEqual([30, -33]);
    expect(blocks[0].rawData[3]).toEqual([40, -44]);
  });
  it('F3 time-series parser also supports one-based channel indexes', () => {
    const blocks = parseF3TimeSeriesFile(buildF3TimeSeriesBufferOneBasedChannels());

    expect(blocks).toHaveLength(1);
    expect(blocks[0].header.channelIndexBase).toBe(1);
    expect(blocks[0].header.resolvedHyIdx).toBe(0);
    expect(blocks[0].header.resolvedExIdx).toBe(1);
    expect(blocks[0].header.resolvedHxIdx).toBe(2);
    expect(blocks[0].header.resolvedEyIdx).toBe(3);
    expect(blocks[0].data[0][0]).toBeCloseTo(20, 5);
    expect(blocks[0].data[0][1]).toBeCloseTo(-22, 5);
    expect(blocks[0].data[1][0]).toBeCloseTo(40, 5);
    expect(blocks[0].data[1][1]).toBeCloseTo(-44, 5);
    expect(blocks[0].data[2][0]).toBeCloseTo(60, 5);
    expect(blocks[0].data[2][1]).toBeCloseTo(-66, 5);
    expect(blocks[0].data[3][0]).toBeCloseTo(80, 5);
    expect(blocks[0].data[3][1]).toBeCloseTo(-88, 5);
    expect(blocks[0].rawData[0]).toEqual([10, -11]);
    expect(blocks[0].rawData[1]).toEqual([20, -22]);
    expect(blocks[0].rawData[2]).toEqual([30, -33]);
    expect(blocks[0].rawData[3]).toEqual([40, -44]);
  });

  it('根据手册标量公式计算视电阻率和相干度', () => {
    const sampleRate = 64;
    const fftSize = 64;
    const frequency = 4;
    const hy = buildRealSignalFromPhasor({ re: 1, im: 0 }, sampleRate, frequency, fftSize);
    const ex = buildRealSignalFromPhasor({ re: 3 * Math.cos(Math.PI / 6), im: 3 * Math.sin(Math.PI / 6) }, sampleRate, frequency, fftSize);
    const zero = new Int16Array(fftSize);

    const rows = computeEh4CrosspowerSpectra([buildBlock([hy, ex, zero, zero])], {
      fftSize,
      baseSampleRate: sampleRate,
      electricFieldScale: () => 1,
      window: 'none'
    });
    const row = findFrequencyRow(rows, frequency);
    const scalar = computeScalarApparentResistivityEntry(row);

    expect(scalar.exHyCoherency).toBeCloseTo(1, 6);
    expect(scalar.rhoX).toBeCloseTo(0.45, 2);
    expect(scalar.phaseX).toBeCloseTo(30, 1);
  });

  it('??????????? EH4 Z ????????????', () => {
    const row = {
      freq: 4,
      bw: 1,
      avg: 1,
      crosspowers: [
        4,
        0, 0, 0,
        0, 36, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 16
      ]
    };

    const [result] = computeEh4ImpedanceFromCrosspowers([row]);

    expect(result.rhoXY).toBeCloseTo(0.45, 6);
    expect(result.rhoYX).toBeCloseTo(0.8, 6);
    expect(result.tensorRhoXY).toBeDefined();
  });

  it('EH4 X ASD rows use scalar apparent resistivity', () => {
    const row = {
      freq: 4,
      bw: 1,
      avg: 1,
      crosspowers: [
        2,
        12, 0, 0,
        -12, 6, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 4
      ]
    };

    const [result] = computeEh4ImpedanceFromCrosspowers([row], {
      spectralDensity: 'asd'
    });

    expect(result.rhoXY).toBeCloseTo(0.45, 6);
    expect(result.rhoYX).toBeCloseTo(0.8, 6);
    expect(result.exHyCoherency).toBeCloseTo(1, 6);
    expect(result.phaseXY).toBeCloseTo(45, 6);
    expect(result.tensorRhoXY).toBeNull();
  });

  it('F3 PSD rows use scalar apparent resistivity ratios', () => {
    const buffer = writeF3PsdFile([{
      frequency: 4,
      bandwidth: 2,
      numOfAvg: 10,
      ch1Ch1: 4,
      ch2Ch2: 36,
      ch3Ch3: 1,
      ch4Ch4: 16,
      ch1Ch2Imag: 0,
      ch2Ch1Real: 12,
      ch3Ch4Imag: 0,
      ch4Ch3Real: 4
    }]);

    const [row] = parseF3PsdFile(buffer);

    expect(row.rhoXY).toBeCloseTo(0.45, 6);
    expect(row.rhoYX).toBeCloseTo(0.8, 6);
  });

  it('EH4 ???????????????', () => {
    const highCoherencyRow = {
      freq: 10,
      bw: 1,
      avg: 1,
      crosspowers: [
        4,
        12, 0, 0,
        0, 36, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 16
      ]
    };
    const lowCoherencyRow = {
      freq: 10.1,
      bw: 1,
      avg: 1,
      crosspowers: [
        4,
        0, 0, 0,
        0, 400, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 16
      ]
    };

    const [result] = computeEh4ImpedanceFromCrosspowers([highCoherencyRow, lowCoherencyRow], {
      averagePerDecade: 10,
      coherencyLimit: 0,
      useCoherencyBins: true
    });

    expect(result.rhoXY).toBeCloseTo(0.18, 6);
    expect(result.exHyCoherency).toBeCloseTo(1, 6);
  });

  it('根据手册张量公式恢复阻抗分量', () => {
    const sampleRate = 64;
    const fftSize = 64;
    const frequency = 4;

    const zxx = { re: 1.0, im: 0.5 };
    const zxy = { re: 2.0, im: -0.25 };
    const zyx = { re: -0.5, im: 1.2 };
    const zyy = { re: 0.8, im: -0.4 };

    const mul = (a, b) => ({
      re: a.re * b.re - a.im * b.im,
      im: a.re * b.im + a.im * b.re
    });
    const add = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });

    const sourcePairs = [
      { hy: { re: 1.2, im: -0.3 }, hx: { re: -0.4, im: 0.9 } },
      { hy: { re: -0.2, im: 1.1 }, hx: { re: 0.7, im: 0.15 } }
    ];

    const blocks = sourcePairs.map(({ hy, hx }) => {
      const exPhasor = add(mul(zxx, hx), mul(zxy, hy));
      const eyPhasor = add(mul(zyx, hx), mul(zyy, hy));
      return buildBlock([
        buildRealSignalFromPhasor(hy, sampleRate, frequency, fftSize),
        buildRealSignalFromPhasor(exPhasor, sampleRate, frequency, fftSize),
        buildRealSignalFromPhasor(hx, sampleRate, frequency, fftSize),
        buildRealSignalFromPhasor(eyPhasor, sampleRate, frequency, fftSize)
      ]);
    });

    const rows = computeEh4CrosspowerSpectra(blocks, {
      fftSize,
      baseSampleRate: sampleRate,
      electricFieldScale: () => 1,
      window: 'none'
    });
    const row = findFrequencyRow(rows, frequency);
    const tensor = computeTensorImpedanceEntry(row);

    expect(tensor.zxx.re).toBeCloseTo(zxx.re, 2);
    expect(tensor.zxx.im).toBeCloseTo(zxx.im, 2);
    expect(tensor.zxy.re).toBeCloseTo(zxy.re, 2);
    expect(tensor.zxy.im).toBeCloseTo(zxy.im, 2);
    expect(tensor.zyx.re).toBeCloseTo(zyx.re, 2);
    expect(tensor.zyx.im).toBeCloseTo(zyx.im, 2);
    expect(tensor.zyy.re).toBeCloseTo(zyy.re, 2);
    expect(tensor.zyy.im).toBeCloseTo(zyy.im, 2);
  });

  it('loads calibration tables from SENSORS.TBL and referenced files', () => {
    const sensors = parseEh4SensorsTable([
      'hy.hf', 'ex.hf', 'hx.hf', 'ey.hf',
      'hy.60h', 'ex.60h', 'hx.60h', 'ey.60h',
      'gain.d', 'gain.c', 'gain.a', 'gain.b', 'gain.m', 'gain.n'
    ].join('\n'));
    const frequencies = [5, 10];
    const textMap = Object.fromEntries(
      sensors.fileNames.map((name) => [name, buildCalibrationText(frequencies)])
    );

    const bundle = loadEh4CalibrationBundle({
      sensorsText: sensors.fileNames.join('\n'),
      calibrationFileTexts: textMap
    });

    expect(bundle.highPass).toHaveLength(4);
    expect(bundle.lowPass).toHaveLength(4);
    expect(bundle.gain).toHaveLength(6);
    expect(bundle.highPass[0][0].freq).toBe(5);
    expect(bundle.highPass[0][0].real).toBe(1);
  });

  it('preserves calibration frequency bins through the calibration chain', () => {
    const sampleRate = 64;
    const fftSize = 64;
    const frequency = 4;
    const hy = buildRealSignalFromPhasor({ re: 1, im: 0 }, sampleRate, frequency, fftSize);
    const ex = buildRealSignalFromPhasor({ re: 2, im: 0 }, sampleRate, frequency, fftSize);
    const hx = buildRealSignalFromPhasor({ re: 0.5, im: 0.25 }, sampleRate, frequency, fftSize);
    const ey = buildRealSignalFromPhasor({ re: 1.5, im: -0.2 }, sampleRate, frequency, fftSize);
    const block = buildBlock([hy, ex, hx, ey]);
    const yBuffer = writeYFile([block]);
    const frequencies = [4];
    const sensorsText = [
      'hy.hf', 'ex.hf', 'hx.hf', 'ey.hf',
      'hy.60h', 'ex.60h', 'hx.60h', 'ey.60h',
      'gain.d', 'gain.c', 'gain.a', 'gain.b', 'gain.m', 'gain.n'
    ].join('\n');
    const calibrationFileTexts = Object.fromEntries(
      sensorsText.split('\n').map((name) => [name, buildCalibrationText(frequencies)])
    );

    const result = computeEh4CalibratedCrosspowersFromYFile(yBuffer, {
      fftSize,
      baseSampleRate: sampleRate,
      electricFieldScale: () => 1,
      window: 'none',
      sensorsText,
      calibrationFileTexts,
      coherencyBins: [0]
    });

    expect(result.calibrationTables).not.toBeNull();
    expect(result.stackedCrosspowers).toHaveLength(1);
    expect(result.calibratedCrosspowers).toHaveLength(1);
    expect(result.calibratedCrosspowers[0].freq).toBeCloseTo(4, 6);
  });

  it('????????? X ??????? mV/km', () => {
    const [row] = applyEh4CalibrationToCrosspowers([{
      freq: 1,
      bw: 1,
      avg: 1,
      crosspowers: [
        1,
        1, 0, 1,
        0, 1, 0, 1,
        0, 0, 1, 0,
        0, 0, 0, 1
      ]
    }], {
      entries: [{
        freq: 1,
        coefficients: [
          { re: 1, im: 0 },
          { re: 1, im: 0 },
          { re: 1, im: 0 },
          { re: 1, im: 0 }
        ]
      }]
    });

    expect(row.crosspowers[0]).toBeCloseTo(1, 12);
    expect(row.crosspowers[1]).toBeCloseTo(1000, 12);
    expect(row.crosspowers[5]).toBeCloseTo(1000000, 6);
    expect(row.crosspowers[15]).toBeCloseTo(1000000, 6);
  });

  it('assigns FFT frequencies to the nearest calibration boundary', () => {
    const makeRow = (freq, avg) => ({
      freq,
      bw: 1,
      avg,
      crosspowers: [
        1,
        0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
      ]
    });

    const [low, high] = sumEh4CrosspowersToCalibrationFrequencies(
      [makeRow(40, 1), makeRow(60, 10)],
      [10, 100]
    );

    expect(low.avg).toBe(1);
    expect(high.avg).toBe(10);
  });

  it('builds low-pass reference coefficients from the 14 calibration files', () => {
    const frequencies = [5];
    const sensorsText = [
      'hy.hf', 'ex.hf', 'hx.hf', 'ey.hf',
      'hy.60h', 'ex.60h', 'hx.60h', 'ey.60h',
      'gain.d', 'gain.c', 'gain.a', 'gain.b', 'gain.m', 'gain.n'
    ].join('\n');
    const calibrationFileTexts = Object.fromEntries(
      sensorsText.split('\n').map((name, index) => [
        name,
        buildCalibrationText(frequencies, index < 8 ? index + 1 : 1)
      ])
    );
    const bundle = loadEh4CalibrationBundle({ sensorsText, calibrationFileTexts });
    const tables = buildEh4HighFrequencyCalibrationTables({
      register: 0,
      xlength: 100,
      ylength: 100,
      calibrationBundle: bundle
    });

    expect(bundle.sensor).toHaveLength(8);
    expect(tables.method).toBe('chinese-manual');
    expect(tables.entries[0].coefficients[0].re).toBeCloseTo(135, 6);
    expect(tables.entries[0].coefficients[1].re).toBeCloseTo(0.000135, 9);
  });

  it('???? 0x140 ????? K + 4 ????????', () => {
    const frequencies = [5];
    const sensorsText = [
      'hy.hf', 'ex.hf', 'hx.hf', 'ey.hf',
      'hy.60h', 'ex.60h', 'hx.60h', 'ey.60h',
      'gain.d', 'gain.c', 'gain.a', 'gain.b', 'gain.m', 'gain.n'
    ].join('\n');
    const calibrationFileTexts = Object.fromEntries(
      sensorsText.split('\n').map((name, index) => [
        name,
        buildCalibrationText(frequencies, index < 8 ? index + 1 : 1)
      ])
    );
    const bundle = loadEh4CalibrationBundle({ sensorsText, calibrationFileTexts });
    const tables = buildEh4HighFrequencyCalibrationTables({
      register: 0x140,
      xlength: 100,
      ylength: 100,
      calibrationBundle: bundle
    });

    expect(tables.entries[0].coefficients[0].re).toBeCloseTo(1350, 6);
  });

  it('????? 0x682 ??????????', () => {
    const frequencies = [5];
    const sensorsText = [
      'hy.hf', 'ex.hf', 'hx.hf', 'ey.hf',
      'hy.60h', 'ex.60h', 'hx.60h', 'ey.60h',
      'gain.d', 'gain.c', 'gain.a', 'gain.b', 'gain.m', 'gain.n'
    ].join('\n');
    const calibrationFileTexts = Object.fromEntries(
      sensorsText.split('\n').map((name) => [name, buildCalibrationText(frequencies)])
    );
    const bundle = loadEh4CalibrationBundle({ sensorsText, calibrationFileTexts });
    const tables = buildEh4HighFrequencyCalibrationTables({
      register: 0x682,
      xlength: 100,
      ylength: 100,
      calibrationBundle: bundle
    });

    expect(tables.method).toBe('chinese-manual');
    expect(tables.entries[0].coefficients[1].re).toBeCloseTo(0.000135, 9);
    expect(tables.entries[0].coefficients[0].re).toBeCloseTo(13.5, 6);
  });

  it('同时生成中文和英文两种算法的标定后功率谱', () => {
    const sampleRate = 64;
    const fftSize = 64;
    const frequency = 4;
    const hy = buildRealSignalFromPhasor({ re: 1, im: 0 }, sampleRate, frequency, fftSize);
    const ex = buildRealSignalFromPhasor({ re: 2, im: 0 }, sampleRate, frequency, fftSize);
    const hx = buildRealSignalFromPhasor({ re: 0.5, im: 0.25 }, sampleRate, frequency, fftSize);
    const ey = buildRealSignalFromPhasor({ re: 1.5, im: -0.2 }, sampleRate, frequency, fftSize);
    const yBuffer = writeYFile([buildBlock([hy, ex, hx, ey])]);
    const frequencies = [4];
    const sensorsText = [
      'hy.hf', 'ex.hf', 'hx.hf', 'ey.hf',
      'hy.60h', 'ex.60h', 'hx.60h', 'ey.60h',
      'gain.d', 'gain.c', 'gain.a', 'gain.b', 'gain.m', 'gain.n'
    ].join('\n');
    const calibrationFileTexts = Object.fromEntries(
      sensorsText.split('\n').map((name) => [name, buildCalibrationText(frequencies)])
    );

    const result = computeEh4CalibratedCrosspowersFromYFile(yBuffer, {
      fftSize,
      baseSampleRate: sampleRate,
      electricFieldScale: () => 1,
      window: 'none',
      sensorsText,
      calibrationFileTexts,
      coherencyBins: [0]
    });

    expect(result.algorithmResults.chinese.crosspowers).toHaveLength(1);
    expect(result.algorithmResults.english.crosspowers).toHaveLength(1);
    expect(result.algorithmResults.chinese.calibrationTables.method).toBe('chinese-manual');
    expect(result.algorithmResults.english.calibrationTables.method).toBe('english-manual');
  });

  it('????????????? F3/Y blocks???? F3 ?????? Y ????', () => {
    const sampleRate = 64;
    const fftSize = 64;
    const frequency = 4;
    const hy = buildRealSignalFromPhasor({ re: 1, im: 0 }, sampleRate, frequency, fftSize);
    const ex = buildRealSignalFromPhasor({ re: 2, im: 0 }, sampleRate, frequency, fftSize);
    const hx = buildRealSignalFromPhasor({ re: 0.5, im: 0.25 }, sampleRate, frequency, fftSize);
    const ey = buildRealSignalFromPhasor({ re: 1.5, im: -0.2 }, sampleRate, frequency, fftSize);
    const blocks = [buildBlock([hy, ex, hx, ey])];
    const bogusBuffer = new ArrayBuffer(0);
    const frequencies = [4];
    const sensorsText = [
      'hy.hf', 'ex.hf', 'hx.hf', 'ey.hf',
      'hy.60h', 'ex.60h', 'hx.60h', 'ey.60h',
      'gain.d', 'gain.c', 'gain.a', 'gain.b', 'gain.m', 'gain.n'
    ].join('\n');
    const calibrationFileTexts = Object.fromEntries(
      sensorsText.split('\n').map((name) => [name, buildCalibrationText(frequencies)])
    );

    const result = buildEh4ComputationProducts(bogusBuffer, {
      blocks,
      fftSize,
      baseSampleRate: sampleRate,
      electricFieldScale: () => 1,
      window: 'none',
      sensorsText,
      calibrationFileTexts,
      coherencyBins: [0]
    });

    expect(result.rawCrosspowers).toHaveLength(32);
    expect(result.crosspowers).toHaveLength(1);
    expect(result.algorithmResults.english.crosspowers).toHaveLength(1);
  });

  it('english-manual calibration applies dipole lengths to CH2 and CH4', () => {
    const frequencies = [5];
    const sensorsText = [
      'hy.hf', 'ex.hf', 'hx.hf', 'ey.hf',
      'hy.60h', 'ex.60h', 'hx.60h', 'ey.60h',
      'gain.d', 'gain.c', 'gain.a', 'gain.b', 'gain.m', 'gain.n'
    ].join('\n');
    const calibrationFileTexts = Object.fromEntries(
      sensorsText.split('\n').map((name) => [name, buildCalibrationText(frequencies)])
    );
    const bundle = loadEh4CalibrationBundle({ sensorsText, calibrationFileTexts });
    const tables = buildEh4HighFrequencyCalibrationTables({
      register: 0,
      xlength: 100,
      ylength: 200,
      calibrationBundle: bundle,
      method: 'english-manual'
    });

    expect(tables.entries[0].coefficients[1].re).toBeCloseTo(0.00135, 12);
    expect(tables.entries[0].coefficients[3].re).toBeCloseTo(0.0027, 12);
  });

  it('english-manual calibration prefers F3 header gain fields', () => {
    const frequencies = [5];
    const sensorsText = [
      'hy.hf', 'ex.hf', 'hx.hf', 'ey.hf',
      'hy.60h', 'ex.60h', 'hx.60h', 'ey.60h',
      'gain.d', 'gain.c', 'gain.a', 'gain.b', 'gain.m', 'gain.n'
    ].join('\n');
    const calibrationFileTexts = Object.fromEntries(
      sensorsText.split('\n').map((name, index) => [
        name,
        buildCalibrationText(frequencies, index < 8 ? 1 : (index - 7) * 10)
      ])
    );
    const bundle = loadEh4CalibrationBundle({ sensorsText, calibrationFileTexts });
    const tables = buildEh4HighFrequencyCalibrationTables({
      register: 0,
      filterRegister: 0,
      electricGainRegister: 0x2,
      magneticGainRegister: 0x400,
      xlength: 100,
      ylength: 200,
      calibrationBundle: bundle,
      method: 'english-manual'
    });

    expect(tables.electricGainIndex).toBe(3);
    expect(tables.magneticGainIndex).toBe(3);
    expect(tables.entries[0].coefficients[1].re).toBeCloseTo(0.0009, 12);
    expect(tables.entries[0].coefficients[3].re).toBeCloseTo(0.0018, 12);
    expect(tables.entries[0].coefficients[0].re).toBeCloseTo(900, 9);
  });

  it('applies EH4 X electric-field unit scaling before scalar ASD resistivity', () => {
    const row = {
      freq: 4,
      bw: 1,
      avg: 1,
      crosspowers: [
        2,
        12, 0, 0,
        -12, 6, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 4
      ]
    };

    const [result] = computeEh4ImpedanceFromCrosspowers([row], {
      spectralDensity: 'asd',
      electricFieldScale: 1000
    });

    expect(result.rhoXY).toBeCloseTo(4.5e5, 3);
    expect(result.rhoYX).toBeCloseTo(8e5, 3);
    expect(result.exHyCoherency).toBeCloseTo(1, 6);
    expect(result.phaseXY).toBeCloseTo(45, 6);
  });
});

