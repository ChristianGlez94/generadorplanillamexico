const fs = require("fs");
const path = require("path");
const { fillVisaPdf } = require("../src/services/pdfFiller");

const sampleData = {
  oficinaConsularMode: "LA_HABANA",
  oficinaConsularTexto: "",

  nombres: "Nombre",
  primerApellido: "Gonzalez",
  segundoApellido: "Aguerrebere",
  sexo: "FEMENINO",
  fechaNacimiento: "2026-12-31",

  paisNacimiento: "Cuba",
  nacionalidad: "Cubana",

  numeroPasaporte: "M115890",
  tipoPasaporte: "ORDINARIO",
  paisExpedicion: "Cuba",
  fechaExpedicion: "2025-10-10",
  fechaVencimiento: "2035-10-10",

  estadoCivil: "SOLTERO",
  domicilioActual: "Calle 45 No. 4813 entre 48 y 50, Cienfuegos, Cuba",
  telefono: "+5354165287",
  correo: "correo.corto@mx.com",
  ocupacion: "Ama de casa",
  compania: "Hospital General",
  lugarResidencia: "Cienfuegos",
  cuentaLegalEstancia: "SI",
  antecedentesPenales: "SI",
  antecedentesDetalle: "Multa de transito",

  tipoVisa: "VISITANTE_SIN_PERMISO",
  fechaIngresoMexico: "2026-10-10",
  ciudadIngreso: "Cancun",
  temporalidad: "MENOR_180",
  haVisitadoMexico: "SI",
  haSidoDeportado: "SI",
  causaDeportacion: "Cierre de CBP One",
  propositoViaje: "Vinculo familiar",

  documentosAdjuntos: [
    "Pasaporte original y copia",
    "Planilla de solicitud y cita impresa",
    "Matrimonio legalizado original y copia",
    "Comprobante de pago",
    "",
  ],

  lugarFirma: "Consulado de Mexico en La Habana, Cuba",
  fechaFirma: "2026-10-10",
};

(async () => {
  const outputDir = path.join(__dirname, "..", "output");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const pdfBuffer = await fillVisaPdf(sampleData);
  const outPath = path.join(outputDir, "sample-filled.pdf");
  fs.writeFileSync(outPath, pdfBuffer);

  console.log(`PDF de muestra generado: ${outPath}`);
})();
