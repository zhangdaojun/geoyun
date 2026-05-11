export const defaultEmap1AuroraSettings = {
  mode: 'scalar_xy',
  nfft: 4096,
  overlap: 0.5,
  window: 'hann',
  huberThreshold: 1.5,
  maxIter: 20,
  tolerance: 1e-4,
  dipoleExM: 25,
  dipoleEyM: 25,
  useRemoteReference: false,
  sampleRatePreference: 'auto',
  targetFrequencyHz: 10
};

export const EMAP1_AURORA_DEFAULT_CALIBRATION = {
  exChannelResponseId: '',
  exSensorResponseId: '',
  eyChannelResponseId: '',
  eySensorResponseId: '',
  hxChannelResponseId: '',
  hxSensorResponseId: '',
  hyChannelResponseId: '',
  hySensorResponseId: ''
};

export const isEmap1CalibrationFile = (name = '') => /\.(tbl|txt|rsp|resp|cal)$/i.test(String(name || '').trim());

export const getEmap1CalibrationCandidateId = (item = {}) => (
  item?.id
  || item?.object_key
  || item?.objectKey
  || item?.path
  || `${item?.parentId || ''}/${item?.name || ''}`
);

const matchEmap1CalibrationAxisScore = (name, axis) => {
  if (!name) return 0;
  if (axis === 'ex') {
    if (/\bex\b|e_x|x-electric|xelectric|x电|x电场|ex[-_ ]?(channel|sensor|resp|response)\b/i.test(name)) return 10;
    if (/\bex\b|e_x|x-axis|xaxis/i.test(name)) return 8;
  }
  if (axis === 'ey') {
    if (/\bey\b|e_y|y-electric|yelectric|y电|y电场|ey[-_ ]?(channel|sensor|resp|response)\b/i.test(name)) return 10;
    if (/\bey\b|e_y|y-axis|yaxis/i.test(name)) return 8;
  }
  if (axis === 'hx') {
    if (/\bhx\b|h_x|x-axis|xaxis|x磁|x轴/i.test(name)) return 8;
    if (/\bhx[-_ ]?(channel|sensor|resp|response)\b/i.test(name)) return 10;
  }
  if (axis === 'hy') {
    if (/\bhy\b|h_y|y-axis|yaxis|y磁|y轴/i.test(name)) return 8;
    if (/\bhy[-_ ]?(channel|sensor|resp|response)\b/i.test(name)) return 10;
  }
  return 0;
};

const matchEmap1CalibrationKindScore = (name, kind) => {
  if (!name) return 0;
  if (kind === 'sensor') {
    if (/sensors?\.tbl|sensor|probe|传感器/i.test(name)) return 12;
    if (/\.tbl$/i.test(name)) return 8;
  }
  if (kind === 'channel') {
    if (/channel|chan|chn|通道/i.test(name)) return 12;
    if (/afev?|response|resp|rsp|50h|60h|hf/i.test(name)) return 6;
  }
  return 0;
};

export const autoMatchEmap1Calibration = (candidates = []) => {
  const pickBest = (axis, kind) => {
    let best = null;
    let bestScore = -1;
    candidates.forEach((item, index) => {
      const name = String(item?.name || '').trim();
      const score = matchEmap1CalibrationAxisScore(name, axis) + matchEmap1CalibrationKindScore(name, kind);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      } else if (score === bestScore && best && index < candidates.indexOf(best)) {
        best = item;
      }
    });
    if (!best || bestScore <= 0) return '';
    return String(getEmap1CalibrationCandidateId(best));
  };

  return {
    exChannelResponseId: pickBest('ex', 'channel'),
    exSensorResponseId: pickBest('ex', 'sensor'),
    eyChannelResponseId: pickBest('ey', 'channel'),
    eySensorResponseId: pickBest('ey', 'sensor'),
    hxChannelResponseId: pickBest('hx', 'channel'),
    hxSensorResponseId: pickBest('hx', 'sensor'),
    hyChannelResponseId: pickBest('hy', 'channel'),
    hySensorResponseId: pickBest('hy', 'sensor')
  };
};
