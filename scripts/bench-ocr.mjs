/**
 * scripts/bench-ocr.mjs — OCR real con ROI fijas (espejo de ocr-engine.js).
 */
import { createWorker } from 'tesseract.js';
import { Jimp } from 'jimp';
import path from 'path';
import { fileURLToPath } from 'url';
import { parsearTextoCapacitacion } from '../parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(__dirname, '../fixtures/portada-muestra.png');
const MIN_PIX = 25;
const TH = 128;
const WL = '0123456789:-/ ';

const ROI_FIJAS = {
  titulo: { x0: 0, y0: 0, x1: 1, y1: 0.55 },
  fecha: { x0: 0.05, y0: 0.55, x1: 0.72, y1: 0.88 },
  horaInicio: { x0: 0, y0: 0.78, x1: 0.38, y1: 1 },
  horaFin: { x0: 0.48, y0: 0.76, x1: 1, y1: 1 },
};

function rgbAHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

const PRED = {
  titulo: (hsv, r, g, b) => {
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const neutro = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) < 40;
    return lum >= 200 && hsv.s <= 0.25 && neutro;
  },
  tituloOscuro: (hsv, r, g, b) => {
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return lum <= 90 && hsv.s <= 0.45;
  },
  rojo: (hsv, r, g, b) =>
    (((hsv.h <= 48) || hsv.h >= 335) && hsv.s >= 0.22 && hsv.v >= 0.22) ||
    (r > 140 && r > g + 25 && r > b + 25),
  azul: (hsv, r, g, b) =>
    (hsv.h >= 175 && hsv.h <= 265 && hsv.s >= 0.18 && hsv.v >= 0.18) ||
    (b > 120 && b > r + 15 && b >= g),
  amarillo: (hsv, r, g, b) =>
    (hsv.h >= 40 && hsv.h <= 72 && hsv.s >= 0.35 && hsv.v >= 0.35) ||
    (r > 160 && g > 140 && b < 100 && r + g > b * 3),
  verde: (hsv, r, g, b) =>
    (hsv.h >= 80 && hsv.h <= 160 && hsv.s >= 0.32 && hsv.v >= 0.28) ||
    (g > 130 && g > r + 30 && g > b + 20 && r < 140),
};

function morphK(ink, w, h, op, kw, kh) {
  const out = new Uint8Array(w * h);
  const rx = Math.floor(kw / 2);
  const ry = Math.floor(kh / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let val = op === 'erode' ? 1 : 0;
      outer: for (let dy = -ry; dy <= ry; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
            if (op === 'erode') { val = 0; break outer; }
            continue;
          }
          const on = ink[ny * w + nx];
          if (op === 'dilate' && on) { val = 1; break outer; }
          if (op === 'erode' && !on) { val = 0; break outer; }
        }
      }
      out[y * w + x] = val;
    }
  }
  return out;
}

function opening(ink, w, h, kw, kh) {
  return morphK(morphK(ink, w, h, 'erode', kw, kh), w, h, 'dilate', kw, kh);
}

function cropRegion(img, region) {
  const w = img.bitmap.width, h = img.bitmap.height;
  const x = Math.max(0, Math.floor(region.x0 * w));
  const y = Math.max(0, Math.floor(region.y0 * h));
  const cw = Math.min(w - x, Math.ceil(region.x1 * w) - x);
  const ch = Math.min(h - y, Math.ceil(region.y1 * h) - y);
  return img.clone().crop({ x, y, w: cw, h: ch });
}

function mascara(img, pred, dilatar = true) {
  const w = img.bitmap.width, h = img.bitmap.height;
  const ink = new Uint8Array(w * h);
  img.scan(0, 0, w, h, function (x, y, idx) {
    const r = this.bitmap.data[idx], g = this.bitmap.data[idx + 1], b = this.bitmap.data[idx + 2];
    if (pred(rgbAHsv(r, g, b), r, g, b)) ink[y * w + x] = 1;
  });
  let mapa = ink;
  if (dilatar) mapa = morphK(ink, w, h, 'dilate', 3, 3);

  const out = img.clone();
  let pixeles = 0, minX = w, minY = h, maxX = -1, maxY = -1;
  out.scan(0, 0, w, h, function (x, y, idx) {
    const on = mapa[y * w + x];
    const v = on ? 0 : 255;
    this.bitmap.data[idx] = v;
    this.bitmap.data[idx + 1] = v;
    this.bitmap.data[idx + 2] = v;
    if (on) {
      pixeles++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  });
  return { img: out, pixeles, bbox: pixeles ? { minX, minY, maxX, maxY } : null };
}

async function preparar(roi, suprimir = false) {
  const w = roi.bitmap.width, h = roi.bitmap.height;
  const ink = new Uint8Array(w * h);
  roi.scan(0, 0, w, h, function (x, y, idx) {
    const gray =
      0.299 * this.bitmap.data[idx] +
      0.587 * this.bitmap.data[idx + 1] +
      0.114 * this.bitmap.data[idx + 2];
    ink[y * w + x] = gray < TH ? 1 : 0;
  });

  let mapa = ink;
  if (suprimir) {
    const lenH = Math.max(15, Math.min(55, Math.round(w * 0.22)));
    const lenV = Math.max(15, Math.min(55, Math.round(h * 0.22)));
    const hLines = opening(ink, w, h, lenH, 1);
    const vLines = opening(ink, w, h, 1, lenV);
    mapa = new Uint8Array(w * h);
    for (let i = 0; i < mapa.length; i++) {
      mapa[i] = ink[i] && !(hLines[i] || vLines[i]) ? 1 : 0;
    }
    mapa = morphK(mapa, w, h, 'dilate', 3, 3);
  } else {
    mapa = morphK(ink, w, h, 'dilate', 3, 3);
  }

  let tinta = 0;
  for (const v of mapa) if (v) tinta++;
  if (tinta > mapa.length * 0.55) {
    for (let i = 0; i < mapa.length; i++) mapa[i] = mapa[i] ? 0 : 1;
  }

  const out = roi.clone();
  out.scan(0, 0, w, h, function (x, y, idx) {
    const v = mapa[y * w + x] ? 0 : 255;
    this.bitmap.data[idx] = v;
    this.bitmap.data[idx + 1] = v;
    this.bitmap.data[idx + 2] = v;
  });
  return out;
}

async function cropBbox(img, bbox, scaleExtra = 1) {
  if (!bbox) return null;
  const pad = 8;
  const x = Math.max(0, bbox.minX - pad);
  const y = Math.max(0, bbox.minY - pad);
  const w = Math.min(img.bitmap.width - x, bbox.maxX - bbox.minX + 1 + pad * 2);
  const h = Math.min(img.bitmap.height - y, bbox.maxY - bbox.minY + 1 + pad * 2);
  let roi = img.clone().crop({ x, y, w, h });
  const targetW = Math.round(360 * scaleExtra);
  if (roi.bitmap.width < targetW) {
    const f = targetW / roi.bitmap.width;
    roi = await roi.resize({
      w: Math.round(roi.bitmap.width * f),
      h: Math.round(roi.bitmap.height * f),
    });
  }
  return roi;
}

function sanitizarNum(t) {
  return String(t || '')
    .replace(/[OoD]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/[Zz]/g, '2')
    .replace(/[¢©]/g, '6')
    .replace(/[£]/g, '1')
    .replace(/[^0-9:\-/\s\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pareceUtil(texto, tipo) {
  const t = String(texto || '');
  if (tipo === 'fecha') return /\d{1,2}\s*[-/.:]\s*\d{1,2}\s*[-/.:]\s*\d{2,4}/.test(t);
  if (tipo === 'hora') {
    return /\d{1,2}\s*[:.]\s*\d{2}/.test(t) ||
      /\b([01]\d|2[0-3])[0-5]\d\b/.test(t) ||
      /\b([01]?\d|2[0-3])\s+[0-5]\d\b/.test(t);
  }
  return t.trim().length > 0;
}

function pareceFecha(texto) {
  return /\d{1,2}\s*[-/.:]\s*\d{1,2}\s*[-/.:]\s*\d{2,4}/.test(texto) ||
    /\d{1,2}\s*[-/.:]\s*\d{1,2}/.test(texto);
}

async function ocrRegion(worker, img, name, pred, opts = {}) {
  const {
    psm = '6',
    whitelist = null,
    dilatar = true,
    esHora = false,
    suprimir = false,
  } = opts;
  const zona = cropRegion(img, ROI_FIJAS[name]);
  const m = mascara(zona, pred, dilatar);
  const area = zona.bitmap.width * zona.bitmap.height;
  console.log(name, 'px', m.pixeles);
  if (m.pixeles < MIN_PIX) return '';
  if (m.pixeles > area * 0.35) {
    console.log(name, 'omitida por ruido de fondo');
    return '';
  }

  let roi = await cropBbox(m.img, m.bbox, esHora ? 1.4 : 1);
  if (!roi) roi = m.img;
  roi = await preparar(roi, suprimir);
  const tipo = whitelist ? (esHora ? 'hora' : 'fecha') : 'titulo';

  if (whitelist) {
    await worker.setParameters({
      tessedit_pageseg_mode: String(psm),
      tessedit_char_whitelist: whitelist,
    });
    let { data } = await worker.recognize(await roi.getBuffer('image/png'));
    const t1 = sanitizarNum(data.text || '');

    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      tessedit_char_whitelist: '',
    });
    ({ data } = await worker.recognize(await roi.getBuffer('image/png')));
    let raw = String(data.text || '');
    if (esHora) {
      raw = raw
        .replace(/\b([01]?\d|2[0-3])\s*[sS]([0-5]\d)\b/g, '$1:3$2')
        .replace(/\b([01]?\d|2[0-3])\s*[sS][0Oo]\b/g, '$1:30');
    }
    const t2 = sanitizarNum(raw);

    const score = (t) => {
      if (!pareceUtil(t, tipo)) return -1;
      if (tipo === 'fecha' && /\d{1,2}\s*[-/.:]\s*\d{1,2}\s*[-/.:]\s*\d{2,4}/.test(t)) return 3;
      if (tipo === 'hora' && /\d{1,2}\s*[:.]\s*\d{2}/.test(t)) return 3;
      if (/\b\d{3,4}\b/.test(t)) return 2;
      if (/\d+\s+\d{2}/.test(t)) return 1;
      return 0;
    };

    let text = '';
    if (score(t2) > score(t1)) text = t2;
    else if (score(t1) >= 0) text = t1;
    else if (score(t2) >= 0) text = t2;
    console.log(`[${name}]`, JSON.stringify(text || { t1, t2 }));
    return text;
  }

  await worker.setParameters({
    tessedit_pageseg_mode: String(psm),
    tessedit_char_whitelist: '',
  });
  const { data } = await worker.recognize(await roi.getBuffer('image/png'));
  const text = String(data.text || '').trim();
  console.log(`[${name}]`, JSON.stringify(text));
  return text;
}

async function main() {
  const t0 = Date.now();
  let img = await Jimp.read(IMG);
  if (img.bitmap.width > 1600) {
    const f = 1600 / img.bitmap.width;
    img = await img.resize({
      w: Math.round(img.bitmap.width * f),
      h: Math.round(img.bitmap.height * f),
    });
  }

  const worker = await createWorker('eng');
  let titulo = await ocrRegion(worker, img, 'titulo', PRED.titulo, {
    psm: '6', dilatar: false, suprimir: false,
  });
  if (!titulo || titulo.replace(/\s/g, '').length < 3) {
    const osc = await ocrRegion(worker, img, 'titulo', PRED.tituloOscuro, {
      psm: '6', dilatar: true, suprimir: false,
    });
    if (osc) titulo = osc;
  }
  let fecha = await ocrRegion(worker, img, 'fecha', PRED.rojo, {
    psm: '7', whitelist: WL, dilatar: true, suprimir: true,
  });
  if (!pareceFecha(fecha)) {
    const azul = await ocrRegion(worker, img, 'fecha', PRED.azul, {
      psm: '7', whitelist: WL, dilatar: true, suprimir: true,
    });
    fecha = pareceFecha(azul) ? azul : [fecha, azul].filter(Boolean).join('\n');
  }
  const horaInicio = await ocrRegion(worker, img, 'horaInicio', PRED.amarillo, {
    psm: '7', whitelist: WL, esHora: true, dilatar: true, suprimir: false,
  });
  const horaFin = await ocrRegion(worker, img, 'horaFin', PRED.verde, {
    psm: '7', whitelist: WL, esHora: true, dilatar: true, suprimir: false,
  });
  await worker.terminate();

  const capas = { titulo, fecha, horaInicio, horaFin };
  const rawText = [titulo, fecha, horaInicio, horaFin].filter(Boolean).join('\n');
  const datos = parsearTextoCapacitacion(rawText, 'portada-muestra.png', capas);
  const ms = Date.now() - t0;
  console.log('\nRESULTADO:', JSON.stringify({ exito: true, datos, rawText, ms }, null, 2));

  const ok =
    /prueba\s*0?1/i.test(datos.titulo) &&
    datos.fecha === '03-07-26' &&
    datos.horaInicio === '13:30 hrs' &&
    datos.horaFin === '14:00 hrs';

  if (!ok) {
    console.error('\nAún no cumple el esperado completo.');
    console.log('titulo OK?', /prueba/i.test(datos.titulo), datos.titulo);
    console.log('fecha OK?', datos.fecha === '03-07-26', datos.fecha);
    console.log('horaInicio OK?', datos.horaInicio);
    console.log('horaFin OK?', datos.horaFin);
    process.exit(2);
  }
  console.log(`\nPASS en ${ms} ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
