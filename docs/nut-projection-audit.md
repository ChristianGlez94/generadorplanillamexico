# Auditoria tecnica del estimador NUT

Fecha de revision: 2026-06-19

## Resumen ejecutivo

El algoritmo de proyeccion esta implementado tanto en el backend Node como en la app Android nativa. La app Android no lee directamente archivos `.xlsx`; descarga CSV exportado desde Google Sheets y, si no existe un CSV sincronizado en almacenamiento local, usa un CSV embebido en assets. El backend web tampoco lee `.xlsx`; carga un CSV en memoria al iniciar.

El archivo `/Users/desarrollo/Downloads/nut_assignments (2).xlsx` tiene 1,920 registros validos, sin celdas vacias, sin fechas invalidas y sin NUT duplicados. Sus columnas son `nut` y `appointment_date`. El CSV actualmente consumido por backend y Android tiene 1,686 registros y termina en `2026-06-05`, mientras que el `.xlsx` llega hasta `2026-06-26`. Faltan 234 registros del Excel en los CSV de la app.

Impacto: para NUT ya presentes en el Excel pero ausentes en el CSV, la app los trata como desconocidos y devuelve proyecciones. Ejemplo medido: `7526796` es historico en el Excel con fecha `2026-06-26`, pero con el CSV actual se proyecta como desconocido hacia `2026-06-24`.

## Flujo actual de datos

### Backend web

- `server.js` define `NUT_MODEL_CSV_PATH`, con default `model-nut/nut_assignments.csv`.
- `ensureNutProjectionModelLoaded()` carga una vez el CSV, entrena el modelo y lo conserva en `NUT_MODEL_STATE.bundle`.
- `/api/nut-forecast` valida reCAPTCHA, valida que el NUT tenga 7 digitos y responde con `buildNutProjection(...)`.
- No hay endpoint de carga de `.xlsx` ni watcher de archivo. Cambiar el CSV requiere reiniciar el proceso o limpiar el estado en memoria.

Referencias: `server.js:340`, `server.js:2116`, `src/services/nutProjectionModel.js:453`.

### Android

- `NutModelRepository.loadModel()` primero busca `nut_assignments_local.csv` en `filesDir`.
- Si existe, usa ese cache local y marca `fromDownloadedCsv = true`.
- Si no existe, usa el asset `app/src/main/assets/nut_assignments.csv`.
- `updateFromGoogleSheet()` descarga CSV desde una URL compartida de Google Sheets, prueba dos formatos de exportacion (`export?format=csv` y `gviz...out:csv`), valida entrenando el motor y reemplaza el cache local.
- `MainActivity` solo calcula con el motor ya cargado y muestra diagnosticos basicos: cantidad de registros, ultima fecha del CSV, rango historico y ultima sincronizacion.

Referencias: `android-app/app/src/main/java/com/planillavisamexico/app/NutModelRepository.kt:38`, `android-app/app/src/main/java/com/planillavisamexico/app/NutModelRepository.kt:67`, `android-app/app/src/main/java/com/planillavisamexico/app/MainActivity.kt:1015`, `android-app/app/src/main/java/com/planillavisamexico/app/MainActivity.kt:1248`.

## Estructura esperada del archivo

El motor no consume `.xlsx` directamente. Lo que realmente espera es CSV con las dos primeras columnas en este orden:

```csv
nut,appointment_date
7181892,2026-01-05
```

Hallazgos:

- El Excel revisado tiene columnas exactas `nut` y `appointment_date`.
- El parser no usa nombres de columnas; usa posiciones. Si Google Sheets exporta columnas extra despues de `appointment_date`, normalmente no rompe. Si una columna extra queda antes de `nut` o entre `nut` y `appointment_date`, si rompe.
- La fecha debe venir como `YYYY-MM-DD`. Fechas tipo `05/01/2026`, seriales de Excel o formatos localizados se descartan silenciosamente.
- Filas vacias, NUT invalido y fecha invalida se omiten sin reporte por fila.
- NUT duplicados se consolidan conservando la fecha mas antigua.
- El input no necesita venir ordenado; el parser ordena internamente por NUT para el modelo. Para la velocidad reciente agrupa por fecha y ordena las fechas.

Referencias: `src/services/nutProjectionModel.js:423`, `android-app/app/src/main/java/com/planillavisamexico/app/NutProjectionEngine.kt:157`, `android-app/app/src/main/java/com/planillavisamexico/app/NutProjectionEngine.kt:488`.

## Perfil del Excel revisado

- Hojas: `nut_assignments`.
- Filas de datos: 1,920.
- Columnas: `nut`, `appointment_date`.
- Registros invalidos: 0.
- NUT duplicados: 0.
- Rango NUT: `5177229` a `7526796`.
- Rango de fechas: `2026-01-05` a `2026-06-26`.
- El archivo esta ordenado por fecha, no estrictamente por NUT: hay 23 inversiones adyacentes de NUT por backfills semanales.
- Comparado contra `model-nut/nut_assignments.csv` y `android-app/app/src/main/assets/nut_assignments.csv`: faltan 234 registros en ambos CSV; no hay fechas distintas para los NUT compartidos.

## Algoritmo actual

El modelo usa dias habiles como eje temporal:

1. Convierte cada fecha historica a indice de dias habiles desde la fecha minima.
2. Ordena los registros por NUT.
3. Calcula una pendiente global robusta `dias_habiles_por_NUT` con Theil-Sen.
4. Calcula un intercepto como mediana de `y - slope * x`.
5. Calcula residuos del modelo global.
6. Para un NUT consultado dentro del rango historico, ajusta el valor global con un residuo local ponderado por vecinos cercanos.
7. Para NUT mayor al maximo historico, extrapola desde el borde y mezcla pendiente global con velocidad reciente, usando 35 dias observados como maximo.
8. Para NUT menor al minimo historico, extrapola hacia atras con la pendiente global, pero la fecha final queda acotada a no ser anterior al minimo historico.
9. Si el NUT ya existe en el historico, devuelve la fecha historica y no una proyeccion.
10. Las ventanas 80% y 95% se derivan del backtest rolling por fechas.

Referencias: `src/services/nutProjectionModel.js:251`, `src/services/nutProjectionModel.js:300`, `src/services/nutProjectionModel.js:343`, `src/services/nutProjectionModel.js:370`, `src/services/nutProjectionModel.js:492`, `android-app/app/src/main/java/com/planillavisamexico/app/NutProjectionEngine.kt:190`.

## Casos criticos

- NUT menor al primer historico: funciona, pero se acota a la primera fecha historica. La confianza baja si esta lejos del rango.
- NUT mayor al ultimo historico: funciona con extrapolacion y evita devolver una fecha ya asignada dentro del rango observado. Riesgo alto si el CSV esta desactualizado.
- NUT entre dos registros historicos: usa regresion global mas residuo local, no interpolacion lineal directa entre vecinos.
- Saltos grandes entre NUT: Theil-Sen resiste outliers mejor que una regresion simple, pero los saltos siguen ampliando el error.
- Periodos sin asignaciones: se modelan implicitamente en dias habiles; no hay feriados ni cierres consulares especiales.
- Fechas repetidas con multiples NUT: soportado.
- Datos en orden incorrecto: soportado.
- Columnas adicionales: solo seguro si van despues de las dos primeras columnas.
- Datos incompletos: se omiten silenciosamente; si quedan menos de 20 registros, falla el entrenamiento.

## Riesgos principales

1. Datos obsoletos: los CSV de backend y Android no reflejan el Excel actual. Este es el mayor riesgo de precision.
2. Formato de fecha fragil: Android y backend solo aceptan ISO `YYYY-MM-DD`. Si Google Sheets exporta fechas localizadas, el modelo puede perder filas o no entrenar.
3. Sin advertencia de stale data: la UI muestra ultima fecha del CSV, pero no advierte si esta demasiado atrasada respecto al dia actual o respecto a la hoja remota.
4. Cache local Android sin TTL: si existe `nut_assignments_local.csv`, la app lo usa hasta que el usuario sincronice o cambie/restablezca URL.
5. Backend cachea en memoria: aunque se actualice el CSV en disco, el proceso web sigue usando el modelo anterior hasta reiniciar o recargar explicitamente.
6. Incertidumbre subestimada o mal comunicada: se muestra MAE y ventanas, pero no se explica que backfills de NUT bajos en semanas recientes bajan la confiabilidad local.
7. No hay feriados consulares: solo se excluyen sabados y domingos.

## Mediciones con CSV actual vs Excel convertido

Metadatos:

- CSV actual: 1,686 registros, `2026-01-05` a `2026-06-05`, NUT maximo `7499935`, MAE `6.73` dias habiles.
- Excel convertido: 1,920 registros, `2026-01-05` a `2026-06-26`, NUT maximo `7526796`, MAE `9.59` dias habiles.

Ejemplos:

- `7141726`: CSV actual lo proyecta como desconocido hacia `2026-01-09`; Excel lo marca historico `2026-06-08`.
- `7501938`: CSV actual lo proyecta `2026-06-08`; Excel lo marca historico `2026-06-09`.
- `7526796`: CSV actual lo proyecta `2026-06-24`; Excel lo marca historico `2026-06-26`.
- `7528000`: CSV actual proyecta `2026-06-24`; Excel convertido proyecta `2026-06-29`.

## Recomendaciones por fases

### Fase 1: sin cambiar negocio

- Actualizar los CSV embebidos desde el Excel/Google Sheet validado.
- Agregar una validacion de freshness: advertir si `metadata.maxDate` tiene mas de 7 dias naturales de atraso.
- Mostrar una advertencia mas fuerte cuando `confidence` sea `media-baja` o `baja`.
- Documentar que la hoja debe exportar `appointment_date` como `YYYY-MM-DD`.

### Fase 2: robustez de importacion

- Crear un validador comun de CSV que reporte filas invalidas, duplicados y rango de fechas antes de entrenar.
- Aceptar formatos de fecha controlados (`YYYY-MM-DD`, `DD/MM/YYYY`) o normalizar la hoja antes de exportar.
- Rechazar hojas donde las columnas `nut` y `appointment_date` no existan en los encabezados, en vez de confiar solo en posicion.
- En Android, despues de descargar, guardar tambien un resumen de validacion para diagnostico.

### Fase 3: modelo y calidad predictiva

- Incorporar feriados o dias sin operacion consular conocidos.
- Separar backfills de NUT antiguos de la tendencia principal, o ponderarlos menos para la extrapolacion futura.
- Comparar el modelo actual contra una alternativa por frontera diaria monotona: para cada fecha, usar percentiles altos de NUT asignado y proyectar desde esa curva.
- Medir precision por segmentos: NUT dentro del rango, sobre maximo, y backfills de NUT bajos.

## Pruebas recomendadas

- Parser CSV: encabezados esperados, columnas extra, filas vacias, fecha invalida, NUT invalido, BOM, duplicados con fecha mas antigua.
- Parser Google Sheets: export `format=csv` y `gviz`, fecha ISO y fecha localizada.
- Modelo: conocido historico devuelve fecha historica exacta; NUT entre registros no se clasifica como conocido; NUT mayor al maximo no devuelve fecha anterior o igual a `maxDate`; pocos datos fallan con error claro.
- Android repository: carga asset si no hay cache, carga cache si existe, `setConfiguredSheetShareUrl` borra cache, descarga fallback de `export` a `gviz`.
- UI Android: muestra fecha real vs proyeccion, diagnostico de registros, ultima fecha del CSV y advertencias de baja confianza.
