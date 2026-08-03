/**
 * ocr.js — Módulo unificado del cliente OCR (Apps Script / navegador).
 *
 * Secciones encapsuladas en un solo archivo (menos piezas para HtmlService):
 *   1) MOTOR OCR   — zonas, color, Tesseract, recorte manual
 *   2) PARSER      — fechas flexibles → DD-MM-YYYY, horas HH:mm, título, payload GAS
 *   3) API PÚBLICA — procesarDocumento, procesarRecorte, payloadDesdeFormulario
 *
 * Uso:
 *   import { procesarDocumento, construirPayloadGas } from './ocr.js';
 */


/* ==========================================================================
 * 1) MOTOR OCR
 * ========================================================================== */

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
 * Bounding boxes relativos — portadas variables, misma convención:
 * título grande al centro | fecha media-baja | horas abajo.
 * Márgenes holgados para tipografía / manuscrito desplazados.
 */
const ROI_FIJAS = {
  titulo: { x0: 0.08, y0: 0.02, x1: 0.92, y1: 0.52 },
  fecha: { x0: 0.15, y0: 0.45, x1: 0.85, y1: 0.9 },
  horaInicio: { x0: 0, y0: 0.68, x1: 0.45, y1: 1 },
  horaFin: { x0: 0.5, y0: 0.68, x1: 1, y1: 1 },
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
  // Primera línea útil si hay varias basura; si hay 1–2 líneas de título, unir
  const lineas = t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lineas.length <= 2) {
    t = lineas.join(' ');
  } else {
    t = lineas[0];
  }
  t = t.replace(/[,.;:_=\-|~'"“”‘’•·]+/g, ' ');
  t = t.replace(/^[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+/u, '');
  t = t.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+$/u, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Título adaptativo para portadas variables:
 *  - Prioriza el centro (no depende de un PDF concreto)
 *  - Agrupa tipografía grande del mismo tamaño
 *  - Une títulos largos (1–3 renglones) de esa tipografía
 */
function extraerTituloPorTamanoYCentro(data, canvasW, canvasH) {
  const rawWords = Array.isArray(data?.words) ? data.words : [];
  if (!rawWords.length || !canvasW || !canvasH) return '';

  const cxPage = canvasW * 0.5;
  const cyPage = canvasH * 0.28;

  const words = rawWords
    .map((w) => {
      const text = String(w.text || '').replace(/[|]/g, 'I').trim();
      const b = w.bbox || {};
      const x0 = Number(b.x0) || 0;
      const y0 = Number(b.y0) || 0;
      const x1 = Number(b.x1) || 0;
      const y1 = Number(b.y1) || 0;
      const h = Math.max(1, y1 - y0);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      // Peso: grande + centrado (funciona aunque el layout se desplace un poco)
      const distX = Math.abs(cx - cxPage) / canvasW;
      const distY = Math.abs(cy - cyPage) / canvasH;
      const centralidad = Math.max(0, 1 - distX * 2.2 - distY * 1.4);
      return {
        text,
        h,
        cx,
        cy,
        x0,
        y0,
        conf: Number(w.confidence) || 0,
        score: h * (0.45 + centralidad),
      };
    })
    .filter(
      (w) =>
        w.text.length >= 1 &&
        /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/u.test(w.text) &&
        w.conf >= 30 &&
        w.cy <= canvasH * 0.62
    );

  if (!words.length) return '';

  // Candidatos centrales (suave): si casi no hay, usar todas las de la mitad superior
  let centro = words.filter((w) => {
    const nx = Math.abs(w.cx - cxPage) / canvasW;
    return nx <= 0.42 && w.cy <= canvasH * 0.58;
  });
  if (centro.length < 1) {
    centro = words.filter((w) => w.cy <= canvasH * 0.55);
  }
  if (!centro.length) centro = words;

  // Tamaño de referencia = mediana de las palabras más “título” (evita 1 glifo raro)
  const porScore = [...centro].sort((a, b) => b.score - a.score);
  const top = porScore.slice(0, Math.min(8, porScore.length));
  const hs = top.map((w) => w.h).sort((a, b) => a - b);
  const refH = hs[Math.floor(hs.length / 2)] || hs[hs.length - 1];
  const maxH = Math.max(...centro.map((w) => w.h));
  // Misma tipografía: ±30–35% del tamaño de referencia (o cerca del máximo)
  const umbral = Math.max(refH * 0.65, maxH * 0.62);

  let cluster = centro.filter((w) => w.h >= umbral);
  if (cluster.length < 1) cluster = top.slice(0, 4);

  cluster.sort((a, b) => {
    if (Math.abs(a.y0 - b.y0) > refH * 0.6) return a.y0 - b.y0;
    return a.x0 - b.x0;
  });

  const lineas = [];
  let actual = [];
  let lastY = null;
  for (const w of cluster) {
    if (lastY != null && Math.abs(w.y0 - lastY) > refH * 0.9) {
      if (actual.length) lineas.push(actual);
      actual = [];
    }
    actual.push(w);
    lastY = w.y0;
  }
  if (actual.length) lineas.push(actual);
  if (!lineas.length) return '';

  // Mejor línea: más centrada y más larga (títulos variables de 1 palabra o frase)
  lineas.sort((a, b) => {
    const scoreLinea = (ln) => {
      const cya = ln.reduce((s, w) => s + w.cy, 0) / ln.length;
      const cxa = ln.reduce((s, w) => s + w.cx, 0) / ln.length;
      const len = ln.map((w) => w.text).join('').length;
      const dist =
        Math.abs(cya - cyPage) / canvasH + Math.abs(cxa - cxPage) / canvasW;
      const hMed = ln.reduce((s, w) => s + w.h, 0) / ln.length;
      return hMed * 2 + len * 0.35 - dist * 40;
    };
    return scoreLinea(b) - scoreLinea(a);
  });

  const principal = lineas[0];
  const cy0 = principal.reduce((s, w) => s + w.cy, 0) / principal.length;
  const extras = lineas.slice(1).filter((ln) => {
    const cy = ln.reduce((s, w) => s + w.cy, 0) / ln.length;
    return Math.abs(cy - cy0) <= refH * 2.1;
  });

  const bloques = [principal, ...extras].sort((a, b) => a[0].y0 - b[0].y0);
  const texto = bloques
    .map((ln) => ln.map((w) => w.text).join(' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return limpiarTituloOcr(texto);
}

/** ¿Parece fecha usable (numérica, compacta o con mes textual)? */
function capaFechaUtil(texto) {
  const t = String(texto || '');
  if (!t.trim()) return false;
  if (
    /\d{1,2}\s*[-/.\s]*(?:de\s+)?[A-Za-zÁÉÍÓÚáéíóúüñ]{3,}\s*[-/.\s]*(?:de\s+)?\d{2,4}/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\b\d{4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}\b/.test(t)) return true;
  if (/\d{1,2}\s*[-/=._~:/]\s*\d{1,2}\s*[-/=._~:/]\s*\d{2,4}/.test(t)) {
    return true;
  }
  const digitos = t.replace(/\D/g, '');
  if (digitos.length === 6 || digitos.length === 8) {
    const mes = Number(digitos.slice(2, 4));
    const dia = Number(digitos.slice(0, 2));
    return dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12;
  }
  return false;
}

function capaHoraUtil(texto) {
  const t = String(texto || '');
  if (!t.trim()) return false;
  return (
    /\d{1,2}\s*[:.]\s*[0-5]\d/.test(t) ||
    /\b([01]\d|2[0-3])[0-5]\d\b/.test(t) ||
    /\b([01]?\d|2[0-3])\s+[0-5]\d\b/.test(t)
  );
}

function scoreTituloCapa(texto) {
  const s = String(texto || '').trim();
  if (!s) return -1;
  const words = s.split(/\s+/).filter((w) => /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}/u.test(w));
  if (!words.length) return -1;
  const avg = words.reduce((a, w) => a + w.length, 0) / words.length;
  const letters = (s.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/gu) || []).length;
  // Premiar títulos largos coherentes; castigar sopa de tokens cortos
  let score = letters * 0.55 + avg * 2.2;
  if (words.length >= 1 && words.length <= 8 && avg >= 3) score += 8;
  if (avg < 2.8 && words.length >= 3) score -= 10;
  return score;
}

function capaTituloUtil(texto) {
  return scoreTituloCapa(texto) >= 4;
}

function pareceSalidaUtil(texto, tipo) {
  if (tipo === 'fecha') return capaFechaUtil(texto);
  if (tipo === 'hora') return capaHoraUtil(texto);
  return String(texto || '').trim().length > 0;
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
          if (
            tipo === 'fecha' &&
            /\d{1,2}\s*[-/.\s]*[A-Za-zÁÉÍÓÚáéíóúüñ]{3,}/i.test(t)
          ) {
            return 4;
          }
          if (tipo === 'fecha' && /\d{1,2}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{2,4}/.test(t)) {
            return 3;
          }
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
      if (esTitulo) {
        const porTamano = extraerTituloPorTamanoYCentro(
          data,
          preparado.width,
          preparado.height
        );
        texto = porTamano || limpiarTituloOcr(texto);
      }
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
    if (mascara.pixeles > areaRegion * 0.28) {
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

/**
 * OCR de una ROI fija SIN filtro de color (texto digital/negro legible).
 * Recorta la zona y manda el bloque a Tesseract.
 */
async function ocrRegionSinColor(pagina, nombreRegion, opts = {}) {
  let region = ROI_FIJAS[nombreRegion];
  if (!region || !pagina) return '';

  // Título: banda central holgada (portadas tipográficas / manuscritas variables)
  if (nombreRegion === 'titulo') {
    region = { x0: 0.1, y0: 0.04, x1: 0.9, y1: 0.48 };
  }
  // Fecha tipográfica: centro (donde suele ir 30-Julio-2026)
  if (nombreRegion === 'fecha') {
    region = { x0: 0.1, y0: 0.35, x1: 0.9, y1: 0.85 };
  }
  // Horas tipográficas: franja inferior un poco más alta
  if (nombreRegion === 'horaInicio') {
    region = { x0: 0, y0: 0.65, x1: 0.45, y1: 1 };
  }
  if (nombreRegion === 'horaFin') {
    region = { x0: 0.5, y0: 0.65, x1: 1, y1: 1 };
  }

  const zona = recortarRegionFija(pagina, region);
  if (!zona) return '';

  const roi = escalarCanvas(zona, {
    minWidth: ROI_MIN_WIDTH,
    scaleExtra: opts.esHora ? 1.5 : opts.esTitulo ? 1.1 : 1.15,
  });
  if (!roi) return '';

  console.log(
    `[ocr-engine] ROI gris "${nombreRegion}" ${zona.width}x${zona.height} (sin color)`
  );
  return reconocerRoi(roi, `${nombreRegion}-gris`, opts);
}

function textoUtilCapa(t, minLen = 2) {
  return String(t || '').replace(/\s/g, '').length >= minLen;
}

async function extraerPorCapas(pagina) {
  const t0 = performance.now();
  await obtenerWorker();

  console.log('[ocr-engine] Solo 1ª página/diapositiva | ROI:', ROI_FIJAS);

  const optsTitulo = {
    psm: '6',
    whitelist: null,
    esTitulo: true,
    dilatar: false,
    suprimirCuadricula: false,
  };
  // Fecha libre: permite "30-Julio-2026" (el parser normaliza).
  // Sin whitelist ni opening de cuadrícula: en diapositivas tipográficas
  // la morfología llega a comerse letras del mes.
  const optsFechaLibre = {
    psm: '6',
    whitelist: null,
    esFecha: true,
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

  // 1) Capas por color (libretas manuscritas) en paralelo
  const [tituloBlanco, fechaRojo, fechaAzul, horaInicioColor, horaFinColor] = await Promise.all([
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
  if (!capaTituloUtil(titulo)) {
    const tituloOscuro = await ocrRegionFija(pagina, 'titulo', PREDICADOS.tituloOscuro, {
      ...optsTitulo,
      dilatar: true,
    });
    if (scoreTituloCapa(tituloOscuro) > scoreTituloCapa(titulo)) {
      titulo = tituloOscuro;
    }
  }

  let fecha = [fechaRojo, fechaAzul].filter(Boolean).join('\n');
  // Desechar basura de color (fondos morados → "-04", etc.)
  if (!capaFechaUtil(fecha)) fecha = '';
  let horaInicio = capaHoraUtil(horaInicioColor) ? horaInicioColor : '';
  let horaFin = capaHoraUtil(horaFinColor) ? horaFinColor : '';

  // 2) Fallback gris: diapositivas/PDF con texto negro (sin tinta de color)
  //    También si el color dio texto pero NO una fecha/hora válida.
  const needTitulo = !capaTituloUtil(titulo);
  const needFecha = !capaFechaUtil(fecha);
  const needHi = !capaHoraUtil(horaInicio);
  const needHf = !capaHoraUtil(horaFin);

  if (needTitulo || needFecha || needHi || needHf) {
    console.log('[ocr-engine] Fallback ROI sin color:', {
      needTitulo,
      needFecha,
      needHi,
      needHf,
    });
    const [tGris, fGris, hiGris, hfGris] = await Promise.all([
      // Siempre reintentar título en gris: el color blanco a veces lee ruido
      ocrRegionSinColor(pagina, 'titulo', optsTitulo),
      needFecha ? ocrRegionSinColor(pagina, 'fecha', optsFechaLibre) : Promise.resolve(''),
      needHi ? ocrRegionSinColor(pagina, 'horaInicio', optsHora) : Promise.resolve(''),
      needHf ? ocrRegionSinColor(pagina, 'horaFin', optsHora) : Promise.resolve(''),
    ]);
    if (scoreTituloCapa(tGris) > scoreTituloCapa(titulo)) titulo = tGris;
    if (needFecha && capaFechaUtil(fGris)) fecha = fGris;
    if (needHi && capaHoraUtil(hiGris)) horaInicio = hiGris;
    if (needHf && capaHoraUtil(hfGris)) horaFin = hfGris;
  }

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
    console.log('[ocr-engine] PDF: solo página/diapositiva 1 de', doc.numPages);
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
  // Libre: conserva "Julio" / abreviaturas; sin whitelist numérica
  const optsFechaLibre = {
    psm: '6',
    whitelist: null,
    esFecha: true,
    dilatar: false,
    suprimirCuadricula: false,
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
      campo === 'horaInicio' || campo === 'horaFin'
        ? 1.5
        : campo === 'titulo'
          ? 1.15
          : 1.2,
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
      // Fondos saturados (morado) no son tinta de fecha
      if (mascara.pixeles > area * 0.28) continue;
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
    const libre = await reconocerRoi(escalado, 'manual-titulo-libre', optsTitulo);
    if (scoreTituloCapa(libre) > scoreTituloCapa(t)) t = libre;
    if (!capaTituloUtil(t)) {
      const osc = await porColor(
        PREDICADOS.tituloOscuro,
        { ...optsTitulo, dilatar: true },
        'manual-titulo-oscuro'
      );
      if (scoreTituloCapa(osc) > scoreTituloCapa(t)) t = osc;
    }
    return t || '';
  }

  if (campo === 'fecha') {
    // 1) OCR libre primero (diapositivas tipográficas: 30-Julio-2026)
    const libre = await reconocerRoi(escalado, 'manual-fecha-libre', optsFechaLibre);
    if (capaFechaUtil(libre)) return libre;

    // 2) Color manuscrito (rojo/azul) solo si parsea como fecha real
    const rojo = await porColor(PREDICADOS.rojo, optsFecha, 'manual-fecha-rojo');
    const azul = await porColor(PREDICADOS.azul, optsFecha, 'manual-fecha-azul');
    const color = [rojo, azul].filter(Boolean).join('\n');
    if (capaFechaUtil(color)) return color;

    // 3) Sin fecha válida → vacío (evita "-04" en el input)
    return '';
  }

  if (campo === 'horaInicio') {
    let t = await porColor(PREDICADOS.amarillo, optsHora, 'manual-hi');
    if (!capaHoraUtil(t)) {
      const libre = await reconocerRoi(escalado, 'manual-hi-libre', optsHora);
      if (capaHoraUtil(libre)) t = libre;
    }
    return capaHoraUtil(t) ? t : '';
  }

  if (campo === 'horaFin') {
    let t = await porColor(PREDICADOS.verde, optsHora, 'manual-hf');
    if (!capaHoraUtil(t)) {
      const libre = await reconocerRoi(escalado, 'manual-hf-libre', optsHora);
      if (capaHoraUtil(libre)) t = libre;
    }
    return capaHoraUtil(t) ? t : '';
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

/* ==========================================================================
 * 2) PARSER (fechas flexibles, horas, título, payload GAS)
 * ========================================================================== */

const SUFIJO_HORA = String.raw`(?:[bh]r[s5]|[bh]rs?|hos|hs|h|[ap]\.?m\.?)`;

/**
 * Numérica flexible: DD-MM-YYYY, D/M/YY, DD - MM - YYYY, etc.
 * Separadores: - / . _ = ~ : (con espacios opcionales alrededor).
 */
const REGEX_FECHA_NUM =
  /(\d{1,2})\s*[-/=._~:]\s*(\d{1,2})\s*[-/=._~:]\s*(\d{2,4})/;

const REGEX_FECHA_NUM_GLOBAL =
  /(\d{1,2})\s*[-/=._~:]\s*(\d{1,2})\s*[-/=._~:]\s*(\d{2,4})/g;

/** Solo espacios entre tokens (cuadrícula): "3 7 26" / "03 07 2026" */
const REGEX_FECHA_ESPACIOS =
  /\b(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})\b/;

const REGEX_FECHA_ESPACIOS_GLOBAL =
  /\b(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})\b/g;

const MESES = {
  enero: '01', ene: '01', jan: '01', january: '01',
  febrero: '02', feb: '02', february: '02',
  marzo: '03', mar: '03', march: '03',
  abril: '04', abr: '04', apr: '04', april: '04',
  mayo: '05', may: '05',
  junio: '06', jun: '06', june: '06',
  julio: '07', jul: '07', july: '07',
  agosto: '08', ago: '08', aug: '08', august: '08',
  septiembre: '09', setiembre: '09', sep: '09', sept: '09', september: '09',
  octubre: '10', oct: '10', october: '10',
  noviembre: '11', nov: '11', november: '11',
  diciembre: '12', dic: '12', dec: '12', december: '12',
};

/** Meses para regex (completos EN primero, luego ES/abrev.) */
const MES_ALT =
  'January|February|March|April|June|July|August|September|October|November|December|' +
  'Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Setiembre|Octubre|Noviembre|Diciembre|' +
  'Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Sept|Set|Oct|Nov|Dic|' +
  'Jan|Apr|Aug|Oct|Nov|Dec';

/** 27-Julio-2026, 30/Julio/2026, 03 de Julio de 2026, 30 Jul 2026 */
const REGEX_FECHA_TEXTO = new RegExp(
  String.raw`(\d{1,2})\s*[-/.\s]*(?:de\s+)?([A-Za-zÁÉÍÓÚáéíóúüñ]{3,})\s*[-/.\s]*(?:de\s+)?(\d{2,4})`,
  'i'
);

const REGEX_FECHA_TEXTO_GLOBAL = new RegExp(
  String.raw`(\d{1,2})\s*[-/.\s]*(?:de\s+)?(${MES_ALT})\s*[-/.\s]*(?:de\s+)?(\d{2,4})`,
  'gi'
);

/** ISO / invertido: 2026-07-30, 2026/07/30 */
const REGEX_FECHA_ISO =
  /(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/;

export function esRuidoOcr(texto) {
  if (!texto || !String(texto).trim()) return true;

  const limpio = String(texto).replace(/\s+/g, ' ').trim();
  if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/.test(limpio)) return true;

  const tokens = limpio.split(/\s+/).filter(Boolean);
  const alfanum = (limpio.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/g) || []).length;
  const simbolos = (limpio.match(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9\s]/g) || []).length;

  if (alfanum <= 3 && simbolos >= 2) return true;
  if (simbolos > alfanum) return true;

  const utiles = tokens.filter(
    (t) => /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}/.test(t) || /\d/.test(t)
  );
  if (utiles.length === 0) return true;

  const palabras = tokens.filter((t) => /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(t));
  const mono = palabras.filter((t) => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]$/u.test(t));
  if (palabras.length >= 2 && mono.length / palabras.length >= 0.55) return true;

  return false;
}

function sanitizarCapa(texto) {
  if (esRuidoOcr(texto)) return '';
  return String(texto).trim();
}

function prepararTextoFechaHora(texto) {
  return String(texto || '')
    .replace(/^[\s.,;:_=\-|~'"“”‘’•·]+/g, '')
    .replace(/[\s.,;:_=\-|~'"“”‘’•·]+$/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function pareceFechaLegible(texto) {
  const t = String(texto || '');
  return (
    /\d{1,2}\s*[-/=._~:]\s*\d{1,2}\s*[-/=._~:]\s*\d{2,4}/.test(t) ||
    /\d{1,2}\s*[-/.\s]+[A-Za-zÁÉÍÓÚáéíóúüñ]{3,}/i.test(t)
  );
}

function pareceHoraLegible(texto) {
  const t = String(texto || '');
  return (
    /\d{1,2}\s*[:;.\s-]?\s*\d{2}/.test(t) ||
    /\b\d{3,4}\b/.test(t) ||
    new RegExp(String.raw`\d{1,2}.+\b${SUFIJO_HORA}\b`, 'i').test(t)
  );
}

/** Limpieza de sufijos/separadores — NO inventa dígitos. */
function normalizarRuidoOcr(texto) {
  return String(texto || '')
    .replace(/\bhos\b/gi, ' ')
    .replace(/\bhes\b/gi, ' ')
    .replace(/\bhe5\b/gi, ' ')
    .replace(/\bh5\b/gi, ' ')
    .replace(/\bhs\b/gi, ' ')
    .replace(/\bhrs?\b/gi, ' ')
    .replace(/\bbr5\b/gi, ' ')
    .replace(/\bhr5\b/gi, ' ')
    .replace(/\bhns\b/gi, ' ')
    .replace(/\bbrs\b/gi, ' ')
    // Tipografía OCR: el 3 manuscrito a menudo se lee como "s"
    .replace(/\b([01]?\d|2[0-3])\s*[sS]([0-5]\d)\b/g, '$1:3$2')
    .replace(/\b([01]?\d|2[0-3])\s*[sS][0Oo]\b/g, '$1:30')
    // "14 ODh" / "14 ODA" (00 manuscrito → OD)
    .replace(/\b([01]?\d|2[0-3])\s*[OoD]{1,2}[A-Za-z]*\b/g, '$1:00')
    .replace(/[=_~]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/[.]{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Confusiones visuales aisladas (no toca letras de meses). */
function corregirDigitosCandidato(texto) {
  return String(texto || '')
    .replace(/(?<![A-Za-zÁÉÍÓÚáéíóú])[OoD](?![A-Za-zÁÉÍÓÚáéíóú])/g, '0')
    .replace(/(?<![A-Za-zÁÉÍÓÚáéíóú])[Il|](?![A-Za-zÁÉÍÓÚáéíóú])/g, '1')
    .replace(/(?<![A-Za-zÁÉÍÓÚáéíóú])[Zz](?![A-Za-zÁÉÍÓÚáéíóú])/g, '2')
    .replace(/[¢©]/g, '6')
    .replace(/[£]/g, '1');
}

/**
 * Corrige mes OCR fuera de 1–12 (trazos/cuadrícula).
 * Ej.: 17→07, 70→07, 13→03. Si no hay corrección fiable → null.
 */
function corregirMesOcr(mes) {
  let mi = Number(mes);
  if (Number.isNaN(mi)) return null;
  if (mi >= 1 && mi <= 12) return mi;

  // 13–19: dígito líder "1" fantasma → 3–9
  if (mi >= 13 && mi <= 19) {
    const r = mi % 10;
    if (r >= 1 && r <= 9) return r;
  }

  // 70–79: "7" + ruido (p. ej. 70≈07)
  if (mi >= 70 && mi <= 79) {
    if (mi === 70) return 7;
    const r = mi % 10;
    if (r >= 1 && r <= 9) return r;
  }

  // 21–29: a veces "2" de cuadrícula delante del mes
  if (mi >= 21 && mi <= 29) {
    const r = mi % 10;
    if (r >= 1 && r <= 9) return r;
  }

  return null;
}

/**
 * Corrige día OCR fuera de 1–31. Si no es recuperable → null.
 */
function corregirDiaOcr(dia) {
  let di = Number(dia);
  if (Number.isNaN(di)) return null;
  if (di >= 1 && di <= 31) return di;

  // 32–39: líder "3" + dígito (poco fiable) → ignorar salvo 30/31 ya válidos
  if (di >= 40 && di <= 49) {
    const r = di % 10;
    if (r >= 1 && r <= 9) return r;
  }

  return null;
}

/**
 * Expande año a 4 dígitos: 26→2026, 99→1999 (umbral 70).
 */
function normalizarAnioCompleto(anio) {
  let a = String(anio || '').replace(/\D/g, '');
  if (!a) return '';
  if (a.length >= 4) {
    a = a.slice(-4);
    const n = Number(a);
    if (n < 1900 || n > 2100) return '';
    return a;
  }
  a = a.padStart(2, '0');
  if (a.length !== 2) return '';
  const yy = Number(a);
  if (Number.isNaN(yy) || yy < 0 || yy > 99) return '';
  return String(yy >= 70 ? 1900 + yy : 2000 + yy);
}

/**
 * Normaliza a DD-MM-YYYY con validación de rangos (día 01–31, mes 01–12).
 */
function normalizarFechaPartes(dia, mes, anio) {
  if (dia == null || mes == null || anio == null) return '';
  if (dia === '' || mes === '' || anio === '') return '';

  let di = corregirDiaOcr(dia);
  let mi = corregirMesOcr(mes);

  // Si el mes sigue inválido pero el "día" es un mes válido, invertir (MM-DD leído como DD-MM)
  if (mi == null) {
    const diaComoMes = corregirMesOcr(dia);
    const mesComoDia = corregirDiaOcr(mes);
    if (diaComoMes != null && mesComoDia != null) {
      di = mesComoDia;
      mi = diaComoMes;
    }
  }

  if (di == null || mi == null) return '';

  const a = normalizarAnioCompleto(anio);
  if (!a) return '';

  // Revalidación final de rangos
  if (di < 1 || di > 31 || mi < 1 || mi > 12) return '';

  return `${String(di).padStart(2, '0')}-${String(mi).padStart(2, '0')}-${a}`;
}

/** Salida estándar 24h: HH:mm (sin "hrs" ni sufijos). */
function formatearHora(h, m) {
  if (h == null || m == null) return '';
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Valida hora en formato 24h (00:00–23:59).
 * Descarta ruido OCR típico: madrugada &lt; 06 (salvo que se relaje),
 * minutos fuera de rejilla de 5.
 */
export function esHoraPlausible(hi, mi) {
  if (Number.isNaN(hi) || Number.isNaN(mi)) return false;
  if (hi < 0 || hi > 23 || mi < 0 || mi > 59) return false;
  // 00–05:xx casi siempre es ruido de cuadrícula en portadas de capacitación
  if (hi < 6) return false;
  // Minutos "sucios" (17, 35, 41…) → alucinación; forzar rejilla de 5
  if (mi % 5 !== 0) return false;
  return true;
}

/**
 * Normaliza a HH:mm (24h) limpio o "" si no es plausible.
 */
export function normalizarHoraLimpia(h, m) {
  const hi = Number(h);
  const mi = Number(m);
  if (!esHoraPlausible(hi, mi)) return '';
  return formatearHora(hi, mi);
}

/**
 * Limpia leet-speak OCR en títulos manuscritos.
 * Ej.: "1510N" → "ISION", "Prue8a" → "Prueba"
 */
export function limpiarLeetSpeakTitulo(texto) {
  if (!texto) return '';

  const mapa = {
    0: 'O', 1: 'I', 2: 'Z', 3: 'E', 4: 'A',
    5: 'S', 6: 'G', 7: 'T', 8: 'B', 9: 'G',
  };

  return String(texto).replace(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+/gu, (token) => {
    if (/^\d{1,3}$/.test(token)) return token;

    const tieneLetra = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/u.test(token);
    const tieneDigito = /\d/.test(token);
    if (!tieneDigito) return token;
    if (!tieneLetra && token.length <= 3) return token;

    return token.replace(/\d/g, (d, offset) => {
      const letter = mapa[d] || d;
      const prev = token[offset - 1] || '';
      const next = token[offset + 1] || '';
      const lowerCtx =
        /[a-záéíóúüñ]/.test(prev) || /[a-záéíóúüñ]/.test(next);
      return lowerCtx ? letter.toLowerCase() : letter;
    });
  });
}

function limpiarTitulo(titulo) {
  if (!titulo) return '';

  let t = String(titulo).trim();
  t = t.split('\n').map((l) => l.trim()).find(Boolean) || t;

  t = t.replace(/^[\-–—_=|]+\s*(?=[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/u, 'P');
  t = t.replace(/^P\s+(?=[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/u, 'P');

  t = limpiarLeetSpeakTitulo(t);

  const digitoALetra = {
    0: 'O', 1: 'I', 3: 'E', 4: 'A', 5: 'S', 6: 'G', 8: 'B', 9: 'G',
  };
  t = t.replace(
    /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])([0-9])([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/gu,
    (_, a, d, b) => a + (digitoALetra[d] || d) + b
  );

  // "Ueha, CLR" → "Ueha CLR"
  t = t.replace(/[,.;:_=\-|~'"“”‘’•·]+/g, ' ');
  t = t.replace(/^[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+/u, '');
  t = t.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+$/u, '');
  t = t.replace(/\s+/g, ' ').trim();

  if (t.length > 0) {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }

  if (esRuidoOcr(t)) return '';
  return t;
}

/**
 * Nombre sugerido: el título limpio es el campo maestro.
 */
export function construirNombreSugerido(titulo, fecha = '') {
  const t = String(titulo || '').trim();
  if (!t) return '';
  const base = t.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();
  if (!base) return '';
  const f = String(fecha || '').trim();
  return f ? `${base} ${f}` : base;
}

export function extraerFecha(texto) {
  if (!texto || !String(texto).trim()) return '';

  let base = prepararTextoFechaHora(texto);
  if (!base) return '';

  let normalizado = corregirDigitosCandidato(base);
  normalizado = normalizarRuidoOcr(normalizado);
  normalizado = prepararTextoFechaHora(normalizado);

  const mesKeyOf = (raw) =>
    String(raw || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

  // 1) Prioridad: fechas con nombre de mes (30-Julio-2026, 30/Julio/2026)
  REGEX_FECHA_TEXTO_GLOBAL.lastIndex = 0;
  let mTxtG;
  while ((mTxtG = REGEX_FECHA_TEXTO_GLOBAL.exec(normalizado)) !== null) {
    const mesNum = MESES[mesKeyOf(mTxtG[2])];
    if (mesNum) {
      const fecha = normalizarFechaPartes(mTxtG[1], mesNum, mTxtG[3]);
      if (fecha) return fecha;
    }
  }

  const mTxt = normalizado.match(REGEX_FECHA_TEXTO);
  if (mTxt) {
    const mesNum = MESES[mesKeyOf(mTxt[2])];
    if (mesNum) {
      const fecha = normalizarFechaPartes(mTxt[1], mesNum, mTxt[3]);
      if (fecha) return fecha;
    }
  }

  // 2) ISO YYYY-MM-DD → DD-MM-YYYY
  const mIso = normalizado.match(REGEX_FECHA_ISO);
  if (mIso) {
    const fecha = normalizarFechaPartes(mIso[3], mIso[2], mIso[1]);
    if (fecha) return fecha;
  }

  // 3) Numérica flexible: DD-MM-YYYY, D/M/YY, DD - MM - YYYY…
  const soloNum = normalizado
    .replace(/[^0-9\-/.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  REGEX_FECHA_NUM_GLOBAL.lastIndex = 0;
  let mGlobal;
  while ((mGlobal = REGEX_FECHA_NUM_GLOBAL.exec(soloNum)) !== null) {
    const fecha = normalizarFechaPartes(mGlobal[1], mGlobal[2], mGlobal[3]);
    if (fecha) return fecha;
  }

  const mNum = soloNum.match(REGEX_FECHA_NUM) || normalizado.match(REGEX_FECHA_NUM);
  if (mNum) {
    const fecha = normalizarFechaPartes(mNum[1], mNum[2], mNum[3]);
    if (fecha) return fecha;
  }

  // 3b) Tokens separados solo por espacios (cuadrícula): "3 7 26"
  REGEX_FECHA_ESPACIOS_GLOBAL.lastIndex = 0;
  let mEsp;
  while ((mEsp = REGEX_FECHA_ESPACIOS_GLOBAL.exec(soloNum)) !== null) {
    const fecha = normalizarFechaPartes(mEsp[1], mEsp[2], mEsp[3]);
    if (fecha) return fecha;
  }
  const mEsp1 = soloNum.match(REGEX_FECHA_ESPACIOS);
  if (mEsp1) {
    const fecha = normalizarFechaPartes(mEsp1[1], mEsp1[2], mEsp1[3]);
    if (fecha) return fecha;
  }

  // 4) Compacto 6–8 dígitos: DDMMYY / DDMMYYYY
  const digitos = soloNum.replace(/\D/g, '');
  if (digitos.length === 6 || digitos.length === 8) {
    const fecha = normalizarFechaPartes(
      digitos.slice(0, 2),
      digitos.slice(2, 4),
      digitos.slice(4)
    );
    if (fecha) return fecha;
  }

  return '';
}

export function extraerHoras(texto) {
  if (!texto || !String(texto).trim()) return [];

  let normalizado = prepararTextoFechaHora(texto);
  normalizado = normalizarRuidoOcr(normalizado);
  normalizado = corregirDigitosCandidato(normalizado);

  const plano = normalizado
    .replace(new RegExp(String.raw`\b${SUFIJO_HORA}\b`, 'gi'), ' ')
    .replace(/[^\d:.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!plano) return [];

  const encontradas = [];
  const vistas = new Set();

  const agregar = (h, m) => {
    const limpia = normalizarHoraLimpia(h, m);
    if (!limpia) return;
    if (vistas.has(limpia)) return;
    vistas.add(limpia);
    encontradas.push(limpia);
  };

  let m;
  const conSeparador = /\b(\d{1,2})\s*[:.]\s*(\d{2})\b/g;
  while ((m = conSeparador.exec(plano)) !== null) {
    agregar(m[1], m[2]);
  }

  if (encontradas.length === 0) {
    // Emparejar tokens numéricos consecutivos (evita que "00 14 00" se coma el 14:00)
    const nums = plano.match(/\b\d{1,2}\b/g) || [];
    for (let i = 0; i < nums.length - 1; i++) {
      const hi = Number(nums[i]);
      const mi = Number(nums[i + 1]);
      if (hi <= 23 && mi <= 59 && String(nums[i + 1]).length === 2) {
        agregar(nums[i], nums[i + 1]);
      }
    }
  }

  if (encontradas.length === 0) {
    const compacto = /\b([01]\d|2[0-3])([0-5]\d)\b/g;
    while ((m = compacto.exec(plano)) !== null) {
      agregar(m[1], m[2]);
    }
  }

  return encontradas;
}

function elegirHoraInicio(horas) {
  if (!horas?.length) return '';
  const enPunto = horas.filter((h) => /:(00|30)$/.test(h));
  if (enPunto.length) return enPunto[0];
  return horas[0];
}

function elegirHoraFin(horas) {
  if (!horas?.length) return '';
  const enPunto = horas.filter((h) => /:(00|30)$/.test(h));
  if (enPunto.length) return enPunto[enPunto.length - 1];
  return horas[horas.length - 1];
}

const MESES_NOM = [
  '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

const MESES_ABR = [
  '', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
];

export function formatearFechaTxt(fechaNo) {
  if (!fechaNo) return '';
  const m = String(fechaNo).match(/^(\d{2})-(\d{2})-(\d{2,4})$/);
  if (!m) return '';
  const dia = m[1];
  const mes = Number(m[2]);
  let anio = m[3];
  if (anio.length === 2) anio = normalizarAnioCompleto(anio);
  if (!anio || mes < 1 || mes > 12) return '';
  return `${dia}-${MESES_ABR[mes]}-${anio} (${dia}-${MESES_NOM[mes]}-${anio})`;
}

export function formatearResultadoLegible(datos) {
  const d = datos || {};
  const fechaTxt = d.fechaTxt || formatearFechaTxt(d.fecha) || '';
  const tituloPdf = d.tituloPdf || d.titulo || '';

  return [
    `Titulo: ${d.titulo || ''}`,
    `Fecha IxT: ${fechaTxt}`,
    `Fecha No: ${d.fecha || ''}`,
    `Hora Inicio: ${d.horaInicio || ''}`,
    `Hora Fin: ${d.horaFin || ''}`,
    '',
    `Titulo de PDF: ${tituloPdf}`,
  ].join('\n');
}

/**
 * @param {string} textoRaw
 * @param {string} [nombreArchivo='']
 * @param {object|null} [capas=null]
 */
export function parsearTextoCapacitacion(textoRaw, nombreArchivo = '', capas = null) {
  const c = capas || {};

  const tituloCapa = sanitizarCapa(c.titulo || '');
  const fechaRaw = String(c.fecha || '').trim();
  const horaInicioRaw = String(c.horaInicio || '').trim();
  const horaFinRaw = String(c.horaFin || '').trim();

  // Título fluido → campo Título + Nombre sugerido
  let titulo = tituloCapa ? limpiarTitulo(tituloCapa) : '';
  if (!titulo && nombreArchivo) {
    titulo = limpiarTitulo(nombreArchivo.replace(/\.[^.]+$/, '')) || '';
  }

  // Fecha: localizar patrón regex en el texto de la zona (ignorar basura)
  let fecha = '';
  if (fechaRaw) {
    fecha = extraerFecha(fechaRaw);
  }
  if (!fecha && textoRaw) {
    fecha = extraerFecha(textoRaw);
  }

  let horasInicio = [];
  if (horaInicioRaw && (pareceHoraLegible(horaInicioRaw) || /\d/.test(horaInicioRaw))) {
    horasInicio = extraerHoras(horaInicioRaw);
  }

  let horasFin = [];
  if (horaFinRaw && (pareceHoraLegible(horaFinRaw) || /\d/.test(horaFinRaw))) {
    horasFin = extraerHoras(horaFinRaw);
  }

  const horaInicio = elegirHoraInicio(horasInicio);
  let horaFin = elegirHoraFin(horasFin);
  if (!horaFin && horasInicio[1]) horaFin = elegirHoraFin(horasInicio.slice(1));

  const fechaTxt = formatearFechaTxt(fecha);
  const tituloPdf = titulo;
  const nombreSugerido = construirNombreSugerido(titulo, fecha);

  const datos = {
    titulo,
    fecha,
    fechaTxt,
    horaInicio,
    horaFin,
    tituloPdf,
    nombreSugerido,
  };

  return {
    ...datos,
    /** Payload plano listo para google.script.run / Code.gs */
    gas: construirPayloadGas(datos),
  };
}

/**
 * Estructura limpia para Google Apps Script (Drive / Hojas).
 * @param {object} datos
 * @param {object} [extras] p. ej. { fileId, spreadsheetId }
 */
export function construirPayloadGas(datos = {}, extras = {}) {
  return {
    titulo: String(datos.titulo || '').trim(),
    fecha: String(datos.fecha || '').trim(),
    horaInicio: String(datos.horaInicio || '').trim(),
    horaFin: String(datos.horaFin || '').trim(),
    nombreSugerido: String(datos.nombreSugerido || '').trim(),
    fechaTxt: String(datos.fechaTxt || '').trim(),
    ...extras,
  };
}

/* ==========================================================================
 * 3) API PÚBLICA
 * ========================================================================== */

const DATOS_VACIOS = {
  titulo: '',
  fecha: '',
  fechaTxt: '',
  horaInicio: '',
  horaFin: '',
  tituloPdf: '',
  nombreSugerido: '',
};

/**
 * Procesa la primera página de un PDF o imagen y extrae
 * Título, Fecha, Hora de Inicio y Hora de Fin (24h HH:mm).
 *
 * @param {File|Blob} file
 */
export async function procesarDocumento(file) {
  try {
    if (!file) {
      const vacio = { ...DATOS_VACIOS, gas: construirPayloadGas(DATOS_VACIOS) };
      return {
        exito: false,
        datos: vacio,
        resumen: formatearResultadoLegible(DATOS_VACIOS),
        rawText: '',
        error: 'No se proporcionó ningún archivo.',
      };
    }

    const nombreArchivo = file.name || '';
    const { rawText, capas } = await extraerDocumento(file);
    const datos = parsearTextoCapacitacion(rawText, nombreArchivo, capas);
    const resumen = formatearResultadoLegible(datos);

    return {
      exito: true,
      datos,
      /** Alias explícito del payload para Code.gs */
      gas: datos.gas || construirPayloadGas(datos),
      resumen,
      rawText,
    };
  } catch (err) {
    const datosBase = {
      ...DATOS_VACIOS,
      titulo: file?.name ? String(file.name).replace(/\.[^.]+$/, '') : '',
      tituloPdf: file?.name ? String(file.name).replace(/\.[^.]+$/, '') : '',
    };
    datosBase.nombreSugerido = datosBase.titulo;
    const datos = { ...datosBase, gas: construirPayloadGas(datosBase) };
    return {
      exito: false,
      datos,
      gas: datos.gas,
      resumen: formatearResultadoLegible(datosBase),
      rawText: '',
      error: err?.message || String(err),
    };
  }
}

/**
 * OCR aislado de un recorte manual → valor normalizado del campo.
 * @param {HTMLCanvasElement} canvasRecorte
 * @param {'titulo'|'fecha'|'horaInicio'|'horaFin'} campo
 */
export async function procesarRecorte(canvasRecorte, campo) {
  const camposOk = new Set(['titulo', 'fecha', 'horaInicio', 'horaFin']);
  if (!camposOk.has(campo)) {
    return { exito: false, campo, valor: '', rawText: '', error: 'Campo inválido.' };
  }

  try {
    const rawText = await ocrRecorteManual(canvasRecorte, campo);
    const capas = { titulo: '', fecha: '', horaInicio: '', horaFin: '' };
    capas[campo] = rawText || '';
    const datos = parsearTextoCapacitacion(rawText || '', '', capas);
    const valor = datos[campo] || '';
    return {
      exito: true,
      campo,
      valor,
      rawText: rawText || '',
      datos,
      gas: datos.gas || construirPayloadGas(datos),
    };
  } catch (err) {
    return {
      exito: false,
      campo,
      valor: '',
      rawText: '',
      error: err?.message || String(err),
    };
  }
}

/**
 * Arma el payload actual desde los inputs de la UI (sin re-OCR).
 * Útil antes de llamar a google.script.run.aplicarMetadatosOcr.
 */
export function payloadDesdeFormulario({
  titulo = '',
  fecha = '',
  horaInicio = '',
  horaFin = '',
  nombreSugerido = '',
  ...extras
} = {}) {
  const datos = parsearTextoCapacitacion('', '', {
    titulo,
    fecha,
    horaInicio,
    horaFin,
  });
  // Respetar ediciones manuales del usuario sobre el nombre sugerido
  if (nombreSugerido && String(nombreSugerido).trim()) {
    datos.nombreSugerido = String(nombreSugerido).trim();
  }
  return construirPayloadGas(datos, extras);
}
/* ==========================================================================
 * RECEPCIÓN DE MENSAJES BASE64 Y EVENTOS DE ESCÁNER OCR
 * ========================================================================== */

if (typeof window !== 'undefined') {
  window.addEventListener('message', async (e) => {
    if (e.data && e.data.type === 'LOAD_BASE64_FILE') {
      const { base64, mimeType, nombre } = e.data;
      try {
        const byteCharacters = atob(base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: mimeType });
        const file = new File([blob], nombre || 'documento.pdf', { type: mimeType });

        console.log('[OCR-Engine] Documento recibido vía Base64:', file.name);

        if (typeof procesarDocumento === 'function') {
          const resultado = await procesarDocumento(file);
          
          if (resultado && resultado.datos) {
            window.parent.postMessage({
              type: 'OCR_DATA_READY',
              payload: {
                titulo: resultado.datos.titulo || '',
                fecha: resultado.datos.fecha || '',
                horaInicio: resultado.datos.horaInicio || '',
                horaFin: resultado.datos.horaFin || ''
              }
            }, '*');
          }
        }
      } catch(err) {
        console.error('[OCR-Engine] Error al decodificar Base64:', err);
      }
    }
  });
}
