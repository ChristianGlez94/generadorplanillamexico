const { z } = require("zod");

const yesNoEnum = z.enum(["SI", "NO"]);
const tipoVisaEnum = z.enum([
  "NO_MARCAR",
  "VISITANTE_SIN_PERMISO",
  "VISITANTE_SIN_PERMISO_LARGA_DURACION",
  "VISITANTE_CON_PERMISO",
  "VISITANTE_ADOPCION",
  "RESIDENTE_TEMPORAL_ESTUDIANTE",
  "RESIDENTE_TEMPORAL",
  "RESIDENTE_PERMANENTE",
  "DIPLOMATICA",
  "OFICIAL",
  "SERVICIO",
]);
const tipoPasaporteEnum = z.enum(["NO_MARCAR", "ORDINARIO", "NO_ORDINARIO", "LAISSEZ_PASSER"]);

const nonEmpty = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "Campo obligatorio");

const optionalTrimmed = z
  .string()
  .optional()
  .transform((value) => (typeof value === "string" ? value.trim() : ""));

function dateField(message) {
  return z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, message);
}

const visaFormSchema = z
  .object({
    oficinaConsularMode: z.enum(["LA_HABANA", "OTRA"]),
    oficinaConsularTexto: optionalTrimmed,

    nombres: nonEmpty,
    primerApellido: nonEmpty,
    segundoApellido: nonEmpty,
    sexo: z.enum(["FEMENINO", "MASCULINO", "NO_ESPECIFICA"]),
    fechaNacimiento: dateField("Fecha de nacimiento inválida"),

    paisNacimiento: nonEmpty,
    nacionalidad: nonEmpty,

    numeroPasaporte: nonEmpty,
    tipoPasaporte: tipoPasaporteEnum,
    paisExpedicion: nonEmpty,
    fechaExpedicion: dateField("Fecha de expedición inválida"),
    fechaVencimiento: dateField("Fecha de vencimiento inválida"),

    estadoCivil: z.enum(["SOLTERO", "CASADO", "CONCUBINATO"]),
    domicilioActual: nonEmpty,
    telefono: nonEmpty,
    correo: z
      .string()
      .trim()
      .email("Correo electrónico inválido")
      .max(
        35,
        "Correo muy largo para el espacio disponible (max. 35 caracteres)."
      ),
    ocupacion: nonEmpty,
    compania: nonEmpty,
    lugarResidencia: nonEmpty,
    cuentaLegalEstancia: yesNoEnum,
    antecedentesPenales: yesNoEnum,
    antecedentesDetalle: optionalTrimmed,

    fechaIngresoMexico: dateField("Fecha de ingreso inválida"),
    ciudadIngreso: nonEmpty,
    tipoVisa: tipoVisaEnum,
    temporalidad: z.enum(["MENOR_180", "MAYOR_180_HASTA_4", "DEFINITIVA"]),
    haVisitadoMexico: yesNoEnum,
    haSidoDeportado: yesNoEnum,
    causaDeportacion: optionalTrimmed,
    propositoViaje: nonEmpty,

    documentosAdjuntos: z
      .array(z.string().transform((value) => value.trim()))
      .max(5, "Máximo 5 documentos adjuntos")
      .default([]),

    lugarFirma: nonEmpty,
    fechaFirma: dateField("Fecha de firma inválida"),
  })
  .superRefine((data, ctx) => {
    if (data.oficinaConsularMode === "OTRA" && !data.oficinaConsularTexto) {
      ctx.addIssue({
        code: "custom",
        message: "Escriba la oficina consular",
        path: ["oficinaConsularTexto"],
      });
    }

    if (data.fechaVencimiento < data.fechaExpedicion) {
      ctx.addIssue({
        code: "custom",
        message: "La fecha de vencimiento no puede ser menor a la de expedición",
        path: ["fechaVencimiento"],
      });
    }
  });

module.exports = {
  visaFormSchema,
};
