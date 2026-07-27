/**
 * scripts/bench-parser.mjs — Prueba unitaria del parser (sin Tesseract).
 * Valida el mapeo esperado de la plantilla de colores.
 */
import { parsearTextoCapacitacion, extraerFecha, extraerHoras } from '../parser.js';

const casos = [
  {
    nombre: 'capas ideales (muestra)',
    capas: {
      titulo: 'Prueba 01',
      fecha: '03-07-26\n03-Jul-26',
      horaInicio: '13:30 hrs',
      horaFin: '14:00 hrs',
    },
    esperado: {
      titulo: 'Prueba 01',
      fecha: '03-07-26',
      horaInicio: '13:30 hrs',
      horaFin: '14:00 hrs',
    },
  },
  {
    nombre: 'fecha solo textual',
    capas: {
      titulo: '-rueba 02',
      fecha: '03-Jul-26',
      horaInicio: '1900 brs',
      horaFin: '14.00 hrs',
    },
    esperado: {
      titulo: 'Prueba 02',
      fecha: '03-07-26',
      horaInicio: '19:00 hrs',
      horaFin: '14:00 hrs',
    },
  },
  {
    nombre: 'capa vacía → campo vacío',
    capas: {
      titulo: 'Capacitacion X',
      fecha: '',
      horaInicio: 'a A EE - =',
      horaFin: '',
    },
    esperado: {
      titulo: 'Capacitacion X',
      fecha: '',
      horaInicio: '',
      horaFin: '',
    },
  },
  {
    nombre: 'ocr ruidoso horas',
    capas: {
      titulo: 'Prueba 01',
      fecha: 'O3-07-2¢',
      horaInicio: '13 sO hrs',
      horaFin: 'Tea 1Y hes',
    },
    esperado: {
      titulo: 'Prueba 01',
      fecha: '03-07-26',
      horaInicio: '13:30 hrs',
      horaFin: '14:00 hrs',
    },
  },
];

let fallos = 0;
for (const c of casos) {
  const got = parsearTextoCapacitacion('', 'archivo.pdf', c.capas);
  const ok =
    got.titulo === c.esperado.titulo &&
    got.fecha === c.esperado.fecha &&
    got.horaInicio === c.esperado.horaInicio &&
    got.horaFin === c.esperado.horaFin;

  console.log(ok ? 'OK ' : 'FAIL', c.nombre);
  if (!ok) {
    fallos++;
    console.log('  esperado:', c.esperado);
    console.log('  obtenido:', {
      titulo: got.titulo,
      fecha: got.fecha,
      horaInicio: got.horaInicio,
      horaFin: got.horaFin,
    });
  }
}

console.log('extraerFecha(03-Jul-26)=', extraerFecha('03-Jul-26'));
console.log('extraerHoras(13:30 hrs)=', extraerHoras('13:30 hrs'));

if (fallos) {
  console.error(`\n${fallos} fallo(s)`);
  process.exit(1);
}
console.log('\nParser OK');
