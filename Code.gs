/**
 * Code.gs — Backend Google Apps Script para metadatos OCR de capacitación.
 *
 * Flujo típico (HtmlService + módulo OCR en el cliente):
 *   1) El HTML carga el archivo y ejecuta procesarDocumento() en el navegador.
 *   2) El resultado incluye `gas` / `datos.gas` con:
 *        { titulo, fecha, horaInicio, horaFin, nombreSugerido, fechaTxt }
 *   3) El cliente llama:
 *        google.script.run
 *          .withSuccessHandler(...)
 *          .aplicarMetadatosOcr(payload, { fileId, spreadsheetId, sheetName });
 *
 * Horas: formato 24h HH:mm (ej. "14:00", "23:30").
 * Fecha: DD-MM-YY tras validación de rangos en el parser del cliente.
 */

/**
 * Sirve la UI del módulo (ajusta el nombre del archivo HTML en el proyecto GAS).
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('test')
    .setTitle('OCR Portadas')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Aplica metadatos OCR: renombra en Drive y/o registra en una hoja.
 *
 * @param {Object} payload
 * @param {string} payload.titulo
 * @param {string} payload.fecha          DD-MM-YY
 * @param {string} payload.horaInicio     HH:mm (24h)
 * @param {string} payload.horaFin        HH:mm (24h)
 * @param {string} payload.nombreSugerido
 * @param {string} [payload.fechaTxt]
 * @param {Object} [opciones]
 * @param {string} [opciones.fileId]         Archivo Drive a renombrar
 * @param {string} [opciones.spreadsheetId]  Libro de registro
 * @param {string} [opciones.sheetName]      Hoja (default: primera)
 * @returns {Object} resumen de la operación
 */
function aplicarMetadatosOcr(payload, opciones) {
  payload = normalizarPayloadGas_(payload || {});
  opciones = opciones || {};

  const resultado = {
    ok: true,
    payload: payload,
    renombrado: null,
    fila: null,
    errores: [],
  };

  if (opciones.fileId && payload.nombreSugerido) {
    try {
      resultado.renombrado = renombrarArchivoDrive(opciones.fileId, payload.nombreSugerido);
    } catch (err) {
      resultado.ok = false;
      resultado.errores.push('Drive: ' + (err.message || String(err)));
    }
  }

  if (opciones.spreadsheetId) {
    try {
      resultado.fila = registrarEnHoja(
        payload,
        opciones.spreadsheetId,
        opciones.sheetName || ''
      );
    } catch (err) {
      resultado.ok = false;
      resultado.errores.push('Sheets: ' + (err.message || String(err)));
    }
  }

  return resultado;
}

/**
 * Renombra un archivo en Drive usando el nombre sugerido (sin extensión forzada).
 * Conserva la extensión original del archivo.
 *
 * @param {string} fileId
 * @param {string} nombreSugerido
 * @returns {{ fileId: string, nombreAnterior: string, nombreNuevo: string }}
 */
function renombrarArchivoDrive(fileId, nombreSugerido) {
  if (!fileId) throw new Error('fileId requerido.');
  const limpio = sanitizarNombreArchivo_(nombreSugerido);
  if (!limpio) throw new Error('nombreSugerido vacío o inválido.');

  const file = DriveApp.getFileById(fileId);
  const anterior = file.getName();
  const ext = extraerExtension_(anterior);
  const nuevo = ext && !/\.[^.]+$/.test(limpio) ? limpio + ext : limpio;
  file.setName(nuevo);

  return {
    fileId: fileId,
    nombreAnterior: anterior,
    nombreNuevo: nuevo,
  };
}

/**
 * Append de una fila con los campos OCR.
 * Encabezados esperados (se crean si la hoja está vacía):
 *   Timestamp | Titulo | Fecha | Hora Inicio | Hora Fin | Nombre Sugerido
 *
 * @param {Object} payload
 * @param {string} spreadsheetId
 * @param {string} [sheetName]
 * @returns {{ sheet: string, row: number }}
 */
function registrarEnHoja(payload, spreadsheetId, sheetName) {
  if (!spreadsheetId) throw new Error('spreadsheetId requerido.');
  payload = normalizarPayloadGas_(payload || {});

  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = sheetName ? ss.getSheetByName(sheetName) || ss.insertSheet(sheetName) : ss.getSheets()[0];
  if (!sheet) throw new Error('No se pudo obtener la hoja.');

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Timestamp',
      'Titulo',
      'Fecha',
      'Hora Inicio',
      'Hora Fin',
      'Nombre Sugerido',
    ]);
  }

  sheet.appendRow([
    new Date(),
    payload.titulo,
    payload.fecha,
    payload.horaInicio,
    payload.horaFin,
    payload.nombreSugerido,
  ]);

  return {
    sheet: sheet.getName(),
    row: sheet.getLastRow(),
  };
}

/** --- Helpers internos --- */

function normalizarPayloadGas_(p) {
  return {
    titulo: String(p.titulo || '').trim(),
    fecha: String(p.fecha || '').trim(),
    horaInicio: String(p.horaInicio || '').trim(),
    horaFin: String(p.horaFin || '').trim(),
    nombreSugerido: String(p.nombreSugerido || '').trim(),
    fechaTxt: String(p.fechaTxt || '').trim(),
  };
}

function sanitizarNombreArchivo_(nombre) {
  return String(nombre || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 180);
}

function extraerExtension_(nombre) {
  const m = String(nombre || '').match(/(\.[A-Za-z0-9]{1,8})$/);
  return m ? m[1] : '';
}
