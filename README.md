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
- `public/blog.html`: listado de noticias.
- `public/noticia.html`: lectura completa de una noticia.
- `public/blog.js`: render, filtros y enlaces a detalle.
- `public/noticia.js`: carga de noticia por id y noticias relacionadas.
- `internal/reporter/reporteros.html`: panel interno no enlazado para reporteros.
- `internal/reporter/reporteros.js`: login de reportero, carga de imagen local y publicacion.
- `src/data/blog-posts.json`: almacenamiento local de noticias.
- `src/data/blogStore.js`: lectura/escritura de noticias.
- `src/validation/blogSchema.js`: validacion de creacion de noticias.
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

## Publicar una noticia en el blog

1. Ve a la ruta interna configurada en `REPORTER_PORTAL_PATH` (por defecto: `/acceso-reporteros-interno`).
2. Inicia sesion con la contrasena de reportero.
3. Completa el formulario de noticia y pulsa `Publicar noticia`.
4. La imagen se sube desde la PC a `public/uploads/`.
5. La noticia se guarda en `src/data/blog-posts.json` y aparece en el blog.
6. En la seccion `Gestionar publicaciones` puedes eliminar noticias existentes.

## Variables de entorno para reporteros

- `REPORTER_PASSWORD`: contrasena requerida para iniciar sesion en el area de reporteros.
- `REPORTER_SESSION_SECRET`: clave para firmar cookies de sesion (usar una cadena larga en produccion).
- `REPORTER_PORTAL_PATH`: ruta privada del panel interno (ejemplo: `/mi-panel-interno-2026`).
