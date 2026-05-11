const fs = require('fs');

let content = fs.readFileSync('src/components/SurveyDataTree.jsx', 'utf8');

const regex = /<div style={{ flex: 1, overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '12px', background: '#fff' }}>[\s\S]*?未找到匹配的数据树节点<\/div>\s*\)\s*}\s*<\/div>/;

const newRenderStr = `<div style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: '12px', background: '#fff', overflow: 'hidden' }}>
          {visibleFlatNodes.length > 0 ? (
            <AutoSizer>
              {({ height, width }) => (
                <List
                  height={height}
                  itemCount={visibleFlatNodes.length}
                  itemSize={56}
                  width={width}
                  itemData={{ visibleFlatNodes, expandedKeys, onToggle: toggleExpanded, selectedId: selectedNode?.id, onSelect: handleSelectNode }}
                >
                  {TreeRow}
                </List>
              )}
            </AutoSizer>
          ) : (
            <div style={{ padding: '40px 16px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>未找到匹配的数据树节点</div>
          )}
        </div>`;

content = content.replace(regex, newRenderStr);
fs.writeFileSync('src/components/SurveyDataTree.jsx', content);
