export const defaultAppSettings = {
  archiveRules: {
    designKeywords: '设计坐标,coord,coords,xls,xlsx',
    rawKeywords: 'edi,mt,@,x,y,z,f3,idx,index,r,psd,fh,fm,fl',
    qcKeywords: 'qc,质控',
    resultKeywords: 'vtk',
    docsKeywords: 'pdf,doc,docx,json',
    autoOpenSingleTarget: true
  },
  backupPolicy: {
    defaultMode: 'full',
    keepHistoryCount: 8
  },
  searchScopes: {
    project: true,
    task: true,
    cloud: true,
    point: true
  }
};

export const ensureAppSettings = (settings) => ({
  ...defaultAppSettings,
  ...(settings || {}),
  archiveRules: {
    ...defaultAppSettings.archiveRules,
    ...(settings?.archiveRules || {})
  },
  backupPolicy: {
    ...defaultAppSettings.backupPolicy,
    ...(settings?.backupPolicy || {})
  },
  searchScopes: {
    ...defaultAppSettings.searchScopes,
    ...(settings?.searchScopes || {})
  }
});
