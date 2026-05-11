import { useMemo } from 'react';

export const useGlobalSearch = ({
  appSettings,
  projectsList,
  globalSearchTerm,
  setGlobalSearchTerm,
  setSelectedProject,
  setPendingDriveFolderId,
  navigate
}) => {
  const globalSearchResults = useMemo(() => {
    const keyword = globalSearchTerm.trim().toLowerCase();
    if (!keyword) return [];
    const results = [];

    projectsList.forEach((project) => {
      const matchProject = [project.name, project.location, project.manager, project.method, project.status]
        .some(value => String(value || '').toLowerCase().includes(keyword));
      if (appSettings.searchScopes.project && matchProject) {
        results.push({
          id: `project_${project.id}`,
          type: 'project',
          title: project.name,
          subtitle: `${project.location} / ${project.method}`,
          projectId: project.id
        });
      }

      if (appSettings.searchScopes.task) (project.tasks || []).forEach((task) => {
        if ([task.name, task.owner, task.relatedFolder, task.status].some(value => String(value || '').toLowerCase().includes(keyword))) {
          results.push({
            id: `task_${task.id}`,
            type: 'task',
            title: `${task.name} / ${project.name}`,
            subtitle: `${task.status} / ${task.relatedFolder}`,
            projectId: project.id,
            folderId: task.relatedFolderId
          });
        }
      });

      if (appSettings.searchScopes.cloud) (project.cloudData?.items || []).forEach((item) => {
        if ([item.name, item.category, item.taskName, item.type].some(value => String(value || '').toLowerCase().includes(keyword))) {
          results.push({
            id: `file_${project.id}_${item.id}`,
            type: item.type === 'folder' ? 'folder' : 'file',
            title: `${item.name} / ${project.name}`,
            subtitle: `${item.type === 'folder' ? '云盘目录' : '云盘文件'}${item.taskName ? ` / ${item.taskName}` : ''}`,
            projectId: project.id,
            folderId: item.type === 'folder' ? item.id : item.parentId
          });
        }
      });

      if (appSettings.searchScopes.point) (project.plan?.designEntries || []).forEach((entry) => {
        if ([entry.line, entry.point, entry.instrument, project.name].some(value => String(value || '').toLowerCase().includes(keyword))) {
          results.push({
            id: `point_${entry.id || `${project.id}_${entry.line}_${entry.point}`}`,
            type: 'point',
            title: `${project.name} / 测线 ${entry.line || '--'} / 测点 ${entry.point || '--'}`,
            subtitle: `${entry.instrument || project.method} / ${entry.source || '方案规划'}`,
            projectId: project.id
          });
        }
      });
    });

    return results.slice(0, 16);
  }, [
    appSettings.searchScopes.cloud,
    appSettings.searchScopes.point,
    appSettings.searchScopes.project,
    appSettings.searchScopes.task,
    globalSearchTerm,
    projectsList
  ]);

  const handleSearchSelect = (result) => {
    if (!result) return;
    const targetProject = projectsList.find(project => project.id === result.projectId) || null;
    if (targetProject) setSelectedProject(targetProject);
    if (result.type === 'file' || result.type === 'folder' || result.type === 'task') {
      setPendingDriveFolderId(result.folderId || null);
      if (navigate) navigate(`/projects/${result.projectId}/data`);
    } else {
      setPendingDriveFolderId(null);
      if (navigate) navigate(`/projects/${result.projectId}`);
    }
    setGlobalSearchTerm('');
  };

  return {
    globalSearchTerm,
    setGlobalSearchTerm,
    globalSearchResults,
    handleSearchSelect
  };
};
