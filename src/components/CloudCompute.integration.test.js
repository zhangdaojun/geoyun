import { describe, expect, it } from 'vitest';
import { buildChartOption, buildUploadGroups } from './CloudCompute.jsx';

describe('CloudCompute integration helpers', () => {
  it('groups uploaded EMAP-1 channel files before batch processing', () => {
    const files = [
      { name: 'P001_EX.txt', webkitRelativePath: 'survey/P001_EX.txt' },
      { name: 'P001_EY.txt', webkitRelativePath: 'survey/P001_EY.txt' },
      { name: 'P001_HX.txt', webkitRelativePath: 'survey/P001_HX.txt' },
      { name: 'P001_HY.txt', webkitRelativePath: 'survey/P001_HY.txt' }
    ];

    const groups = buildUploadGroups(files);

    expect(groups).toHaveLength(1);
    expect(groups[0].groupKey).toBe('survey/P001');
    expect(groups[0].missingChannels).toEqual([]);
    expect(Object.keys(groups[0].channels)).toEqual(['ex', 'ey', 'hx', 'hy']);
  });

  it('turns EMAP-1 batch result rows into a chart-ready option', () => {
    const option = buildChartOption([
      { freq_hz: 1, rho_xy: 100, rho_yx: 120, phase_xy_deg: 30, phase_yx_deg: 35 },
      { freq_hz: 10, rho_xy: 80, rho_yx: 95, phase_xy_deg: 40, phase_yx_deg: 42 }
    ], 'P001');

    expect(option.title.text).toContain('P001');
    expect(option.xAxis[0].type).toBe('log');
    expect(option.series.map((item) => item.name)).toEqual([
      'Rho XY',
      'Rho YX',
      'Phase XY',
      'Phase YX',
      'Coh XY',
      'Coh YX'
    ]);
    expect(option.series[0].data).toEqual([[1, 100], [10, 80]]);
  });
});
