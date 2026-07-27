/**
 * parser.js — Mapeo directo por capas de color (genérico).
 * Sin adivinar: capa vacía o formato inválido → campo "".
 */

const SUFIJO_HORA = String.raw`(?:[bh]r[s5]|[bh]rs?|hos|hs|h|[ap]\.?m\.?)`;

/** Fecha numérica: 27-07-26, 27/07/2026, 27.07.26 */
const REGEX_FECHA_NUM =
  /(\d{1,2})\s*[-/=._~:]+?\s*(\d{1,2})\s*[-/=._~:]+?\s*(\d{2,4})/;

/** 27-Julio-2026, 27-JUL-26, 27 de Julio de 2026 */
const REGEX_FECHA_TEXTO =
  /(\d{1,2})\s*[-/.\s]*(?:de\s+)?([A-Za-zÁÉÍÓÚáéíóúüñ]{3,})\s*[-/.\s]*(?:de\s+)?(\d{2,4})/i;

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

function normalizarFechaPartes(dia, mes, anio) {
  if (!dia || !mes || !anio) return '';

  const d = String(dia).padStart(2, '0');
  const m = String(mes).padStart(2, '0');
  let a = String(anio);

  if (a.length === 4) a = a.slice(-2);
  else a = a.padStart(2, '0');

  const di = Number(d);
  const mi = Number(m);
  if (di < 1 || di > 31 || mi < 1 || mi > 12) return '';

  return `${d}-${m}-${a}`;
}

function formatearHora(h, m) {
  if (h == null || m == null) return '';
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} hrs`;
}

/**
 * Descarta horas absurdas típicas de OCR (00:17, 00:35, etc.).
 * Capacitación: jornada 06:00–22:59; minutos en múltiplos de 5;
 * preferencia implícita :00/:30 vía ranking en elegirHora*.
 */
export function esHoraPlausible(hi, mi) {
  if (Number.isNaN(hi) || Number.isNaN(mi)) return false;
  if (hi < 0 || hi > 23 || mi < 0 || mi > 59) return false;
  // 00:xx / 01–05:xx casi siempre es ruido de cuadrícula o trazo perdido
  if (hi < 6) return false;
  if (hi > 22) return false;
  // Minutos "sucios" (17, 35, 41…) → alucinación; forzar rejilla de 5
  if (mi % 5 !== 0) return false;
  return true;
}

/**
 * Normaliza a HH:MM limpio o "" si no es plausible.
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
  const soloNum = normalizado.replace(/[^0-9\-/\s.:]/g, ' ').replace(/\s+/g, ' ').trim();

  const mNum = soloNum.match(REGEX_FECHA_NUM) || normalizado.match(REGEX_FECHA_NUM);
  if (mNum) {
    const fecha = normalizarFechaPartes(mNum[1], mNum[2], mNum[3]);
    if (fecha) return fecha;
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
  const enPunto = horas.filter((h) => /:(00|30)\s*hrs$/.test(h));
  if (enPunto.length) return enPunto[0];
  return horas[0];
}

function elegirHoraFin(horas) {
  if (!horas?.length) return '';
  const enPunto = horas.filter((h) => /:(00|30)\s*hrs$/.test(h));
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

  let titulo = tituloCapa ? limpiarTitulo(tituloCapa) : '';
  if (!titulo && nombreArchivo) {
    titulo = limpiarTitulo(nombreArchivo.replace(/\.[^.]+$/, '')) || '';
  }

  let fecha = '';
  if (fechaRaw && (pareceFechaLegible(fechaRaw) || /\d{1,2}\s*[-/.:]/.test(fechaRaw))) {
    fecha = extraerFecha(fechaRaw);
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
  // Título limpio alimenta de inmediato el nombre sugerido
  const nombreSugerido = construirNombreSugerido(titulo, fecha);

  return {
    titulo,
    fecha,
    fechaTxt,
    horaInicio,
    horaFin,
    tituloPdf,
    nombreSugerido,
  };
}
