const fs = require("fs");
const path = require("path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { layout } = require("../config/pdfLayout");

const templatePath = path.join(__dirname, "..", "..", "assets", "visa-template.pdf");
const BODY_TEXT_BASELINE_ADJUST = 8;
const DOB_FIELDS_BASELINE_ADJUST = 6;

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function toUpper(value) {
  return normalizeText(value).toLocaleUpperCase("es-MX");
}

function toPdfRect(rectPx) {
  const scale = layout.PX_SCALE;
  const x = rectPx.x / scale;
  const y = layout.PAGE_HEIGHT_PT - (rectPx.y + rectPx.h) / scale;
  const w = rectPx.w / scale;
  const h = rectPx.h / scale;

  return { x, y, w, h };
}

function toPdfPoint(pointPx) {
  return {
    x: pointPx.x / layout.PX_SCALE,
    y: layout.PAGE_HEIGHT_PT - pointPx.y / layout.PX_SCALE,
  };
}

function fitFontSize(font, text, widthPt, maxSize, minSize) {
  let size = maxSize;

  while (size > minSize && font.widthOfTextAtSize(text, size) > widthPt - 2) {
    size -= 0.2;
  }

  return Number(size.toFixed(1));
}

function truncateToWidth(font, text, widthPt, fontSize) {
  if (!text) return "";
  if (font.widthOfTextAtSize(text, fontSize) <= widthPt) return text;

  const suffix = "...";
  let trimmed = text;

  while (trimmed.length > 0 && font.widthOfTextAtSize(`${trimmed}${suffix}`, fontSize) > widthPt) {
    trimmed = trimmed.slice(0, -1);
  }

  return trimmed ? `${trimmed}${suffix}` : "";
}

function drawTextInRect(page, font, text, rectPx, options = {}) {
  const clean = normalizeText(text);
  if (!clean) return;

  const rect = toPdfRect(rectPx);
  const minSize = options.minSize ?? 5.6;
  const maxSize = options.maxSize ?? 8;
  const fixedSize = options.fixedSize ?? null;

  const fontSize = fixedSize ?? fitFontSize(font, clean, rect.w, maxSize, minSize);
  const drawText = options.clamp ? truncateToWidth(font, clean, rect.w - 2, fontSize) : clean;
  if (!drawText) return;

  const textWidth = font.widthOfTextAtSize(drawText, fontSize);

  let x = rect.x + 1;
  if (options.align === "center") {
    x = rect.x + (rect.w - textWidth) / 2;
  }
  if (options.align === "right") {
    x = rect.x + rect.w - textWidth - 1;
  }

  const baselineAdjust = options.baselineAdjust ?? BODY_TEXT_BASELINE_ADJUST;
  const y = rect.y + (rect.h - fontSize) / 2 + baselineAdjust;

  page.drawText(drawText, {
    x,
    y,
    size: fontSize,
    font,
    color: options.color ?? rgb(0.08, 0.08, 0.08),
  });
}

function drawMark(page, font, pointPx) {
  if (!pointPx) return;

  const point = toPdfPoint(pointPx);
  page.drawText("X", {
    x: point.x - 3.0,
    y: point.y + 4.6,
    size: 8.2,
    font,
    color: rgb(0.07, 0.07, 0.07),
  });
}

function formatDate(dateInput, separator = " / ") {
  if (!dateInput) return "";

  const [year, month, day] = String(dateInput).split("-");
  if (!year || !month || !day) return "";

  return `${day.padStart(2, "0")}${separator}${month.padStart(2, "0")}${separator}${year}`;
}

function splitDateParts(dateInput) {
  if (!dateInput) return { dia: "", mes: "", anio: "" };

  const [year, month, day] = String(dateInput).split("-");
  if (!year || !month || !day) return { dia: "", mes: "", anio: "" };

  return {
    dia: day.padStart(2, "0"),
    mes: month.padStart(2, "0"),
    anio: year,
  };
}

function splitEmailForTwoLines(email, maxPerLine = 24) {
  const clean = normalizeText(email).replace(/\s+/g, "");
  if (!clean) return ["", ""];
  if (clean.length <= maxPerLine) return [clean, ""];

  let splitIndex = clean.lastIndexOf("@", maxPerLine);
  if (splitIndex < 8) {
    splitIndex = clean.lastIndexOf(".", maxPerLine);
  }
  if (splitIndex < 8) {
    splitIndex = maxPerLine;
  }

  return [clean.slice(0, splitIndex), clean.slice(splitIndex)];
}

function drawDateParts(page, font, dateInput, partsLayout, options = {}) {
  const { dia, mes, anio } = splitDateParts(dateInput);
  drawTextInRect(page, font, dia, partsLayout.dia, {
    align: "center",
    maxSize: options.maxSize ?? 7.2,
    minSize: options.minSize ?? 6,
    baselineAdjust: options.baselineAdjust ?? BODY_TEXT_BASELINE_ADJUST,
  });
  drawTextInRect(page, font, mes, partsLayout.mes, {
    align: "center",
    maxSize: options.maxSize ?? 7.2,
    minSize: options.minSize ?? 6,
    baselineAdjust: options.baselineAdjust ?? BODY_TEXT_BASELINE_ADJUST,
  });
  drawTextInRect(page, font, anio, partsLayout.anio, {
    align: "center",
    maxSize: options.maxSize ?? 7.2,
    minSize: options.minSize ?? 6,
    baselineAdjust: options.baselineAdjust ?? BODY_TEXT_BASELINE_ADJUST,
  });
}

function calculateAge(dateInput) {
  const birthDate = new Date(dateInput);
  if (Number.isNaN(birthDate.getTime())) return "";

  const now = new Date();
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birthDate.getUTCMonth();

  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birthDate.getUTCDate())) {
    age -= 1;
  }

  return String(Math.max(0, age));
}

function getSecondSurnameTextOptions(value) {
  const clean = toUpper(value);
  const length = clean.length;

  if (length <= 9) {
    return {
      maxSize: 7,
      minSize: 5.6,
      clamp: true,
      baselineAdjust: BODY_TEXT_BASELINE_ADJUST,
    };
  }

  if (length <= 14) {
    return {
      maxSize: 6.4,
      minSize: 5,
      clamp: true,
      baselineAdjust: BODY_TEXT_BASELINE_ADJUST,
    };
  }

  return {
    maxSize: 6,
    minSize: 4.4,
    clamp: true,
    baselineAdjust: BODY_TEXT_BASELINE_ADJUST,
  };
}

async function fillVisaPdf(formData) {
  const templateBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  // Estilo normal para campos capturados, recomendado para documentos oficiales.
  const helveticaBold = helvetica;

  const [page1, page2] = pdfDoc.getPages();

  const officeConsular =
    formData.oficinaConsularMode === "LA_HABANA"
      ? "LA HABANA, CUBA"
      : toUpper(formData.oficinaConsularTexto);

  drawTextInRect(page1, helveticaBold, officeConsular, layout.page1.oficinaConsular, {
    align: "center",
    maxSize: 7.4,
    minSize: 6,
    baselineAdjust: 0.6,
  });

  drawTextInRect(page1, helveticaBold, toUpper(formData.nombres), layout.page1.nombres, {
    maxSize: 7,
    minSize: 5.6,
    clamp: true,
    baselineAdjust: BODY_TEXT_BASELINE_ADJUST,
  });
  drawTextInRect(page1, helveticaBold, toUpper(formData.primerApellido), layout.page1.primerApellido, {
    maxSize: 7,
    minSize: 5.6,
    clamp: true,
    baselineAdjust: BODY_TEXT_BASELINE_ADJUST,
  });
  drawTextInRect(
    page1,
    helveticaBold,
    toUpper(formData.segundoApellido),
    layout.page1.segundoApellido,
    getSecondSurnameTextOptions(formData.segundoApellido),
  );

  drawMark(page1, helveticaBold, layout.page1.sexoMarks[formData.sexo]);

  drawDateParts(page1, helvetica, formData.fechaNacimiento, layout.page1.fechaNacimientoPartes, {
    baselineAdjust: DOB_FIELDS_BASELINE_ADJUST,
  });
  drawTextInRect(page1, helvetica, calculateAge(formData.fechaNacimiento), layout.page1.edad, {
    align: "center",
    maxSize: 7.2,
    minSize: 6,
    baselineAdjust: DOB_FIELDS_BASELINE_ADJUST,
  });

  drawTextInRect(page1, helveticaBold, toUpper(formData.paisNacimiento), layout.page1.paisNacimiento, {
    maxSize: 6.8,
    minSize: 5.6,
    clamp: true,
  });
  drawTextInRect(page1, helveticaBold, toUpper(formData.nacionalidad), layout.page1.nacionalidad, {
    maxSize: 6.8,
    minSize: 5.2,
    clamp: true,
  });

  drawTextInRect(page1, helveticaBold, toUpper(formData.numeroPasaporte), layout.page1.numeroPasaporte, {
    maxSize: 7,
    minSize: 5.6,
    clamp: true,
  });
  drawTextInRect(page1, helveticaBold, toUpper(formData.paisExpedicion), layout.page1.paisExpedicion, {
    maxSize: 6.8,
    minSize: 5.6,
    clamp: true,
  });
  drawTextInRect(page1, helvetica, formatDate(formData.fechaExpedicion, "/"), layout.page1.fechaExpedicion, {
    align: "center",
    maxSize: 5.9,
    minSize: 5.4,
    fixedSize: 5.8,
  });
  drawDateParts(page1, helvetica, formData.fechaVencimiento, layout.page1.fechaVencimientoPartes);

  drawMark(page1, helveticaBold, layout.page1.estadoCivilMarks[formData.estadoCivil]);

  drawTextInRect(page1, helvetica, toUpper(formData.domicilioActual), layout.page1.domicilioActual, {
    maxSize: 5.8,
    minSize: 4.8,
    clamp: true,
  });
  drawTextInRect(page1, helvetica, normalizeText(formData.telefono), layout.page1.telefono, {
    maxSize: 6,
    minSize: 5.2,
    clamp: true,
  });
  const [correoLinea1, correoLinea2] = splitEmailForTwoLines(formData.correo);
  drawTextInRect(page1, helvetica, correoLinea1, layout.page1.correoLinea1, {
    fixedSize: 5.1,
    clamp: true,
  });
  drawTextInRect(page1, helvetica, correoLinea2, layout.page1.correoLinea2, {
    fixedSize: 5.1,
    clamp: true,
  });

  drawTextInRect(page1, helvetica, toUpper(formData.ocupacion), layout.page1.ocupacion, {
    maxSize: 6.4,
    minSize: 5.2,
    clamp: true,
  });
  drawTextInRect(page1, helvetica, toUpper(formData.compania), layout.page1.compania, {
    maxSize: 5.7,
    minSize: 4.8,
    clamp: true,
  });

  drawTextInRect(page1, helvetica, toUpper(formData.lugarResidencia), layout.page1.lugarResidencia, {
    fixedSize: 4.7,
    clamp: true,
  });
  drawMark(page1, helveticaBold, layout.page1.legalEstanciaMarks[formData.cuentaLegalEstancia]);

  drawMark(page1, helveticaBold, layout.page1.antecedentesMarks[formData.antecedentesPenales]);
  drawTextInRect(page1, helvetica, toUpper(formData.antecedentesDetalle), layout.page1.antecedentesDetalle, {
    maxSize: 6.2,
    minSize: 5,
    clamp: true,
  });

  // "NO_MARCAR" deja este apartado en blanco para uso oficial cuando aplica.
  if (formData.tipoVisa !== "NO_MARCAR") {
    drawMark(page1, helveticaBold, layout.page1.tipoVisaMarks[formData.tipoVisa]);
  }

  drawDateParts(page1, helvetica, formData.fechaIngresoMexico, layout.page1.fechaIngresoPartes);
  drawTextInRect(page1, helvetica, toUpper(formData.ciudadIngreso), layout.page1.ciudadIngreso, {
    maxSize: 6.5,
    minSize: 5.2,
    clamp: true,
  });

  drawMark(page1, helveticaBold, layout.page1.temporalidadMarks[formData.temporalidad]);
  drawMark(page1, helveticaBold, layout.page1.visitoMarks[formData.haVisitadoMexico]);
  drawMark(page1, helveticaBold, layout.page1.deportadoMarks[formData.haSidoDeportado]);

  drawTextInRect(page1, helvetica, toUpper(formData.causaDeportacion), layout.page1.causaDeportacion, {
    maxSize: 6.2,
    minSize: 5,
    clamp: true,
  });
  drawTextInRect(page1, helvetica, toUpper(formData.propositoViaje), layout.page1.propositoViaje, {
    maxSize: 6.4,
    minSize: 5,
    clamp: true,
  });

  // "NO_MARCAR" deja este apartado en blanco para uso oficial cuando aplica.
  if (formData.tipoPasaporte !== "NO_MARCAR") {
    drawMark(page1, helveticaBold, layout.page1.tipoPasaporteMarks[formData.tipoPasaporte]);
  }

  const docs = Array.from({ length: 5 }, (_, idx) => toUpper(formData.documentosAdjuntos[idx] || ""));
  docs.forEach((line, idx) => {
    // En documentos adjuntos priorizamos mostrar el texto completo ajustando el tamaño.
    drawTextInRect(page2, helvetica, line, layout.page2.documentos[idx], {
      maxSize: 5.6,
      minSize: 4.2,
      clamp: true,
    });
  });

  drawTextInRect(page2, helvetica, toUpper(formData.lugarFirma), layout.page2.lugar, {
    maxSize: 6,
    minSize: 5.2,
    clamp: true,
  });
  drawDateParts(page2, helvetica, formData.fechaFirma, layout.page2.fechaFirmaPartes, {
    maxSize: 7,
    minSize: 6,
  });

  return Buffer.from(await pdfDoc.save());
}

module.exports = {
  fillVisaPdf,
};
