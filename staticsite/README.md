# Static Site - Planilla Visa México

Sitio estático oficial para presentar la app Android **Planilla Visa México** y enlazar a Google Play.

## Estructura

- `index.html`: página principal
- `styles.css`: estilos
- `assets/`: imágenes y favicon
- `robots.txt` y `sitemap.xml`: SEO técnico básico
- `render.yaml`: configuración lista para Render Static Site

## Deploy en Render

1. Crear un servicio **Static Site** en Render.
2. Conectar este repositorio.
3. Verificar que Render detecte `render.yaml`.
4. Si Render solicita valores manuales:
   - `Runtime`: `static`
   - `Publish Directory`: `.`

## Dominio

Este sitio asume dominio principal:

- `https://planillavisamexico.com`

Si cambias el dominio, actualiza en `index.html` y `sitemap.xml`:

- `canonical`
- `og:url`
- `og:image` (si cambia la URL base)
- `Sitemap` en `robots.txt`
