/**
 * EH4 (Stratagem) 大地电磁仪器数据读写模块
 * 包含 Z_file (阻抗), X_file (交叉功率谱), Y_file (时间序列) 的解析与生成方法
 */

// 辅助函数：解析固定宽度的文本列 (每列通常为 11 个字符)
const parseFixedWidthLines = (line, colWidth = 11) => {
  const numCols = Math.floor(line.length / colWidth);
  const cols = [];
  for (let i = 0; i < numCols; i++) {
    const valStr = line.substring(i * colWidth, (i + 1) * colWidth).trim();
    cols.push(valStr ? Number(valStr) : 0);
  }
  const splitCols = line.trim().split(/\s+/).map(Number).filter(Number.isFinite);
  const fixedHasInvalid = cols.some((value) => !Number.isFinite(value));
  if (splitCols.length > cols.length || fixedHasInvalid) return splitCols;
  return cols;
};

// 辅助函数：将数值格式化为固定宽度的科学计数法或浮点数字符串
const formatFixedWidth = (values, colWidth = 11) => {
  return values.map(v => {
    let str;
    if (v === 0) {
      str = '0.000e+000';
    } else if (Math.abs(v) >= 1000 || Math.abs(v) < 0.1) {
      // 类似 5.204e+007
      str = v.toExponential(3);
      // 补齐指数部分的 0，如 e+7 -> e+007
      str = str.replace(/e([+-])(\d)$/, 'e$100$2').replace(/e([+-])(\d{2})$/, 'e$10$2');
    } else {
      // 类似 153.379 或 34.161
      str = Number.isInteger(v) ? v.toFixed(1) : v.toPrecision(6);
    }
    
    // 如果长度超出，进行截断保护
    if (str.length > colWidth) {
      str = str.substring(0, colWidth);
    }
    
    return str.padStart(colWidth, ' ');
  }).join('');
};

/**
 * 解析 @ 文件 (工程索引文件)
 * @param {string} text @ 文件的完整文本内容
 * @returns {Array} 解析后的测点位置信息数组
 */
export const parseAtFile = (text) => {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const stations = [];
  
  lines.forEach(line => {
    // 忽略头部只有数字的行，例如 " 50   0"
    if (/^\s*\d+\s+\d+\s*$/.test(line)) return;

    const parts = line.trim().split(/\s+/);
    if (parts.length === 0) return;

    const id = parts[0];
    
    // 忽略以 .000 结尾的测点 (通常为基站或占位数据)
    if (id.endsWith('.000')) return;
    
    // 检查是否包含 EH4 专用的 RX=, RY=, Rz= 格式
    const matchRx = line.match(/RX=\s*([-\d.]+)/i);
    const matchRy = line.match(/RY=\s*([-\d.]+)/i);
    const matchRz = line.match(/Rz=\s*([-\d.]+)/i);
    const matchXl = line.match(/XL=\s*([-\d.]+)/i);
    const matchYl = line.match(/YL=\s*([-\d.]+)/i);

    if (matchRx && matchRy) {
      stations.push({
        id: id,
        x: parseFloat(matchRx[1]),
        y: parseFloat(matchRy[1]),
        z: matchRz ? parseFloat(matchRz[1]) : 0,
        rxValue: matchRx[1],
        ryValue: matchRy[1],
        rx: parseFloat(matchRx[1]),
        ry: parseFloat(matchRy[1]),
        // @文件中 XL, YL 的单位是 cm，在此统一转换为 m
        xl: matchXl ? parseFloat(matchXl[1]) / 100 : null,
        yl: matchYl ? parseFloat(matchYl[1]) / 100 : null,
      });
    } else if (parts.length >= 4 && !line.includes('=')) {
      // 回退到简单列格式
      stations.push({
        id: id,
        x: parseFloat(parts[1]),
        y: parseFloat(parts[2]),
        z: parseFloat(parts[3])
      });
    } else if (parts.length === 3 && !line.includes('=')) {
      stations.push({
        id: id,
        x: parseFloat(parts[1]),
        y: parseFloat(parts[2]),
        z: 0
      });
    }
  });
  
  return stations;
};

/**
 * 生成 @ 文件 (工程索引文件)
 * @param {Array} stations 测点位置数组
 * @returns {string} 格式化后的 @ 文件文本
 */
export const writeAtFile = (stations) => {
  return stations.map(s => {
    return `${s.id.padEnd(10, ' ')} ${s.x.toFixed(3).padStart(12, ' ')} ${s.y.toFixed(3).padStart(12, ' ')} ${s.z.toFixed(3).padStart(12, ' ')}`;
  }).join('\n');
};

// ==========================================
// XYZ 文件 (三维/二维点云数据) 读写
// ==========================================

/**
 * 解析常规 XYZ 文本数据
 * 格式通常为: X Y Z (空格或逗号分隔)，可带可选列
 * @param {string} text XYZ 的完整文本内容
 * @returns {Array} 解析后的数据对象数组
 */
export const parseXYZFile = (text) => {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const data = [];

  lines.forEach(line => {
    // 支持由空格、制表符或逗号分隔的格式
    const parts = line.trim().split(/[\s,]+/);
    if (parts.length >= 3) {
      data.push({
        x: parseFloat(parts[0]),
        y: parseFloat(parts[1]),
        z: parseFloat(parts[2]),
        // 如果有额外的列(如视电阻率等)，存储在 extras 中
        extras: parts.slice(3).map(p => parseFloat(p))
      });
    }
  });

  return data;
};

/**
 * 生成 XYZ 文本数据
 * @param {Array} data 数据对象数组 [{x, y, z, extras: [...]}]
 * @returns {string} 格式化后的 XYZ 文本
 */
export const writeXYZFile = (data) => {
  return data.map(d => {
    let line = `${d.x.toFixed(4).padStart(12, ' ')} ${d.y.toFixed(4).padStart(12, ' ')} ${d.z.toFixed(4).padStart(12, ' ')}`;
    if (d.extras && d.extras.length > 0) {
      line += ' ' + d.extras.map(val => val.toFixed(4).padStart(12, ' ')).join(' ');
    }
    return line;
  }).join('\n');
};


/**
 * 解析 Z_file 文本
 * @param {string} text Z_file 的完整文本内容
 * @returns {Array} 解析后的数据对象数组
 */
export const parseZFile = (text) => {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const data = [];
  
  for (let i = 0; i < lines.length; i++) {
    // Z_file 的数据行通常以空格或数字开头，跳过包含字母(如 Station name 等头部信息)的行
    if (!/^[ \t]*[-+]?\d/.test(lines[i])) continue;

    if (i + 1 >= lines.length) break;
    
    // 如果下一行不是数字开头，说明这可能不是成对的数据行
    if (!/^[ \t]*[-+]?\d/.test(lines[i+1])) continue;

    const line1 = parseFixedWidthLines(lines[i], 11);
    const line2 = parseFixedWidthLines(lines[i+1], 11);
    
    data.push({
      freq: line1[0],
      exhy_coh: line1[1],
      exhy_rho: line1[2],
      exhy_phs: line1[3],
      eyhz_coh: line1[4], // [5]: EyHz coherency
      eyhx_rho: line1[5], // [6]: EyHx apparent resistivity
      eyhx_phs: line1[6], // [7]: EyHx phase
      zxx_r: line2[0], zxx_i: line2[1],
      zxy_r: line2[2], zxy_i: line2[3],
      zyx_r: line2[4], zyx_i: line2[5],
      zyy_r: line2[6], zyy_i: line2[7],
    });
    
    i++; // 跳过已经读取的第二行
  }
  
  return data;
};

export const parseF3ResistivityFile = (arrayBuffer) => {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 4) {
    throw new Error('F3 R 文件过小');
  }

  const count = view.getUint32(0, true);
  const expectedBytes = 4 + count * 60;
  if (view.byteLength < expectedBytes) {
    throw new Error(`F3 R 文件长度不匹配：期望至少 ${expectedBytes} 字节，实际 ${view.byteLength} 字节`);
  }

  let offset = 4;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const frequency = view.getFloat32(offset, true); offset += 4;
    const cohXY = view.getFloat32(offset, true); offset += 4;
    const rhoXY = view.getFloat32(offset, true); offset += 4;
    const phaseXY = view.getFloat32(offset, true); offset += 4;
    const cohYX = view.getFloat32(offset, true); offset += 4;
    const rhoYX = view.getFloat32(offset, true); offset += 4;
    const phaseYX = view.getFloat32(offset, true); offset += 4;
    const zxxR = view.getFloat32(offset, true); offset += 4;
    const zxxI = view.getFloat32(offset, true); offset += 4;
    const zxyR = view.getFloat32(offset, true); offset += 4;
    const zxyI = view.getFloat32(offset, true); offset += 4;
    const zyxR = view.getFloat32(offset, true); offset += 4;
    const zyxI = view.getFloat32(offset, true); offset += 4;
    const zyyR = view.getFloat32(offset, true); offset += 4;
    const zyyI = view.getFloat32(offset, true); offset += 4;

    rows.push({
      frequency,
      period: frequency > 0 ? 1 / frequency : 0,
      rhoXY,
      phaseXY,
      rhoYX,
      phaseYX,
      cohXY,
      cohYX,
      zxxR,
      zxxI,
      zxyR,
      zxyI,
      zyxR,
      zyxI,
      zyyR,
      zyyI,
      rhoError: 0,
      phaseError: 0
    });
  }

  return rows.filter(d =>
    Number.isFinite(d.frequency) &&
    d.frequency > 0 &&
    Number.isFinite(d.rhoXY) &&
    d.rhoXY > 0 &&
    Number.isFinite(d.rhoYX) &&
    d.rhoYX > 0 &&
    Number.isFinite(d.phaseXY) &&
    Number.isFinite(d.phaseYX)
  );
};

export const parseF3PsdFile = (arrayBuffer) => {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 4) {
    throw new Error('F3 PSD 文件过小');
  }

  const count = view.getUint32(0, true);
  const expectedBytes = 4 + count * 76;
  if (view.byteLength < expectedBytes) {
    throw new Error(`F3 PSD 文件长度不匹配：期望至少 ${expectedBytes} 字节，实际 ${view.byteLength} 字节`);
  }

  let offset = 4;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const frequency = view.getFloat32(offset, true); offset += 4;
    const bandwidth = view.getFloat32(offset, true); offset += 4;
    const numOfAvg = view.getFloat32(offset, true); offset += 4;
    const ch1Ch1 = view.getFloat32(offset, true); offset += 4;
    const ch1Ch2Imag = view.getFloat32(offset, true); offset += 4;
    const _ch1Ch3Imag = view.getFloat32(offset, true); offset += 4;
    const _ch1Ch4Imag = view.getFloat32(offset, true); offset += 4;
    const ch2Ch1Real = view.getFloat32(offset, true); offset += 4;
    const ch2Ch2 = view.getFloat32(offset, true); offset += 4;
    const _ch2Ch3Imag = view.getFloat32(offset, true); offset += 4;
    const _ch2Ch4Imag = view.getFloat32(offset, true); offset += 4;
    const _ch3Ch1Real = view.getFloat32(offset, true); offset += 4;
    const _ch3Ch2Real = view.getFloat32(offset, true); offset += 4;
    const ch3Ch3 = view.getFloat32(offset, true); offset += 4;
    const ch3Ch4Imag = view.getFloat32(offset, true); offset += 4;
    const _ch4Ch1Real = view.getFloat32(offset, true); offset += 4;
    const _ch4Ch2Real = view.getFloat32(offset, true); offset += 4;
    const ch4Ch3Real = view.getFloat32(offset, true); offset += 4;
    const ch4Ch4 = view.getFloat32(offset, true); offset += 4;

    const cohXYDen = ch1Ch1 * ch2Ch2;
    const cohYXDen = ch3Ch3 * ch4Ch4;
    const cohXY = cohXYDen > 0 ? Math.max(0, (ch1Ch2Imag * ch1Ch2Imag + ch2Ch1Real * ch2Ch1Real) / cohXYDen) : 0;
    const cohYX = cohYXDen > 0 ? Math.max(0, (ch3Ch4Imag * ch3Ch4Imag + ch4Ch3Real * ch4Ch3Real) / cohYXDen) : 0;

    const phaseXY = Math.atan2(ch1Ch2Imag, ch2Ch1Real) * 180 / Math.PI;
    const phaseYX = Math.atan2(ch3Ch4Imag, ch4Ch3Real) * 180 / Math.PI;

    const rhoFactor = frequency > 0 ? 0.2 / frequency : 0;
    const rhoXY = ch1Ch1 > 0 ? Math.max(0, rhoFactor * (ch2Ch2 / ch1Ch1)) : 0;
    const rhoYX = ch3Ch3 > 0 ? Math.max(0, rhoFactor * (ch4Ch4 / ch3Ch3)) : 0;

    rows.push({
      frequency,
      period: frequency > 0 ? 1 / frequency : 0,
      rhoXY,
      phaseXY,
      rhoYX,
      phaseYX,
      cohXY,
      cohYX,
      bandwidth,
      numOfAvg,
      ch1Ch1,
      ch1Ch2Imag,
      ch2Ch1Real,
      ch2Ch2,
      ch3Ch3,
      ch3Ch4Imag,
      ch4Ch3Real,
      ch4Ch4,
      rhoError: 0,
      phaseError: 0
    });
  }

  return rows.filter(d =>
    Number.isFinite(d.frequency) &&
    d.frequency > 0 &&
    Number.isFinite(d.rhoXY) &&
    Number.isFinite(d.rhoYX) &&
    Number.isFinite(d.phaseXY) &&
    Number.isFinite(d.phaseYX)
  );
};

export const writeF3PsdFile = (rows) => {
  const count = Array.isArray(rows) ? rows.length : 0;
  const buffer = new ArrayBuffer(4 + count * 76);
  const view = new DataView(buffer);
  view.setUint32(0, count, true);
  let offset = 4;
  rows.forEach((row) => {
    const vals = [
      row.frequency || 0,
      row.bandwidth || 0,
      row.numOfAvg || 0,
      row.ch1Ch1 || 0,
      row.ch1Ch2Imag || 0,
      row.ch1Ch3Imag || 0,
      row.ch1Ch4Imag || 0,
      row.ch2Ch1Real || 0,
      row.ch2Ch2 || 0,
      row.ch2Ch3Imag || 0,
      row.ch2Ch4Imag || 0,
      row.ch3Ch1Real || 0,
      row.ch3Ch2Real || 0,
      row.ch3Ch3 || 0,
      row.ch3Ch4Imag || 0,
      row.ch4Ch1Real || 0,
      row.ch4Ch2Real || 0,
      row.ch4Ch3Real || 0,
      row.ch4Ch4 || 0
    ];
    vals.forEach((v) => {
      view.setFloat32(offset, Number(v) || 0, true);
      offset += 4;
    });
  });
  return buffer;
};

export const parseF3TimeSeriesFile = (arrayBuffer) => {
  const view = new DataView(arrayBuffer);
  const fileLen = view.byteLength;
  let pos = 0;
  let chunkIndex = 0;
  const blocks = [];

  const resolveF3ChannelIndexBase = (primaryIndices, fallbackIndices, channelCount) => {
    const pickOneBased = (indices) => {
      const numericIndices = indices
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0);
      if (!numericIndices.length || !Number.isFinite(channelCount) || channelCount <= 0) {
        return 0;
      }
      const hasZero = numericIndices.includes(0);
      const allOneBased = numericIndices.every((value) => value >= 1 && value <= channelCount);
      return !hasZero && allOneBased ? 1 : 0;
    };

    const primaryNumericIndices = primaryIndices
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0);
    if (primaryNumericIndices.length >= 2) {
      if (primaryNumericIndices.includes(0)) return 0;
      const primaryBase = pickOneBased(primaryNumericIndices);
      if (primaryBase === 1) return 1;
    }
    return pickOneBased(fallbackIndices);
  };

  const readSample = (offset, dataType, dataBigEndian, startByte, validBytes, sampleBytes, fVRef, fLsbVal) => {
    if (dataType === 1) {
      if (offset + 4 > fileLen) return { value: 0, nextOffset: fileLen };
      const value = view.getFloat32(offset, true);
      return { value, physicalValue: value, nextOffset: offset + 4 };
    }
    const sb = sampleBytes;
    if (sb <= 0 || sb > 4 || offset + sb > fileLen) return { value: 0, nextOffset: fileLen };
    const bytes = [];
    for (let i = 0; i < sb; i++) bytes.push(view.getUint8(offset + i));
    let dataRaw = 0;
    if (dataBigEndian > 0) {
      const start = startByte;
      const end = start + validBytes;
      if (start < 0 || end > sb) return { value: 0, nextOffset: fileLen };
      const be = [0, 0, 0, 0];
      const dstStart = 4 - (end - start);
      for (let i = 0; i < end - start; i++) {
        be[dstStart + i] = bytes[start + i];
      }
      dataRaw = new DataView(Uint8Array.from(be).buffer).getInt32(0, false);
      dataRaw >>= (4 - validBytes) * 8;
    } else {
      const le = [0, 0, 0, 0];
      for (let i = 0; i < sb; i++) {
        le[i] = bytes[i];
      }
      dataRaw = new DataView(Uint8Array.from(le).buffer).getInt32(0, true);
      dataRaw <<= startByte * 8;
      dataRaw >>= (4 - validBytes) * 8;
    }
    const physicalValue = (fVRef * fLsbVal) * dataRaw * 1000;
    return { value: dataRaw, physicalValue, nextOffset: offset + sb };
  };

  while (pos + 512 <= fileLen) {
    const headerBase = pos + 256;
    const cpuId1 = view.getUint32(headerBase + 0, true);
    const cpuId2 = view.getUint32(headerBase + 4, true);
    const cpuId3 = view.getUint32(headerBase + 8, true);
    const deviceId = view.getUint32(headerBase + 12, true);
    const subSecond = view.getUint16(headerBase + 16, true);
    const year = view.getUint16(headerBase + 18, true);
    const month = view.getUint8(headerBase + 20);
    const day = view.getUint8(headerBase + 21);
    const hour = view.getUint8(headerBase + 22);
    const minute = view.getUint8(headerBase + 23);
    const second = view.getUint8(headerBase + 24);
    const channels = view.getUint8(headerBase + 32);
    const sampleBytes = view.getUint8(headerBase + 33);
    const validBytes = view.getUint8(headerBase + 34);
    const startByte = view.getUint8(headerBase + 35);
    const dataType = view.getUint8(headerBase + 36);
    const dataBigEndian = view.getUint8(headerBase + 37);
    const exIdx = view.getUint8(headerBase + 38);
    const eyIdx = view.getUint8(headerBase + 39);
    const ezIdx = view.getUint8(headerBase + 40);
    const hxIdx = view.getUint8(headerBase + 41);
    const hyIdx = view.getUint8(headerBase + 42);
    const hzIdx = view.getUint8(headerBase + 43);
    const lineNo = view.getInt32(headerBase + 44, true);
    const pointNo = view.getInt32(headerBase + 48, true);
    const scans = view.getUint32(headerBase + 52, true);
    const sampleRate = view.getFloat32(headerBase + 56, true);
    const fLsbVal = view.getFloat32(headerBase + 60, true);
    const fVRef = view.getFloat32(headerBase + 64, true);
    const fPgaValE = view.getFloat32(headerBase + 68, true);
    const fPgaValH = view.getFloat32(headerBase + 72, true);
    const fXLength = view.getFloat32(headerBase + 76, true);
    const fYLength = view.getFloat32(headerBase + 80, true);
    const uNs = view.getUint32(headerBase + 84, true);
    const uSlot = view.getUint32(headerBase + 88, true);
    const buffSize = view.getUint32(headerBase + 92, true);
    const gpsLongitude = view.getFloat64(headerBase + 96, true);
    const gpsLatitude = view.getFloat64(headerBase + 104, true);
    const gpsElevation = view.getFloat64(headerBase + 112, true);
    const uEh4Band = view.getUint32(headerBase + 120, true);
    const uEh4EGain = view.getUint32(headerBase + 124, true);
    const uEh4MGain = view.getUint32(headerBase + 128, true);
    const fPgaValE1 = view.getFloat32(headerBase + 132, true);
    const fPgaValH1 = view.getFloat32(headerBase + 136, true);
    const bandLDirectSample = view.getUint32(headerBase + 188, true);
    const band = view.getUint8(headerBase + 25);
    const tagSize = view.getUint8(headerBase + 26);
    const status = view.getUint8(headerBase + 27);
    const saturation = view.getUint8(headerBase + 28);
    const gpsStatus = view.getUint8(headerBase + 29);
    const satellites = view.getUint8(headerBase + 30);
    const clockStatus = view.getUint8(headerBase + 31);
    const dataInterweave = view.getUint32(headerBase + 192, true);
    const decimation = view.getUint32(headerBase + 196, true);
    const downMultiple = view.getUint32(headerBase + 200, true);
    const downBandIndex = view.getUint32(headerBase + 204, true);
    const project = readFixedStringFromView(view, headerBase + 208, 16);
    const company = readFixedStringFromView(view, headerBase + 224, 16);
    const operator = readFixedStringFromView(view, headerBase + 240, 16);

    if (!Number.isFinite(scans) || scans <= 0 || !Number.isFinite(channels) || channels <= 0) break;

    let dataOffset = pos + 512;
    const rawChannels = Array.from({ length: channels }, () => new Array(scans).fill(0));
    const displayChannels = Array.from({ length: channels }, () => new Array(scans).fill(0));
    if (dataInterweave === 0) {
      for (let iScan = 0; iScan < scans; iScan++) {
        for (let iCh = 0; iCh < channels; iCh++) {
          const { value, physicalValue, nextOffset } = readSample(dataOffset, dataType, dataBigEndian, startByte, validBytes, sampleBytes, fVRef, fLsbVal);
          dataOffset = nextOffset;
          rawChannels[iCh][iScan] = value;
          displayChannels[iCh][iScan] = Number.isFinite(physicalValue) ? physicalValue : value;
        }
      }
    } else {
      for (let iCh = 0; iCh < channels; iCh++) {
        for (let iScan = 0; iScan < scans; iScan++) {
          const { value, physicalValue, nextOffset } = readSample(dataOffset, dataType, dataBigEndian, startByte, validBytes, sampleBytes, fVRef, fLsbVal);
          dataOffset = nextOffset;
          rawChannels[iCh][iScan] = value;
          displayChannels[iCh][iScan] = Number.isFinite(physicalValue) ? physicalValue : value;
        }
      }
    }

    const channelIndexBase = resolveF3ChannelIndexBase(
      [hyIdx, exIdx, hxIdx, eyIdx],
      [exIdx, eyIdx, ezIdx, hxIdx, hyIdx, hzIdx],
      channels
    );
    const normalizeChannelIndex = (idx) => {
      const numericIndex = Number(idx);
      if (!Number.isInteger(numericIndex)) return -1;
      const normalizedIndex = numericIndex - channelIndexBase;
      return normalizedIndex >= 0 && normalizedIndex < channels ? normalizedIndex : -1;
    };
    const resolvedExIdx = normalizeChannelIndex(exIdx);
    const resolvedEyIdx = normalizeChannelIndex(eyIdx);
    const resolvedEzIdx = normalizeChannelIndex(ezIdx);
    const resolvedHxIdx = normalizeChannelIndex(hxIdx);
    const resolvedHyIdx = normalizeChannelIndex(hyIdx);
    const resolvedHzIdx = normalizeChannelIndex(hzIdx);
    const pickRaw = (idx) => (idx >= 0 && idx < channels ? rawChannels[idx] : new Array(scans).fill(0));
    const pickDisplay = (idx) => (idx >= 0 && idx < channels ? displayChannels[idx] : new Array(scans).fill(0));
    const orderedRaw = [pickRaw(resolvedHyIdx), pickRaw(resolvedExIdx), pickRaw(resolvedHxIdx), pickRaw(resolvedEyIdx)];
    const orderedDisplay = [pickDisplay(resolvedHyIdx), pickDisplay(resolvedExIdx), pickDisplay(resolvedHxIdx), pickDisplay(resolvedEyIdx)];

    blocks.push({
      header: {
        source: 'F3',
        decimation,
        counts: chunkIndex + 1,
        registor: band,
        xlength: fXLength * 100,
        ylength: fYLength * 100,
        length: scans,
        channel: channels,
        sampleUnit: 'mV',
        rawSampleUnit: dataType === 1 ? 'float32' : 'adc-count',
        sampleScaleMillivolts: fVRef * fLsbVal * 1000,
        sampleRate,
        cpuId1,
        cpuId2,
        cpuId3,
        deviceId,
        subSecond,
        year,
        month,
        day,
        hour,
        minute,
        second,
        band,
        tagSize,
        status,
        saturation,
        gpsStatus,
        satellites,
        clockStatus,
        sampleBytes,
        validBytes,
        startByte,
        dataType,
        dataBigEndian,
        channelIndexBase,
        exIdx,
        eyIdx,
        ezIdx,
        hxIdx,
        hyIdx,
        hzIdx,
        resolvedExIdx,
        resolvedEyIdx,
        resolvedEzIdx,
        resolvedHxIdx,
        resolvedHyIdx,
        resolvedHzIdx,
        lineNo,
        pointNo,
        fLsbVal,
        fVRef,
        fPgaValE,
        fPgaValH,
        uNs,
        uSlot,
        buffSize,
        gpsLongitude,
        gpsLatitude,
        gpsElevation,
        uEh4Band,
        uEh4EGain,
        uEh4MGain,
        fPgaValE1,
        fPgaValH1,
        bandLDirectSample,
        dataInterweave,
        downMultiple,
        downBandIndex,
        project,
        company,
        operator
      },
      data: orderedDisplay,
      rawData: orderedRaw
    });

    if (dataOffset <= pos) break;
    pos = dataOffset;
    chunkIndex++;
  }

  return blocks;
};

const readFixedStringFromView = (view, offset, length) => {
  let out = '';
  for (let i = 0; i < length; i++) {
    const code = view.getUint8(offset + i);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
};

const writeFixedStringToView = (view, offset, length, value) => {
  const str = String(value ?? '');
  for (let i = 0; i < length; i++) {
    view.setUint8(offset + i, i < str.length ? str.charCodeAt(i) : 0);
  }
};

export const parseF3IndexFile = (arrayBuffer) => {
  const view = new DataView(arrayBuffer);
  const blockSize = 512;
  if (view.byteLength < blockSize) return [];

  const entries = [];
  for (let base = 0; base + blockSize <= view.byteLength; base += blockSize) {
    let o = base;
    const index = view.getUint32(o, true); o += 4;
    const cpuId1 = view.getUint32(o, true); o += 4;
    const cpuId2 = view.getUint32(o, true); o += 4;
    const cpuId3 = view.getUint32(o, true); o += 4;
    const deviceType = view.getUint32(o, true); o += 4;
    const deviceId = view.getUint32(o, true); o += 4;
    const project = readFixedStringFromView(view, o, 8); o += 8;
    const line = readFixedStringFromView(view, o, 8); o += 8;
    const point = readFixedStringFromView(view, o, 16); o += 16;

    const gpsStatus = view.getUint8(o); o += 1;
    const satelliteCount = view.getUint8(o); o += 1;
    const gpsSync = view.getUint8(o); o += 1;
    const timeZone = view.getUint8(o); o += 1;

    const second = view.getUint8(o); o += 1;
    const minute = view.getUint8(o); o += 1;
    const hour = view.getUint8(o); o += 1;
    const day = view.getUint8(o); o += 1;
    const month = view.getUint8(o); o += 1;
    const yearLow = view.getUint8(o); o += 1;
    o += 1;
    const century = view.getUint8(o); o += 1;
    const year = century * 100 + yearLow;
    const startTimeMillis = new Date(year, Math.max(0, month - 1), day, hour, minute, second).getTime();

    o += 4;
    const gpsLongitude = view.getFloat64(o, true); o += 8;
    const gpsLatitude = view.getFloat64(o, true); o += 8;
    const gpsElevation = view.getFloat64(o, true); o += 8;
    const exLen = view.getFloat32(o, true); o += 4;
    const eyLen = view.getFloat32(o, true); o += 4;
    const hxAngle = view.getFloat32(o, true); o += 4;
    const hyAngle = view.getFloat32(o, true); o += 4;

    const hasAnyIdentity = Boolean(project || line || point);
    const hasAnyNumericSignal = (
      index !== 0 ||
      deviceType !== 0 ||
      deviceId !== 0 ||
      gpsLongitude !== 0 ||
      gpsLatitude !== 0 ||
      gpsElevation !== 0 ||
      exLen !== 0 ||
      eyLen !== 0 ||
      hxAngle !== 0 ||
      hyAngle !== 0
    );
    if (!hasAnyIdentity && !hasAnyNumericSignal) continue;

    entries.push({
      index,
      cpuId1,
      cpuId2,
      cpuId3,
      deviceType,
      deviceId,
      project,
      line,
      point,
      gpsStatus,
      satelliteCount,
      gpsSync,
      timeZone,
      startTimeMillis,
      gpsLongitude,
      gpsLatitude,
      gpsElevation,
      exLen,
      eyLen,
      hxAngle,
      hyAngle,
      __rawBlock: arrayBuffer.slice(base, base + blockSize)
    });
  }

  return entries;
};

export const writeF3IndexFile = (entries) => {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  const blockSize = 512;
  const buffer = new ArrayBuffer(normalizedEntries.length * blockSize);

  normalizedEntries.forEach((entry, idx) => {
    const base = idx * blockSize;
    const rawBlock = entry?.__rawBlock instanceof ArrayBuffer && entry.__rawBlock.byteLength >= blockSize
      ? entry.__rawBlock
      : new ArrayBuffer(blockSize);

    new Uint8Array(buffer, base, blockSize).set(new Uint8Array(rawBlock, 0, blockSize));
    const view = new DataView(buffer, base, blockSize);

    view.setUint32(0, Number(entry?.index) || 0, true);
    view.setUint32(4, Number(entry?.cpuId1) || 0, true);
    view.setUint32(8, Number(entry?.cpuId2) || 0, true);
    view.setUint32(12, Number(entry?.cpuId3) || 0, true);
    view.setUint32(16, Number(entry?.deviceType) || 0, true);
    view.setUint32(20, Number(entry?.deviceId) || 0, true);
    writeFixedStringToView(view, 24, 8, entry?.project);
    writeFixedStringToView(view, 32, 8, entry?.line);
    writeFixedStringToView(view, 40, 16, entry?.point);
    view.setUint8(56, Number(entry?.gpsStatus) || 0);
    view.setUint8(57, Number(entry?.satelliteCount) || 0);
    view.setUint8(58, Number(entry?.gpsSync) || 0);
    view.setUint8(59, Number(entry?.timeZone) || 0);

    const date = Number.isFinite(entry?.startTimeMillis) ? new Date(entry.startTimeMillis) : null;
    if (date && !Number.isNaN(date.getTime())) {
      const year = date.getFullYear();
      view.setUint8(60, date.getSeconds());
      view.setUint8(61, date.getMinutes());
      view.setUint8(62, date.getHours());
      view.setUint8(63, date.getDate());
      view.setUint8(64, date.getMonth() + 1);
      view.setUint8(65, year % 100);
      view.setUint8(67, Math.floor(year / 100));
    }

    view.setFloat64(72, Number(entry?.gpsLongitude) || 0, true);
    view.setFloat64(80, Number(entry?.gpsLatitude) || 0, true);
    view.setFloat64(88, Number(entry?.gpsElevation) || 0, true);
    view.setFloat32(96, Number(entry?.exLen) || 0, true);
    view.setFloat32(100, Number(entry?.eyLen) || 0, true);
    view.setFloat32(104, Number(entry?.hxAngle) || 0, true);
    view.setFloat32(108, Number(entry?.hyAngle) || 0, true);
  });

  return buffer;
};

const scoreMTTSSamples = (values) => {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const absValues = [];
  const diffs = [];
  for (let i = 0; i < values.length; i++) {
    const current = values[i];
    if (!Number.isFinite(current)) return Number.POSITIVE_INFINITY;
    absValues.push(Math.abs(current));
    if (i > 0) diffs.push(Math.abs(current - values[i - 1]));
  }
  absValues.sort((a, b) => a - b);
  diffs.sort((a, b) => a - b);
  const pick = (arr, ratio) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * ratio))] : 0;
  const medianAbs = pick(absValues, 0.5);
  const p95Abs = pick(absValues, 0.95);
  const medianDiff = pick(diffs, 0.5);
  const p95Diff = pick(diffs, 0.95);
  const smoothness = medianAbs > 0 ? medianDiff / medianAbs : medianDiff;
  const spikeRatio = p95Abs > 0 ? p95Diff / p95Abs : p95Diff;
  return smoothness * 3 + spikeRatio + (p95Abs > 1e9 ? 1000 : 0);
};

const detectMTTSSampleEndian = (view, headerLength, totalSamples, lsb) => {
  const availableSamples = Math.floor((view.byteLength - headerLength) / 4);
  const probeSamples = Math.max(0, Math.min(totalSamples, availableSamples, 2048));
  if (!probeSamples) {
    return {
      sampleEndian: 'BE',
      bigEndianScore: null,
      littleEndianScore: null
    };
  }
  const decodeSamples = (littleEndian) => {
    const values = new Float64Array(probeSamples);
    let sampleOffset = headerLength;
    for (let i = 0; i < probeSamples; i++) {
      const raw = view.getInt32(sampleOffset, littleEndian);
      values[i] = raw * lsb * 1000.0;
      sampleOffset += 4;
    }
    return values;
  };
  const bigEndianSamples = decodeSamples(false);
  const littleEndianSamples = decodeSamples(true);
  const bigEndianScore = scoreMTTSSamples(bigEndianSamples);
  const littleEndianScore = scoreMTTSSamples(littleEndianSamples);
  return {
    sampleEndian: littleEndianScore + 1e-9 < bigEndianScore ? 'LE' : 'BE',
    bigEndianScore,
    littleEndianScore
  };
};

export const parseMTTSHeader = (arrayBuffer, fileName = '', options = {}) => {
  const normalizedFileName = String(fileName || '').split(/[\\/]/).pop() || '';
  const baseName = normalizedFileName.replace(/\.[^.]+$/, '');
  const pointNo = (baseName.split('_')[0] || baseName).trim();
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 166) {
    throw new Error(`MTTS 文件过小：${fileName || 'unknown'}`);
  }

  let offset = 0;
  const headerLength = view.getInt16(offset, true); offset += 2;
  const version = view.getInt16(offset, true); offset += 2;
  const nsamples = view.getInt32(offset, true); offset += 4;
  const sampleRate = view.getFloat32(offset, true); offset += 4;
  const start = view.getInt32(offset, true); offset += 4;
  const lsb = view.getFloat64(offset, true); offset += 8;
  const gmtOffset = view.getInt32(offset, true); offset += 4;
  const originalSampleFreq = view.getFloat32(offset, true); offset += 4;
  const aduSerialNumber = view.getInt16(offset, true); offset += 2;
  const aduAdb = view.getInt16(offset, true); offset += 2;
  const channelNumber = view.getInt8(offset); offset += 1;
  const sensorChopper = view.getInt8(offset); offset += 1;
  const channelType = readFixedStringFromView(view, offset, 2).toLowerCase(); offset += 2;
  const sensor = readFixedStringFromView(view, offset, 6); offset += 6;
  const sensorNumber = view.getInt16(offset, true); offset += 2;
  const x1 = view.getFloat32(offset, true); offset += 4;
  const y1 = view.getFloat32(offset, true); offset += 4;
  const z1 = view.getFloat32(offset, true); offset += 4;
  const x2 = view.getFloat32(offset, true); offset += 4;
  const y2 = view.getFloat32(offset, true); offset += 4;
  const z2 = view.getFloat32(offset, true); offset += 4;
  const dipoleLength = view.getFloat32(offset, true); offset += 4;
  const dipoleAngle = view.getFloat32(offset, true); offset += 4;
  const probeResistivity = view.getFloat32(offset, true); offset += 4;
  const dcOffset = view.getFloat32(offset, true); offset += 4;
  const internalGainAmplification = view.getFloat32(offset, true); offset += 4;
  const posGain = view.getFloat32(offset, true); offset += 4;
  const latitude = view.getInt32(offset, true); offset += 4;
  const longitude = view.getInt32(offset, true); offset += 4;
  const elevation = view.getInt32(offset, true); offset += 4;
  const latLongType = readFixedStringFromView(view, offset, 1); offset += 1;
  const additionalCoordinatesType = view.getInt8(offset); offset += 1;
  const referenceMeridian = view.getInt16(offset, true); offset += 2;
  const xCoordinate = view.getFloat64(offset, true); offset += 8;
  const yCoordinate = view.getFloat64(offset, true); offset += 8;
  const gpsStatus = readFixedStringFromView(view, offset, 1); offset += 1;
  const gpsAccuracy = view.getInt8(offset); offset += 1;
  const utcOffset = view.getInt16(offset, true); offset += 2;
  const systemType = readFixedStringFromView(view, offset, 12); offset += 12;
  const surveyHeaderFilename = readFixedStringFromView(view, offset, 12); offset += 12;
  const measurementType = readFixedStringFromView(view, offset, 4); offset += 4;
  const dcOffsetCorrectionValue = view.getFloat64(offset, true); offset += 8;
  const dcOffsetCorrectionOn = view.getInt8(offset); offset += 1;
  const inputDivisorOn = view.getInt8(offset); offset += 1;
  const bitIndicator = view.getInt16(offset, true); offset += 2;
  const selfTestResult = readFixedStringFromView(view, offset, 2); offset += 2;
  const numberSlice = view.getUint16(offset, true); offset += 2;
  const numberCalibrationFrequencies = view.getUint16(offset, true); offset += 2;

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`MTTS 采样率无效：${sampleRate}`);
  }
  if (!Number.isFinite(lsb) || lsb <= 0) {
    throw new Error(`MTTS LSB 无效：${lsb}`);
  }
  if (headerLength <= 0 || headerLength > view.byteLength) {
    throw new Error(`MTTS 头长度无效：${headerLength}`);
  }

  const totalByteLength = Number(options?.totalByteLength) || view.byteLength;
  const availableSamples = Math.floor((totalByteLength - headerLength) / 4);
  const actualSamples = Math.max(0, Math.min(nsamples, availableSamples));
  const endianInfo = detectMTTSSampleEndian(view, headerLength, actualSamples, lsb);

  const channelLabel = channelType ? channelType.toUpperCase() : 'MTTS';
  return {
    source: 'MTTS',
    counts: 1,
    length: actualSamples,
    channel: 1,
    pointNo: pointNo || '--',
    stationId: pointNo || '--',
    fileName: normalizedFileName,
    channelNames: [channelLabel],
    sampleEndian: endianInfo.sampleEndian,
    bigEndianScore: endianInfo.bigEndianScore,
    littleEndianScore: endianInfo.littleEndianScore,
    sampleRate,
    headerLength,
    version,
    nsamples,
    nsamplesInFile: actualSamples,
    start,
    startTimeMillis: (start - gmtOffset * 3600) * 1000,
    lsb,
    gmtOffset,
    originalSampleFreq,
    aduSerialNumber,
    aduAdb,
    channelNumber,
    sensorChopper,
    channelType,
    sensor,
    sensorNumber,
    x1,
    y1,
    z1,
    x2,
    y2,
    z2,
    dipoleLength,
    dipoleAngle,
    probeResistivity,
    dcOffset,
    internalGainAmplification,
    posGain,
    latitude,
    longitude,
    elevation,
    latLongType,
    additionalCoordinatesType,
    referenceMeridian,
    xCoordinate,
    yCoordinate,
    gpsStatus,
    gpsAccuracy,
    utcOffset,
    systemType,
    surveyHeaderFilename,
    measurementType,
    dcOffsetCorrectionValue,
    dcOffsetCorrectionOn,
    inputDivisorOn,
    bitIndicator,
    selfTestResult,
    numberSlice,
    numberCalibrationFrequencies
  };
};

export const parseMTTSSegment = (arrayBuffer, header, options = {}) => {
  const view = new DataView(arrayBuffer);
  const availableSamples = Math.floor(view.byteLength / 4);
  const sampleCount = Math.max(0, Math.min(Number(options.sampleCount) || availableSamples, availableSamples));
  const littleEndian = (options.sampleEndian || header?.sampleEndian || 'BE') === 'LE';
  const lsb = Number(header?.lsb);
  if (!Number.isFinite(lsb) || lsb <= 0) {
    throw new Error('MTTS 头中的 LSB 无效');
  }
  const samples = new Float64Array(sampleCount);
  let sampleOffset = 0;
  for (let i = 0; i < sampleCount; i++) {
    const raw = view.getInt32(sampleOffset, littleEndian);
    samples[i] = raw * lsb * 1000.0;
    sampleOffset += 4;
  }
  return samples;
};

export const parseMTTSFile = (arrayBuffer, fileName = '') => {
  const header = parseMTTSHeader(arrayBuffer, fileName);
  const sampleByteStart = header.headerLength;
  const sampleByteEnd = sampleByteStart + header.nsamplesInFile * 4;
  const sampleBuffer = arrayBuffer.slice(sampleByteStart, sampleByteEnd);
  const samples = parseMTTSSegment(sampleBuffer, header, { sampleCount: header.nsamplesInFile });
  return [{
    header,
    data: [samples]
  }];
};

export const parseF3File = (input, fileName = '') => {
  const lowerName = fileName.toLowerCase();
  if (input instanceof ArrayBuffer) {
    if (lowerName.endsWith('.r')) {
      return parseF3ResistivityFile(input);
    }
    if (lowerName.endsWith('.psd')) {
      return parseF3PsdFile(input);
    }
    const text = new TextDecoder('utf-8').decode(input);
    return parseF3File(text, fileName);
  }

  const text = typeof input === 'string' ? input : '';
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const normalizeKey = (v) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const splitTokens = (line) => line.split(/[,\t; ]+/).map(v => v.trim()).filter(Boolean);

  const headerIndex = lines.findIndex(line => /[a-zA-Z]/.test(line) && /(freq|hz|rho|res|phs|phase|coh)/i.test(line));
  let parsed = [];

  if (headerIndex >= 0) {
    const headers = splitTokens(lines[headerIndex]).map(normalizeKey);
    const findIndex = (keys) => headers.findIndex(h => keys.some(k => h.includes(k)));

    const freqIndex = findIndex(['freq', 'hz']);
    const rhoXYIndex = findIndex(['rhoxy', 'rxy', 'resxy', 'rhoxx', 'rxx', 'resxx']);
    const phaseXYIndex = findIndex(['phsxy', 'phasexy', 'pxy', 'phsxx', 'phasexx', 'pxx']);
    const rhoYXIndex = findIndex(['rhoyx', 'ryx', 'resyx', 'rhoyy', 'ryy', 'resyy']);
    const phaseYXIndex = findIndex(['phsyx', 'phaseyx', 'pyx', 'phsyy', 'phaseyy', 'pyy']);
    const cohXYIndex = findIndex(['cohxy', 'cxy', 'cohxx', 'cxx']);
    const cohYXIndex = findIndex(['cohyx', 'cyx', 'cohyy', 'cyy']);

    if (freqIndex >= 0 && rhoXYIndex >= 0 && phaseXYIndex >= 0 && rhoYXIndex >= 0 && phaseYXIndex >= 0) {
      parsed = lines.slice(headerIndex + 1).map((line) => {
        const cols = splitTokens(line);
        const getNum = (idx) => {
          if (idx < 0 || idx >= cols.length) return NaN;
          const v = Number(cols[idx]);
          return Number.isFinite(v) ? v : NaN;
        };
        const frequency = getNum(freqIndex);
        const rhoXY = getNum(rhoXYIndex);
        const phaseXY = getNum(phaseXYIndex);
        const rhoYX = getNum(rhoYXIndex);
        const phaseYX = getNum(phaseYXIndex);
        const cohXY = cohXYIndex >= 0 ? getNum(cohXYIndex) : 1;
        const cohYX = cohYXIndex >= 0 ? getNum(cohYXIndex) : 1;
        return {
          frequency,
          period: frequency > 0 ? 1 / frequency : 0,
          rhoXY,
          phaseXY,
          rhoYX,
          phaseYX,
          cohXY: Number.isFinite(cohXY) ? cohXY : 1,
          cohYX: Number.isFinite(cohYX) ? cohYX : 1,
          rhoError: 0,
          phaseError: 0
        };
      });
    }
  }

  if (parsed.length === 0) {
    parsed = lines.map(line => {
      const nums = (line.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number);
      if (nums.length < 5) return null;
      const frequency = nums[0];
      return {
        frequency,
        period: frequency > 0 ? 1 / frequency : 0,
        rhoXY: nums[1],
        phaseXY: nums[2],
        rhoYX: nums[3],
        phaseYX: nums[4],
        cohXY: Number.isFinite(nums[5]) ? nums[5] : 1,
        cohYX: Number.isFinite(nums[6]) ? nums[6] : 1,
        rhoError: 0,
        phaseError: 0
      };
    }).filter(Boolean);
  }

  return parsed.filter(d =>
    Number.isFinite(d.frequency) &&
    d.frequency > 0 &&
    Number.isFinite(d.rhoXY) &&
    d.rhoXY > 0 &&
    Number.isFinite(d.rhoYX) &&
    d.rhoYX > 0 &&
    Number.isFinite(d.phaseXY) &&
    Number.isFinite(d.phaseYX)
  );
};

// ==========================================
// EDI 文件读写模块
// ==========================================

export const parseEDIFile = (text) => {
  const lines = text.split('\n').map(l => l.trim());
  const blocks = {};
  
  let currentBlock = null;
  let currentData = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line) continue;
    
    if (line.startsWith('>')) {
      // 遇到了新块，保存旧块
      if (currentBlock && currentData.length > 0) {
        blocks[currentBlock] = currentData;
      }
      
      // 解析块头
      // 例如 ">FREQ // 5" 或 ">FREQ"
      let blockHeader = line.substring(1).split('//')[0].trim();
      // 移除前导的 = 或 ! 等特殊符号
      let blockName = blockHeader.split(/[\s,]+/)[0].toUpperCase().replace(/^[=!]+/, '');
      
      currentBlock = blockName;
      currentData = [];
      
      // 有时候数据直接跟在块头同一行
      let inlineDataStr = blockHeader.substring(blockName.length).trim();
      if (inlineDataStr) {
        let inlineParts = inlineDataStr.split(/[\s,]+/).filter(p => p !== '' && !p.includes('='));
        inlineParts.forEach(p => {
          let val = parseFloat(p);
          if (!isNaN(val)) currentData.push(val);
        });
      }
    } else {
      // 数据行
      if (currentBlock) {
        // EDI 中的数据通常用空格或逗号分隔
        let parts = line.split(/[\s,]+/).filter(p => p !== '');
        parts.forEach(p => {
          let val = parseFloat(p);
          if (!isNaN(val)) currentData.push(val);
        });
      }
    }
  }
  
  // 保存最后一个块
  if (currentBlock && currentData.length > 0) {
    blocks[currentBlock] = currentData;
  }
  
  // 提取频率和数据
  const freqs = blocks['FREQ'];
  if (!freqs || freqs.length === 0) {
    throw new Error('无效的 EDI 文件：未找到 >FREQ 数据块');
  }
  
  const numFreqs = freqs.length;
  const mtData = [];
  
  for (let i = 0; i < numFreqs; i++) {
    const f = freqs[i];
    
    let rhoXY = blocks['RHOXY'] ? blocks['RHOXY'][i] : 0;
    let phsXY = blocks['PHSXY'] ? blocks['PHSXY'][i] : 0;
    let rhoYX = blocks['RHOYX'] ? blocks['RHOYX'][i] : 0;
    let phsYX = blocks['PHSYX'] ? blocks['PHSYX'][i] : 0;
    
    let zxyR = blocks['ZXYR'] ? blocks['ZXYR'][i] : 0;
    let zxyI = blocks['ZXYI'] ? blocks['ZXYI'][i] : 0;
    let zyxR = blocks['ZYXR'] ? blocks['ZYXR'][i] : 0;
    let zyxI = blocks['ZYXI'] ? blocks['ZYXI'][i] : 0;
    
    // 如果没有 RHOXY 但有 ZXYR，则通过公式计算： rho = 0.2 * (1/f) * |Z|^2
    if (!blocks['RHOXY'] && blocks['ZXYR'] && blocks['ZXYI']) {
      rhoXY = 0.2 * (1 / f) * (zxyR * zxyR + zxyI * zxyI);
      phsXY = Math.atan2(zxyI, zxyR) * (180 / Math.PI);
    }
    if (!blocks['RHOYX'] && blocks['ZYXR'] && blocks['ZYXI']) {
      rhoYX = 0.2 * (1 / f) * (zyxR * zyxR + zyxI * zyxI);
      phsYX = Math.atan2(zyxI, zyxR) * (180 / Math.PI);
      // 注意：由于 ZYX 通常在不同象限，可能需要将相位校正到 0-90
      if (phsYX < -180) phsYX += 360;
      if (phsYX > 180) phsYX -= 360;
      phsYX = Math.abs(phsYX);
    }
    
    // 简单构造相干度 (如果没有，默认为 1.0)
    let cohXY = blocks['COHXY'] ? blocks['COHXY'][i] : 1.0;
    let cohYX = blocks['COHYX'] ? blocks['COHYX'][i] : 1.0;

    mtData.push({
      frequency: f,
      period: 1 / f,
      rhoXY: rhoXY,
      phaseXY: phsXY,
      cohXY: cohXY,
      rhoYX: rhoYX,
      phaseYX: phsYX,
      cohYX: cohYX,
      rhoError: 0,
      phaseError: 0
    });
  }
  
  return mtData;
};

export const writeEDIFile = (mtData, stationInfo = {}, exportType = 'all', xData = null) => {
  const stationName = typeof stationInfo === 'string' ? stationInfo : (stationInfo.id || 'MT_Station');
  const lat = stationInfo.lat;
  const lon = stationInfo.lon;
  const elev = stationInfo.z !== undefined ? stationInfo.z : 0;
  const x = stationInfo.x !== undefined ? stationInfo.x : 0;
  const y = stationInfo.y !== undefined ? stationInfo.y : 0;

  const now = new Date();
  const dateStr = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;

  let latStr = '';
  if (lat !== undefined && lat !== null) {
    latStr = `${Math.floor(lat)}:${Math.floor((lat % 1) * 60)}:${(((lat % 1) * 60) % 1) * 60}`;
  }
  let lonStr = '';
  if (lon !== undefined && lon !== null) {
    lonStr = `${Math.floor(lon)}:${Math.floor((lon % 1) * 60)}:${(((lon % 1) * 60) % 1) * 60}`;
  }

  const freqs = mtData ? mtData.map(d => d.frequency) : (xData ? xData.map(d => d.freq) : []);
  const numFreqs = freqs.length;
  
  let ediContent = `>HEAD
  DATAID="${stationName}"
  ACQBY="GeoYun"
  FILEBY="GeoYun"
  ACQDATE="${dateStr}"
  FILEDATE="${dateStr}"
  PROGVERS="GeoYun Web v1.0"
  EMPTY=1.00000e+32
>INFO   
  REFLOC="${x.toFixed(0)}"
  LAT=${latStr}
  LON=${lonStr}
  ELEV=${elev.toFixed(2)}
  X=${x.toFixed(2)}
  Y=${y.toFixed(2)}
>=DEFINEMEAS
`;

  // 格式化输出数组 (每行最多 5 个数据)
  const formatArray = (arr) => {
    let res = '';
    for (let i = 0; i < arr.length; i++) {
      res += arr[i].toExponential(5).padStart(15, ' ');
      if ((i + 1) % 5 === 0) res += '\n';
    }
    if (arr.length % 5 !== 0) res += '\n';
    return res;
  };

  if (exportType === 'spectra' || exportType === 'all') {
    if (xData && xData.length > 0) {
      ediContent += `>=SPECTRASECT\n  NCHAN=4\n  NFREQ=${xData.length}\n`;
      for (let i = 0; i < xData.length; i++) {
        ediContent += `>SPECTRA FREQ=${xData[i].freq}\n`;
        ediContent += formatArray(xData[i].crosspowers);
      }
    }
  }

  if (exportType !== 'spectra') {
    ediContent += `>=MTSECT\n`;
    ediContent += `>FREQ // ${numFreqs}\n`;
    ediContent += formatArray(freqs);
  }

  if (exportType === 'impedance' || exportType === 'all') {
    if (mtData && mtData.length > 0 && mtData[0].zxxR !== undefined) {
      ediContent += `>ZXXR // ${numFreqs}\n` + formatArray(mtData.map(d => d.zxxR));
      ediContent += `>ZXXI // ${numFreqs}\n` + formatArray(mtData.map(d => d.zxxI));
      ediContent += `>ZXYR // ${numFreqs}\n` + formatArray(mtData.map(d => d.zxyR));
      ediContent += `>ZXYI // ${numFreqs}\n` + formatArray(mtData.map(d => d.zxyI));
      ediContent += `>ZYXR // ${numFreqs}\n` + formatArray(mtData.map(d => d.zyxR));
      ediContent += `>ZYXI // ${numFreqs}\n` + formatArray(mtData.map(d => d.zyxI));
      ediContent += `>ZYYR // ${numFreqs}\n` + formatArray(mtData.map(d => d.zyyR));
      ediContent += `>ZYYI // ${numFreqs}\n` + formatArray(mtData.map(d => d.zyyI));
    }
  }

  if (exportType === 'resistivity' || exportType === 'all') {
    if (mtData && mtData.length > 0) {
      ediContent += `>RHOXY // ${numFreqs}\n` + formatArray(mtData.map(d => d.rhoXY));
      ediContent += `>PHSXY // ${numFreqs}\n` + formatArray(mtData.map(d => d.phaseXY));
      ediContent += `>RHOYX // ${numFreqs}\n` + formatArray(mtData.map(d => d.rhoYX));
      ediContent += `>PHSYX // ${numFreqs}\n` + formatArray(mtData.map(d => d.phaseYX));
    }
  }
  
  ediContent += `>END\n`;
  return ediContent;
};

/**
 * 生成 Z_file 文本
 * @param {Array} data 数据对象数组
 * @returns {string} 格式化后的 Z_file 文本
 */
export const writeZFile = (data) => {
  let text = '';
  data.forEach(d => {
    const line1 = [d.freq, d.exhy_coh, d.exhy_rho, d.exhy_phs, d.eyhz_coh, d.eyhx_rho, d.eyhx_phs];
    const line2 = [d.zxx_r, d.zxx_i, d.zxy_r, d.zxy_i, d.zyx_r, d.zyx_i, d.zyy_r, d.zyy_i];
    
    text += formatFixedWidth(line1, 11) + '\n';
    text += formatFixedWidth(line2, 11) + '\n';
  });
  return text;
};


// ==========================================
// X_file (交叉功率谱文件) 读写
// ==========================================

/**
 * 解析 X_file 文本
 * @param {string} text X_file 的完整文本内容
 * @returns {Array} 解析后的交叉谱数据数组
 */
export const parseXFile = (text) => {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  return lines.map(line => {
    const cols = parseFixedWidthLines(line, 11);
    return {
      freq: cols[0],
      bw: cols[1],
      avg: cols[2],
      crosspowers: cols.slice(3) // 包含 16 个功率谱值 (实部虚部交替)
    };
  });
};

/**
 * 生成 X_file 文本
 * @param {Array} data 交叉谱数据数组
 * @returns {string} 格式化后的 X_file 文本
 */
export const writeXFile = (data) => {
  return data.map(d => {
    const cols = [d.freq, d.bw, d.avg, ...(d.crosspowers || new Array(16).fill(0))];
    return formatFixedWidth(cols, 11);
  }).join('\n');
};


// ==========================================
// Y_file (时间序列二进制文件) 读写
// ==========================================

/**
 * 解析 Y_file 二进制时间序列 (2-byte integer, low-high byte / Little Endian)
 * @param {ArrayBuffer} arrayBuffer Y_file 的二进制数据
 * @returns {Array} 包含块头信息和多通道数据的数组
 */
export const parseYFile = (arrayBuffer) => {
  const view = new DataView(arrayBuffer);
  let offset = 0;
  const blocks = [];

  while (offset + 14 <= view.byteLength) {
    // 读取文件头 (每个字 2 bytes)
    const decimation = view.getInt16(offset, true); offset += 2;
    const counts = view.getInt16(offset, true); offset += 2;
    const registor = view.getUint16(offset, true); offset += 2; // unsigned
    const xlength = view.getInt16(offset, true); offset += 2;
    const ylength = view.getInt16(offset, true); offset += 2;
    const length = view.getInt16(offset, true); offset += 2;
    const channel = view.getInt16(offset, true); offset += 2;

    const remainingBytes = view.byteLength - offset;
    const manualSamplesPerChannel = channel > 0 && length % channel === 0 ? length / channel : length;
    const manualBytes = manualSamplesPerChannel * channel * 2;
    const legacyBytes = length * channel * 2;
    const samplesPerChannel = manualBytes <= remainingBytes && (
      legacyBytes > remainingBytes ||
      (remainingBytes - manualBytes) < (remainingBytes - legacyBytes)
    ) ? manualSamplesPerChannel : length;
    const totalSampleWords = samplesPerChannel * channel;
    const dataLengthBytes = totalSampleWords * 2;
    
    // 如果剩余数据不足以完整读取一个 block，则跳出
    if (offset + dataLengthBytes > view.byteLength) {
      break; 
    }

    // 初始化通道数据数组
    const data = Array.from({ length: channel }, () => new Int16Array(samplesPerChannel));
    
    // 读取交错的时间序列数据
    // 顺序: CH1_pt1, CH2_pt1, CH3_pt1, CH4_pt1, CH1_pt2, CH2_pt2 ...
    for (let pt = 0; pt < samplesPerChannel; pt++) {
      for (let ch = 0; ch < channel; ch++) {
        data[ch][pt] = view.getInt16(offset, true);
        offset += 2;
      }
    }

    blocks.push({
      header: { decimation, counts, registor, xlength, ylength, length: samplesPerChannel, rawLength: length, channel },
      data
    });
  }
  
  return blocks;
};

/**
 * 生成 Y_file 二进制时间序列
 * @param {Array} blocks 包含 header 和 data 的块数组
 * @returns {ArrayBuffer} 生成的二进制 ArrayBuffer
 */
export const writeYFile = (blocks) => {
  // 计算所需总字节数
  let totalBytes = 0;
  blocks.forEach(block => {
    totalBytes += 14; // Header 占 14 字节
    totalBytes += block.header.length * block.header.channel * 2; // 数据部分
  });

  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  let offset = 0;

  blocks.forEach(block => {
    const { decimation, counts, registor, xlength, ylength, length, channel } = block.header;
    
    // 写入 Header
    view.setInt16(offset, decimation, true); offset += 2;
    view.setInt16(offset, counts, true); offset += 2;
    view.setUint16(offset, registor, true); offset += 2;
    view.setInt16(offset, xlength, true); offset += 2;
    view.setInt16(offset, ylength, true); offset += 2;
    view.setInt16(offset, length * channel, true); offset += 2;
    view.setInt16(offset, channel, true); offset += 2;

    // 写入交错数据
    const data = block.data;
    for (let pt = 0; pt < length; pt++) {
      for (let ch = 0; ch < channel; ch++) {
        view.setInt16(offset, data[ch][pt], true);
        offset += 2;
      }
    }
  });

  return buffer;
};
