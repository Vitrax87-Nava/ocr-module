/**
 * index.js — Punto de entrada del módulo OCR de portadas de capacitación.
 *
 * Uso (navegador / HtmlService):
 *   import { procesarDocumento, construirPayloadGas } from './index.js';
 *   const resultado = await procesarDocumento(file);
 *   // resultado.datos.gas → listo para google.script.run.aplicarMetadatosOcr(...)
 */

import {
  extraerDocumento,
  extraerTexto,
  ocrRecorteManual,
} from './ocr-engine.js';
import {
  parsearTextoCapacitacion,
  formatearResultadoLegible,
  construirPayloadGas,
} from './parser.js';

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

export {
  parsearTextoCapacitacion,
  formatearResultadoLegible,
  formatearFechaTxt,
  construirNombreSugerido,
  construirPayloadGas,
} from './parser.js';
export {
  extraerTexto,
  extraerDocumento,
  precalentarMotor,
  cargarPaginaComoCanvas,
  ocrRecorteManual,
  recortarCanvas,
} from './ocr-engine.js';
