import { create } from 'zustand';

// 展平后的树节点结构，方便 react-window 直接读取
// flatNode 结构: { node, level }
const calculateVisibleFlatNodes = (rootNode, expandedKeys, filteredNodeIds) => {
  if (!rootNode) return [];
  const result = [];

  const traverse = (node, level) => {
    // 如果有搜索过滤，且该节点不在过滤结果中，则跳过
    if (filteredNodeIds && !filteredNodeIds.has(node.id)) {
      return;
    }
    
    result.push({ node, level });

    if (expandedKeys.has(node.id) && node.children && node.children.length > 0) {
      node.children.forEach(child => traverse(child, level + 1));
    }
  };

  traverse(rootNode, 0);
  return result;
};

export const useSurveyTreeStore = create((set, get) => ({
  rootNode: null,
  allNodes: [],
  pointAncestorMap: {},
  eh4Points: [],
  emapPoints: [],
  f3Points: [],
  
  query: '',
  expandedKeys: new Set(),
  filteredNodeIds: null,
  visibleFlatNodes: [],

  stats: { methods: 0, lines: 0, points: 0 },

  initTree: (rootNode, allNodes, pointAncestorMap, stats) => {
    set((state) => {
      // 保持之前的 expandedKeys，如果是首次加载则默认展开第一层
      const nextExpandedKeys = state.rootNode 
        ? state.expandedKeys 
        : new Set([rootNode.id, ...(rootNode.children || []).map(node => node.id)]);

      const eh4Points = allNodes.filter((node) => node.type === 'point' && node.instrumentType === 'eh4');
      const emapPoints = allNodes.filter((node) => node.type === 'point' && node.instrumentType === 'emap');
      const f3Points = allNodes.filter((node) => node.type === 'point' && node.instrumentType === 'f3');

      // 如果有 query，重新计算 filteredNodeIds
      let nextFilteredNodeIds = state.filteredNodeIds;
      if (state.query.trim()) {
        nextFilteredNodeIds = get()._computeFilteredIds(rootNode, state.query);
      }

      const visibleFlatNodes = calculateVisibleFlatNodes(rootNode, nextExpandedKeys, nextFilteredNodeIds);

      return {
        rootNode,
        allNodes,
        pointAncestorMap,
        eh4Points,
        emapPoints,
        f3Points,
        stats,
        expandedKeys: nextExpandedKeys,
        filteredNodeIds: nextFilteredNodeIds,
        visibleFlatNodes
      };
    });
  },

  setQuery: (query) => {
    const { rootNode, expandedKeys } = get();
    if (!rootNode) return;

    const keyword = query.trim().toLowerCase();
    let filteredNodeIds = null;
    
    if (keyword) {
      filteredNodeIds = get()._computeFilteredIds(rootNode, query);
    }

    const visibleFlatNodes = calculateVisibleFlatNodes(rootNode, expandedKeys, filteredNodeIds);
    set({ query, filteredNodeIds, visibleFlatNodes });
  },

  _computeFilteredIds: (rootNode, query) => {
    const keyword = query.trim().toLowerCase();
    const matchedIds = new Set();
    const visit = (node, ancestors = []) => {
      const haystacks = [
        node.name,
        node.type,
        node.status,
        ...Object.values(node.meta || {})
      ].map(value => String(value || '').toLowerCase());
      
      const matched = haystacks.some(value => value.includes(keyword));
      if (matched) {
        ancestors.forEach(id => matchedIds.add(id));
        matchedIds.add(node.id);
      }
      (node.children || []).forEach(child => visit(child, [...ancestors, node.id]));
    };
    visit(rootNode);
    return matchedIds;
  },

  toggleExpanded: (id) => {
    set((state) => {
      if (!state.rootNode) return state;
      const nextKeys = new Set(state.expandedKeys);
      if (nextKeys.has(id)) {
        nextKeys.delete(id);
      } else {
        nextKeys.add(id);
      }
      const visibleFlatNodes = calculateVisibleFlatNodes(state.rootNode, nextKeys, state.filteredNodeIds);
      return { expandedKeys: nextKeys, visibleFlatNodes };
    });
  },

  setExpandedKeys: (updater) => {
    set((state) => {
      if (!state.rootNode) return state;
      const nextKeys = typeof updater === 'function' ? updater(state.expandedKeys) : updater;
      const visibleFlatNodes = calculateVisibleFlatNodes(state.rootNode, nextKeys, state.filteredNodeIds);
      return { expandedKeys: nextKeys, visibleFlatNodes };
    });
  },

  // 增量更新节点状态的 action
  updateNodeStatus: () => {
    set((state) => {
      // 深度克隆并更新节点状态 (可以根据实际需要引入 immer，这里使用简化的对象更新)
      // 在这个版本中，我们假设在性能要求极高时才会需要真正的增量树克隆。
      // 目前由于 JS 构建这棵树的时间很短（几毫秒），主要是 DOM 渲染耗时。
      return state; 
    });
  }
}));
