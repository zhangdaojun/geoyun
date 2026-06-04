import fs from 'fs';
import path from 'path';

// 1. Load project files
const rawData = JSON.parse(fs.readFileSync('scratch/project_files.json', 'utf8'));

// 2. Simulate adaptProjectFile (from adminProjectApi.js)
const adaptProjectFile = (fileItem) => ({
  id: fileItem.file_id || `db_file_${fileItem.id}`,
  parentId: fileItem.parent_id || null,
  type: fileItem.item_type || 'file',
  name: fileItem.name || '未命名文件',
  date: fileItem.date || '',
  size: fileItem.size || '',
  ext: fileItem.ext || null,
  category: fileItem.category || null,
  taskName: fileItem.task_name || '',
  status: fileItem.status || '',
  ...(fileItem.metadata_json || {})
});

const fileSystem = rawData.map(adaptProjectFile);

// 3. Define helper functions (from ERTParser.jsx)
const getSourceStem = (name = 'ert_result') => (
  String(name || 'ert_result').replace(/\.[^.]+$/, '').trim() || 'ert_result'
);

const sourceName = 'E-1.dat';
const sourceStem = getSourceStem(sourceName);

const foldersById = new Map(
  fileSystem
    .filter((item) => item?.type === 'folder')
    .map((item) => [item.id, item])
);

const rootFolderFor = (item) => {
  const parent = foldersById.get(item?.parentId);
  if (parent?.iterationIndex !== undefined || /^第\s*\d+\s*次迭代$/.test(String(parent?.name || ''))) {
    return foldersById.get(parent.parentId) || parent;
  }
  return parent || null;
};

const isSameSource = (item) => (
  String(item?.sourceFileName || '').trim() === sourceName
  || String(item?.source_file_name || '').trim() === sourceName
);

const isLikelySourceFolder = (folder) => {
  const name = String(folder?.name || '');
  return isSameSource(folder) || (
    sourceStem
    && name.startsWith(`${sourceStem}_`)
    && /反演|inversion/i.test(name)
  );
};

// 4. Run grouping logic
console.log('sourceName:', sourceName);
console.log('sourceStem:', sourceStem);

const groups = new Map();
let processedFilesCount = 0;
let resultsFilesCount = 0;

fileSystem.forEach((item) => {
  if (item?.type !== 'file') return;
  if (item?.category === 'results') {
    resultsFilesCount++;
  }
  if (item?.category !== 'results') return;
  
  const rootFolder = rootFolderFor(item);
  if (!rootFolder) {
    return;
  }

  const isSame = isSameSource(item);
  const isLikely = isLikelySourceFolder(rootFolder);
  
  if (!isSame && !isLikely) {
    return;
  }
  
  processedFilesCount++;
  const group = groups.get(rootFolder.id) || { folder: rootFolder, files: [] };
  group.files.push(item);
  groups.set(rootFolder.id, group);
});

console.log('Total files in fileSystem:', fileSystem.length);
console.log('Files with category="results":', resultsFilesCount);
console.log('Files matched and processed into groups:', processedFilesCount);
console.log('Groups found:', groups.size);

for (const [id, group] of groups.entries()) {
  console.log(`\nGroup ID: ${id}`);
  console.log(`Folder Name: ${group.folder.name}`);
  console.log(`Folder metadata.sourceFileName: ${group.folder.sourceFileName}`);
  console.log(`Files count in group: ${group.files.length}`);
  
  const finalNpz = group.files.find((item) => /^simpeg_ert_inversion\.npz$/i.test(String(item?.name || '')));
  const finalVtk = group.files.find((item) => /^resistivity\.vtk$/i.test(String(item?.name || '')));
  console.log(`  Has finalNpz (simpeg_ert_inversion.npz):`, !!finalNpz);
  console.log(`  Has finalVtk (resistivity.vtk):`, !!finalVtk);
}
