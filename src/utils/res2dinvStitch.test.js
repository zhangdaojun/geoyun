import { describe, expect, it } from 'vitest';
import {
  buildStitchedRes2dinvDat,
  getRes2dinvRecordExtent,
  getRes2dinvRecordSpan,
  parseRes2dinvSource,
  parseRes2dinvTopographyBlock,
  resolveRes2dinvLayout,
  transformRes2dinvDataLine,
} from './res2dinvStitch.js';

/**
 * 构造一个最小化的 RES2DINV 偶极-偶极 (arrayType=3) 排列文件文本。
 * 6 个电极，间距 a=5，xLocationType=0，无 IP。
 *
 * 数据行格式：x  a  n  rho   （x = 最左电极 C2 位置）
 * 测点取 4 条：
 *   1) C2=0,  a=5, n=1  → 电极覆盖 [0..15]
 *   2) C2=5,  a=5, n=1  → 覆盖 [5..20]
 *   3) C2=10, a=5, n=1  → 覆盖 [10..25]
 *   4) C2=0,  a=5, n=2  → 覆盖 [0..20]
 * 排列首电极=0，末电极=25，spreadLength=25。
 */
const buildDDFile = ({ title = 'spread', firstX = 0 } = {}) => {
  const offset = firstX;
  const dataLines = [
    `${offset + 0} 5 1 100`,
    `${offset + 5} 5 1 110`,
    `${offset + 10} 5 1 120`,
    `${offset + 0} 5 2 200`,
  ];
  return [
    title,
    '5',     // unit electrode spacing
    '3',     // arrayType (dipole-dipole)
    String(dataLines.length),
    '0',     // xLocationType (= leftmost electrode)
    '0',     // ipFlag
    ...dataLines,
    '0',     // tail (常见的 4 行 0 用作 topography flags)
    '0',
    '0',
    '0',
  ].join('\r\n');
};

const buildWennerFile = ({ title = 'wenner', firstX = 0 } = {}) => {
  const offset = firstX;
  // Wenner alpha: x  a  rho  （只有 3 列；span = 3a = 15）
  const dataLines = [
    `${offset + 0} 5 100`,
    `${offset + 5} 5 110`,
    `${offset + 10} 5 120`,
  ];
  return [
    title,
    '5',
    '1',     // arrayType (Wenner alpha)
    String(dataLines.length),
    '0',     // xLocationType
    '0',     // ipFlag
    ...dataLines,
    '0',
    '0',
    '0',
    '0',
  ].join('\r\n');
};

describe('getRes2dinvRecordSpan', () => {
  it('Wenner α/β/γ 跨度恒为 3a，与 n 无关', () => {
    expect(getRes2dinvRecordSpan(1, 5, 1)).toBe(15);
    expect(getRes2dinvRecordSpan(1, 5, 6)).toBe(15);
    expect(getRes2dinvRecordSpan(4, 10, 3)).toBe(30);
    expect(getRes2dinvRecordSpan(5, 5, 8)).toBe(15);
  });

  it('偶极-偶极 (arrayType=3) 跨度 = (n+2)a', () => {
    expect(getRes2dinvRecordSpan(3, 5, 1)).toBe(15);
    expect(getRes2dinvRecordSpan(3, 5, 6)).toBe(40);
  });

  it('Schlumberger (arrayType=7) 跨度 = (2n+1)a', () => {
    expect(getRes2dinvRecordSpan(7, 5, 1)).toBe(15);
    expect(getRes2dinvRecordSpan(7, 5, 4)).toBe(45);
  });
});

describe('RES2DINV topography sections', () => {
  it('parses index-format topography elevation points', () => {
    const file = [
      'TOPO',
      '10',
      '1',
      '3',
      '0',
      '0',
      '0 10 100',
      '10 10 110',
      '20 10 120',
      '2',
      '3',
      '0,1000',
      '10,1002.5',
      '20,1001',
      '1',
      '0',
      '0',
    ].join('\r\n');
    const parsed = parseRes2dinvSource(file);
    expect(parsed.topographyBlock.flag).toBe(2);
    expect(parsed.topographyBlock.points).toEqual([
      { x: 0, elevation: 1000, z: 1000 },
      { x: 10, elevation: 1002.5, z: 1002.5 },
      { x: 20, elevation: 1001, z: 1001 },
    ]);
    expect(parseRes2dinvTopographyBlock(parsed.tailLines, 0).pointCount).toBe(3);
  });

  it('merges and shifts topography points when stitching spreads', () => {
    const withTopo = (title) => [
      title,
      '5',
      '3',
      '4',
      '0',
      '0',
      '0 5 1 100',
      '5 5 1 110',
      '10 5 1 120',
      '0 5 2 200',
      '2',
      '2',
      '0,1000',
      '25,1005',
      '1',
      '0',
    ].join('\r\n');
    const text = buildStitchedRes2dinvDat({
      sources: [{ text: withTopo('A') }, { text: withTopo('B') }],
      rows: [{ xLocation: 0 }, { xLocation: 25 }],
    });
    const lines = text.split('\r\n');
    const topography = parseRes2dinvTopographyBlock(lines, 14);
    expect(topography.points).toEqual([
      { x: 0, elevation: 1000, z: 1000 },
      { x: 25, elevation: 1000, z: 1000 },
      { x: 50, elevation: 1005, z: 1005 },
    ]);
  });
});

describe('getRes2dinvRecordExtent', () => {
  it('xLocationType=0 时 leftmost 即 parts[0]', () => {
    const e = getRes2dinvRecordExtent({ arrayType: 3, xLocationType: 0, values: [10, 5, 1] });
    expect(e).toEqual({ leftmost: 10, rightmost: 25, span: 15 });
  });

  it('xLocationType=1 时 leftmost = x − span/2（对 arrayType=3 同样有效，因为它的全阵关于中线对称）', () => {
    // n=1, span=15, mid 距 leftmost 7.5
    const e = getRes2dinvRecordExtent({ arrayType: 3, xLocationType: 1, values: [10, 5, 1] });
    expect(e.leftmost).toBeCloseTo(2.5);
    expect(e.rightmost).toBeCloseTo(17.5);
  });

  it('xLocationType=2 (供电偶极中点) 在偶极–偶极上 leftmost = x − a/2（不是 −span/2）', () => {
    // 这是修复的核心：原代码会把 leftmost 算成 x - (n+2)*a/2，对偶极–偶极偏 9*a/2
    const e = getRes2dinvRecordExtent({ arrayType: 3, xLocationType: 2, values: [10, 5, 6] });
    expect(e.leftmost).toBeCloseTo(7.5);     // 10 - 5/2
    expect(e.rightmost).toBeCloseTo(7.5 + (6 + 2) * 5); // 47.5
    expect(e.span).toBe((6 + 2) * 5);        // span 不变
  });

  it('Wenner α 在 xLocationType=2 下与 xLocationType=1 等价（对称装置）', () => {
    const e1 = getRes2dinvRecordExtent({ arrayType: 1, xLocationType: 1, values: [20, 5] });
    const e2 = getRes2dinvRecordExtent({ arrayType: 1, xLocationType: 2, values: [20, 5] });
    expect(e2).toEqual(e1);
  });

  it('values 不合法时返回 null', () => {
    expect(getRes2dinvRecordExtent({ arrayType: 3, values: [10, 0, 1] })).toBeNull();
    expect(getRes2dinvRecordExtent({ arrayType: 3, values: ['x'] })).toBeNull();
  });
});

describe('resolveRes2dinvLayout', () => {
  it('标准 arrayType（非 11/12/13）固定布局', () => {
    const lines = ['title', '5', '3', '4', '0', '0', '0 5 1 100'];
    const layout = resolveRes2dinvLayout(lines, 3);
    expect(layout).toEqual({
      dataCount: 4,
      dataStartIndex: 6,
      dataCountIndex: 3,
      xLocationType: 0,
      ipFlag: 0,
    });
  });
});

describe('parseRes2dinvSource & computeSpreadElectrodeRange', () => {
  it('偶极–偶极 (arrayType=3, xLocationType=0)：firstElectrodeX=0，lastElectrodeX=25', () => {
    const parsed = parseRes2dinvSource(buildDDFile());
    expect(parsed).toBeTruthy();
    expect(parsed.arrayType).toBe(3);
    expect(parsed.layout.xLocationType).toBe(0);
    expect(parsed.firstElectrodeX).toBe(0);
    expect(parsed.lastElectrodeX).toBe(25);
    expect(parsed.spreadLength).toBe(25);
    expect(parsed.dataLines.length).toBe(4);
  });

  it('Wenner α：firstElectrodeX=0, lastElectrodeX=25 (10+3a)', () => {
    const parsed = parseRes2dinvSource(buildWennerFile());
    expect(parsed.arrayType).toBe(1);
    expect(parsed.firstElectrodeX).toBe(0);
    expect(parsed.lastElectrodeX).toBe(25);
  });

  it('xLocationType=2 偶极–偶极用新公式得到正确的首电极位置（不再因 max-n 偏移）', () => {
    // 构造一个 xLocationType=2 的 DD 文件：parts[0] = mid-of-C-dipole = leftmost + a/2
    const a = 5;
    const dataLines = [
      // n=1, leftmost=0  → x = 0 + 2.5 = 2.5
      `2.5 ${a} 1 100`,
      // n=6, leftmost=0  → x = 0 + 2.5 = 2.5（同最左电极位置但 n 更大）
      `2.5 ${a} 6 200`,
      // n=1, leftmost=10 → x = 12.5
      `12.5 ${a} 1 110`,
    ];
    const text = [
      'spread',
      String(a),
      '3',
      String(dataLines.length),
      '2',     // xLocationType=2
      '0',
      ...dataLines,
      '0', '0', '0', '0',
    ].join('\r\n');
    const parsed = parseRes2dinvSource(text);
    expect(parsed.firstElectrodeX).toBeCloseTo(0);
    // 最右电极 = leftmost (10) + span((6+2)*5? 但这里最右记录是 n=1@x=12.5，对应 leftmost=10，rightmost=25)
    // n=6@x=2.5 对应 leftmost=0, rightmost=0 + 8*5 = 40，应该取 max=40
    expect(parsed.lastElectrodeX).toBeCloseTo(40);
  });
});

describe('transformRes2dinvDataLine', () => {
  it('正向平移：x_global = x_local − firstElectrodeX + targetStartX', () => {
    const out = transformRes2dinvDataLine({
      line: '10 5 1 120',
      arrayType: 3,
      xLocationType: 0,
      firstElectrodeX: 0,
      lastElectrodeX: 25,
      targetStartX: 100,
      reverse: false,
    });
    expect(out).toBe('110 5 1 120');
  });

  it('正向平移：源文件局部坐标系不从 0 开始时也能锚到 targetStartX', () => {
    // 排列首电极在局部 X=50 的位置，targetStartX=200
    // 一条记录 parts[0]=60（局部偏移 10）应被映射到 200 + 10 = 210
    const out = transformRes2dinvDataLine({
      line: '60 5 1 100',
      arrayType: 3,
      xLocationType: 0,
      firstElectrodeX: 50,
      lastElectrodeX: 75,
      targetStartX: 200,
      reverse: false,
    });
    expect(out).toBe('210 5 1 100');
  });

  it('反向 (lineSign=1) + xLocationType=0：parts[0] 转换为新最左电极位置', () => {
    // 排列长度 = 25。parts[0]=10（n=1, span=15，原最右电极=25）
    // 反向后镜像位置：max+min - x = 25 - 10 = 15（这是原最右电极的镜像）
    // 由于 xLocationType=0 表示 leftmost，需再减去 span(15)：15 - 15 = 0
    // targetStartX=100 → 100 + (0 - 0) = 100
    const out = transformRes2dinvDataLine({
      line: '10 5 1 120',
      arrayType: 3,
      xLocationType: 0,
      firstElectrodeX: 0,
      lastElectrodeX: 25,
      targetStartX: 100,
      reverse: true,
    });
    expect(out).toBe('100 5 1 120');

    // 再验证一条 parts[0]=0（最左记录，原最左电极=0，原最右电极=15）
    // 镜像后该记录在排列右端：最右=25-0=25，最左=25-15=10
    // 所以新 parts[0]=10，shift 后 100 + 10 = 110
    const out2 = transformRes2dinvDataLine({
      line: '0 5 1 100',
      arrayType: 3,
      xLocationType: 0,
      firstElectrodeX: 0,
      lastElectrodeX: 25,
      targetStartX: 100,
      reverse: true,
    });
    expect(out2).toBe('110 5 1 100');
  });

  it('反向 + xLocationType=1：中点直接镜像（不减 span）', () => {
    // 排列首电极=0、末电极=25，记录中点=12（n=1 span=15，原电极覆盖 [4.5, 19.5]）
    // 反向后中点=25-12=13；shift → targetStartX + 13
    const out = transformRes2dinvDataLine({
      line: '12 5 1 120',
      arrayType: 3,
      xLocationType: 1,
      firstElectrodeX: 0,
      lastElectrodeX: 25,
      targetStartX: 100,
      reverse: true,
    });
    expect(out).toBe('113 5 1 120');
  });
});

describe('buildStitchedRes2dinvDat', () => {
  it('两个相同结构的偶极–偶极排列首尾相接拼接，全局 X 单调递增', () => {
    const file1 = buildDDFile({ title: 'L1' });          // 0..25
    const file2 = buildDDFile({ title: 'L2' });          // 0..25 (局部)
    const text = buildStitchedRes2dinvDat({
      sources: [{ text: file1 }, { text: file2 }],
      rows: [
        { xLocation: 0, lineSign: '0' },
        { xLocation: 25, lineSign: '0' },  // 紧接第一排列
      ],
      outputName: 'STITCH',
    });

    const lines = text.split('\r\n');
    expect(lines[0]).toBe('STITCH');
    expect(lines[1]).toBe('5');             // unit spacing
    expect(lines[2]).toBe('3');             // arrayType
    expect(lines[3]).toBe('8');             // dataCount = 4 + 4

    // 全部数据行的 parts[0]
    const xs = lines.slice(6, 6 + 8).map((line) => Number(line.trim().split(/\s+/)[0]));
    expect(xs).toEqual([0, 5, 10, 0, 25, 30, 35, 25]);
    // 第二排列的 parts[0] = 局部值 + 25
  });

  it('反向排列 (lineSign=1) 在拼接后位置正确', () => {
    const file1 = buildDDFile({ title: 'A' });
    const file2 = buildDDFile({ title: 'B' });
    const text = buildStitchedRes2dinvDat({
      sources: [{ text: file1 }, { text: file2 }],
      rows: [
        { xLocation: 0, lineSign: '0' },
        { xLocation: 25, lineSign: '1' },   // 反向接在右边
      ],
    });
    const lines = text.split('\r\n');
    expect(lines[3]).toBe('8');

    // 第一排列保持原值 (0,5,10,0)
    const xs = lines.slice(6, 14).map((l) => Number(l.trim().split(/\s+/)[0]));
    expect(xs.slice(0, 4)).toEqual([0, 5, 10, 0]);

    // 第二排列反向，对照 transformRes2dinvDataLine 反向用例：
    //   parts[0]=0  → 25 + (新最左=10) = 35
    //   parts[0]=5  → 25 + 5 = 30
    //   parts[0]=10 → 25 + 0 = 25
    //   parts[0]=0(n=2, span=20) → 25 + (新最左=25-0-20=5) = 30
    expect(xs.slice(4)).toEqual([35, 30, 25, 30]);
  });

  it('arrayType 不一致时拒绝拼接', () => {
    const ddFile = buildDDFile();
    const wennerFile = buildWennerFile();
    expect(() => buildStitchedRes2dinvDat({
      sources: [{ text: ddFile }, { text: wennerFile }],
      rows: [{ xLocation: 0 }, { xLocation: 25 }],
    })).toThrow(/arrayType/);
  });

  it('IP flag 不一致时拒绝拼接（避免列数错位）', () => {
    const fileNoIp = buildDDFile();
    const fileWithIp = [
      'L2', '5', '3', '2',
      '0',
      '1',         // ipFlag=1
      '0 5 1 100 5',
      '5 5 1 110 6',
      '0', '0', '0', '0',
    ].join('\r\n');
    expect(() => buildStitchedRes2dinvDat({
      sources: [{ text: fileNoIp }, { text: fileWithIp }],
      rows: [{ xLocation: 0 }, { xLocation: 25 }],
    })).toThrow(/IP flag/);
  });

  it('重叠数据可按前一排列保留', () => {
    const file1 = buildWennerFile({ title: 'A' });
    const file2 = buildWennerFile({ title: 'B' });
    const text = buildStitchedRes2dinvDat({
      sources: [{ text: file1 }, { text: file2 }],
      rows: [{ xLocation: 0 }, { xLocation: 10 }],
      overlapMode: 'previous',
    });
    const lines = text.split('\r\n');
    expect(lines[3]).toBe('5');
    expect(lines.slice(6, 11)).toEqual([
      '0 5 100',
      '5 5 110',
      '10 5 120',
      '15 5 110',
      '20 5 120',
    ]);
  });

  it('重叠数据可按后一排列替换', () => {
    const file1 = buildWennerFile({ title: 'A' });
    const file2 = buildWennerFile({ title: 'B' });
    const text = buildStitchedRes2dinvDat({
      sources: [{ text: file1 }, { text: file2 }],
      rows: [{ xLocation: 0 }, { xLocation: 10 }],
      overlapMode: 'next',
    });
    const lines = text.split('\r\n');
    expect(lines[3]).toBe('5');
    expect(lines.slice(6, 11)).toEqual([
      '0 5 100',
      '5 5 110',
      '10 5 100',
      '15 5 110',
      '20 5 120',
    ]);
  });

  it('重叠数据可取平均', () => {
    const file1 = buildWennerFile({ title: 'A' });
    const file2 = buildWennerFile({ title: 'B' });
    const text = buildStitchedRes2dinvDat({
      sources: [{ text: file1 }, { text: file2 }],
      rows: [{ xLocation: 0 }, { xLocation: 10 }],
      overlapMode: 'average',
    });
    const lines = text.split('\r\n');
    expect(lines[3]).toBe('5');
    expect(lines.slice(6, 11)).toEqual([
      '0 5 100',
      '5 5 110',
      '10 5 110',
      '15 5 110',
      '20 5 120',
    ]);
  });
});

describe('与 RES2DINV 官方 CONCATENATE 行为对齐 — 局部坐标非 0 起的源文件', () => {
  it('首电极在局部 50m 处的源文件，targetStartX 仍代表"该排列首电极在全局的位置"', () => {
    // 模拟某些采集软件直接用真实桩号作为局部坐标的情况
    const file = buildDDFile({ firstX: 50 });
    const text = buildStitchedRes2dinvDat({
      sources: [{ text: file }],
      rows: [{ xLocation: 1000, lineSign: '0' }],
    });
    const lines = text.split('\r\n');
    const xs = lines.slice(6, 10).map((l) => Number(l.trim().split(/\s+/)[0]));
    // 排列首电极原本在 50，要求映射到 1000：偏移 +950
    expect(xs).toEqual([1000, 1005, 1010, 1000]);
  });
});
