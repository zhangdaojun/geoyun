import { ensureCurrentUser } from './accessControl.js';
import { normalizeProjectInvitations } from '../services/memberManagementApi.js';

const defaultPlan = {
  surveyGoal: '',
  surveyScope: '',
  plannedLines: '',
  plannedPoints: '',
  lineSpacing: '',
  pointSpacing: '',
  instrumentModel: '',
  startDate: '',
  endDate: '',
  reviewer: '',
  approvalStatus: '待提交',
  riskControl: '',
  remarks: '',
  completed: false,
  designEntries: [],
  coordParamsConfigured: false,
  coordParams: {
    coordType: 'lonlat',
    lonlatFormat: 'degree',
    centralMeridian: 102,
    latOrigin: 0,
    falseEasting: 500000,
    falseNorthing: 0,
    scale: 1
  }
};

const folderBlueprints = [
  { key: 'design', name: '01_方案设计', taskName: '方案规划' },
  { key: 'raw', name: '02_野外采集', taskName: '野外采集' },
  { key: 'processed', name: '03_处理解释', taskName: '数据质控' },
  { key: 'results', name: '04_反演成果', taskName: '成果解算' },
  { key: 'qc', name: '05_质量控制', taskName: '数据质控' },
  { key: 'docs', name: '06_项目资料', taskName: '方案规划' }
];

const taskBlueprints = [
  { key: 'planning', name: '方案规划', category: 'design', ownerType: 'manager' },
  { key: 'acquisition', name: '野外采集', category: 'raw', ownerType: 'manager' },
  { key: 'qc', name: '数据质控', category: 'qc', ownerType: 'system' },
  { key: 'result', name: '成果解算', category: 'results', ownerType: 'system' }
];

const projectRoleSet = new Set(['owner', 'manager', 'operator', 'reviewer', 'viewer']);

const normalizeProjectMember = (member, index = 0) => {
  const role = projectRoleSet.has(member?.projectRole) ? member.projectRole : 'viewer';
  const status = member?.status === 'pending' ? 'pending' : 'active';
  return {
    id: member?.id || `member_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
    userId: member?.userId || '',
    name: member?.name || '',
    account: member?.account || '',
    projectRole: role,
    status,
    invitedAt: member?.invitedAt || new Date().toLocaleString(),
    invitedBy: member?.invitedBy || '',
    joinedAt: member?.joinedAt || (status === 'active' ? (member?.joinedAt || new Date().toLocaleString()) : '')
  };
};

const ensureProjectMembers = (project) => {
  const source = Array.isArray(project?.projectMembers) ? project.projectMembers : [];
  const seenUserIds = new Set();
  const members = source
    .map((member, index) => normalizeProjectMember(member, index))
    .filter((member) => {
      if (!member.userId) return false;
      if (seenUserIds.has(member.userId)) return false;
      seenUserIds.add(member.userId);
      return true;
    });
  if (!members.length && project?.createdByUserId) {
    return [normalizeProjectMember({
      userId: project.createdByUserId,
      name: project.createdByName || '',
      account: project.createdByAccount || '',
      projectRole: 'owner',
      status: 'active',
      invitedBy: project.createdByName || '',
      joinedAt: project.createdAt || new Date().toLocaleString(),
      invitedAt: project.createdAt || new Date().toLocaleString()
    })];
  }
  return members;
};

const resolveProjectManager = (project) => {
  const members = ensureProjectMembers(project);
  const owner = members.find(member => member.projectRole === 'owner' && member.status !== 'pending');
  if (owner?.name) return owner.name;
  const manager = members.find(member => member.projectRole === 'manager' && member.status !== 'pending');
  if (manager?.name) return manager.name;
  return project?.manager || project?.createdByName || '未指定';
};

const resolveProjectName = (project = {}) => {
  const rawName = String(project?.name || '').trim();
  if (!rawName) {
    return project?.id ? `项目 ${project.id}` : '未命名项目';
  }
  if (/^[?？\uFFFD\s._-]+$/u.test(rawName)) {
    return project?.id ? `项目 ${project.id}` : '未命名项目';
  }
  return rawName;
};

const getValidDesignCoords = (project) => {
  return (project?.plan?.designEntries || [])
    .map(entry => ({
      lat: Number(entry?.gpsLatitude),
      lng: Number(entry?.gpsLongitude)
    }))
    .filter(entry => Number.isFinite(entry.lat) && Number.isFinite(entry.lng));
};

const DEFAULT_PROJECT_CENTER = [35.86166, 104.195397];

const isValidLatLng = (value) => (
  Array.isArray(value)
  && value.length >= 2
  && Number.isFinite(Number(value[0]))
  && Number.isFinite(Number(value[1]))
);

const sanitizeLatLng = (value, fallback = DEFAULT_PROJECT_CENTER) => {
  if (isValidLatLng(value)) {
    return [Number(value[0]), Number(value[1])];
  }
  return [...fallback];
};

const sanitizeAreaCoords = (value, fallbackCenter = DEFAULT_PROJECT_CENTER) => {
  const nextAreaCoords = Array.isArray(value)
    ? value
      .filter(item => isValidLatLng(item))
      .map(item => [Number(item[0]), Number(item[1])])
    : [];

  if (nextAreaCoords.length >= 3) {
    return nextAreaCoords;
  }

  const [lat, lng] = sanitizeLatLng(fallbackCenter);
  return [
    [Number((lat + 0.1).toFixed(6)), Number((lng - 0.1).toFixed(6))],
    [Number((lat + 0.1).toFixed(6)), Number((lng + 0.1).toFixed(6))],
    [Number((lat - 0.1).toFixed(6)), Number((lng + 0.1).toFixed(6))],
    [Number((lat - 0.1).toFixed(6)), Number((lng - 0.1).toFixed(6))]
  ];
};

const deriveProjectSpatialShape = (project) => {
  const coords = getValidDesignCoords(project);
  if (!coords.length) {
    const nextCoords = sanitizeLatLng(project?.coords, DEFAULT_PROJECT_CENTER);
    return {
      coords: nextCoords,
      areaCoords: sanitizeAreaCoords(project?.areaCoords, nextCoords)
    };
  }
  const avgLat = coords.reduce((sum, item) => sum + item.lat, 0) / coords.length;
  const avgLng = coords.reduce((sum, item) => sum + item.lng, 0) / coords.length;
  const latValues = coords.map(item => item.lat);
  const lngValues = coords.map(item => item.lng);
  const minLat = Math.min(...latValues);
  const maxLat = Math.max(...latValues);
  const minLng = Math.min(...lngValues);
  const maxLng = Math.max(...lngValues);
  const latPadding = Math.max((maxLat - minLat) * 0.12, 0.0008);
  const lngPadding = Math.max((maxLng - minLng) * 0.12, 0.0008);
  const nextAreaCoords = [
    [minLat - latPadding, minLng - lngPadding],
    [minLat - latPadding, maxLng + lngPadding],
    [maxLat + latPadding, maxLng + lngPadding],
    [maxLat + latPadding, minLng - lngPadding]
  ];
  return {
    coords: [Number(avgLat.toFixed(6)), Number(avgLng.toFixed(6))],
    areaCoords: nextAreaCoords.map(item => item.map(value => Number(value.toFixed(6))))
  };
};

const buildLogEntry = ({ project, nodeId = 'storage', nodeName = '成果入库节点', level = 'info', title, detail, actor }) => {
  const nextActor = actor ? ensureCurrentUser(actor) : null;
  return {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    nodeId,
    nodeName,
    level,
    time: new Date().toLocaleString(),
    title,
    detail,
    nodeStatus: '--',
    projectId: project.id,
    actorName: nextActor?.name || ''
  };
};

const appendProjectLog = (project, log) => {
  const nextLogs = [log, ...(project.activityLogs || [])].slice(0, 50);
  return {
    ...project,
    activityLogs: nextLogs
  };
};

const buildDefaultCloudItems = (project) => {
  const baseDate = project.lastUpdate || new Date().toISOString().slice(0, 10);
  const prefix = project.id.toLowerCase().replace(/[^a-z0-9]/g, '');
  return [
    ...folderBlueprints.map(folder => ({
      id: `${project.id}_${folder.key}`,
      parentId: null,
      type: 'folder',
      name: folder.name,
      date: baseDate,
      size: '--',
      ext: null,
      category: folder.key,
      taskName: folder.taskName
    })),
    { id: `${project.id}_design_xls`, parentId: `${project.id}_design`, type: 'file', name: `${project.name}设计坐标.xlsx`, date: baseDate, size: '0.18 MB', ext: 'code', category: 'design' },
    { id: `${project.id}_plan_doc`, parentId: `${project.id}_docs`, type: 'file', name: `${project.name}_任务书.pdf`, date: baseDate, size: '0.82 MB', ext: 'doc', category: 'docs' },
    { id: `${project.id}_meta`, parentId: `${project.id}_docs`, type: 'file', name: `${prefix}_manifest.json`, date: baseDate, size: '0.04 MB', ext: 'code', category: 'docs' }
  ];
};

export const deriveProjectFiles = (project) => {
  return (project?.cloudData?.items || []).filter(item => item.type === 'file');
};

const resolveActualFolderId = (project, folderConfig) => {
  const items = project?.cloudData?.items || [];
  return items.find(item =>
    item.type === 'folder' && (
      item.id === `${project.id}_${folderConfig.key}` ||
      item.category === folderConfig.key ||
      item.taskName === folderConfig.taskName ||
      item.name === folderConfig.name
    )
  )?.id || `${project.id}_${folderConfig.key}`;
};

export const deriveProjectTasks = (project) => {
  const files = deriveProjectFiles(project);
  const plan = project.plan || defaultPlan;
  const designCount = (plan.designEntries || []).length;
  const rawCount = files.filter(file => file.category === 'raw').length;
  const qcCount = files.filter(file => file.category === 'qc' || file.status === '质控完成').length;
  const resultCount = files.filter(file => file.category === 'results' || file.status === '解算完成').length;
  const metricsMap = {
    design: {
      count: designCount,
      status: plan.completed ? '已完成' : (designCount > 0 ? '进行中' : '待开始'),
      countText: `${designCount} 个设计点`
    },
    raw: {
      count: rawCount,
      status: rawCount > 0 ? '进行中' : '待开始',
      countText: `${rawCount} 个采集文件`
    },
    qc: {
      count: qcCount,
      status: qcCount > 0 ? '进行中' : '待开始',
      countText: `${qcCount} 个质控成果`
    },
    results: {
      count: resultCount,
      status: resultCount > 0 ? '进行中' : '待开始',
      countText: `${resultCount} 个成果文件`
    }
  };

  return taskBlueprints.map(task => {
    const folder = folderBlueprints.find(folderItem => folderItem.key === task.category);
    const relatedFolderId = folder ? resolveActualFolderId(project, folder) : `${project.id}_${task.category}`;
    const metric = metricsMap[task.category] || { count: 0, status: '待开始', countText: '0' };
    const existingTask = (project.tasks || []).find(item => item.name === task.name) || {};
    return {
      id: `${project.id}_task_${task.key}`,
      name: task.name,
      owner: existingTask.owner || (task.ownerType === 'manager' ? project.manager : `云端${task.name}节点`),
      status: existingTask.status || metric.status,
      relatedFolder: folder?.name || '',
      relatedFolderId,
      category: task.category,
      countText: metric.countText,
      description: existingTask.description || `${task.name}对应目录：${folder?.name || '--'}`,
      updatedAt: existingTask.updatedAt || project.lastUpdate
    };
  });
};

export const ensureProjectShape = (project) => {
  const cloudItems = project?.cloudData?.items?.length ? project.cloudData.items : buildDefaultCloudItems(project);
  const spatialShape = deriveProjectSpatialShape(project);
  const projectMembers = ensureProjectMembers(project);
  const projectInvitations = normalizeProjectInvitations(project?.projectInvitations || []);
  const managerName = resolveProjectManager({ ...project, projectMembers });
  const projectName = resolveProjectName(project);
  const nextProject = {
    ...project,
    name: projectName,
    createdAt: project?.createdAt || new Date().toLocaleString(),
    createdByUserId: project?.createdByUserId || '',
    createdByName: project?.createdByName || '',
    createdByAccount: project?.createdByAccount || '',
    manager: managerName,
    projectMembers,
    projectInvitations,
    coords: spatialShape.coords,
    areaCoords: spatialShape.areaCoords,
    plan: { ...defaultPlan, ...(project.plan || {}) },
    cloudData: {
      projectId: project.id,
      items: cloudItems,
      taskFolders: folderBlueprints.reduce((acc, folder) => {
        acc[folder.taskName] = resolveActualFolderId({ ...project, cloudData: { ...(project.cloudData || {}), items: cloudItems } }, folder);
        return acc;
      }, {})
    }
  };
  const tasks = deriveProjectTasks(nextProject);
  const completedCount = tasks.filter(task => task.status === '已完成').length;
  const runningCount = tasks.filter(task => task.status === '进行中').length;
  const derivedStatus = completedCount === tasks.length && tasks.length > 0 ? '已完成' : (runningCount > 0 ? '执行中' : (project.status || '规划中'));
  return {
    ...nextProject,
    tasks,
    activityLogs: project.activityLogs || [],
    status: derivedStatus
  };
};

export const updateProjectWithCloudItems = (project, items, options = {}) => {
  let nextProject = {
    ...project,
    lastUpdate: new Date().toLocaleString(),
    cloudData: {
      ...(project.cloudData || {}),
      projectId: project.id,
      items
    }
  };
  if (options.log) {
    nextProject = appendProjectLog(nextProject, buildLogEntry({
      project,
      nodeId: options.nodeId || 'storage',
      nodeName: options.nodeName || '成果入库节点',
      level: options.level || 'info',
      title: options.title,
      detail: options.detail,
      actor: options.actor
    }));
  }
  return ensureProjectShape(nextProject);
};

export const updateProjectWithTask = (project, taskPatch, options = {}) => {
  const prevTask = (project.tasks || []).find(task => task.id === taskPatch.id);
  let nextProject = {
    ...project,
    lastUpdate: new Date().toLocaleString(),
    tasks: (project.tasks || []).map(task => task.id === taskPatch.id ? { ...task, ...taskPatch, updatedAt: new Date().toLocaleString() } : task)
  };
  if (prevTask) {
    const changedFields = [];
    if (prevTask.status !== taskPatch.status) changedFields.push(`状态由“${prevTask.status}”调整为“${taskPatch.status}”`);
    if (prevTask.owner !== taskPatch.owner) changedFields.push(`负责人更新为 ${taskPatch.owner}`);
    if (changedFields.length) {
      nextProject = appendProjectLog(nextProject, buildLogEntry({
        project,
        nodeId: taskPatch.category === 'raw' ? 'collector' : taskPatch.category === 'qc' ? 'qc' : taskPatch.category === 'results' ? 'solver' : 'storage',
        nodeName: `${taskPatch.name}任务`,
        level: taskPatch.status === '已完成' ? 'success' : 'info',
        title: `${taskPatch.name}任务已更新`,
        detail: changedFields.join('；'),
        actor: options.actor
      }));
    }
  }
  return ensureProjectShape(nextProject);
};

export const updateProjectWithPlan = (project, planPatch, options = {}) => {
  const prevPlan = project.plan || defaultPlan;
  const nextPlan = { ...prevPlan, ...(planPatch || {}), updatedAt: new Date().toLocaleString() };
  let nextProject = {
    ...project,
    lastUpdate: new Date().toLocaleString(),
    plan: nextPlan
  };
  const changedFields = [];
  if (prevPlan.completed !== nextPlan.completed) changedFields.push(nextPlan.completed ? '方案规划已标记完成' : '方案规划重新打开编辑');
  if (String(prevPlan.plannedLines || '') !== String(nextPlan.plannedLines || '')) changedFields.push(`计划测线更新为 ${nextPlan.plannedLines || 0} 条`);
  if (String(prevPlan.plannedPoints || '') !== String(nextPlan.plannedPoints || '')) changedFields.push(`计划测点更新为 ${nextPlan.plannedPoints || 0} 个`);
  if ((prevPlan.designEntries || []).length !== (nextPlan.designEntries || []).length) changedFields.push(`设计点数量调整为 ${(nextPlan.designEntries || []).length} 个`);
  if (prevPlan.surveyGoal !== nextPlan.surveyGoal) changedFields.push('勘查目标已更新');
  if (prevPlan.surveyScope !== nextPlan.surveyScope) changedFields.push('测区范围已更新');
  if (prevPlan.instrumentModel !== nextPlan.instrumentModel) changedFields.push('仪器配置已更新');
  if (changedFields.length) {
    nextProject = appendProjectLog(nextProject, buildLogEntry({
      project,
      nodeId: 'planning',
      nodeName: '方案规划',
      level: nextPlan.completed ? 'success' : 'info',
      title: '方案规划已更新',
      detail: changedFields.join('；'),
      actor: options.actor
    }));
  }
  return ensureProjectShape(nextProject);
};

export const updateProjectWithMembers = (project, members, options = {}) => {
  const nextMembers = (Array.isArray(members) ? members : []).map((member, index) => normalizeProjectMember(member, index));
  const prevMembers = ensureProjectMembers(project);
  const changedUsers = new Set();
  nextMembers.forEach((member) => {
    const prev = prevMembers.find(item => item.userId === member.userId);
    if (!prev || prev.projectRole !== member.projectRole || prev.status !== member.status) {
      changedUsers.add(member.userId);
    }
  });
  prevMembers.forEach((member) => {
    if (!nextMembers.some(item => item.userId === member.userId)) changedUsers.add(member.userId);
  });
  let nextProject = {
    ...project,
    lastUpdate: new Date().toLocaleString(),
    projectMembers: nextMembers
  };
  if (changedUsers.size) {
    nextProject = appendProjectLog(nextProject, buildLogEntry({
      project,
      nodeId: 'planning',
      nodeName: '项目成员管理',
      level: 'info',
      title: '更新项目成员',
      detail: `已调整 ${changedUsers.size} 位成员的项目角色或状态`,
      actor: options.actor
    }));
  }
  return ensureProjectShape(nextProject);
};

export const updateProjectWithInvitations = (project, invitations, options = {}) => {
  const nextInvitations = normalizeProjectInvitations(invitations || []);
  let nextProject = {
    ...project,
    lastUpdate: new Date().toLocaleString(),
    projectInvitations: nextInvitations
  };
  if (options.logTitle) {
    nextProject = appendProjectLog(nextProject, buildLogEntry({
      project,
      nodeId: 'planning',
      nodeName: '成员邀请管理',
      level: options.level || 'info',
      title: options.logTitle,
      detail: options.logDetail || '项目成员邀请信息已更新',
      actor: options.actor
    }));
  }
  return ensureProjectShape(nextProject);
};

export const resolveTaskByFolderId = (project, folderId) => {
  return (project?.tasks || []).find(task => task.relatedFolderId === folderId) || null;
};

export const resolveFolderIdByTaskName = (project, taskName) => {
  return project?.cloudData?.taskFolders?.[taskName] || null;
};

export const updateProjectWithNavigationLog = (project, folderName, taskName = '', options = {}) => {
  return ensureProjectShape(appendProjectLog(project, buildLogEntry({
    project,
    nodeId: taskName === '野外采集' ? 'collector' : taskName === '数据质控' ? 'qc' : taskName === '成果解算' ? 'solver' : 'storage',
    nodeName: taskName ? `${taskName}任务` : '云盘目录',
    level: 'info',
    title: `进入目录：${folderName || '项目根目录'}`,
    detail: taskName ? `已切换到“${taskName}”关联目录。` : '已切换到项目云盘目录。',
    actor: options.actor
  })));
};
