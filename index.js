/**
 * index.js — Punto de entrada del módulo OCR de portadas de capacitación.
 *
 * Uso:
 *   import { procesarDocumento } from './ocr-module/index.js';
 *   const resultado = await procesarDocumento(file);
 */

import { extraerDocumento, extraerTexto } from './ocr-engine.js';
import {
  parsearTextoCapacitacion,
  formatearResultadoLegible,
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
 * Título, Fecha, Hora de Inicio y Hora de Fin.
 *
 * @param {File|Blob} file
 * @returns {Promise<{
 *   exito: boolean,
 *   datos: object,
 *   resumen: string,
 *   rawText: string,
 *   error?: string
 * }>}
 */
export async function procesarDocumento(file) {
  try {
    if (!file) {
      return {
        exito: false,
        datos: { ...DATOS_VACIOS },
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
      resumen,
      rawText,
    };
  } catch (err) {
    const datos = {
      ...DATOS_VACIOS,
      titulo: file?.name ? String(file.name).replace(/\.[^.]+$/, '') : '',
      tituloPdf: file?.name ? String(file.name).replace(/\.[^.]+$/, '') : '',
    };
    return {
      exito: false,
      datos,
      resumen: formatearResultadoLegible(datos),
      rawText: '',
      error: err?.message || String(err),
    };
  }
}

export {
  parsearTextoCapacitacion,
  formatearResultadoLegible,
  formatearFechaTxt,
} from './parser.js';
export { extraerTexto, extraerDocumento } from './ocr-engine.js';
