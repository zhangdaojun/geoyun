import fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const pdfPath = 'D:\\BaiduNetdiskWorkspace\\PYTHON CODE\\geoyun\\public\\seg_mt_emap_1987.pdf';
const dataBuffer = new Uint8Array(fs.readFileSync(pdfPath));

pdfjsLib.getDocument(dataBuffer).promise.then(async (doc) => {
    let fullText = '';
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        const page = await doc.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        fullText += `Page ${pageNum}:\n${pageText}\n\n`;
    }
    fs.writeFileSync('D:\\BaiduNetdiskWorkspace\\PYTHON CODE\\geoyun\\public\\seg_mt_emap_1987.txt', fullText);
    console.log('PDF parsed with pdfjs and saved to txt');
}).catch(console.error);