import { beforeEach, describe, expect, it, vi } from 'vitest';

const parseAtFileMock = vi.fn();
const parseF3IndexFileMock = vi.fn();
const parseMTTSHeaderMock = vi.fn();
const resolveDriveFileContentMock = vi.fn();

vi.mock('./eh4io.js', () => ({
  parseAtFile: parseAtFileMock,
  parseF3IndexFile: parseF3IndexFileMock,
  parseMTTSHeader: parseMTTSHeaderMock
}));

vi.mock('./lazyModules.js', () => ({
  loadEh4Io: async () => ({
    parseAtFile: parseAtFileMock,
    parseF3IndexFile: parseF3IndexFileMock,
    parseMTTSHeader: parseMTTSHeaderMock
  })
}));

vi.mock('./driveFileContent.js', () => ({
  resolveDriveFileContent: resolveDriveFileContentMock
}));

const { buildPointDataSuffix, syncDriveSurveyEntries } = await import('./fieldSurveyGeneration.js');

const createTextFile = (text) => ({
  text: async () => text,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer
});

const createBinaryFile = (size = 32) => ({
  arrayBuffer: async () => new ArrayBuffer(size),
  text: async () => ''
});

const createBaseProject = () => ({
  id: 'project-1',
  plan: {
    designEntries: []
  }
});

describe('fieldSurveyGeneration', () => {
  beforeEach(() => {
    parseAtFileMock.mockReset();
    parseF3IndexFileMock.mockReset();
    parseMTTSHeaderMock.mockReset();
    resolveDriveFileContentMock.mockReset();
    resolveDriveFileContentMock.mockImplementation(async (item) => item?.rawFile || null);
  });

  it('builds EH4 points from @ files and annotates x/y/z suffixes', async () => {
    parseAtFileMock.mockReturnValue([
      { id: '51750', line: '0', z: 4300 },
      { id: '51775', line: '0', z: 4310 }
    ]);

    const items = [
      { id: 'raw', type: 'folder', name: '02_野外采集', category: 'raw' },
      { id: 'eh4-root', type: 'folder', parentId: 'raw', name: 'eh4', instrumentType: 'EH4' },
      { id: 'line-0', type: 'folder', parentId: 'eh4-root', name: '测线 0' },
      { id: 'station-file', type: 'file', parentId: 'line-0', name: '@stations', rawFile: createTextFile('@') },
      { id: 'x-1', type: 'file', parentId: 'line-0', name: 'XGEGZ.026' },
      { id: 'y-1', type: 'file', parentId: 'line-0', name: 'YGEGZ.026' },
      { id: 'z-1', type: 'file', parentId: 'line-0', name: 'ZGEGZ.026' },
      { id: 'x-2', type: 'file', parentId: 'line-0', name: 'XGEGZ.027' },
      { id: 'y-2', type: 'file', parentId: 'line-0', name: 'YGEGZ.027' }
    ];

    const result = await syncDriveSurveyEntries(createBaseProject(), items);

    expect(result.changed).toBe(true);
    expect(result.pointCount).toBe(2);
    expect(result.lineCount).toBe(1);

    const first = result.designEntries.find((entry) => entry.point === '51750');
    const second = result.designEntries.find((entry) => entry.point === '51775');

    expect(first.instrument).toBe('EH4');
    expect(first.line).toBe('0');
    expect(first.matchedDataCount).toBe(3);
    expect(buildPointDataSuffix(first)).toBe('xyz');

    expect(second.matchedDataCount).toBe(2);
    expect(buildPointDataSuffix(second)).toBe('xy');
  });

  it('uses RY from EH4 @ files as the line code', async () => {
    parseAtFileMock.mockReturnValue([
      { id: 'GEGZ.027', rxValue: '51750', ryValue: '99', z: 4300 }
    ]);
    parseF3IndexFileMock.mockReturnValue([
      { point: '52000', gpsLongitude: 80.7, gpsLatitude: 30.9, gpsElevation: 4200 }
    ]);
    parseMTTSHeaderMock.mockReturnValue({
      pointNo: '0-10',
      surveyHeaderFilename: 'line99',
      elevation: 4567
    });

    const ediText = `
DATAID=Z_54950.No36
STN=54950
LAT=30.886900
LONG=80.726045
ELEV=4321
`;

    const items = [
      { id: 'raw', type: 'folder', name: '02_野外采集', category: 'raw' },
      { id: 'eh4-root', type: 'folder', parentId: 'raw', name: 'eh4', instrumentType: 'EH4' },
      { id: 'line-99', type: 'folder', parentId: 'eh4-root', name: 'EH4' },
      { id: 'f3-root', type: 'folder', parentId: 'raw', name: 'f3', instrumentType: 'F3' },
      { id: 'edi-root', type: 'folder', parentId: 'raw', name: 'edi', instrumentType: 'EDI' },
      { id: 'emap-root', type: 'folder', parentId: 'raw', name: 'emap', instrumentType: 'EMAP-1' },
      { id: 'f3-line-99', type: 'folder', parentId: 'f3-root', name: 'line99' },
      { id: 'edi-line-99', type: 'folder', parentId: 'edi-root', name: 'L99' },
      { id: 'emap-line-99', type: 'folder', parentId: 'emap-root', name: '测线 99' },
      { id: 'station-file', type: 'file', parentId: 'line-99', name: '@stations', rawFile: createTextFile('@') },
      { id: 'x-1', type: 'file', parentId: 'line-99', name: 'XGEGZ.026' },
      { id: 'index-file', type: 'file', parentId: 'f3-line-99', name: 'line99.idx', rawFile: createBinaryFile() },
      { id: 'edi-file', type: 'file', parentId: 'edi-line-99', name: 'line99.edi', rawFile: createTextFile(ediText) },
      { id: 'mtts-1', type: 'file', parentId: 'emap-line-99', name: '0-10_ex_38400H.mtts', rawFile: createBinaryFile() }
    ];

    const result = await syncDriveSurveyEntries(createBaseProject(), items);

    expect(result.changed).toBe(true);
    const eh4Entry = result.designEntries.find((entry) => entry.instrument === 'EH4');
    expect(eh4Entry).toMatchObject({
      instrument: 'EH4',
      line: '99',
      point: '51750',
      matchedDataCount: 1
    });
  });

  it('uses RX from EH4 @ files as the point code before the station id', async () => {
    parseAtFileMock.mockReturnValue([
      { id: 'GEGZ.027', rxValue: '026', ryValue: '0', z: 4300 }
    ]);

    const items = [
      { id: 'raw', type: 'folder', name: '02_野外采集', category: 'raw' },
      { id: 'eh4-root', type: 'folder', parentId: 'raw', name: 'eh4', instrumentType: 'EH4' },
      { id: 'eh4-folder', type: 'folder', parentId: 'eh4-root', name: 'EH4' },
      { id: 'station-file', type: 'file', parentId: 'eh4-folder', name: '@stations', rawFile: createTextFile('@') },
      { id: 'x-1', type: 'file', parentId: 'eh4-folder', name: 'XGEGZ.027' }
    ];

    const result = await syncDriveSurveyEntries(createBaseProject(), items);

    expect(result.changed).toBe(true);
    expect(result.designEntries[0]).toMatchObject({
      instrument: 'EH4',
      line: '0',
      point: '026',
      matchedDataCount: 1
    });
  });

  it('skips EH4 @ points when neither RY nor an explicit line code is available', async () => {
    parseAtFileMock.mockReturnValue([
      { id: '51750', z: 4300 }
    ]);

    const items = [
      { id: 'raw', type: 'folder', name: '02_野外采集', category: 'raw' },
      { id: 'eh4-root', type: 'folder', parentId: 'raw', name: 'eh4', instrumentType: 'EH4' },
      { id: 'eh4-folder', type: 'folder', parentId: 'eh4-root', name: 'EH4' },
      { id: 'station-file', type: 'file', parentId: 'eh4-folder', name: '@stations', rawFile: createTextFile('@') },
      { id: 'x-1', type: 'file', parentId: 'eh4-folder', name: 'XGEGZ.026' }
    ];

    const result = await syncDriveSurveyEntries(createBaseProject(), items);

    expect(result.changed).toBe(false);
    expect(result.pointCount).toBe(0);
    expect(result.lineCount).toBe(0);
    expect(result.designEntries).toEqual([]);
  });

  it('builds F3 points from index files and matches r/psd/fh files by serial order', async () => {
    parseF3IndexFileMock.mockReturnValue([
      { line: '0', point: '52000', gpsLongitude: 80.7, gpsLatitude: 30.9, gpsElevation: 4200 },
      { line: '0', point: '52025', gpsLongitude: 80.8, gpsLatitude: 31.0, gpsElevation: 4210 }
    ]);

    const items = [
      { id: 'raw', type: 'folder', name: '02_野外采集', category: 'raw' },
      { id: 'f3-root', type: 'folder', parentId: 'raw', name: 'f3', instrumentType: 'F3' },
      { id: 'line-0', type: 'folder', parentId: 'f3-root', name: '测线 0' },
      { id: 'index-file', type: 'file', parentId: 'line-0', name: 'line.idx', rawFile: createBinaryFile() },
      { id: 'r-1', type: 'file', parentId: 'line-0', name: 'line.001.r' },
      { id: 'psd-1', type: 'file', parentId: 'line-0', name: 'line.001.psd' },
      { id: 'fh-1', type: 'file', parentId: 'line-0', name: 'line.001.fh' },
      { id: 'r-2', type: 'file', parentId: 'line-0', name: 'line.002.r' }
    ];

    const result = await syncDriveSurveyEntries(createBaseProject(), items);

    expect(result.pointCount).toBe(2);
    const first = result.designEntries.find((entry) => entry.point === '52000');
    const second = result.designEntries.find((entry) => entry.point === '52025');

    expect(first.instrument).toBe('F3');
    expect(first.matchedDataCount).toBe(3);
    expect(buildPointDataSuffix(first)).toBe('xyz');
    expect(second.matchedDataCount).toBe(1);
    expect(buildPointDataSuffix(second)).toBe('z');
  });

  it('does not treat per-point F3 IDX files as project index sources', async () => {
    parseF3IndexFileMock.mockReturnValue([
      { line: '0', point: '52000', gpsLongitude: 80.7, gpsLatitude: 30.9, gpsElevation: 4200 }
    ]);

    const items = [
      { id: 'raw', type: 'folder', name: 'raw', category: 'raw' },
      { id: 'f3-root', type: 'folder', parentId: 'raw', name: 'f3', instrumentType: 'F3' },
      { id: 'line-0', type: 'folder', parentId: 'f3-root', name: 'line-0' },
      { id: 'index-file', type: 'file', parentId: 'line-0', name: 'GEGZ.ID0031.INDEX', rawFile: createBinaryFile() },
      { id: 'point-idx', type: 'file', parentId: 'line-0', name: 'GEGZ.0033.IDX', rawFile: createBinaryFile() },
      { id: 'r-33', type: 'file', parentId: 'line-0', name: 'GEGZ.0033.R' }
    ];

    const result = await syncDriveSurveyEntries(createBaseProject(), items);

    expect(parseF3IndexFileMock).toHaveBeenCalledTimes(1);
    expect(result.pointCount).toBe(1);
    expect(result.designEntries[0]).toMatchObject({
      instrument: 'F3',
      line: '0',
      point: '52000',
      matchedDataCount: 1
    });
  });

  it('deduplicates duplicate F3 serial files before ordinal point matching', async () => {
    parseF3IndexFileMock.mockReturnValue([
      { line: '0', point: '65700', gpsLongitude: 80.7, gpsLatitude: 30.9, gpsElevation: 4200 },
      { line: '0', point: '65725', gpsLongitude: 80.8, gpsLatitude: 31.0, gpsElevation: 4210 }
    ]);

    const items = [
      { id: 'raw', type: 'folder', name: 'raw', category: 'raw' },
      { id: 'f3-root', type: 'folder', parentId: 'raw', name: 'f3', instrumentType: 'F3' },
      { id: 'line-0', type: 'folder', parentId: 'f3-root', name: 'line-0' },
      { id: 'index-file', type: 'file', parentId: 'line-0', name: 'GEGZ.ID0031.INDEX', rawFile: createBinaryFile() },
      { id: 'r-33-a', type: 'file', parentId: 'line-0', name: 'GEGZ.0033.R' },
      { id: 'r-33-b', type: 'file', parentId: 'line-0', name: 'GEGZ.0033.R' },
      { id: 'r-34', type: 'file', parentId: 'line-0', name: 'GEGZ.0034.R' }
    ];

    const result = await syncDriveSurveyEntries(createBaseProject(), items);
    const first = result.designEntries.find((entry) => entry.point === '65700');
    const second = result.designEntries.find((entry) => entry.point === '65725');

    expect(first.matchedDataPaths.some((path) => path.endsWith('/GEGZ.0033.R'))).toBe(true);
    expect(second.matchedDataPaths).toEqual(['raw/f3/line-0/GEGZ.0034.R']);
  });

  it('matches F3 files once across overlapping index sources', async () => {
    parseF3IndexFileMock
      .mockReturnValueOnce([
        { line: '0', point: '52000', gpsLongitude: 80.7, gpsLatitude: 30.9, gpsElevation: 4200 },
        { line: '0', point: '52025', gpsLongitude: 80.8, gpsLatitude: 31.0, gpsElevation: 4210 }
      ])
      .mockReturnValueOnce([
        { line: '0', point: '52025', gpsLongitude: 80.8, gpsLatitude: 31.0, gpsElevation: 4210 }
      ]);

    const items = [
      { id: 'raw', type: 'folder', name: '02_閲庡閲囬泦', category: 'raw' },
      { id: 'f3-root', type: 'folder', parentId: 'raw', name: 'f3', instrumentType: 'F3' },
      { id: 'line-0', type: 'folder', parentId: 'f3-root', name: '娴嬬嚎 0' },
      { id: 'index-main', type: 'file', parentId: 'line-0', name: 'main.index', rawFile: createBinaryFile() },
      { id: 'index-part', type: 'file', parentId: 'line-0', name: 'part.idx', rawFile: createBinaryFile() },
      { id: 'r-1', type: 'file', parentId: 'line-0', name: 'GEGZ.0026.R' },
      { id: 'psd-1', type: 'file', parentId: 'line-0', name: 'GEGZ.0026.PSD' },
      { id: 'fh-1', type: 'file', parentId: 'line-0', name: 'GEGZ.0026.FH' },
      { id: 'r-2', type: 'file', parentId: 'line-0', name: 'GEGZ.0027.R' }
    ];

    const result = await syncDriveSurveyEntries(createBaseProject(), items);
    const first = result.designEntries.find((entry) => entry.point === '52000');
    const second = result.designEntries.find((entry) => entry.point === '52025');

    expect(first.matchedDataPaths).toEqual([
      '02_閲庡閲囬泦/f3/娴嬬嚎 0/GEGZ.0026.R',
      '02_閲庡閲囬泦/f3/娴嬬嚎 0/GEGZ.0026.PSD',
      '02_閲庡閲囬泦/f3/娴嬬嚎 0/GEGZ.0026.FH'
    ]);
    expect(second.matchedDataPaths).toEqual(['02_閲庡閲囬泦/f3/娴嬬嚎 0/GEGZ.0027.R']);
  });

  it('builds EDI and EMAP-1 points from file headers', async () => {
    parseMTTSHeaderMock.mockImplementation((_buffer, fileName) => ({
      pointNo: fileName.startsWith('0-10') ? '0-10' : '10-20',
      lineNo: '0',
      elevation: 4567,
      surveyHeaderFilename: 'line0'
    }));

    const ediText = `
DATAID=Z_54950.No36
STN=54950
LINE=0
LAT=30.886900
LONG=80.726045
ELEV=4321
`;

    const items = [
      { id: 'raw', type: 'folder', name: '02_野外采集', category: 'raw' },
      { id: 'edi-root', type: 'folder', parentId: 'raw', name: 'edi', instrumentType: 'EDI' },
      { id: 'emap-root', type: 'folder', parentId: 'raw', name: 'emap', instrumentType: 'EMAP-1' },
      { id: 'edi-line', type: 'folder', parentId: 'edi-root', name: '测线 0' },
      { id: 'emap-line', type: 'folder', parentId: 'emap-root', name: '测线 0' },
      { id: 'edi-file', type: 'file', parentId: 'edi-line', name: 'Z_54950.No36.edi', rawFile: createTextFile(ediText) },
      { id: 'mtts-1', type: 'file', parentId: 'emap-line', name: '0-10_ex_38400H.mtts', rawFile: createBinaryFile() },
      { id: 'mtts-2', type: 'file', parentId: 'emap-line', name: '0-10_hy_38400H.mtts', rawFile: createBinaryFile() },
      { id: 'mtts-3', type: 'file', parentId: 'emap-line', name: '10-20_ex_38400H.mtts', rawFile: createBinaryFile() }
    ];

    const result = await syncDriveSurveyEntries(createBaseProject(), items);

    const ediEntry = result.designEntries.find((entry) => entry.instrument === 'EDI');
    const emapEntry = result.designEntries.find((entry) => entry.instrument === 'EMAP-1' && entry.point === '0-10');

    expect(ediEntry).toMatchObject({
      point: '54950',
      line: '0',
      matchedDataCount: 1
    });
    expect(buildPointDataSuffix(ediEntry)).toBe('z');

    expect(emapEntry).toMatchObject({
      line: '0',
      matchedDataCount: 2
    });
    expect(buildPointDataSuffix(emapEntry)).toBe('y');
  });

  it('builds EMAP-1 points from MTTS file names when headers are unavailable', async () => {
    parseMTTSHeaderMock.mockImplementation(() => {
      throw new Error('header unavailable');
    });

    const items = [
      { id: 'raw', type: 'folder', name: '02_野外采集', category: 'raw' },
      { id: 'emap-root', type: 'folder', parentId: 'raw', name: 'EMAP', instrumentType: 'EMAP-1' },
      { id: 'emap-file-1', type: 'file', parentId: 'emap-root', name: '0-10_ex_1200L.mtts', rawFile: createBinaryFile() },
      { id: 'emap-file-2', type: 'file', parentId: 'emap-root', name: '0-10_hy_1200L.mtts', rawFile: createBinaryFile() },
      { id: 'emap-file-3', type: 'file', parentId: 'emap-root', name: '10-20_ex_1200L.mtts', rawFile: createBinaryFile() }
    ];

    const result = await syncDriveSurveyEntries(createBaseProject(), items);
    const first = result.designEntries.find((entry) => entry.point === '0-10');
    const second = result.designEntries.find((entry) => entry.point === '10-20');

    expect(first).toMatchObject({
      instrument: 'EMAP-1',
      line: '0',
      matchedDataCount: 2,
      hasExistingData: true
    });
    expect(first.matchedDataPaths).toEqual([
      '02_野外采集/EMAP/0-10_ex_1200L.mtts',
      '02_野外采集/EMAP/0-10_hy_1200L.mtts'
    ]);
    expect(second).toMatchObject({
      instrument: 'EMAP-1',
      line: '0',
      matchedDataCount: 1
    });
  });

  it('syncs ERT files as line arrangements instead of survey points', async () => {
    const items = [
      { id: 'raw', type: 'folder', name: '02_野外采集', category: 'raw' },
      { id: 'ert-root', type: 'folder', parentId: 'raw', name: '高密度电法', instrumentType: '高密度电法' },
      { id: 'folder-1', type: 'folder', parentId: 'ert-root', name: '1' },
      { id: 'array-a', type: 'file', parentId: 'folder-1', name: 'FS_2.dat', rawFile: createTextFile('0 1 100') },
      { id: 'array-b', type: 'file', parentId: 'folder-1', name: 'FS_3.dat', rawFile: createTextFile('0 1 120') },
      { id: 'array-c', type: 'file', parentId: 'folder-1', name: 'FS-1.dat', rawFile: createTextFile('0 1 130') },
      { id: 'single-array', type: 'file', parentId: 'folder-1', name: 'LineOnly.dat', rawFile: createTextFile('0 1 140') }
    ];

    const result = await syncDriveSurveyEntries(createBaseProject(), items);

    expect(result.lineCount).toBe(2);
    expect(result.pointCount).toBe(0);
    expect(result.designEntries).toHaveLength(4);
    expect(result.designEntries.map((entry) => `${entry.line}:${entry.point}`)).toEqual(['FS:1', 'FS:2', 'FS:3', 'LineOnly:1']);
    result.designEntries.forEach((entry) => {
      expect(entry).toMatchObject({
        instrument: '高密度电法',
        entryKind: 'array',
        matchedDataCount: 1
      });
    });
  });

  it('replaces stored matched paths when files are deleted from the drive', async () => {
    parseAtFileMock.mockReturnValue([
      { id: '51750', line: '0', z: 4300 }
    ]);

    const project = {
      id: 'project-1',
      plan: {
        designEntries: [
          {
            id: 'entry-1',
            instrument: 'EH4',
            line: '0',
            point: '51750',
            sourceCoordFileName: '@stations',
            sourceCoordFileId: 'station-file',
            matchedDataPaths: [
              '02_野外采集/eh4/测线 0/XGEGZ.026',
              '02_野外采集/eh4/测线 0/YGEGZ.026',
              '02_野外采集/eh4/测线 0/ZGEGZ.026'
            ],
            matchedDataCount: 3,
            hasExistingData: true,
            pointStatus: 'matched'
          }
        ]
      }
    };

    const items = [
      { id: 'raw', type: 'folder', name: '02_野外采集', category: 'raw' },
      { id: 'eh4-root', type: 'folder', parentId: 'raw', name: 'eh4', instrumentType: 'EH4' },
      { id: 'line-0', type: 'folder', parentId: 'eh4-root', name: '测线 0' },
      { id: 'station-file', type: 'file', parentId: 'line-0', name: '@stations', rawFile: createTextFile('@') },
      { id: 'x-1', type: 'file', parentId: 'line-0', name: 'XGEGZ.026' }
    ];

    const result = await syncDriveSurveyEntries(project, items);
    const entry = result.designEntries.find((item) => item.point === '51750');

    expect(entry.matchedDataPaths).toEqual(['02_野外采集/eh4/测线 0/XGEGZ.026']);
    expect(entry.matchedDataCount).toBe(1);
    expect(entry.hasExistingData).toBe(true);
    expect(buildPointDataSuffix(entry)).toBe('x');
  });

  it('keeps existing F3 survey points when F3 source files are present but the index is temporarily unreadable', async () => {
    parseF3IndexFileMock.mockReturnValue([]);

    const project = {
      id: 'project-1',
      plan: {
        designEntries: [
          {
            id: 'f3-entry-1',
            instrument: 'F3',
            line: '0',
            point: '54300',
            sourceCoordFileName: 'GEGZ.0026.IDX',
            sourceCoordFileId: 'idx-1',
            matchedDataPaths: [
              '02_野外采集/f3/GEGZ.0026.IDX',
              '02_野外采集/f3/GEGZ.0026.R',
              '02_野外采集/f3/GEGZ.0026.PSD',
              '02_野外采集/f3/GEGZ.0026.FH'
            ],
            matchedDataCount: 4,
            hasExistingData: true,
            pointStatus: 'matched',
            generatedFromDrive: true
          }
        ]
      }
    };

    const items = [
      { id: 'raw', type: 'folder', name: '02_野外采集', category: 'raw' },
      { id: 'f3-root', type: 'folder', parentId: 'raw', name: 'f3', instrumentType: 'F3' },
      { id: 'idx-1', type: 'file', parentId: 'f3-root', name: 'GEGZ.0026.IDX', rawFile: createBinaryFile() },
      { id: 'r-1', type: 'file', parentId: 'f3-root', name: 'GEGZ.0026.R' }
    ];

    const result = await syncDriveSurveyEntries(project, items);

    expect(result.designEntries).toHaveLength(1);
    expect(result.designEntries[0]).toMatchObject({
      instrument: 'F3',
      line: '0',
      point: '54300',
      matchedDataCount: 4,
      hasExistingData: true
    });
  });

  it('removes workbook-imported points because survey entries no longer come from Excel', async () => {
    const project = {
      id: 'project-1',
      plan: {
        designEntries: [
          {
            id: 'entry-1',
            instrument: 'EH4',
            line: '0',
            point: '51750',
            sourceCoordFileName: '设计坐标.xlsx',
            sourceCoordFileId: 'coord-file',
            matchedDataPaths: [
              '02_野外采集/eh4/测线 0/XGEGZ.026',
              '02_野外采集/eh4/测线 0/YGEGZ.026',
              '02_野外采集/eh4/测线 0/ZGEGZ.026'
            ],
            matchedDataCount: 3,
            hasExistingData: true,
            pointStatus: 'matched'
          }
        ]
      }
    };

    const result = await syncDriveSurveyEntries(project, []);
    expect(result.designEntries).toEqual([]);
    expect(result.pointCount).toBe(0);
  });
});
