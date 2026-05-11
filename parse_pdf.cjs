const fs = require('fs');
const { PDFParse } = require('pdf-parse');

async function run() {
    const parser = new PDFParse({
        data: fs.readFileSync('D:\\BaiduNetdiskWorkspace\\PYTHON CODE\\geoyun\\public\\seg_mt_emap_1987.pdf')
    });

    const result = await parser.getText();
    fs.writeFileSync('D:\\BaiduNetdiskWorkspace\\PYTHON CODE\\geoyun\\public\\seg_mt_emap_1987.txt', result.text);
    console.log('PDF parsed and saved to txt');
}

run().catch(function(error) {
    console.error('Error parsing PDF:', error);
});