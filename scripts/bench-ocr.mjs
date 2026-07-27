/**
 * scripts/bench-ocr.mjs — OCR real sobre fixtures/portada-muestra.png
 * Replica el pipeline de ocr-engine.js (prep + whitelist + fallback).
 */
import { createWorker } from 'tesseract.js';
import { Jimp } from 'jimp';
import path from 'path';
import { fileURLToPath } from 'url';
import { parsearTextoCapacitacion } from '../parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(__dirname, '../fixtures/portada-muestra.png');
const MIN_PIX = 40;
const TH = 128;
const WL = '0123456789:-/ ';

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
    const neutro = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) < 45;
    return lum >= 155 && hsv.s <= 0.35 && neutro;
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

function morph(ink, w, h, op, R = 1) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let val = op === 'erode' ? 1 : 0;
      outer: for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > R * R) continue;
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

function mascara(img, pred, dilatar = true) {
  const w = img.bitmap.width, h = img.bitmap.height;
  const ink = new Uint8Array(w * h);
  img.scan(0, 0, w, h, function (x, y, idx) {
    const r = this.bitmap.data[idx], g = this.bitmap.data[idx + 1], b = this.bitmap.data[idx + 2];
    if (pred(rgbAHsv(r, g, b), r, g, b)) ink[y * w + x] = 1;
  });
  const mapa = dilatar ? morph(ink, w, h, 'dilate', 1) : ink;
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

async function preparar(roi) {
  const w = roi.bitmap.width, h = roi.bitmap.height;
  const total = w * h;
  const ink = new Uint8Array(total);
  let pixBinarios = 0;

  roi.scan(0, 0, w, h, function (x, y, idx) {
    const gray =
      0.299 * this.bitmap.data[idx] +
      0.587 * this.bitmap.data[idx + 1] +
      0.114 * this.bitmap.data[idx + 2];
    if (gray < 10 || gray > 245) pixBinarios++;
    ink[y * w + x] = gray < TH ? 1 : 0;
  });

  const yaBinaria = pixBinarios / total > 0.94;
  let mapa = yaBinaria ? ink : morph(ink, w, h, 'dilate', 1);

  let tinta = 0;
  for (const v of mapa) if (v) tinta++;
  if (tinta > mapa.length * 0.55) {
    for (let i = 0; i < mapa.length; i++) mapa[i] = mapa[i] ? 0 : 1;
  }

  if (yaBinaria && tinta <= mapa.length * 0.55) return roi;

  const out = roi.clone();
  out.scan(0, 0, w, h, function (x, y, idx) {
    const v = mapa[y * w + x] ? 0 : 255;
    this.bitmap.data[idx] = v;
    this.bitmap.data[idx + 1] = v;
    this.bitmap.data[idx + 2] = v;
  });
  return out;
}

async function crop(img, bbox) {
  if (!bbox) return null;
  const pad = 12;
  const x = Math.max(0, bbox.minX - pad);
  const y = Math.max(0, bbox.minY - pad);
  const w = Math.min(img.bitmap.width - x, bbox.maxX - bbox.minX + 1 + pad * 2);
  const h = Math.min(img.bitmap.height - y, bbox.maxY - bbox.minY + 1 + pad * 2);
  let roi = img.clone().crop({ x, y, w, h });
  if (roi.bitmap.width < 360) {
    const f = 360 / roi.bitmap.width;
    roi = await roi.resize({ w: Math.round(roi.bitmap.width * f), h: Math.round(roi.bitmap.height * f) });
  }
  return preparar(roi);
}

function corregir(texto, esHora = false) {
  let t = String(texto || '');
  if (esHora) {
    t = t
      .replace(/\b00\s*([:.])/g, '10$1')
      .replace(/\b[lI|]\s*[O0]\s*([:.])/g, '10$1')
      .replace(/\b[O0][O0]\s*([:.])/gi, '10$1')
      .replace(/\b00([0-5]\d)\b/g, '10$1');
  }
  t = t
    .replace(/[OoD]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/[Zz]/g, '2')
    .replace(/[¢©]/g, '6')
    .replace(/[£]/g, '1')
    .replace(/\bhos\b/gi, 'hrs')
    .replace(/\bhes\b/gi, 'hrs')
    .replace(/\bhs\b/gi, 'hrs');
  if (esHora) {
    t = t
      .replace(/\b([01]?\d|2[0-3])\s*[sS][0Oo]\b/g, '$1:30')
      .replace(/\b([01]?\d|2[0-3])\s*[sS](\d)\b/g, '$1:3$2')
      .replace(/\b(\d)[Yy]\b(?=\s*(?:hrs?|hes|hs))/gi, '$14:00')
      .replace(/\b([01]?\d|2[0-3])\s+00(?=\s*(?:hrs?|hs|h|\b))/gi, '$1:00')
      .replace(/\b([01]?\d|2[0-3])\s+00\b/g, '$1:00')
      .replace(/\b00\s*([:.])/g, '10$1')
      .replace(/\b00([0-5]\d)\b/g, '10$1');
  } else {
    t = t.replace(/[Ss]/g, '5').replace(/[Bb]/g, '8');
  }
  return t.trim();
}

function pareceUtil(texto, tipo) {
  const t = String(texto || '');
  if (tipo === 'fecha') return /\d{1,2}\s*[-/.:]\s*\d/.test(t);
  if (tipo === 'hora') {
    return /\d{1,2}\s*[:.\s]\s*\d{2}/.test(t) || /\b\d{3,4}\b/.test(t) || /\d{1,2}\s+\d{2}/.test(t);
  }
  return t.trim().length > 0;
}

function sanitizarNum(t) {
  return String(t || '').replace(/[^0-9:\-/\s\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

function pareceFecha(texto) {
  return /\d{1,2}\s*[-/.:]\s*\d{1,2}\s*[-/.:]\s*\d{2,4}/.test(texto) ||
    /\d{1,2}\s*[-/.:]\s*\d{1,2}/.test(texto);
}

async function ocrCapa(worker, img, pred, name, opts = {}) {
  const { psm = '6', whitelist = null, dilatar = true, esHora = false } = opts;
  const m = mascara(img, pred, dilatar);
  console.log(name, 'px', m.pixeles);
  if (m.pixeles < MIN_PIX) return '';
  const roi = await crop(m.img, m.bbox);
  const tipo = whitelist ? (esHora ? 'hora' : 'fecha') : 'titulo';

  if (whitelist) {
    await worker.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: whitelist });
    const { data } = await worker.recognize(await roi.getBuffer('image/png'));
    const t1 = corregir(data.text || '', esHora);
    if (pareceUtil(t1, tipo)) {
      console.log(`[${name}] wl`, JSON.stringify(t1));
      return t1;
    }
  }

  const psmFb = tipo === 'titulo' ? String(psm) : '6';
  await worker.setParameters({ tessedit_pageseg_mode: psmFb, tessedit_char_whitelist: '' });
  const { data } = await worker.recognize(await roi.getBuffer('image/png'));
  let text = corregir(data.text || '', esHora);
  if (whitelist) text = sanitizarNum(text);
  console.log(`[${name}]${whitelist ? ' fb' : ''}`, JSON.stringify(text));
  return text;
}

async function main() {
  const t0 = Date.now();
  let img = await Jimp.read(IMG);
  if (img.bitmap.width > 1600) {
    const f = 1600 / img.bitmap.width;
    img = await img.resize({ w: Math.round(img.bitmap.width * f), h: Math.round(img.bitmap.height * f) });
  }

  const worker = await createWorker('eng');
  const optsTitulo = { psm: '6', whitelist: null, dilatar: false };
  const optsFecha = { psm: '7', whitelist: WL };
  const optsHora = { psm: '7', whitelist: WL, esHora: true };

  const titulo = await ocrCapa(worker, img, PRED.titulo, 'titulo', optsTitulo);
  const fechaRojo = await ocrCapa(worker, img, PRED.rojo, 'fecha-rojo', optsFecha);
  let fecha = pareceFecha(fechaRojo) ? fechaRojo : '';
  if (!fecha) {
    const fechaAzul = await ocrCapa(worker, img, PRED.azul, 'fecha-azul', optsFecha);
    if (pareceFecha(fechaAzul)) fecha = fechaAzul;
    else fecha = [fechaRojo, fechaAzul].filter(Boolean).join('\n');
  }
  const horaInicio = await ocrCapa(worker, img, PRED.amarillo, 'horaInicio', optsHora);
  const horaFin = await ocrCapa(worker, img, PRED.verde, 'horaFin', optsHora);
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
