/**
 * parser.js — Mapeo por zonas / patrones.
 *
 *  - Título: texto libre limpio → campo Título + Nombre sugerido
 *  - Fecha: regex DD-MM-YY(YY) / DD/MM/… + rangos día 1–31, mes 1–12
 *  - Horas: laterales; salida estándar 24h `HH:mm` (sin sufijo)
 */

const SUFIJO_HORA = String.raw`(?:[bh]r[s5]|[bh]rs?|hos|hs|h|[ap]\.?m\.?)`;

/** Fecha numérica estricta: 03-07-26, 03/07/2026, 03.07.26 */
const REGEX_FECHA_NUM =
  /(\d{1,2})\s*[-/=._~:]+?\s*(\d{1,2})\s*[-/=._~:]+?\s*(\d{2,4})/;

/** Variante compacta tolerante a ruido OCR entre tokens */
const REGEX_FECHA_NUM_GLOBAL =
  /(\d{2})\s*[-/=._~:]\s*(\d{2})\s*[-/=._~:]\s*(\d{2,4})/g;

/** 27-Julio-2026, 27-JUL-26, 03 Jul 26, 03 de Julio de 2026 */
const REGEX_FECHA_TEXTO =
  /(\d{1,2})\s*[-/.\s]*(?:de\s+)?([A-Za-zÁÉÍÓÚáéíóúüñ]{3,})\s*[-/.\s]*(?:de\s+)?(\d{2,4})/i;

const REGEX_FECHA_TEXTO_GLOBAL =
  /(\d{1,2})\s*[-/.\s]*(?:de\s+)?(Ene(?:ro)?|Feb(?:rero)?|Mar(?:zo)?|Abr(?:il)?|May(?:o)?|Jun(?:io)?|Jul(?:io)?|Ago(?:sto)?|Sep(?:t(?:iembre)?)?|Set(?:iembre)?|Oct(?:ubre)?|Nov(?:iembre)?|Dic(?:iembre)?)\s*[-/.\s]*(?:de\s+)?(\d{2,4})/gi;

const MESES = {
  enero: '01', ene: '01',
  febrero: '02', feb: '02',
  marzo: '03', mar: '03',
  abril: '04', abr: '04',
  mayo: '05', may: '05',
  junio: '06', jun: '06',
  julio: '07', jul: '07',
  agosto: '08', ago: '08',
  septiembre: '09', setiembre: '09', sep: '09', sept: '09',
  octubre: '10', oct: '10',
  noviembre: '11', nov: '11',
  diciembre: '12', dic: '12',
};

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
 * Normaliza a DD-MM-YY con validación de rangos (día≤31, mes≤12).
 * Año de 2 dígitos se presenta limpio; de 4 se reduce a YY.
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

  let a = String(anio).replace(/\D/g, '');
  if (!a) return '';
  if (a.length >= 4) a = a.slice(-2);
  else a = a.padStart(2, '0');
  if (a.length !== 2) return '';

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

  // Canal estricto: solo dígitos y -/ (igual que whitelist del motor)
  const estricto = normalizado
    .replace(/[^0-9\-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[-/]{2,}/g, '-')
    .trim();

  const soloNum = estricto || normalizado.replace(/[^0-9\-/\s.:]/g, ' ').replace(/\s+/g, ' ').trim();

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

  // Compacto 6–8 dígitos: DDMMYY / DDMMYYYY
  const digitos = soloNum.replace(/\D/g, '');
  if (digitos.length === 6 || digitos.length === 8) {
    const fecha = normalizarFechaPartes(
      digitos.slice(0, 2),
      digitos.slice(2, 4),
      digitos.slice(4)
    );
    if (fecha) return fecha;
  }

  REGEX_FECHA_TEXTO_GLOBAL.lastIndex = 0;
  let mTxtG;
  while ((mTxtG = REGEX_FECHA_TEXTO_GLOBAL.exec(normalizado)) !== null) {
    const mesKey = mTxtG[2]
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const mesNum = MESES[mesKey];
    if (mesNum) {
      const fecha = normalizarFechaPartes(mTxtG[1], mesNum, mTxtG[3]);
      if (fecha) return fecha;
    }
  }

  const mTxt = normalizado.match(REGEX_FECHA_TEXTO);
  if (mTxt) {
    const mesKey = mTxt[2]
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const mesNum = MESES[mesKey];
    if (mesNum) {
      const fecha = normalizarFechaPartes(mTxt[1], mesNum, mTxt[3]);
      if (fecha) return fecha;
    }
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
  const anio = m[3].length === 4 ? m[3].slice(-2) : m[3];
  if (mes < 1 || mes > 12) return '';
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
