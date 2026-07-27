/**
 * ocr-engine.js — Capas de color genéricas y rápidas (sin OCR de hoja completa).
 *
 * Capas:
 *  - titulo     → blanco / gris claro
 *  - fecha      → rojo/naranja + azul (OCR por subcapa, se elige la legible)
 *  - horaInicio → amarillo
 *  - horaFin    → verde
 */

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';

const PDF_RENDER_SCALE = 1.5;
/** Más bajo: trazos de lápiz/plumón delgados generan pocos píxeles. */
const MIN_PIXELES_OCR = 40;
const ROI_PADDING = 14;
const ROI_MIN_WIDTH = 360;
/** Radio de dilatación para unir trazos finos (color). */
const DILATE_RADIUS = 1;
/** Umbral de binarización previo a Tesseract. */
const BINARIZE_THRESHOLD = 128;
/** Solo dígitos y separadores para fecha/hora (evita alucinaciones). */
const WHITELIST_FECHA_HORA = '0123456789:-/ ';

const PREDICADOS = {
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

let tesseractReady = null;
let pdfjsReady = null;
let workerPromise = null;

async function cargarTesseract() {
  if (typeof window !== 'undefined' && window.Tesseract) return window.Tesseract;
  if (!tesseractReady) {
    tesseractReady = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TESSERACT_CDN;
      script.async = true;
      script.onload = () =>
        window.Tesseract
          ? resolve(window.Tesseract)
          : reject(new Error('Tesseract.js no se cargó.'));
      script.onerror = () => reject(new Error('No se pudo cargar Tesseract.js'));
      document.head.appendChild(script);
    });
  }
  return tesseractReady;
}

async function obtenerWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const Tesseract = await cargarTesseract();
    const worker = await Tesseract.createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    return worker;
  })().catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

async function cargarPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = import(PDFJS_CDN)
    .then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return pdfjs;
    })
    .catch((err) => {
      pdfjsReady = null;
      throw err;
    });
  return pdfjsReady;
}

function esPdf(file) {
  const tipo = (file.type || '').toLowerCase();
  const nombre = (file.name || '').toLowerCase();
  return tipo === 'application/pdf' || nombre.endsWith('.pdf');
}

function normalizarRawText(texto) {
  return String(texto || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

/** Correcciones OCR en dígitos; cuidado con horas 10→00. */
function corregirDigitosOcr(texto, esHora = false) {
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
      .replace(/\b(\d)[Yy]\b(?=\s*(?:hrs?|hes|hs|[ap]\.?m))/gi, '$14:00')
      .replace(/\b([01]?\d|2[0-3])\s+00(?=\s*(?:hrs?|hs|h|\b))/gi, '$1:00')
      .replace(/\b([01]?\d|2[0-3])\s+00\b/g, '$1:00')
      .replace(/\b00\s*([:.])/g, '10$1')
      .replace(/\b00([0-5]\d)\b/g, '10$1');
  } else {
    t = t.replace(/[Ss]/g, '5').replace(/[Bb]/g, '8');
  }

  return t;
}

function pareceSalidaUtil(texto, tipo) {
  const t = String(texto || '');
  if (tipo === 'fecha') {
    return /\d{1,2}\s*[-/.:]\s*\d/.test(t);
  }
  if (tipo === 'hora') {
    return (
      /\d{1,2}\s*[:.\s]\s*\d{2}/.test(t) ||
      /\b\d{3,4}\b/.test(t) ||
      /\d{1,2}\s+\d{2}/.test(t)
    );
  }
  return t.trim().length > 0;
}

function sanitizarSalidaNumerica(texto) {
  return String(texto || '')
    .replace(/[^0-9:\-/\s\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rgbAHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
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

function crearMascaraColor(fuente, predicado, { dilatar = true, radio = DILATE_RADIUS } = {}) {
  const w = fuente.width;
  const h = fuente.height;
  const src = fuente.getContext('2d').getImageData(0, 0, w, h);
  const ink = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = src.data[i];
      const g = src.data[i + 1];
      const b = src.data[i + 2];
      if (predicado(rgbAHsv(r, g, b), r, g, b)) ink[y * w + x] = 1;
    }
  }

  let mapa = ink;
  if (dilatar && radio > 0) {
    // Dilatación N px: une trazos de lápiz delgados sin borrar huecos
    const dil = new Uint8Array(w * h);
    const R = radio;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = ink[y * w + x];
        if (!hit) {
          outer: for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
              if (dx * dx + dy * dy > R * R) continue;
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              if (ink[ny * w + nx]) {
                hit = 1;
                break outer;
              }
            }
          }
        }
        dil[y * w + x] = hit;
      }
    }
    mapa = dil;
  }

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const dst = out.getContext('2d').createImageData(w, h);

  let pixeles = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const on = mapa[y * w + x];
      const val = on ? 0 : 255;
      dst.data[i] = val;
      dst.data[i + 1] = val;
      dst.data[i + 2] = val;
      dst.data[i + 3] = 255;
      if (on) {
        pixeles++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  out.getContext('2d').putImageData(dst, 0, 0);
  return {
    canvas: out,
    pixeles,
    bbox: pixeles > 0 ? { minX, minY, maxX, maxY } : null,
  };
}

function recortarRoi(mascara, bbox) {
  if (!bbox || !mascara) return null;
  const pad = ROI_PADDING;
  const x = Math.max(0, bbox.minX - pad);
  const y = Math.max(0, bbox.minY - pad);
  const x2 = Math.min(mascara.width - 1, bbox.maxX + pad);
  const y2 = Math.min(mascara.height - 1, bbox.maxY + pad);
  const rw = x2 - x + 1;
  const rh = y2 - y + 1;
  if (rw < 4 || rh < 4) return null;

  let outW = rw;
  let outH = rh;
  if (outW < ROI_MIN_WIDTH) {
    const f = ROI_MIN_WIDTH / outW;
    outW = Math.round(outW * f);
    outH = Math.round(outH * f);
  }

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(mascara, x, y, rw, rh, 0, 0, outW, outH);
  return out;
}

/**
 * Morfología binaria sobre máscara de tinta (1 = tinta).
 * @param {'erode'|'dilate'} op
 */
function morfologiaInk(ink, w, h, op, radio = 1) {
  const out = new Uint8Array(w * h);
  const R = radio;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let val = op === 'erode' ? 1 : 0;
      outer: for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > R * R) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
            if (op === 'erode') {
              val = 0;
              break outer;
            }
            continue;
          }
          const on = ink[ny * w + nx];
          if (op === 'dilate' && on) {
            val = 1;
            break outer;
          }
          if (op === 'erode' && !on) {
            val = 0;
            break outer;
          }
        }
      }
      out[y * w + x] = val;
    }
  }
  return out;
}

/**
 * Preprocesado obligatorio antes de Tesseract:
 * - Binariza si hace falta
 * - Garantiza texto negro sobre fondo blanco (Tesseract lo exige)
 * - Dilate suave solo si la ROI no viene ya binarizada de la máscara de color
 * @param {HTMLCanvasElement} canvas
 * @returns {HTMLCanvasElement}
 */
function prepararRoiParaOcr(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  const src = ctx.getImageData(0, 0, w, h);
  const total = w * h;
  const ink = new Uint8Array(total);
  let pixBinarios = 0;

  for (let i = 0, p = 0; i < src.data.length; i += 4, p++) {
    const gray = 0.299 * src.data[i] + 0.587 * src.data[i + 1] + 0.114 * src.data[i + 2];
    if (gray < 10 || gray > 245) pixBinarios++;
    ink[p] = gray < BINARIZE_THRESHOLD ? 1 : 0;
  }

  const yaBinaria = pixBinarios / total > 0.94;
  let mapa = yaBinaria ? ink : morfologiaInk(ink, w, h, 'dilate', 1);

  let tinta = 0;
  for (let i = 0; i < mapa.length; i++) if (mapa[i]) tinta++;

  if (tinta > mapa.length * 0.55) {
    for (let i = 0; i < mapa.length; i++) mapa[i] = mapa[i] ? 0 : 1;
  }

  // Si ya era binaria y la polaridad es correcta, devolver el canvas original
  if (yaBinaria && tinta <= mapa.length * 0.55) {
    return canvas;
  }

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const dst = out.getContext('2d').createImageData(w, h);
  for (let p = 0; p < mapa.length; p++) {
    const i = p * 4;
    const val = mapa[p] ? 0 : 255;
    dst.data[i] = val;
    dst.data[i + 1] = val;
    dst.data[i + 2] = val;
    dst.data[i + 3] = 255;
  }
  out.getContext('2d').putImageData(dst, 0, 0);
  return out;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string} etiqueta
 * @param {{ psm?: string, whitelist?: string|null, esHora?: boolean }} [opts]
 */
async function reconocerRoi(canvas, etiqueta, opts = {}) {
  if (!canvas?.width || !canvas?.height) return '';
  const {
    psm = '6',
    whitelist = null,
    esHora = false,
  } = opts;

  const tipo = whitelist ? (esHora ? 'hora' : 'fecha') : 'titulo';

  try {
    const preparado = prepararRoiParaOcr(canvas);
    const worker = await obtenerWorker();

    // Paso 1: whitelist + PSM pedido (fecha/hora)
    if (whitelist) {
      await worker.setParameters({
        tessedit_pageseg_mode: String(psm),
        tessedit_char_whitelist: whitelist,
      });
      const { data: d1 } = await worker.recognize(preparado);
      const t1 = normalizarRawText(corregirDigitosOcr(d1?.text || '', esHora));
      if (pareceSalidaUtil(t1, tipo)) {
        console.log(`TesseractText [${etiqueta}] wl:`, t1);
        return t1;
      }
    }

    // Paso 2: fallback sin letras (fecha/hora) o lectura libre (título)
    const psmFb = tipo === 'titulo' ? String(psm) : '6';
    await worker.setParameters({
      tessedit_pageseg_mode: psmFb,
      tessedit_char_whitelist: '',
    });
    const { data: d2 } = await worker.recognize(preparado);
    let texto = corregirDigitosOcr(d2?.text || '', esHora);
    if (whitelist) texto = sanitizarSalidaNumerica(texto);
    texto = normalizarRawText(texto);
    console.log(`TesseractText [${etiqueta}]${whitelist ? ' fb' : ''}:`, texto);
    return texto;
  } catch (err) {
    console.error(`[ocr-engine] Error (${etiqueta}):`, err);
    return '';
  }
}

/**
 * @param {{ canvas: HTMLCanvasElement, pixeles: number, bbox: object|null }} mascara
 * @param {string} etiqueta
 * @param {{ psm?: string, whitelist?: string|null, esHora?: boolean }} [opts]
 */
async function ocrCapaSiUtil(mascara, etiqueta, opts = {}) {
  if (!mascara || mascara.pixeles < MIN_PIXELES_OCR) {
    console.log(`[ocr-engine] "${etiqueta}" omitida (px=${mascara?.pixeles ?? 0})`);
    return '';
  }
  const roi = recortarRoi(mascara.canvas, mascara.bbox);
  if (!roi) return '';
  console.log(`[ocr-engine] OCR "${etiqueta}" ${roi.width}x${roi.height} px=${mascara.pixeles}`);
  return reconocerRoi(roi, etiqueta, opts);
}

/** ¿El texto parece fecha numérica usable? (whitelist sin letras) */
function pareceFecha(texto) {
  return /\d{1,2}\s*[-/.:]\s*\d{1,2}\s*[-/.:]\s*\d{2,4}/.test(texto) ||
    /\d{1,2}\s*[-/.:]\s*\d{1,2}/.test(texto);
}

function pareceHora(texto) {
  return /\d{1,2}\s*[:.]\s*\d{2}/.test(texto) ||
    /\b\d{3,4}\b/.test(texto);
}

async function extraerPorCapas(pagina) {
  const t0 = performance.now();
  const workerReady = obtenerWorker();

  const mTitulo = crearMascaraColor(pagina, PREDICADOS.titulo, { dilatar: false });
  const mRojo = crearMascaraColor(pagina, PREDICADOS.rojo, { dilatar: true, radio: 1 });
  const mAzul = crearMascaraColor(pagina, PREDICADOS.azul, { dilatar: true, radio: 1 });
  const mAmarillo = crearMascaraColor(pagina, PREDICADOS.amarillo, { dilatar: true, radio: 1 });
  const mVerde = crearMascaraColor(pagina, PREDICADOS.verde, { dilatar: true, radio: 1 });

  console.log('[ocr-engine] Píxeles:', {
    titulo: mTitulo.pixeles,
    rojo: mRojo.pixeles,
    azul: mAzul.pixeles,
    amarillo: mAmarillo.pixeles,
    verde: mVerde.pixeles,
  });

  await workerReady;

  const optsTitulo = { psm: '6', whitelist: null };
  const optsFecha = { psm: '7', whitelist: WHITELIST_FECHA_HORA };
  const optsHora = { psm: '7', whitelist: WHITELIST_FECHA_HORA, esHora: true };

  const titulo = await ocrCapaSiUtil(mTitulo, 'titulo', optsTitulo);

  const fechaRojo = await ocrCapaSiUtil(mRojo, 'fecha-rojo', optsFecha);
  let fecha = pareceFecha(fechaRojo) ? fechaRojo : '';
  if (!fecha) {
    const fechaAzul = await ocrCapaSiUtil(mAzul, 'fecha-azul', optsFecha);
    if (pareceFecha(fechaAzul)) fecha = fechaAzul;
    else fecha = [fechaRojo, fechaAzul].filter(Boolean).join('\n');
  }

  const horaInicio = await ocrCapaSiUtil(mAmarillo, 'horaInicio', optsHora);
  const horaFin = await ocrCapaSiUtil(mVerde, 'horaFin', optsHora);

  const capas = {
    titulo: titulo || '',
    fecha: fecha || '',
    horaInicio: horaInicio || '',
    horaFin: horaFin || '',
  };

  const rawText = normalizarRawText(
    [capas.titulo, capas.fecha, capas.horaInicio, capas.horaFin]
      .filter((t) => t && t.trim())
      .join('\n')
  );

  console.log(`rawText:`, rawText, `| ${Math.round(performance.now() - t0)} ms`);
  return { rawText, capas };
}

async function paginaACanvas(page) {
  const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (!width || !height) throw new Error(`Viewport inválido: ${width}x${height}`);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function fuenteACanvas(source) {
  if (source instanceof HTMLCanvasElement) return source;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (source instanceof HTMLImageElement) {
    canvas.width = source.naturalWidth || source.width;
    canvas.height = source.naturalHeight || source.height;
    ctx.drawImage(source, 0, 0);
    return canvas;
  }
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('No se pudo cargar la imagen.'));
      el.src = url;
    });
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    ctx.drawImage(img, 0, 0);
    return canvas;
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

export async function extraerDocumento(file) {
  if (!file) throw new Error('No se proporcionó ningún archivo.');

  try {
    let pagina;
    if (esPdf(file)) {
      const pdfjs = await cargarPdfJs();
      const buffer = await file.arrayBuffer();
      const doc = await pdfjs.getDocument({ data: buffer }).promise;
      const page = await doc.getPage(1);
      pagina = await paginaACanvas(page);
    } else {
      pagina = await fuenteACanvas(file);
    }

    if (pagina.width > 1600) {
      const f = 1600 / pagina.width;
      const small = document.createElement('canvas');
      small.width = Math.round(pagina.width * f);
      small.height = Math.round(pagina.height * f);
      small.getContext('2d').drawImage(pagina, 0, 0, small.width, small.height);
      pagina = small;
    }

    console.log('[ocr-engine] Página:', pagina.width, 'x', pagina.height);
    return await extraerPorCapas(pagina);
  } catch (err) {
    console.error('[ocr-engine] falló:', err);
    throw err;
  }
}

export async function extraerTexto(file) {
  const { rawText } = await extraerDocumento(file);
  return rawText;
}
