const fs = require('fs');
let content = fs.readFileSync('src/components/SurveyDataTree.jsx', 'utf8');

content = content.replace(/import \{ FixedSizeList as List \} from 'react-window';/, `import reactWindow from 'react-window';
const { FixedSizeList: List } = reactWindow;`);

content = content.replace(/import AutoSizer from 'react-virtualized-auto-sizer';/, `import AutoSizerPkg from 'react-virtualized-auto-sizer';
const AutoSizer = AutoSizerPkg.default || AutoSizerPkg;`);

fs.writeFileSync('src/components/SurveyDataTree.jsx', content);
