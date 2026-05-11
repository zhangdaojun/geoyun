const fs = require('fs');
let content = fs.readFileSync('src/components/SurveyDataTree.jsx', 'utf8');

content = content.replace(/import reactWindow from 'react-window';\r?\nconst \{ FixedSizeList: List \} = reactWindow;/, `import * as reactWindow from 'react-window';
const { FixedSizeList: List } = reactWindow;`);

content = content.replace(/import AutoSizerPkg from 'react-virtualized-auto-sizer';\r?\nconst AutoSizer = AutoSizerPkg\.default \|\| AutoSizerPkg;/, `import * as AutoSizerPkg from 'react-virtualized-auto-sizer';
const AutoSizer = AutoSizerPkg.default || AutoSizerPkg;`);

fs.writeFileSync('src/components/SurveyDataTree.jsx', content);
