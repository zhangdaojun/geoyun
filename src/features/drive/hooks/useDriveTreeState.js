import { useEffect, useMemo, useState } from 'react';
import { resolveTaskByFolderId } from '../../../utils/projectModel';
import { parseMTTSDisplayMeta } from '../driveFileRules';

export const useDriveTreeState = ({
  selectedProject,
  fileSystem,
  initialFolderId
}) => {
  const [currentFolderId, setCurrentFolderId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    const nextFolderId = selectedProject?.id && initialFolderId ? initialFolderId : null;
    const timer = window.setTimeout(() => {
      setCurrentFolderId(nextFolderId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedProject?.id, initialFolderId]);

  const currentFolder = useMemo(
    () => fileSystem.find(item => item.id === currentFolderId) || null,
    [currentFolderId, fileSystem]
  );

  const currentTask = useMemo(
    () => (currentFolder ? resolveTaskByFolderId(selectedProject, currentFolder.id) : null),
    [currentFolder, selectedProject]
  );

  const breadcrumbs = useMemo(() => {
    const crumbs = [];
    let curr = currentFolderId;
    while (curr) {
      const folder = fileSystem.find(item => item.id === curr);
      if (!folder) break;
      crumbs.unshift({ id: folder.id, name: folder.name });
      curr = folder.parentId;
    }
    return [{ id: null, name: `${selectedProject?.name || '项目'} 云盘` }, ...crumbs];
  }, [currentFolderId, fileSystem, selectedProject?.name]);

  const currentItems = useMemo(() => (
    fileSystem
      .filter(item =>
        item.parentId === currentFolderId &&
        (searchTerm === '' || item.name.toLowerCase().includes(searchTerm.toLowerCase()))
      )
      .sort((a, b) => {
        if (a.type === 'folder' && b.type === 'file') return -1;
        if (a.type === 'file' && b.type === 'folder') return 1;
        return a.name.localeCompare(b.name);
      })
  ), [currentFolderId, fileSystem, searchTerm]);

  const displayItems = useMemo(() => {
    const grouped = [];
    const mttsGroups = new Map();
    currentItems.forEach((item) => {
      const meta = item.type === 'file' ? parseMTTSDisplayMeta(item.name) : null;
      if (!meta) {
        grouped.push(item);
        return;
      }
      const existing = mttsGroups.get(meta.pointNo);
      if (existing) {
        existing.files.push({ ...item, mttsMeta: meta });
        return;
      }
      const groupItem = {
        id: `mtts-group:${currentFolderId || 'root'}:${meta.pointNo}`,
        type: 'mtts-group',
        name: meta.pointNo,
        date: item.date,
        size: '1 个文件',
        pointNo: meta.pointNo,
        files: [{ ...item, mttsMeta: meta }]
      };
      mttsGroups.set(meta.pointNo, groupItem);
      grouped.push(groupItem);
    });
    return grouped.map((item) => {
      if (item.type !== 'mtts-group') return item;
      const sortedFiles = [...item.files].sort((a, b) => {
        const aRate = a.mttsMeta?.sampleRateTag || '';
        const bRate = b.mttsMeta?.sampleRateTag || '';
        const rateCompare = aRate.localeCompare(bRate, undefined, { numeric: true, sensitivity: 'base' });
        if (rateCompare !== 0) return rateCompare;
        return (a.mttsMeta?.channel || '').localeCompare(b.mttsMeta?.channel || '', undefined, { sensitivity: 'base' });
      });
      return {
        ...item,
        files: sortedFiles,
        date: sortedFiles[0]?.date || item.date,
        size: `${sortedFiles.length} 个文件`
      };
    });
  }, [currentFolderId, currentItems]);

  const navigateToFolder = (folderId) => {
    setCurrentFolderId(folderId);
    setSearchTerm('');
  };

  return {
    breadcrumbs,
    currentFolder,
    currentFolderId,
    currentItems,
    currentTask,
    displayItems,
    navigateToFolder,
    searchTerm,
    setCurrentFolderId,
    setSearchTerm
  };
};
