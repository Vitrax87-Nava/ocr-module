/**
 * scripts/bench-parser.mjs — Prueba unitaria del parser (sin Tesseract).
 */
import {
  parsearTextoCapacitacion,
  extraerFecha,
  extraerHoras,
  construirNombreSugerido,
} from '../ocr.js';

const casos = [
  {
    nombre: 'capas ideales (muestra)',
    capas: {
      titulo: 'Prueba 01',
      fecha: '03-07-2026\n03-Jul-26',
      horaInicio: '13:30',
      horaFin: '14:00',
    },
    esperado: {
      titulo: 'Prueba 01',
      fecha: '03-07-2026',
      horaInicio: '13:30',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 01 03-07-2026',
    },
  },
  {
    nombre: 'titulo con comas/puntos residuales',
    capas: {
      titulo: 'Ueha, CLR.',
      fecha: '27-JUL-26',
      horaInicio: '12:00.',
      horaFin: '14:00',
    },
    esperado: {
      titulo: 'Ueha CLR',
      fecha: '27-07-2026',
      horaInicio: '12:00',
      horaFin: '14:00',
      nombreSugerido: 'Ueha CLR 27-07-2026',
    },
  },
  {
    nombre: 'fecha solo textual',
    capas: {
      titulo: '-rueba 02',
      fecha: '03-Jul-26',
      horaInicio: '1900',
      horaFin: '14.00',
    },
    esperado: {
      titulo: 'Prueba 02',
      fecha: '03-07-2026',
      horaInicio: '19:00',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 02 03-07-2026',
    },
  },
  {
    nombre: 'capa vacía / inválida → campo vacío (no inventar)',
    capas: {
      titulo: 'Capacitacion X',
      fecha: '',
      horaInicio: 'a A EE - =',
      horaFin: '00:35', // absurda → descartada
    },
    esperado: {
      titulo: 'Capacitacion X',
      fecha: '',
      horaInicio: '',
      horaFin: '',
      nombreSugerido: 'Capacitacion X',
    },
  },
  {
    nombre: 'horas con espacio whitelist',
    capas: {
      titulo: 'Prueba 01',
      fecha: '03-07-2026',
      horaInicio: '13 30',
      horaFin: '14 00',
    },
    esperado: {
      titulo: 'Prueba 01',
      fecha: '03-07-2026',
      horaInicio: '13:30',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 01 03-07-2026',
    },
  },
  {
    nombre: 'fecha por regex con texto secundario',
    capas: {
      titulo: 'Prueba 01.',
      fecha: 'xxx ruido 03-07-2026 lado derecho Jul',
      horaInicio: '1330',
      horaFin: '14:00',
    },
    esperado: {
      titulo: 'Prueba 01',
      fecha: '03-07-2026',
      horaInicio: '13:30',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 01 03-07-2026',
    },
  },
  {
    nombre: 'hora fin OCR OD→00',
    capas: {
      titulo: 'Prueba 01',
      fecha: '03-07-2026',
      horaInicio: '13:30',
      horaFin: '14 ODh-s',
    },
    esperado: {
      titulo: 'Prueba 01',
      fecha: '03-07-2026',
      horaInicio: '13:30',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 01 03-07-2026',
    },
  },
  {
    nombre: 'fecha mes OCR 17→07 y año 4 dígitos',
    capas: {
      titulo: 'Prueba 01',
      fecha: '03-17-2026',
      horaInicio: '13:30',
      horaFin: '14:00',
    },
    esperado: {
      titulo: 'Prueba 01',
      fecha: '03-07-2026',
      horaInicio: '13:30',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 01 03-07-2026',
    },
  },
  {
    nombre: 'fecha mes absurdo → vacío',
    capas: {
      titulo: 'Capacitacion',
      fecha: '03-99-26',
      horaInicio: '',
      horaFin: '',
    },
    esperado: {
      titulo: 'Capacitacion',
      fecha: '',
      horaInicio: '',
      horaFin: '',
      nombreSugerido: 'Capacitacion',
    },
  },
  {
    nombre: 'fecha compacta whitelist 030726',
    capas: {
      titulo: 'Prueba 01',
      fecha: '030726',
      horaInicio: '13:30',
      horaFin: '14:00',
    },
    esperado: {
      titulo: 'Prueba 01',
      fecha: '03-07-2026',
      horaInicio: '13:30',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 01 03-07-2026',
    },
  },
  {
    nombre: 'hora 24h hasta 23:55',
    capas: {
      titulo: 'Turno noche',
      fecha: '03-07-2026',
      horaInicio: '14:00',
      horaFin: '23:55',
    },
    esperado: {
      titulo: 'Turno noche',
      fecha: '03-07-2026',
      horaInicio: '14:00',
      horaFin: '23:55',
      nombreSugerido: 'Turno noche 03-07-2026',
    },
  },
  {
    nombre: 'fecha 30-Julio-2026 y 30/Julio/2026',
    capas: {
      titulo: 'OCR LOG',
      fecha: '30-Julio-2026\n30/Julio/2026',
      horaInicio: '11:00 hrs',
      horaFin: '11:30 hrs',
    },
    esperado: {
      titulo: 'OCR LOG',
      fecha: '30-07-2026',
      horaInicio: '11:00',
      horaFin: '11:30',
      nombreSugerido: 'OCR LOG 30-07-2026',
    },
  },
  {
    nombre: 'fecha ISO 2026-07-30',
    capas: {
      titulo: 'Sesion',
      fecha: 'fecha: 2026-07-30',
      horaInicio: '09:00',
      horaFin: '10:00',
    },
    esperado: {
      titulo: 'Sesion',
      fecha: '30-07-2026',
      horaInicio: '09:00',
      horaFin: '10:00',
      nombreSugerido: 'Sesion 30-07-2026',
    },
  },
  {
    nombre: 'fecha con espacios DD - MM - YYYY',
    capas: {
      titulo: 'Grid',
      fecha: '03 - 07 - 2026',
      horaInicio: '08:00',
      horaFin: '09:00',
    },
    esperado: {
      titulo: 'Grid',
      fecha: '03-07-2026',
      horaInicio: '08:00',
      horaFin: '09:00',
      nombreSugerido: 'Grid 03-07-2026',
    },
  },
  {
    nombre: 'fecha corta D/M/YY',
    capas: {
      titulo: 'Corta',
      fecha: '3/7/26',
      horaInicio: '08:00',
      horaFin: '09:00',
    },
    esperado: {
      titulo: 'Corta',
      fecha: '03-07-2026',
      horaInicio: '08:00',
      horaFin: '09:00',
      nombreSugerido: 'Corta 03-07-2026',
    },
  },
  {
    nombre: 'fecha D - M - YY con espacios',
    capas: {
      titulo: 'Espacios',
      fecha: '3 - 7 - 26',
      horaInicio: '08:00',
      horaFin: '09:00',
    },
    esperado: {
      titulo: 'Espacios',
      fecha: '03-07-2026',
      horaInicio: '08:00',
      horaFin: '09:00',
      nombreSugerido: 'Espacios 03-07-2026',
    },
  },
  {
    nombre: 'fecha DD/MM/YYYY barras',
    capas: {
      titulo: 'Barras',
      fecha: '03/07/2026',
      horaInicio: '08:00',
      horaFin: '09:00',
    },
    esperado: {
      titulo: 'Barras',
      fecha: '03-07-2026',
      horaInicio: '08:00',
      horaFin: '09:00',
      nombreSugerido: 'Barras 03-07-2026',
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
    got.horaFin === c.esperado.horaFin &&
    got.nombreSugerido === c.esperado.nombreSugerido;

  console.log(ok ? 'OK ' : 'FAIL', c.nombre);
  if (!ok) {
    fallos++;
    console.log('  esperado:', c.esperado);
    console.log('  obtenido:', {
      titulo: got.titulo,
      fecha: got.fecha,
      horaInicio: got.horaInicio,
      horaFin: got.horaFin,
      nombreSugerido: got.nombreSugerido,
    });
  }
}

console.log('extraerFecha(03-Jul-26)=', extraerFecha('03-Jul-26'));
console.log('extraerFecha(3 - 7 - 26)=', extraerFecha('3 - 7 - 26'));
console.log('extraerFecha(03/07/26)=', extraerFecha('03/07/26'));
console.log('extraerHoras(13:30)=', extraerHoras('13:30'));
console.log('construirNombreSugerido=', construirNombreSugerido('Ueha, CLR', '01-01-2026'));

if (fallos) {
  console.error(`\n${fallos} fallo(s)`);
  process.exit(1);
}
console.log('\nParser OK');
