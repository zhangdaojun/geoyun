export const loadXlsx = () => import('xlsx');
export const loadProj4 = () => import('proj4').then((module) => module.default || module);
export const loadEh4Io = () => import('./eh4io.js');
