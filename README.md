# Plataforma Web - Solicitud de Visa (Mexico / La Habana)

Aplicacion web para capturar los datos del solicitante y generar automaticamente la planilla PDF oficial de solicitud de visa.

## Tecnologias elegidas

- `Node.js + Express`: backend simple, robusto y mantenible.
- `zod`: validacion estricta de entrada.
- `pdf-lib`: escritura profesional de datos en la planilla PDF.
- `HTML/CSS/JS` (sin framework): facil de mantener y desplegar.

## Estructura

- `server.js`: servidor y endpoints API.
- `public/`: interfaz web.
- `src/validation/visaSchema.js`: reglas de validacion.
- `src/services/pdfFiller.js`: motor de relleno del PDF.
- `src/config/pdfLayout.js`: coordenadas de campos (calibrables).
- `assets/visa-template.pdf`: planilla base.

## Instalacion y uso

```bash
npm install
npm run dev
```

Abrir en navegador: [http://localhost:3000](http://localhost:3000)

## Flujo

1. El usuario completa el formulario.
2. El frontend llama `POST /api/generate-visa-pdf`.
3. El backend valida todos los datos.
4. Se genera el PDF final con letra profesional y marcas `X`.
5. Se descarga automaticamente el archivo listo para imprimir.

## Cambios de calibracion

- Se agregaron `tipo de visa` y `tipo de pasaporte`.
- `nacionalidad` se captura como gentilicio (ejemplo: Cubana, Mexicana, Canadiense).
- Correo electronico limitado a `27` caracteres por espacio fisico disponible en la planilla.
- `antecedentesDetalle` y `causaDeportacion` ahora pueden quedar en blanco.
- Documentos adjuntos recortan texto para no salirse del renglon visible.

## Nota importante

- La seccion de `Nombre y firma del solicitante` se deja para firma manuscrita, como indicaste.
- Si necesitas ajuste fino de alineacion (1-2 mm), solo se editan coordenadas en `src/config/pdfLayout.js`.
