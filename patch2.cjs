const fs = require('fs');
let content = fs.readFileSync('src/components/SurveyDataTree.jsx', 'utf8');

const regex = /const statusColor = \{[\s\S]*?处理中': \{ bg: '#eff6ff', text: '#2563eb' \},\r?\n\};\r?\n\r?\n\s*'规划中': \{ bg: '#f8fafc', text: '#64748b' \},/;
const newStr = `const statusColor = {
  '规划中': { bg: '#f8fafc', text: '#64748b' },`;

content = content.replace(regex, newStr);
fs.writeFileSync('src/components/SurveyDataTree.jsx', content);
