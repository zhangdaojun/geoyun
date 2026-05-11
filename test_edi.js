import { parseEDIFile, writeEDIFile } from './src/utils/eh4io.js';

const data = [
  { frequency: 1, rhoXY: 10, phaseXY: 45, rhoYX: 10, phaseYX: 45, cohXY: 1, cohYX: 1 },
  { frequency: 2, rhoXY: 20, phaseXY: 45, rhoYX: 20, phaseYX: 45, cohXY: 1, cohYX: 1 },
];

const ediText = writeEDIFile(data, 'Test');
console.log('--- EDI TEXT ---');
console.log(ediText);

console.log('--- PARSED ---');
console.log(parseEDIFile(ediText));
