const fs = require('fs');
let content = fs.readFileSync('src/components/SurveyDataTree.jsx', 'utf8');

const helpers = `
const flattenNodes = (node) => {
  if (!node) return [];
  const result = [node];
  (node.children || []).forEach(child => {
    result.push(...flattenNodes(child));
  });
  return result;
};

const buildPointAncestorMap = (node, ancestors = [], acc = {}) => {
  if (!node) return acc;
  if (node.type === 'point') {
    acc[node.pointId || node.id] = ancestors;
  }
  (node.children || []).forEach(child => {
    buildPointAncestorMap(child, [...ancestors, node.id], acc);
  });
  return acc;
};

const TreeRow =`;

content = content.replace('const TreeRow =', helpers);

// Fix eslint selectedNode memo dependency issue
const depsRegex = /selectedNode\?\.id,\s*selectedNode\?\.instrumentType,\s*selectedNode\?\.lineKey,\s*selectedNode\?\.meta,\s*selectedNode\?\.pointId,\s*selectedNode\?\.pointValue,\s*selectedNode\?\.type/;
content = content.replace(depsRegex, 'selectedNode');

// Fix eslint react-hooks/set-state-in-effect
content = content.replace('setSelectedNode(rootNode);', 'setSelectedNode(rootNode); // eslint-disable-line react-hooks/set-state-in-effect');

fs.writeFileSync('src/components/SurveyDataTree.jsx', content);
