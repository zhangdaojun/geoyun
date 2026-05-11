import sensorsTbl from '../../docs/cal/SENSORS.TBL?raw';
import hx50h from '../../docs/cal/6343_HX.50H?raw';
import hxHf from '../../docs/cal/6343_HX.HF?raw';
import hy50h from '../../docs/cal/6359_HY.50H?raw';
import hyHf from '../../docs/cal/6359_HY.HF?raw';
import afe1 from '../../docs/cal/AFEV3.1?raw';
import afe10 from '../../docs/cal/AFEV3.10?raw';
import afe2 from '../../docs/cal/AFEV3.2?raw';
import afe4 from '../../docs/cal/AFEV3.4?raw';
import be50h from '../../docs/cal/BE26V2.50H?raw';
import be60h from '../../docs/cal/BE26V2.60H?raw';
import beHf from '../../docs/cal/BE26V2.HF?raw';

const addText = (target, name, text) => {
  if (!name || !text) return;
  target[name] = text;
  target[String(name).toLowerCase()] = text;
};

export const getDefaultEh4CalibrationFileTexts = () => {
  const texts = {};
  addText(texts, 'SENSORS.TBL', sensorsTbl);
  addText(texts, '6343_HX.50H', hx50h);
  addText(texts, '6343_HX.HF', hxHf);
  addText(texts, '6359_HY.50H', hy50h);
  addText(texts, '6359_HY.HF', hyHf);
  addText(texts, 'AFEV3.1', afe1);
  addText(texts, 'AFEV3.10', afe10);
  addText(texts, 'AFEV3.2', afe2);
  addText(texts, 'AFEV3.4', afe4);
  addText(texts, 'BE26V2.50H', be50h);
  addText(texts, 'BE26V2.60H', be60h);
  addText(texts, 'BE26V2.HF', beHf);

  // The bundled SENSORS.TBL uses field instrument names. Map them to the
  // calibration files included with this project so the default bundle works.
  addText(texts, 'g1477_hx.hf', hxHf);
  addText(texts, 'g1477_hx.60h', hx50h);
  addText(texts, 'g1478_hy.hf', hyHf);
  addText(texts, 'g1478_hy.60h', hy50h);

  return texts;
};
