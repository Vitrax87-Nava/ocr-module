/**
 * parser.js — Mapeo directo por capas de color (genérico).
 * Sin adivinar con hoja completa: capa vacía → campo "".
 */

const SUFIJO_HORA = String.raw`(?:[bh]r[s5]|[bh]rs?|hos|hs|h|[ap]\.?m\.?)`;

/** Fecha numérica: 27-07-26, 27/07/2026, 27.07.26 */
const REGEX_FECHA_NUM =
  /(\d{1,2})\s*[-/=._~:]+?\s*(\d{1,2})\s*[-/=._~:]+?\s*(\d{2,4})/;

const REGEX_FECHA_PEGADA = /(\d{1,2})\s*[-/=._~:]+?\s*(\d)(\d{2})\b/;

/** 27-Julio-2026, 27-JUL-26, 27 de Julio de 2026 */
const REGEX_FECHA_TEXTO =
  /(\d{1,2})\s*[-/.\s]*(?:de\s+)?([A-Za-zÁÉÍÓÚáéíóúüñ]{3,})\s*[-/.\s]*(?:de\s+)?(\d{2,4})/i;

/** Hora tolerante: HH:MM, HH.MM, HH;MM, HHMM, con o sin sufijo */
const REGEX_HORA_TOLERANTE = /(\d{1,2})[:;.\s-]?(\d{2})/g;

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

/**
 * Limpia bordes ruidosos SIN descartar el texto (para fecha/hora).
 * @param {string} texto
 * @returns {string}
 */
function prepararTextoFechaHora(texto) {
  return String(texto || '')
    .replace(/^[\s.,;:_=\-|~'"“”‘’•·]+/g, '')
    .replace(/[\s.,;:_=\-|~'"“”‘’•·]+$/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * ¿Parece contener una fecha aunque tenga ruido alrededor?
 * @param {string} texto
 * @returns {boolean}
 */
function pareceFechaLegible(texto) {
  const t = String(texto || '');
  return (
    /\d{1,2}\s*[-/=._~:]\s*\d{1,2}\s*[-/=._~:]\s*\d{2,4}/.test(t) ||
    /\d{1,2}\s*[-/.\s]+[A-Za-zÁÉÍÓÚáéíóúüñ]{3,}/i.test(t)
  );
}

/**
 * ¿Parece contener una hora?
 * @param {string} texto
 * @returns {boolean}
 */
function pareceHoraLegible(texto) {
  const t = String(texto || '');
  return (
    /\d{1,2}\s*[:;.\s-]?\s*\d{2}/.test(t) ||
    /\b\d{3,4}\b/.test(t) ||
    new RegExp(String.raw`\d{1,2}.+\b${SUFIJO_HORA}\b`, 'i').test(t)
  );
}

function normalizarRuidoOcr(texto) {
  return String(texto || '')
    .replace(/\bhos\b/gi, 'hrs')
    .replace(/\bhes\b/gi, 'hrs')
    .replace(/\bhe5\b/gi, 'hrs')
    .replace(/\bh5\b/gi, 'hrs')
    .replace(/\bhs\b/gi, 'hrs')
    .replace(/\bbr5\b/gi, 'hrs')
    .replace(/\bhr5\b/gi, 'hrs')
    .replace(/\bhns\b/gi, 'hrs')
    .replace(/\bbrs\b/gi, 'hrs')
    // "13 s0" / "13 sO" → "13:30"
    .replace(/\b([01]?\d|2[0-3])\s*[sS][0Oo]\b/g, '$1:30')
    .replace(/\b([01]?\d|2[0-3])\s*[sS](\d)\b/g, '$1:3$2')
    // "1Y hrs" → "14:00 hrs"
    .replace(/\b(\d)[Yy]\b(?=\s*(?:hrs?|hes|hs|[ap]\.?m))/gi, '$14:00')
    .replace(/\b([01]?\d|2[0-3])\s+00(?=\s*(?:hrs?|hs|h|\b))/gi, '$1:00')
    .replace(/\b([01]?\d|2[0-3])\s+00\b/g, '$1:00')
    // Evitar 10 → 00: el "1" delgado se pierde y queda "00:xx" / "00 30"
    .replace(/\b00\s*([:.])/g, '10$1')
    .replace(/\b[O0][O0]\s*([:.])/gi, '10$1')
    .replace(/\b00([0-5]\d)\b/g, '10$1')
    .replace(/\b00\s+([0-5]\d)\b(?!\s*:)/g, '10:$1')
    .replace(/[=_~]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/[.]{2,}/g, '.');
}

/** Solo confusiones de dígitos aislados (no toca letras de meses). */
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

  let d = String(dia).padStart(2, '0');
  let m = String(mes).padStart(2, '0');
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
 * Limpia leet-speak OCR en títulos manuscritos.
 * Ej.: "1510N" → "ISION", "Prue8a" → "Prueba", "CAPAC1TAC10N" → "CAPACITACION"
 * Conserva números puros cortos (ej. "01").
 * @param {string} texto
 * @returns {string}
 */
export function limpiarLeetSpeakTitulo(texto) {
  if (!texto) return '';

  const mapa = {
    0: 'O',
    1: 'I',
    2: 'Z',
    3: 'E',
    4: 'A',
    5: 'S',
    6: 'G',
    7: 'T',
    8: 'B',
    9: 'G',
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
      const next = token[offset + d.length] || token[offset + 1] || '';
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

  // Quitar puntuación residual al inicio/final (ej. "REVISION OCR :")
  t = t.replace(/^[\s.,;:_=\-|~'"“”‘’•·]+/u, '');
  t = t.replace(/[\s.,;:_=\-|~'"“”‘’•·]+$/u, '');
  t = t.replace(/^[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+/u, '');
  t = t.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+$/u, '');
  t = t.replace(/\.(?=\s|$)/g, '');

  // Leet-speak manuscrito (1510N→ISION, 1→I, 5→S, 0→O dentro de palabras)
  t = limpiarLeetSpeakTitulo(t);

  const digitoALetra = {
    0: 'O', 1: 'I', 3: 'E', 4: 'A', 5: 'S', 6: 'G', 8: 'B', 9: 'G',
  };
  t = t.replace(
    /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])([0-9])([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/gu,
    (_, a, d, b) => a + (digitoALetra[d] || d) + b
  );

  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/[\s.,;:_=\-|~]+$/u, '').trim();

  if (t.length > 0) {
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }

  if (esRuidoOcr(t)) return '';
  return t;
}

export function extraerFecha(texto) {
  if (!texto || !String(texto).trim()) return '';

  // No descartar por esRuidoOcr: intentar parsear siempre
  let base = prepararTextoFechaHora(texto);
  if (!base) return '';

  let normalizado = normalizarRuidoOcr(base);
  normalizado = corregirDigitosCandidato(normalizado);
  normalizado = prepararTextoFechaHora(normalizado);

  // 1) Numérica: 27-07-26 / 27/07/2026
  const mNum = normalizado.match(REGEX_FECHA_NUM);
  if (mNum) {
    const fecha = normalizarFechaPartes(mNum[1], mNum[2], mNum[3]);
    if (fecha) return fecha;
  }

  // 2) Pegada: 07-426 → 07-04-26
  const mPeg = normalizado.match(REGEX_FECHA_PEGADA);
  if (mPeg) {
    const fecha = normalizarFechaPartes(mPeg[1], mPeg[2], mPeg[3]);
    if (fecha) return fecha;
  }

  // 3) Mes en texto: 27-Julio-2026 / 27-JUL-26 → 07
  const mTxt = normalizado.match(REGEX_FECHA_TEXTO);
  if (mTxt) {
    const mesKey = mTxt[2]
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const mesNum = MESES[mesKey];
    if (mesNum) {
      const fecha = normalizarFechaPartes(
        corregirDigitosCandidato(mTxt[1]),
        mesNum,
        corregirDigitosCandidato(mTxt[3])
      );
      if (fecha) return fecha;
    }
  }

  // 4) Buscar mes conocido en cualquier parte del texto
  for (const [nombre, num] of Object.entries(MESES)) {
    const re = new RegExp(
      String.raw`(\d{1,2})\s*[-/.\s]*(?:de\s+)?${nombre}\s*[-/.\s]*(?:de\s+)?(\d{2,4})`,
      'i'
    );
    const m = normalizado.match(re);
    if (m) {
      const fecha = normalizarFechaPartes(m[1], num, m[2]);
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
  normalizado = normalizado
    .replace(/\b00\s*([:.])/g, '10$1')
    .replace(/\b00([0-5]\d)\b/g, '10$1')
    .replace(/\b00\s+([0-5]\d)\b(?!\s*:)/g, '10:$1');

  // Descartar sufijos hrs/hs/h y basura; quedarse con dígitos y separadores
  const plano = normalizado
    .replace(new RegExp(String.raw`\b${SUFIJO_HORA}\b`, 'gi'), ' ')
    .replace(/[^\d:.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const encontradas = [];
  const vistas = new Set();

  const agregar = (h, m) => {
    const hi = Number(h);
    const mi = Number(m);
    if (Number.isNaN(hi) || Number.isNaN(mi)) return;
    // Validar rango 00:00–23:59
    if (hi < 0 || hi > 23 || mi < 0 || mi > 59) return;
    const key = `${String(hi).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
    if (vistas.has(key)) return;
    vistas.add(key);
    encontradas.push(formatearHora(hi, mi));
  };

  let m;
  // Preferir HH:MM / HH.MM explícitos
  const conSeparador = /\b(\d{1,2})\s*[:.]\s*(\d{2})\b/g;
  while ((m = conSeparador.exec(plano)) !== null) {
    agregar(m[1], m[2]);
  }

  if (encontradas.length === 0) {
    const re = new RegExp(REGEX_HORA_TOLERANTE.source, 'g');
    while ((m = re.exec(plano)) !== null) agregar(m[1], m[2]);
  }

  if (encontradas.length === 0) {
    const compacto = /\b([01]\d|2[0-3])([0-5]\d)\b/g;
    while ((m = compacto.exec(plano)) !== null) agregar(m[1], m[2]);
  }

  if (encontradas.length === 0) {
    const re2 = new RegExp(REGEX_HORA_TOLERANTE.source, 'g');
    while ((m = re2.exec(normalizado)) !== null) agregar(m[1], m[2]);
  }

  return encontradas;
}

/**
 * Elige la hora de fin entre varias candidatas (prefiere :00 y evita 00:xx espurios).
 * @param {string[]} horas
 * @returns {string}
 */
function elegirHoraFin(horas) {
  if (!horas?.length) return '';
  const enPunto = horas.filter((h) => /:\d{2}\s*hrs$/.test(h) && h.includes(':00'));
  if (enPunto.length) return enPunto[enPunto.length - 1];
  const sinCero = horas.filter((h) => !/^00:/.test(h));
  if (sinCero.length) return sinCero[sinCero.length - 1];
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

/**
 * DD-MM-YY → "03-Jul-26 (03-Julio-26)"
 * @param {string} fechaNo
 * @returns {string}
 */
export function formatearFechaTxt(fechaNo) {
  if (!fechaNo) return '';
  const m = String(fechaNo).match(/^(\d{2})-(\d{2})-(\d{2,4})$/);
  if (!m) return '';
  const dia = m[1];
  const mes = Number(m[2]);
  const anio = m[3].length === 4 ? m[3].slice(-2) : m[3];
  if (mes < 1 || mes > 12) return '';
  const abr = MESES_ABR[mes];
  const nom = MESES_NOM[mes];
  return `${dia}-${abr}-${anio} (${dia}-${nom}-${anio})`;
}

/**
 * Formato legible pedido por el usuario.
 * @param {{ titulo: string, fecha: string, fechaTxt?: string, horaInicio: string, horaFin: string, tituloPdf?: string }} datos
 * @returns {string}
 */
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

  // Título: sí filtrar ruido extremo
  const tituloCapa = sanitizarCapa(c.titulo || '');

  // Fecha/hora: NUNCA descartar por esRuidoOcr — intentar parsear si hay texto
  const fechaRaw = String(c.fecha || '').trim();
  const horaInicioRaw = String(c.horaInicio || '').trim();
  const horaFinRaw = String(c.horaFin || '').trim();

  let titulo = tituloCapa ? limpiarTitulo(tituloCapa) : '';
  if (!titulo && nombreArchivo) {
    titulo = limpiarTitulo(nombreArchivo.replace(/\.[^.]+$/, '')) || '';
  }

  // Si el canal parece fecha/hora, forzar intento de parseo
  let fecha = '';
  if (fechaRaw && (pareceFechaLegible(fechaRaw) || !esRuidoOcr(fechaRaw) || /\d/.test(fechaRaw))) {
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

  const horaInicio = horasInicio[0] || '';
  let horaFin = elegirHoraFin(horasFin);
  if (!horaFin && horasInicio[1]) horaFin = horasInicio[1];

  const fechaTxt = formatearFechaTxt(fecha);
  const tituloPdf = titulo;
  const nombreSugerido = [titulo, fecha].filter(Boolean).join(' ').trim();

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
