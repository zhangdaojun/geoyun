import fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const inputPath = new URL('./docs/EH4manual_2.19.pdf', import.meta.url);
const outputPath = new URL('./docs/EH4manual_2.19.txt', import.meta.url);

const dataBuffer = new Uint8Array(fs.readFileSync(inputPath));
const doc = await pdfjsLib.getDocument(dataBuffer).promise;

let fullText = '';
for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
  const page = await doc.getPage(pageNum);
  const textContent = await page.getTextContent();
  const pageText = textContent.items.map((item) => item.str).join(' ');
  fullText += `Page ${pageNum}:\n${pageText}\n\n`;
}

fs.writeFileSync(outputPath, fullText);
console.log(`Extracted ${doc.numPages} pages to ${outputPath.pathname}`);
