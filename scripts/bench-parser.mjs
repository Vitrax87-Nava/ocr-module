/**
 * scripts/bench-parser.mjs — Prueba unitaria del parser (sin Tesseract).
 */
import {
  parsearTextoCapacitacion,
  extraerFecha,
  extraerHoras,
  construirNombreSugerido,
} from '../parser.js';

const casos = [
  {
    nombre: 'capas ideales (muestra)',
    capas: {
      titulo: 'Prueba 01',
      fecha: '03-07-26\n03-Jul-26',
      horaInicio: '13:30',
      horaFin: '14:00',
    },
    esperado: {
      titulo: 'Prueba 01',
      fecha: '03-07-26',
      horaInicio: '13:30',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 01 03-07-26',
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
      fecha: '27-07-26',
      horaInicio: '12:00',
      horaFin: '14:00',
      nombreSugerido: 'Ueha CLR 27-07-26',
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
      fecha: '03-07-26',
      horaInicio: '19:00',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 02 03-07-26',
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
      fecha: '03-07-26',
      horaInicio: '13 30',
      horaFin: '14 00',
    },
    esperado: {
      titulo: 'Prueba 01',
      fecha: '03-07-26',
      horaInicio: '13:30',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 01 03-07-26',
    },
  },
  {
    nombre: 'fecha por regex con texto secundario',
    capas: {
      titulo: 'Prueba 01.',
      fecha: 'xxx ruido 03-07-26 lado derecho Jul',
      horaInicio: '1330',
      horaFin: '14:00',
    },
    esperado: {
      titulo: 'Prueba 01',
      fecha: '03-07-26',
      horaInicio: '13:30',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 01 03-07-26',
    },
  },
  {
    nombre: 'hora fin OCR OD→00',
    capas: {
      titulo: 'Prueba 01',
      fecha: '03-07-26',
      horaInicio: '13:30',
      horaFin: '14 ODh-s',
    },
    esperado: {
      titulo: 'Prueba 01',
      fecha: '03-07-26',
      horaInicio: '13:30',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 01 03-07-26',
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
      fecha: '03-07-26',
      horaInicio: '13:30',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 01 03-07-26',
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
      fecha: '03-07-26',
      horaInicio: '13:30',
      horaFin: '14:00',
      nombreSugerido: 'Prueba 01 03-07-26',
    },
  },
  {
    nombre: 'hora 24h hasta 23:55',
    capas: {
      titulo: 'Turno noche',
      fecha: '03-07-26',
      horaInicio: '14:00',
      horaFin: '23:55',
    },
    esperado: {
      titulo: 'Turno noche',
      fecha: '03-07-26',
      horaInicio: '14:00',
      horaFin: '23:55',
      nombreSugerido: 'Turno noche 03-07-26',
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
console.log('extraerHoras(13:30)=', extraerHoras('13:30'));
console.log('construirNombreSugerido=', construirNombreSugerido('Ueha, CLR', '01-01-26'));

if (fallos) {
  console.error(`\n${fallos} fallo(s)`);
  process.exit(1);
}
console.log('\nParser OK');
