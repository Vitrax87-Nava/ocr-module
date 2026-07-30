/**
 * scripts/bench-ocr.mjs — OCR real (espejo del motor en ocr.js: zonas / regex / laterales).
 */
import { createWorker } from 'tesseract.js';
import { Jimp } from 'jimp';
import path from 'path';
import { fileURLToPath } from 'url';
import { parsearTextoCapacitacion } from '../ocr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.join(__dirname, '../fixtures/portada-muestra.png');
const MIN_PIX = 25;
const TH = 128;
const WL_FECHA = '0123456789-/';
const WL_HORA = '0123456789:';

const ROI_FIJAS = {
  titulo: { x0: 0.08, y0: 0.02, x1: 0.92, y1: 0.52 },
  fecha: { x0: 0.15, y0: 0.45, x1: 0.85, y1: 0.9 },
  horaInicio: { x0: 0, y0: 0.68, x1: 0.45, y1: 1 },
  horaFin: { x0: 0.5, y0: 0.68, x1: 1, y1: 1 },
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
    const neutro = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) < 45;
    return lum >= 170 && hsv.s <= 0.35 && neutro;
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

/** Máscara de color ∩ ROI (sobre página completa). */
function mascaraEnRegion(img, region, pred, dilatar = true) {
  const w = img.bitmap.width, h = img.bitmap.height;
  const x0 = Math.max(0, Math.floor(region.x0 * w));
  const y0 = Math.max(0, Math.floor(region.y0 * h));
  const x1 = Math.min(w, Math.ceil(region.x1 * w));
  const y1 = Math.min(h, Math.ceil(region.y1 * h));
  const ink = new Uint8Array(w * h);
  img.scan(0, 0, w, h, function (x, y, idx) {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) return;
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
  const area = (x1 - x0) * (y1 - y0);
  return { img: out, pixeles, bbox: pixeles ? { minX, minY, maxX, maxY } : null, area };
}

async function preparar(roi, suprimir = false) {
  const w = roi.bitmap.width, h = roi.bitmap.height;
  const ink = new Uint8Array(w * h);
  let pixBinarios = 0;
  roi.scan(0, 0, w, h, function (x, y, idx) {
    const gray =
      0.299 * this.bitmap.data[idx] +
      0.587 * this.bitmap.data[idx + 1] +
      0.114 * this.bitmap.data[idx + 2];
    if (gray < 10 || gray > 245) pixBinarios++;
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
  } else if (pixBinarios / (w * h) <= 0.92) {
    mapa = morphK(ink, w, h, 'dilate', 2, 2);
  }

  let tinta = 0;
  for (const v of mapa) if (v) tinta++;
  if (tinta > mapa.length * 0.55) {
    for (let i = 0; i < mapa.length; i++) mapa[i] = mapa[i] ? 0 : 1;
  }

  if (!suprimir && pixBinarios / (w * h) > 0.92 && tinta <= mapa.length * 0.55) {
    return roi;
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

async function cropBbox(img, bbox, { scaleExtra = 1, pad = 12, padBottom = 8 } = {}) {
  if (!bbox) return null;
  const x = Math.max(0, bbox.minX - pad);
  const y = Math.max(0, bbox.minY - pad);
  const w = Math.min(img.bitmap.width - x, bbox.maxX - bbox.minX + 1 + pad * 2);
  const h = Math.min(img.bitmap.height - y, bbox.maxY - bbox.minY + 1 + pad + padBottom);
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

function sanitizarNum(t, soloHora = false) {
  let s = String(t || '')
    .replace(/[OoD]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/[Zz]/g, '2')
    .replace(/[¢©]/g, '6')
    .replace(/[£]/g, '1');
  if (soloHora) {
    return s.replace(/[^0-9:]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return s
    .replace(/[^0-9:\-/\s\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function limpiarTituloOcr(texto) {
  let t = String(texto || '').trim();
  t = t.split('\n').map((l) => l.trim()).find(Boolean) || t;
  t = t.replace(/[,.;:_=\-|~'"“”‘’•·]+/g, ' ');
  t = t.replace(/^[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+/u, '');
  t = t.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+$/u, '');
  return t.replace(/\s+/g, ' ').trim();
}

function pareceUtil(texto, tipo) {
  const t = String(texto || '');
  if (tipo === 'fecha') {
    return /\d{1,2}\s*[-/.:]\s*\d{1,2}\s*[-/.:]\s*\d{2,4}/.test(t) ||
      /\d{2,}/.test(t);
  }
  if (tipo === 'hora') {
    return /\d{1,2}\s*[:.]\s*\d{2}/.test(t) ||
      /\b([01]\d|2[0-3])[0-5]\d\b/.test(t) ||
      /\b([01]?\d|2[0-3])\s+[0-5]\d\b/.test(t) ||
      /\d{3,4}/.test(t);
  }
  return t.trim().length > 0;
}

async function ocrRegion(worker, img, name, pred, opts = {}) {
  const {
    psm = '6',
    whitelist = null,
    dilatar = true,
    esHora = false,
    esTitulo = false,
    suprimir = false,
    recortarInferior = false,
  } = opts;
  const region = ROI_FIJAS[name];
  const m = mascaraEnRegion(img, region, pred, dilatar);
  console.log(name, 'px', m.pixeles);
  if (m.pixeles < MIN_PIX) return '';
  if (m.pixeles > m.area * 0.35) {
    console.log(name, 'omitida por ruido de fondo');
    return '';
  }

  let bbox = m.bbox;
  if (recortarInferior && bbox) {
    const alto = bbox.maxY - bbox.minY + 1;
    const cut = bbox.minY + Math.floor(alto * 0.3);
    bbox = { ...bbox, minY: Math.min(bbox.maxY - 4, Math.max(bbox.minY, cut)) };
  }

  let roi = await cropBbox(m.img, bbox, {
    scaleExtra: esHora ? 1.5 : esTitulo ? 1.15 : 1,
    pad: esTitulo ? 20 : 12,
    padBottom: esTitulo ? 36 : 8,
  });
  if (!roi) roi = m.img;
  roi = await preparar(roi, suprimir);
  const tipo = esTitulo ? 'titulo' : esHora ? 'hora' : 'fecha';

  if (whitelist) {
    await worker.setParameters({
      tessedit_pageseg_mode: String(psm),
      tessedit_char_whitelist: whitelist,
    });
    let { data } = await worker.recognize(await roi.getBuffer('image/png'));
    const t1 = sanitizarNum(data.text || '', esHora);

    await worker.setParameters({
      tessedit_pageseg_mode: esHora ? '7' : '6',
      tessedit_char_whitelist: '',
    });
    ({ data } = await worker.recognize(await roi.getBuffer('image/png')));
    let raw = String(data.text || '');
    if (esHora) {
      raw = raw
        .replace(/\b([01]?\d|2[0-3])\s*[sS]([0-5]\d)\b/g, '$1:3$2')
        .replace(/\b([01]?\d|2[0-3])\s*[sS][0Oo]\b/g, '$1:30')
        .replace(/\b([01]?\d|2[0-3])\s*[OoD]{1,2}[A-Za-z]*\b/g, '$1:00');
    }
    const t2 = sanitizarNum(raw, esHora);

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
    else if (esHora) text = t2 || t1;
    console.log(`[${name}]`, JSON.stringify(text || { t1, t2 }));
    return text;
  }

  await worker.setParameters({
    tessedit_pageseg_mode: String(psm),
    tessedit_char_whitelist: '',
  });
  const { data } = await worker.recognize(await roi.getBuffer('image/png'));
  let text = String(data.text || '').trim();
  if (esTitulo) text = limpiarTituloOcr(text);
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
    psm: '6', dilatar: false, suprimir: false, esTitulo: true,
  });
  if (!titulo || titulo.replace(/\s/g, '').length < 3) {
    const osc = await ocrRegion(worker, img, 'titulo', PRED.tituloOscuro, {
      psm: '6', dilatar: true, suprimir: false, esTitulo: true,
    });
    if (osc) titulo = osc;
  }
  const fechaRojo = await ocrRegion(worker, img, 'fecha', PRED.rojo, {
    psm: '7', whitelist: WL_FECHA, dilatar: true, suprimir: true,
  });
  const fechaAzul = await ocrRegion(worker, img, 'fecha', PRED.azul, {
    psm: '7', whitelist: WL_FECHA, dilatar: true, suprimir: true,
  });
  const fecha = [fechaRojo, fechaAzul].filter(Boolean).join('\n');
  const horaInicio = await ocrRegion(worker, img, 'horaInicio', PRED.amarillo, {
    psm: '7', whitelist: WL_HORA, esHora: true, dilatar: true, suprimir: false,
  });
  const horaFin = await ocrRegion(worker, img, 'horaFin', PRED.verde, {
    psm: '7', whitelist: WL_HORA, esHora: true, dilatar: true, suprimir: false,
    recortarInferior: true,
  });
  await worker.terminate();

  const capas = { titulo, fecha, horaInicio, horaFin };
  const rawText = [titulo, fecha, horaInicio, horaFin].filter(Boolean).join('\n');
  const datos = parsearTextoCapacitacion(rawText, 'portada-muestra.png', capas);
  const ms = Date.now() - t0;
  console.log('\nRESULTADO:', JSON.stringify({ exito: true, datos, rawText, ms }, null, 2));

  const ok =
    /prueba\s*0?1/i.test(datos.titulo) &&
    datos.fecha === '03-07-2026' &&
    datos.horaInicio === '13:30' &&
    datos.horaFin === '14:00';

  if (!ok) {
    console.error('\nAún no cumple el esperado completo.');
    console.log('titulo OK?', /prueba/i.test(datos.titulo), datos.titulo);
    console.log('fecha OK?', datos.fecha === '03-07-2026', datos.fecha);
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
