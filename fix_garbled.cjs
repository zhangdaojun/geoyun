const fs = require('fs');
const path = require('path');

const filePatterns = [
  { search: / 路 /g, replace: ' · ' },
  { search: /浜戠洏鐩綍/g, replace: '云盘目录' },
  { search: /浜戠洏鏂囦欢/g, replace: '云盘文件' },
  { search: /娴嬬嚎/g, replace: '测线' },
  { search: /娴嬬偣/g, replace: '测点' },
  { search: /鏂规瑙勫垝/g, replace: '方案规划' },
  { search: /绯荤粺鏃ュ織/g, replace: '系统日志' },
  { search: /鏈湴鍚庡彴/g, replace: '本地后台' },
  { search: /璁＄畻浜у搧鍙洿鎺ヤ娇鐢ㄥ凡瑙ｆ瀽鐨\? F3\/Y blocks锛岄伩鍏嶆妸 F3 浜岃繘鍒跺綋浣滄棫 Y 鏂囦欢閲嶈/g, replace: '计算产品可直接使用已解析的 F3/Y blocks，避免把 F3 二进制当作旧 Y 文件重读' },
  { search: /褰撳墠鍗曠偣娌℃湁鍙敤浜\? Aurora 璁＄畻鐨\? MTTS 鏁版嵁/g, replace: '当前单点没有可用于 Aurora 计算的 MTTS 数据' },
  { search: /闂傚倸鍊搁崐鎼佸磹.*?(?=<)/g, replace: '请联系项目负责人或系统管理员获取更高权限。' }
];

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      if (file.endsWith('.js') || file.endsWith('.jsx')) {
        results.push(file);
      }
    }
  });
  return results;
}

const files = walk(path.join(__dirname, 'src'));

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  let originalContent = content;
  
  filePatterns.forEach(pattern => {
    content = content.replace(pattern.search, pattern.replace);
  });
  
  if (content !== originalContent) {
    fs.writeFileSync(file, content, 'utf8');
    console.log('Fixed garbled text in:', file);
  }
});
