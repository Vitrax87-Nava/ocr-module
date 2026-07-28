/**
 * ocr-engine.js — Extracción automática por zonas / color / patrón.
 *
 * Al cargar un archivo se dispara el pipeline concurrente:
 *  - titulo      → franja superior, texto libre (psm 6, sin whitelist)
 *  - fecha       → centro-inferior (rojo/azul); el parser localiza por regex
 *  - horaInicio  → esquina inferior izquierda (amarillo) → HH:mm 24h
 *  - horaFin     → esquina inferior derecha (verde) → HH:mm 24h
 */

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';

const PDF_RENDER_SCALE = 1.5;
const MIN_PIXELES_OCR = 25;
const ROI_MIN_WIDTH = 360;
const DILATE_RADIUS = 1;
const BINARIZE_THRESHOLD = 128;
/** Fecha: solo dígitos y guiones/barras (bloquea letras y ruido de cuadrícula). */
const WHITELIST_FECHA = '0123456789-/';
/** Horas laterales: solo dígitos y dos puntos (evita "hrs"/letras). */
const WHITELIST_HORA = '0123456789:';

/**
 * Bounding boxes fijos — estructura estándar de portada.
 * Título con margen inferior holgado para no cortar trazos blancos.
 */
const ROI_FIJAS = {
  titulo: { x0: 0, y0: 0, x1: 1, y1: 0.72 },
  fecha: { x0: 0.2, y0: 0.55, x1: 0.75, y1: 0.9 },
  horaInicio: { x0: 0, y0: 0.72, x1: 0.4, y1: 1 },
  horaFin: { x0: 0.48, y0: 0.72, x1: 1, y1: 1 },
};

const PREDICADOS = {
  // Trazo blanco del título (umbral calibrado; no recortar papel primero)
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

let tesseractReady = null;
let pdfjsReady = null;
let workerPromise = null;
/** Cola: un solo recognize a la vez sobre el worker singleton. */
let colaOcr = Promise.resolve();

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

/**
 * Worker Tesseract persistente (singleton). Reutilizado entre escaneos.
 */
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

/** Precalienta el motor (CDN + worker) para el primer escaneo más rápido. */
export async function precalentarMotor() {
  await obtenerWorker();
}

function enColaOcr(tarea) {
  const corrida = colaOcr.then(tarea, tarea);
  colaOcr = corrida.then(
    () => undefined,
    () => undefined
  );
  return corrida;
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

/** Correcciones mínimas de confusión visual (sin inventar valores). */
function corregirDigitosOcr(texto, esHora = false) {
  let t = String(texto || '');

  t = t
    .replace(/[OoD]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/[Zz]/g, '2')
    .replace(/[¢©]/g, '6')
    .replace(/[£]/g, '1');

  if (!esHora) {
    t = t.replace(/[Ss]/g, '5').replace(/[Bb]/g, '8');
  }

  return t;
}

function sanitizarSalidaNumerica(texto, { soloHora = false, soloFecha = false } = {}) {
  // Primero confusiones visuales (O/D→0), luego filtrar charset
  let t = corregirDigitosOcr(texto, soloHora || soloFecha);
  if (soloHora) {
    return t
      .replace(/[^0-9:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (soloFecha) {
    // Whitelist estricta de zona fecha: 0-9, -, /
    return t
      .replace(/[^0-9\-/]/g, '')
      .replace(/[-/]{2,}/g, '-')
      .trim();
  }
  return t
    .replace(/[^0-9:\-/\s\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Limpieza ligera del título OCR (fluido → Título / Nombre sugerido). */
function limpiarTituloOcr(texto) {
  let t = normalizarRawText(texto);
  if (!t) return '';
  // Primera línea útil
  t = t.split('\n').map((l) => l.trim()).find(Boolean) || t;
  t = t.replace(/[,.;:_=\-|~'"“”‘’•·]+/g, ' ');
  t = t.replace(/^[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+/u, '');
  t = t.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+$/u, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function pareceSalidaUtil(texto, tipo) {
  const t = String(texto || '');
  if (tipo === 'fecha') {
    return (
      /\d{1,2}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{2,4}/.test(t) ||
      /\d{6,8}/.test(t.replace(/\D/g, '')) ||
      /\d{2,}/.test(t)
    );
  }
  if (tipo === 'hora') {
    return (
      /\d{1,2}\s*[:.]\s*\d{2}/.test(t) ||
      /\b([01]\d|2[0-3])[0-5]\d\b/.test(t) ||
      /\b([01]?\d|2[0-3])\s+[0-5]\d\b/.test(t) ||
      /\d{3,4}/.test(t)
    );
  }
  return t.trim().length > 0;
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

/**
 * Máscara de color restringida a una ROI (coords relativas 0–1).
 * Se aplica sobre la página completa para no confundir papel claro con tinta.
 */
function crearMascaraColor(fuente, predicado, { dilatar = true, radio = DILATE_RADIUS, region = null } = {}) {
  const w = fuente.width;
  const h = fuente.height;
  const src = fuente.getContext('2d').getImageData(0, 0, w, h);
  const ink = new Uint8Array(w * h);

  let x0 = 0;
  let y0 = 0;
  let x1 = w;
  let y1 = h;
  if (region) {
    x0 = Math.max(0, Math.floor(region.x0 * w));
    y0 = Math.max(0, Math.floor(region.y0 * h));
    x1 = Math.min(w, Math.ceil(region.x1 * w));
    y1 = Math.min(h, Math.ceil(region.y1 * h));
  }

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
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

/**
 * Recorta una región fija de la página (coordenadas relativas 0–1).
 * @returns {HTMLCanvasElement|null}
 */
function recortarRegionFija(pagina, region) {
  if (!pagina || !region) return null;
  const w = pagina.width;
  const h = pagina.height;
  const x = Math.max(0, Math.floor(region.x0 * w));
  const y = Math.max(0, Math.floor(region.y0 * h));
  const x2 = Math.min(w, Math.ceil(region.x1 * w));
  const y2 = Math.min(h, Math.ceil(region.y1 * h));
  const rw = x2 - x;
  const rh = y2 - y;
  if (rw < 8 || rh < 8) return null;

  const out = document.createElement('canvas');
  out.width = rw;
  out.height = rh;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, rw, rh);
  ctx.drawImage(pagina, x, y, rw, rh, 0, 0, rw, rh);
  return out;
}

function escalarCanvas(canvas, { minWidth = ROI_MIN_WIDTH, minHeight = 48, scaleExtra = 1 } = {}) {
  if (!canvas) return null;
  let outW = canvas.width;
  let outH = canvas.height;
  const targetW = Math.round(minWidth * scaleExtra);
  if (outW < targetW) {
    const f = targetW / outW;
    outW = Math.round(outW * f);
    outH = Math.round(outH * f);
  }
  if (outH < minHeight) {
    const f = minHeight / outH;
    outW = Math.round(outW * f);
    outH = minHeight;
  }
  if (outW === canvas.width && outH === canvas.height) return canvas;
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, outW, outH);
  return out;
}

function recortarRoi(mascara, bbox, { minWidth = ROI_MIN_WIDTH, scaleExtra = 1, pad = 12, padBottom = 0 } = {}) {
  if (!bbox || !mascara) return null;
  const x = Math.max(0, bbox.minX - pad);
  const y = Math.max(0, bbox.minY - pad);
  const x2 = Math.min(mascara.width - 1, bbox.maxX + pad);
  const y2 = Math.min(mascara.height - 1, bbox.maxY + pad + padBottom);
  const rw = x2 - x + 1;
  const rh = y2 - y + 1;
  if (rw < 4 || rh < 4) return null;

  const out = document.createElement('canvas');
  out.width = rw;
  out.height = rh;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, rw, rh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(mascara, x, y, rw, rh, 0, 0, rw, rh);
  return escalarCanvas(out, { minWidth, scaleExtra });
}

/**
 * Morfología binaria con kernel rectangular (equiv. OpenCV morphologyEx).
 * @param {'erode'|'dilate'} op
 * @param {number} kw ancho del kernel (impar preferible)
 * @param {number} kh alto del kernel
 */
function morfologiaKernel(ink, w, h, op, kw, kh) {
  const out = new Uint8Array(w * h);
  const rx = Math.max(0, Math.floor(kw / 2));
  const ry = Math.max(0, Math.floor(kh / 2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let val = op === 'erode' ? 1 : 0;
      outer: for (let dy = -ry; dy <= ry; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
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

function openingKernel(ink, w, h, kw, kh) {
  return morfologiaKernel(
    morfologiaKernel(ink, w, h, 'erode', kw, kh),
    w,
    h,
    'dilate',
    kw,
    kh
  );
}

function morfologiaInk(ink, w, h, op, radio = 1) {
  const k = radio * 2 + 1;
  return morfologiaKernel(ink, w, h, op, k, k);
}

/**
 * Supresión de líneas de cuadrícula (equiv. cv.morphologyEx OPEN
 * con kernels horizontales/verticales alargados).
 * Extrae líneas finas y las resta del ink, dejando solo trazos de dígitos.
 * mode: 'hv' | 'h' | 'v'
 */
function suprimirLineasCuadricula(ink, w, h, mode = 'hv') {
  // Kernels largos y delgados: capturan líneas de libreta, no dígitos compactos
  const lenH = Math.max(15, Math.min(55, Math.round(w * 0.22)));
  const lenV = Math.max(15, Math.min(55, Math.round(h * 0.22)));
  const lineas = new Uint8Array(w * h);

  if (mode === 'hv' || mode === 'h') {
    const lineasH = openingKernel(ink, w, h, lenH, 1);
    for (let i = 0; i < lineas.length; i++) if (lineasH[i]) lineas[i] = 1;
  }
  if (mode === 'hv' || mode === 'v') {
    const lineasV = openingKernel(ink, w, h, 1, lenV);
    for (let i = 0; i < lineas.length; i++) if (lineasV[i]) lineas[i] = 1;
  }

  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    out[i] = ink[i] && !lineas[i] ? 1 : 0;
  }
  // Reconectar trazos de dígitos rotos por la resta
  return morfologiaKernel(out, w, h, 'dilate', 3, 3);
}

function inkACanvas(mapa, w, h) {
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
 * Preprocesado obligatorio:
 * 1) Binarizar
 * 2) Opcional: opening H/V (equiv. cv.morphologyEx) para quitar cuadrícula
 * 3) Dilate suave + texto negro / fondo blanco
 */
function prepararRoiParaOcr(canvas, opts = {}) {
  const { suprimirCuadricula = false, modoLineas = 'hv' } = opts;
  const w = canvas.width;
  const h = canvas.height;
  const src = canvas.getContext('2d').getImageData(0, 0, w, h);
  const total = w * h;
  const ink = new Uint8Array(total);
  let pixBinarios = 0;

  for (let i = 0, p = 0; i < src.data.length; i += 4, p++) {
    const gray = 0.299 * src.data[i] + 0.587 * src.data[i + 1] + 0.114 * src.data[i + 2];
    if (gray < 10 || gray > 245) pixBinarios++;
    ink[p] = gray < BINARIZE_THRESHOLD ? 1 : 0;
  }

  let mapa = ink;
  if (suprimirCuadricula) {
    mapa = suprimirLineasCuadricula(ink, w, h, modoLineas);
  } else {
    // Máscara de color ya es B/N: no destruir trazos finos
    const yaBinaria = pixBinarios / total > 0.92;
    if (!yaBinaria) {
      mapa = morfologiaKernel(ink, w, h, 'dilate', 2, 2);
    }
  }

  let tinta = 0;
  for (let i = 0; i < mapa.length; i++) if (mapa[i]) tinta++;
  if (tinta > mapa.length * 0.55) {
    for (let i = 0; i < mapa.length; i++) mapa[i] = mapa[i] ? 0 : 1;
  }

  // Si ya era B/N correcto y no se pidió morph, devolver original
  if (!suprimirCuadricula && pixBinarios / total > 0.92 && tinta <= mapa.length * 0.55) {
    return canvas;
  }

  return inkACanvas(mapa, w, h);
}

async function reconocerRoi(canvas, etiqueta, opts = {}) {
  if (!canvas?.width || !canvas?.height) return '';
  const {
    psm = '6',
    whitelist = null,
    esHora = false,
    esTitulo = false,
    esFecha = false,
    suprimirCuadricula = false,
  } = opts;

  const tipo = esTitulo ? 'titulo' : esHora ? 'hora' : esFecha ? 'fecha' : whitelist ? 'fecha' : 'titulo';

  // Prep de imagen fuera de la cola (paralelo); recognize serializado
  let preparado;
  try {
    preparado = prepararRoiParaOcr(canvas, {
      suprimirCuadricula,
      modoLineas: opts.modoLineas || 'hv',
    });
  } catch (err) {
    console.error(`[ocr-engine] Prep (${etiqueta}):`, err);
    return '';
  }

  return enColaOcr(async () => {
    try {
      const worker = await obtenerWorker();

      if (whitelist) {
        await worker.setParameters({
          tessedit_pageseg_mode: String(psm),
          tessedit_char_whitelist: whitelist,
        });
        const { data: d1 } = await worker.recognize(preparado);
        let t1 = sanitizarSalidaNumerica(d1?.text || '', {
          soloHora: esHora,
          soloFecha: esFecha,
        });

        await worker.setParameters({
          tessedit_pageseg_mode: esHora ? '7' : '6',
          tessedit_char_whitelist: '',
        });
        const { data: d2 } = await worker.recognize(preparado);
        let t2 = String(d2?.text || '');
        if (esHora) {
          t2 = t2
            .replace(/\b([01]?\d|2[0-3])\s*[sS]([0-5]\d)\b/g, '$1:3$2')
            .replace(/\b([01]?\d|2[0-3])\s*[sS][0Oo]\b/g, '$1:30')
            .replace(/\b([01]?\d|2[0-3])\s*[OoD]{1,2}[A-Za-z]*\b/g, '$1:00');
        }
        t2 = sanitizarSalidaNumerica(t2, {
          soloHora: esHora,
          soloFecha: esFecha,
        });

        const score = (t) => {
          if (!pareceSalidaUtil(t, tipo)) return -1;
          if (tipo === 'fecha' && /\d{1,2}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{2,4}/.test(t)) return 3;
          if (tipo === 'hora' && /\d{1,2}\s*[:.]\s*\d{2}/.test(t)) return 3;
          if (/\b\d{3,4}\b/.test(t)) return 2;
          if (/\d+\s+\d{2}/.test(t)) return 1;
          return 0;
        };

        let texto = '';
        if (score(t2) > score(t1)) texto = t2;
        else if (score(t1) >= 0) texto = t1;
        else if (score(t2) >= 0) texto = t2;
        else if (esHora) texto = t2 || t1;

        if (!texto) {
          console.log(`TesseractText [${etiqueta}] inválido:`, JSON.stringify({ t1, t2 }));
          return '';
        }
        texto = normalizarRawText(texto);
        console.log(`TesseractText [${etiqueta}]:`, texto);
        return texto;
      }

      await worker.setParameters({
        tessedit_pageseg_mode: String(psm),
        tessedit_char_whitelist: '',
      });
      const { data } = await worker.recognize(preparado);
      let texto = normalizarRawText(data?.text || '');
      if (esTitulo) texto = limpiarTituloOcr(texto);
      console.log(`TesseractText [${etiqueta}]:`, texto);
      return texto;
    } catch (err) {
      console.error(`[ocr-engine] Error (${etiqueta}):`, err);
      return '';
    }
  });
}

/**
 * OCR por zona: máscara de color ∩ ROI fija → prep → Tesseract.
 */
async function ocrRegionFija(pagina, nombreRegion, predicados, opts = {}) {
  const region = ROI_FIJAS[nombreRegion];
  if (!region || !pagina) {
    console.log(`[ocr-engine] ROI "${nombreRegion}" inválida`);
    return '';
  }

  const lista = Array.isArray(predicados) ? predicados : [predicados];
  const dilatar = opts.dilatar !== false;
  const textos = [];
  const areaRegion =
    (region.x1 - region.x0) * pagina.width * ((region.y1 - region.y0) * pagina.height);

  for (let i = 0; i < lista.length; i++) {
    const mascara = crearMascaraColor(pagina, lista[i], {
      dilatar,
      radio: dilatar ? DILATE_RADIUS : 0,
      region,
    });

    // Fondo claro / máscara inundada → ruido
    if (mascara.pixeles > areaRegion * 0.35) {
      console.log(
        `[ocr-engine] ROI "${nombreRegion}" pred#${i} omitida (ruido ${(
          (100 * mascara.pixeles) /
          areaRegion
        ).toFixed(0)}%)`
      );
      continue;
    }
    console.log(
      `[ocr-engine] ROI "${nombreRegion}" pred#${i} px=${mascara.pixeles}` +
        ` (${pagina.width}x${pagina.height})`
    );
    if (mascara.pixeles < MIN_PIXELES_OCR) continue;

    let bbox = mascara.bbox;
    // Hora fin: quedarse con la franja inferior del bbox (recorta ruido superior)
    if (opts.recortarInferior && bbox) {
      const alto = bbox.maxY - bbox.minY + 1;
      const cut = bbox.minY + Math.floor(alto * 0.3);
      bbox = { ...bbox, minY: Math.min(bbox.maxY - 4, Math.max(bbox.minY, cut)) };
    }

    let roi = recortarRoi(mascara.canvas, bbox, {
      minWidth: ROI_MIN_WIDTH,
      scaleExtra: opts.esHora ? 1.5 : opts.esTitulo ? 1.15 : 1,
      pad: opts.esTitulo ? 20 : 12,
      padBottom: opts.esTitulo ? 36 : 8,
    });
    if (!roi) {
      roi = escalarCanvas(mascara.canvas, {
        minWidth: ROI_MIN_WIDTH,
        scaleExtra: opts.esHora ? 1.5 : 1,
      });
    }
    const texto = await reconocerRoi(
      roi,
      `${nombreRegion}${lista.length > 1 ? `-${i}` : ''}`,
      opts
    );
    if (texto) textos.push(texto);
  }

  return textos.join('\n');
}

async function extraerPorCapas(pagina) {
  const t0 = performance.now();
  await obtenerWorker();

  console.log('[ocr-engine] ROI fijas (concurrente):', ROI_FIJAS);

  const optsTitulo = {
    psm: '6',
    whitelist: null,
    esTitulo: true,
    dilatar: false,
    suprimirCuadricula: false,
  };
  const optsFecha = {
    psm: '7',
    whitelist: WHITELIST_FECHA,
    esFecha: true,
    dilatar: true,
    suprimirCuadricula: true,
    modoLineas: 'hv',
  };
  const optsHora = {
    psm: '7',
    whitelist: WHITELIST_HORA,
    esHora: true,
    dilatar: true,
    suprimirCuadricula: false,
  };

  // Disparo concurrente: prep en paralelo + OCR en cola del singleton
  const [tituloBlanco, fechaRojo, fechaAzul, horaInicio, horaFin] = await Promise.all([
    ocrRegionFija(pagina, 'titulo', PREDICADOS.titulo, optsTitulo),
    ocrRegionFija(pagina, 'fecha', PREDICADOS.rojo, optsFecha),
    ocrRegionFija(pagina, 'fecha', PREDICADOS.azul, optsFecha),
    ocrRegionFija(pagina, 'horaInicio', PREDICADOS.amarillo, optsHora),
    ocrRegionFija(pagina, 'horaFin', PREDICADOS.verde, {
      ...optsHora,
      recortarInferior: true,
    }),
  ]);

  let titulo = tituloBlanco || '';
  if (!titulo || titulo.replace(/\s/g, '').length < 3) {
    const tituloOscuro = await ocrRegionFija(pagina, 'titulo', PREDICADOS.tituloOscuro, {
      ...optsTitulo,
      dilatar: true,
    });
    if (
      tituloOscuro &&
      tituloOscuro.replace(/\s/g, '').length > (titulo || '').replace(/\s/g, '').length
    ) {
      titulo = tituloOscuro;
    }
  }

  const capas = {
    titulo: titulo || '',
    fecha: [fechaRojo, fechaAzul].filter(Boolean).join('\n'),
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
    const pagina = await cargarPaginaComoCanvas(file);
    console.log('[ocr-engine] Página:', pagina.width, 'x', pagina.height);
    return await extraerPorCapas(pagina);
  } catch (err) {
    console.error('[ocr-engine] falló:', err);
    throw err;
  }
}

/**
 * Carga PDF (1ª pág.) o imagen a canvas (máx. 1600 px de ancho).
 * Útil para vista previa + recorte manual.
 */
export async function cargarPaginaComoCanvas(file) {
  if (!file) throw new Error('No se proporcionó ningún archivo.');

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
  return pagina;
}

/**
 * OCR de un recorte manual asignado a un campo concreto.
 * @param {HTMLCanvasElement} recorte
 * @param {'titulo'|'fecha'|'horaInicio'|'horaFin'} campo
 * @returns {Promise<string>} texto crudo de la capa
 */
export async function ocrRecorteManual(recorte, campo) {
  if (!recorte?.width || !recorte?.height) return '';
  await obtenerWorker();

  const optsTitulo = {
    psm: '6',
    whitelist: null,
    esTitulo: true,
    dilatar: false,
    suprimirCuadricula: false,
  };
  const optsFecha = {
    psm: '7',
    whitelist: WHITELIST_FECHA,
    esFecha: true,
    dilatar: true,
    suprimirCuadricula: true,
    modoLineas: 'hv',
  };
  const optsHora = {
    psm: '7',
    whitelist: WHITELIST_HORA,
    esHora: true,
    dilatar: true,
    suprimirCuadricula: false,
  };

  const escalado = escalarCanvas(recorte, {
    minWidth: ROI_MIN_WIDTH,
    scaleExtra:
      campo === 'horaInicio' || campo === 'horaFin' ? 1.5 : campo === 'titulo' ? 1.15 : 1,
  });

  async function porColor(predicados, opts, etiqueta) {
    const lista = Array.isArray(predicados) ? predicados : [predicados];
    const textos = [];
    const area = escalado.width * escalado.height;
    for (let i = 0; i < lista.length; i++) {
      const mascara = crearMascaraColor(escalado, lista[i], {
        dilatar: opts.dilatar !== false,
        radio: opts.dilatar === false ? 0 : DILATE_RADIUS,
      });
      if (mascara.pixeles < MIN_PIXELES_OCR) continue;
      if (mascara.pixeles > area * 0.45) continue;
      let roi = recortarRoi(mascara.canvas, mascara.bbox, {
        minWidth: ROI_MIN_WIDTH,
        scaleExtra: opts.esHora ? 1.5 : 1,
        pad: 10,
        padBottom: 8,
      });
      if (!roi) roi = escalado;
      const t = await reconocerRoi(roi, `${etiqueta}-${i}`, opts);
      if (t) textos.push(t);
    }
    return textos.join('\n');
  }

  if (campo === 'titulo') {
    let t = await porColor(PREDICADOS.titulo, optsTitulo, 'manual-titulo');
    if (!t || t.replace(/\s/g, '').length < 3) {
      t = await reconocerRoi(escalado, 'manual-titulo-libre', optsTitulo);
    }
    if (!t || t.replace(/\s/g, '').length < 3) {
      const osc = await porColor(
        PREDICADOS.tituloOscuro,
        { ...optsTitulo, dilatar: true },
        'manual-titulo-oscuro'
      );
      if (osc && osc.replace(/\s/g, '').length > (t || '').replace(/\s/g, '').length) {
        t = osc;
      }
    }
    return t || '';
  }

  if (campo === 'fecha') {
    const rojo = await porColor(PREDICADOS.rojo, optsFecha, 'manual-fecha-rojo');
    const azul = await porColor(PREDICADOS.azul, optsFecha, 'manual-fecha-azul');
    let t = [rojo, azul].filter(Boolean).join('\n');
    if (!t) t = await reconocerRoi(escalado, 'manual-fecha-libre', optsFecha);
    return t || '';
  }

  if (campo === 'horaInicio') {
    let t = await porColor(PREDICADOS.amarillo, optsHora, 'manual-hi');
    if (!t) t = await reconocerRoi(escalado, 'manual-hi-libre', optsHora);
    return t || '';
  }

  if (campo === 'horaFin') {
    let t = await porColor(PREDICADOS.verde, optsHora, 'manual-hf');
    if (!t) t = await reconocerRoi(escalado, 'manual-hf-libre', optsHora);
    return t || '';
  }

  return '';
}

/**
 * Recorta un rectángulo (coords de imagen) desde un canvas fuente.
 */
export function recortarCanvas(fuente, { x, y, w, h }) {
  if (!fuente) return null;
  const sx = Math.max(0, Math.floor(x));
  const sy = Math.max(0, Math.floor(y));
  const sw = Math.min(fuente.width - sx, Math.ceil(w));
  const sh = Math.min(fuente.height - sy, Math.ceil(h));
  if (sw < 4 || sh < 4) return null;
  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(fuente, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

export async function extraerTexto(file) {
  const { rawText } = await extraerDocumento(file);
  return rawText;
}
