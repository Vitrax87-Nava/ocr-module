/**
 * Code.gs — Backend unificado Google Apps Script (OCR portadas).
 *
 * Un solo archivo .gs con secciones encapsuladas (menos piezas en el proyecto):
 *   1) UI / HtmlService
 *   2) Autenticación / sesión
 *   3) Drive y carpetas
 *   4) Hojas de cálculo (registro)
 *   5) Orquestación de metadatos OCR
 *
 * Flujo típico:
 *   Cliente (test.html + ocr.js) → procesarDocumento()
 *   → google.script.run.aplicarMetadatosOcr(payload, opciones)
 *
 * Horas: HH:mm 24h | Fecha: DD-MM-YYYY (normalizada en ocr.js)
 */

/* ==========================================================================
 * 1) UI / HtmlService
 * ========================================================================== */

/**
 * Sirve la UI del módulo (archivo HTML del proyecto: test).
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('test')
    .setTitle('OCR Portadas')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Incluye un archivo HTML parcial (útil si se parte la UI).
 * @param {string} filename
 * @returns {string}
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ==========================================================================
 * 2) Autenticación / sesión
 * ========================================================================== */

/**
 * Usuario de la sesión activa (cuenta de Google que ejecuta el script).
 * @returns {{ email: string, nombre: string }}
 */
function obtenerUsuarioActivo() {
  const u = Session.getActiveUser();
  const e = Session.getEffectiveUser();
  return {
    email: (u && u.getEmail()) || (e && e.getEmail()) || '',
    nombre: (e && e.getEmail()) || '',
  };
}

/**
 * Comprueba que hay sesión usable antes de tocar Drive/Sheets.
 * @throws {Error}
 */
function requerirUsuario_() {
  const info = obtenerUsuarioActivo();
  if (!info.email) {
    throw new Error(
      'No hay usuario autenticado. Abre el web app e inicia sesión con Google.'
    );
  }
  return info;
}

/* ==========================================================================
 * 3) Drive y carpetas
 * ========================================================================== */

/**
 * Obtiene una carpeta por ID, o la crea bajo un padre si se pasa nombre.
 *
 * @param {Object} opts
 * @param {string} [opts.folderId]     ID existente
 * @param {string} [opts.nombre]       Nombre a buscar/crear
 * @param {string} [opts.parentId]     Carpeta padre (default: raíz del Drive del usuario)
 * @returns {GoogleAppsScript.Drive.Folder}
 */
function obtenerOCrearCarpeta(opts) {
  opts = opts || {};
  requerirUsuario_();

  if (opts.folderId) {
    return DriveApp.getFolderById(opts.folderId);
  }

  const nombre = String(opts.nombre || '').trim();
  if (!nombre) throw new Error('folderId o nombre de carpeta requerido.');

  const padre = opts.parentId
    ? DriveApp.getFolderById(opts.parentId)
    : DriveApp.getRootFolder();

  const it = padre.getFoldersByName(nombre);
  if (it.hasNext()) return it.next();
  return padre.createFolder(nombre);
}

/**
 * Mueve un archivo a una carpeta (lo quita de los padres actuales salvo que
 * se pida conservar).
 *
 * @param {string} fileId
 * @param {string} folderId
 * @param {Object} [opciones]
 * @param {boolean} [opciones.conservarPadres=false]
 * @returns {{ fileId: string, folderId: string, nombre: string }}
 */
function moverArchivoACarpeta(fileId, folderId, opciones) {
  requerirUsuario_();
  if (!fileId) throw new Error('fileId requerido.');
  if (!folderId) throw new Error('folderId requerido.');
  opciones = opciones || {};

  const file = DriveApp.getFileById(fileId);
  const dest = DriveApp.getFolderById(folderId);
  dest.addFile(file);

  if (!opciones.conservarPadres) {
    const padres = file.getParents();
    while (padres.hasNext()) {
      const p = padres.next();
      if (p.getId() !== folderId) p.removeFile(file);
    }
  }

  return {
    fileId: fileId,
    folderId: folderId,
    nombre: file.getName(),
  };
}

/**
 * Lista archivos de una carpeta (metadatos básicos).
 * @param {string} folderId
 * @param {number} [limite=50]
 * @returns {Array<{ id: string, nombre: string, mimeType: string }>}
 */
function listarArchivosEnCarpeta(folderId, limite) {
  requerirUsuario_();
  if (!folderId) throw new Error('folderId requerido.');
  limite = Math.max(1, Math.min(Number(limite) || 50, 200));

  const folder = DriveApp.getFolderById(folderId);
  const out = [];
  const it = folder.getFiles();
  while (it.hasNext() && out.length < limite) {
    const f = it.next();
    out.push({
      id: f.getId(),
      nombre: f.getName(),
      mimeType: f.getMimeType(),
    });
  }
  return out;
}

/**
 * Renombra un archivo en Drive usando el nombre sugerido.
 * Conserva la extensión original del archivo.
 *
 * @param {string} fileId
 * @param {string} nombreSugerido
 * @returns {{ fileId: string, nombreAnterior: string, nombreNuevo: string }}
 */
function renombrarArchivoDrive(fileId, nombreSugerido) {
  requerirUsuario_();
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

/* ==========================================================================
 * 4) Hojas de cálculo (registro)
 * ========================================================================== */

/**
 * Append de una fila con los campos OCR.
 * Encabezados (se crean si la hoja está vacía):
 *   Timestamp | Titulo | Fecha | Hora Inicio | Hora Fin | Nombre Sugerido | Usuario
 *
 * @param {Object} payload
 * @param {string} spreadsheetId
 * @param {string} [sheetName]
 * @returns {{ sheet: string, row: number }}
 */
function registrarEnHoja(payload, spreadsheetId, sheetName) {
  requerirUsuario_();
  if (!spreadsheetId) throw new Error('spreadsheetId requerido.');
  payload = normalizarPayloadGas_(payload || {});
  const usuario = obtenerUsuarioActivo();

  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = sheetName
    ? ss.getSheetByName(sheetName) || ss.insertSheet(sheetName)
    : ss.getSheets()[0];
  if (!sheet) throw new Error('No se pudo obtener la hoja.');

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Timestamp',
      'Titulo',
      'Fecha',
      'Hora Inicio',
      'Hora Fin',
      'Nombre Sugerido',
      'Usuario',
    ]);
  }

  sheet.appendRow([
    new Date(),
    payload.titulo,
    payload.fecha,
    payload.horaInicio,
    payload.horaFin,
    payload.nombreSugerido,
    usuario.email,
  ]);

  return {
    sheet: sheet.getName(),
    row: sheet.getLastRow(),
  };
}

/* ==========================================================================
 * 5) Orquestación de metadatos OCR
 * ========================================================================== */

/**
 * Aplica metadatos OCR: renombra en Drive, mueve a carpeta y/o registra en hoja.
 *
 * @param {Object} payload
 * @param {string} payload.titulo
 * @param {string} payload.fecha          DD-MM-YYYY
 * @param {string} payload.horaInicio     HH:mm (24h)
 * @param {string} payload.horaFin        HH:mm (24h)
 * @param {string} payload.nombreSugerido
 * @param {string} [payload.fechaTxt]
 * @param {Object} [opciones]
 * @param {string} [opciones.fileId]
 * @param {string} [opciones.folderId]        Mover aquí tras renombrar
 * @param {string} [opciones.folderName]      Crear/usar carpeta por nombre
 * @param {string} [opciones.parentFolderId]  Padre si se crea por nombre
 * @param {string} [opciones.spreadsheetId]
 * @param {string} [opciones.sheetName]
 * @returns {Object} resumen de la operación
 */
function aplicarMetadatosOcr(payload, opciones) {
  requerirUsuario_();
  payload = normalizarPayloadGas_(payload || {});
  opciones = opciones || {};

  const resultado = {
    ok: true,
    usuario: obtenerUsuarioActivo(),
    payload: payload,
    renombrado: null,
    carpeta: null,
    fila: null,
    errores: [],
  };

  if (opciones.fileId && payload.nombreSugerido) {
    try {
      resultado.renombrado = renombrarArchivoDrive(
        opciones.fileId,
        payload.nombreSugerido
      );
    } catch (err) {
      resultado.ok = false;
      resultado.errores.push('Drive: ' + (err.message || String(err)));
    }
  }

  if (opciones.fileId && (opciones.folderId || opciones.folderName)) {
    try {
      const folder = obtenerOCrearCarpeta({
        folderId: opciones.folderId || '',
        nombre: opciones.folderName || '',
        parentId: opciones.parentFolderId || '',
      });
      resultado.carpeta = moverArchivoACarpeta(opciones.fileId, folder.getId());
    } catch (err) {
      resultado.ok = false;
      resultado.errores.push('Carpeta: ' + (err.message || String(err)));
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

/* --- Helpers internos --- */

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
