# Tesorero: demostración organizada por archivos

Esta copia es independiente. No se publicó ni se modificó la aplicación que utilizan los usuarios.

## Abrir la demostración

1. Descomprime el ZIP completo en una carpeta de un computador.
2. Con Python 3 instalado, abre una terminal en esa carpeta y ejecuta:

   ```sh
   python iniciar.py
   ```

   En macOS/Linux puede ser `python3 iniciar.py`.
3. Se abrirá el navegador con una dirección local. Cierra el servidor con Ctrl+C.

No abras solamente `index.html` con doble clic: el navegador necesita un servidor local para cargar el JSON. No hace falta instalar dependencias para usar la app. El servidor escucha únicamente en `127.0.0.1`, sin publicar el proyecto en internet. Las capturas incluidas se pueden ver directamente desde un celular.

## Organización

| Ubicación | Contenido |
| --- | --- |
| `index.html` | Estructura mínima, carga ordenada de estilos y scripts. |
| `styles/base.css` | Estilos heredados. |
| `styles/profesional.css` | Diseño de la demostración y adaptación a pantallas. |
| `data/demo.json` | Datos iniciales ficticios: cursos, alumnos, pagos, movimientos y notas. |
| `js/core/` | Estado compartido, finanzas, almacenamiento, navegación y modales. |
| `js/features/` | Funciones de alumnos, cuotas, pagos, fondos, movimientos, cobranza, reportes, configuración y archivos. |
| `js/preview/` | Aislamiento, mejoras de la demo y arranque. |
| `vendor/` | Chart.js y SheetJS locales. |
| `scripts.json` | Lista ordenada de archivos JavaScript. |
| `tests/` | Pruebas reproducibles y resultado obtenido. |
| `capturas/` | Vistas móvil y escritorio. |

Se separaron 36 archivos de funciones heredadas, más 3 archivos de la demostración. Se conservaron scripts clásicos y el estado compartido para mantener compatibilidad con los eventos del HTML existente. Esta entrega no transforma todavía toda la app en módulos ES con import/export.

`demo.json` es la semilla de la demostración, no una base de datos activa. Los cambios realizados en el navegador se guardan localmente; no reescriben el JSON. El botón «Reiniciar demo» elimina solo los datos locales de esta copia y vuelve a cargar el JSON.

## Aislamiento

- No contiene el servidor ni la clave de producción.
- No carga la biblioteca de autenticación.
- Solo permite `fetch` de `data/demo.json`, desde el propio servidor local.
- Una política CSP bloquea conexiones a otros orígenes, workers y envíos de formularios.
- Los enlaces externos y funciones de envío de notificaciones están desactivados.
- Usa su propio prefijo de almacenamiento: `tesorero-modular-demo:v1:`.
- No instala ni actualiza un service worker y no sincroniza con la aplicación pública.

Mantén esta copia fuera del alojamiento de producción. No necesita datos reales para probarse.

## Verificación realizada

Chromium, móvil de 390 × 844 y escritorio de 1440 × 1000:

- Carga completa de archivos y JSON, sin recursos fallidos.
- Diez secciones en cada tamaño, sin desbordamiento de la página.
- Gráficos sin errores al cambiar de pantalla.
- Alta de alumno y nota; conservación al recargar.
- Pago de $5.000: saldo de $57.000 a $62.000.
- Rechazo de monto negativo y pago duplicado.
- Restablecimiento de la demo sin borrar otras claves del navegador.
- Pantalla de recuperación si los datos locales están dañados, sin sobrescribirlos.
- Sin errores JavaScript ni solicitudes externas durante estas pruebas.

El resultado está en `tests/resultado.json`. Esto verifica los escenarios indicados; no certifica todos los flujos heredados ni sustituye una auditoría financiera o de seguridad antes de una futura publicación.

Para repetir las pruebas hacen falta Node.js, Python 3, Playwright y Chromium:

```sh
npm install --no-save playwright
npx playwright install chromium
node tests/pruebas.cjs
```

Si se utiliza un Chromium del sistema, puede indicarse su ruta con `CHROMIUM_PATH`. No hacen falta estas dependencias para abrir la demostración con `iniciar.py`.

## Bibliotecas

Chart.js 4.4.1 (MIT) y SheetJS Community Edition 0.18.5 (Apache-2.0). Se conservan los avisos incluidos en sus archivos. Las conexiones y funciones de integración heredadas se conservan para una futura revisión, pero permanecen desactivadas en esta copia.
