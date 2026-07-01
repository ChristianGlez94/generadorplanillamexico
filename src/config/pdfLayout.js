const PAGE_HEIGHT_PT = 842.2499787;
const PX_SCALE = 2;

const layout = {
  PAGE_HEIGHT_PT,
  PX_SCALE,
  page1: {
    oficinaConsular: { x: 362, y: 214, w: 378, h: 24 },

    nombres: { x: 292, y: 502, w: 448, h: 24 },
    primerApellido: { x: 328, y: 546, w: 172, h: 24 },
    segundoApellido: { x: 664, y: 546, w: 80, h: 24 },

    sexoMarks: {
      FEMENINO: { x: 316.5, y: 608.5 },
      MASCULINO: { x: 432.5, y: 608.5 },
      NO_ESPECIFICA: { x: 544.5, y: 609.5 },
    },

    fechaNacimientoPartes: {
      dia: { x: 378, y: 621, w: 26, h: 24 },
      mes: { x: 431, y: 621, w: 26, h: 24 },
      anio: { x: 478, y: 621, w: 52, h: 24 },
    },
    edad: { x: 620, y: 621, w: 38, h: 24 },

    paisNacimiento: { x: 356, y: 671, w: 156, h: 24 },
    nacionalidad: { x: 646, y: 671, w: 94, h: 24 },

    numeroPasaporte: { x: 638, y: 708, w: 102, h: 24 },
    paisExpedicion: { x: 355, y: 741, w: 145, h: 24 },
    fechaExpedicion: { x: 676, y: 742, w: 68, h: 22 },
    fechaVencimientoPartes: {
      dia: { x: 434, y: 773, w: 26, h: 24 },
      mes: { x: 530, y: 773, w: 26, h: 24 },
      anio: { x: 640, y: 773, w: 52, h: 24 },
    },

    estadoCivilMarks: {
      SOLTERO: { x: 332.5, y: 885.5 },
      CASADO: { x: 444.5, y: 885.5 },
      CONCUBINATO: { x: 558.5, y: 885.5 },
    },

    domicilioActual: { x: 340, y: 901, w: 400, h: 20 },
    telefono: { x: 286, y: 927, w: 168, h: 22 },
    correoLinea1: { x: 634, y: 928, w: 112, h: 12 },
    correoLinea2: { x: 634, y: 942, w: 112, h: 12 },

    ocupacion: { x: 304, y: 956, w: 430, h: 24 },
    compania: { x: 505, y: 986, w: 235, h: 20 },

    lugarResidencia: { x: 366, y: 1017, w: 62, h: 16 },
    legalEstanciaMarks: {
      SI: { x: 664.5, y: 1023.5 },
      NO: { x: 707.5, y: 1023.5 },
    },

    antecedentesMarks: {
      SI: { x: 654.5, y: 1050.5 },
      NO: { x: 702.5, y: 1050.5 },
    },
    antecedentesDetalle: { x: 454, y: 1064, w: 286, h: 22 },

    tipoVisaMarks: {
      VISITANTE_SIN_PERMISO: { x: 783.5, y: 770 },
      VISITANTE_SIN_PERMISO_LARGA_DURACION: { x: 783.5, y: 825.5 },
      VISITANTE_CON_PERMISO: { x: 783.5, y: 905.5 },
      VISITANTE_ADOPCION: { x: 783.5, y: 961 },
      RESIDENTE_TEMPORAL_ESTUDIANTE: { x: 783.5, y: 1016 },
      RESIDENTE_TEMPORAL: { x: 783.5, y: 1044.5 },
      RESIDENTE_PERMANENTE: { x: 783.5, y: 1071.5 },
      DIPLOMATICA: { x: 783.5, y: 1099.5 },
      OFICIAL: { x: 783.5, y: 1126.5 },
      SERVICIO: { x: 783.5, y: 1154.5 },
    },

    fechaIngresoPartes: {
      dia: { x: 468, y: 1146, w: 26, h: 24 },
      mes: { x: 588, y: 1146, w: 26, h: 24 },
      anio: { x: 692, y: 1146, w: 52, h: 24 },
    },
    ciudadIngreso: { x: 430, y: 1188, w: 310, h: 22 },

    temporalidadMarks: {
      MENOR_180: { x: 473.5, y: 1225.5 },
      MAYOR_180_HASTA_4: { x: 485.5, y: 1247.5 },
      DEFINITIVA: { x: 486.5, y: 1267.5 },
    },

    visitoMarks: {
      SI: { x: 479, y: 1291.5 },
      NO: { x: 564.5, y: 1291.5 },
    },

    deportadoMarks: {
      SI: { x: 476.5, y: 1319.5 },
      NO: { x: 561.5, y: 1320 },
    },

    causaDeportacion: { x: 474, y: 1336, w: 266, h: 20 },
    propositoViaje: { x: 448, y: 1366, w: 292, h: 20 },

    tipoPasaporteMarks: {
      ORDINARIO: { x: 783.5, y: 1242.5 },
      NO_ORDINARIO: { x: 783.5, y: 1260.5 },
      LAISSEZ_PASSER: { x: 783.5, y: 1279.5 },
    },
  },

  page2: {
    documentos: [
      { x: 210, y: 372, w: 870, h: 18 },
      { x: 210, y: 394, w: 870, h: 18 },
      { x: 210, y: 415, w: 870, h: 18 },
      { x: 210, y: 437, w: 870, h: 18 },
      { x: 210, y: 458, w: 870, h: 18 },
    ],

    lugar: { x: 238, y: 820, w: 382, h: 18 },
    fechaFirmaPartes: {
      dia: { x: 786, y: 814, w: 24, h: 24 },
      mes: { x: 904, y: 814, w: 24, h: 24 },
      anio: { x: 990, y: 814, w: 52, h: 24 },
    },
  },
};

module.exports = {
  layout,
};
