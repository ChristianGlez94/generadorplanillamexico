const path = require("path");
const express = require("express");
const cors = require("cors");

const { countryList } = require("./src/data/countries");
const { visaFormSchema } = require("./src/validation/visaSchema");
const { fillVisaPdf } = require("./src/services/pdfFiller");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use((_req, res, next) => {
  // Evita servir una version antigua del formulario o JS por cache del navegador.
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/countries", (_req, res) => {
  res.json({
    countries: countryList,
  });
});

app.post("/api/generate-visa-pdf", async (req, res) => {
  const parsed = visaFormSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: "Hay campos inválidos o incompletos.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const pdfBuffer = await fillVisaPdf(parsed.data);

    const safePassport = String(parsed.data.numeroPasaporte || "solicitud")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 16);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="solicitud_visa_${safePassport || "generada"}.pdf"`
    );

    return res.send(pdfBuffer);
  } catch (error) {
    console.error("Error generando PDF:", error);
    return res.status(500).json({
      message: "No se pudo generar el PDF. Intente de nuevo.",
    });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`Servidor activo en http://localhost:${port}`);
});
