# Auditoría: saveDB(), acceso compartido y recordar acceso
_Sesión v9 · 2026-11-03_

---

## 1. saveDB() — análisis y pendientes

### Cómo funciona

`saveDB()` en `js/core/almacenamiento.js` (línea 308):

1. Escribe `DB` serializado en `previewStorage[KEY]` (localStorage),  
   donde `KEY = 'tesorero_u_' + userId` para sesiones con usuario identificado.
2. Guarda un timestamp `tesorero_ts_<cloudId>` para control de concurrencia.
3. Dispara un guardado a Supabase (`saveToCloud(cloudId)`) con debounce de 1 s.
4. En `beforeunload` hace un `fetch` síncrono con `keepalive:true` si quedaba un guardado pendiente.

### Relación con apoderado_v9

- `puedeEscribir()` devuelve `false` para `apoderado_v9` (whitelist en `almacenamiento.js`).  
  Todas las acciones de escritura (pagos, movimientos, cuotas, etc.) comprueban  
  `puedeEscribir()` antes de llamar `saveDB()`.
- `doAccesoCodigoV9()` **no llama** `_setUserKeyV9()`, por lo que `KEY` retiene el  
  valor previo (vacío o del último tesorero en esa sesión de navegador).

### ⚠️ Pendiente #1 — saveDB() carece de guard de rol

`saveDB()` en sí **no verifica el rol** antes de escribir. Si alguna ruta omite la  
comprobación de `puedeEscribir()`, un `apoderado_v9` podría escribir en el  
localStorage del tesorero activo.

**Corrección recomendada** (en `saveDB()`):

```javascript
function saveDB(){
  // Guard: apoderado_v9 nunca escribe en el storage del tesorero
  if (S.session?.rol === 'apoderado_v9') return;
  // … resto del código …
}
```

---

## 2. Acceso compartido (apoderado_lector / visor)

### Flujo actual

- Tesorero genera código `CC-XXXX-XXXX` con `generarCodigoCompartido()`  
  (`js/features/preferencias.js`); se almacena en `DB.cursos[i].codigoCompartido`.
- El código se sincroniza a la nube vía `saveDB()` → `saveToCloud()`.
- Quien ingresa con ese código recibe `rol: 'apoderado_lector'` con acceso de solo  
  lectura a dashboard, movimientos, reportes y mis-datos.

### Estado en v9

- En la versión v9 el "acceso compartido" del apoderado usa un flujo distinto:  
  código de invitación (`CUR-XXX`) + PIN por alumno → `rol: 'apoderado_v9'`.
- El código `CC-XXXX-XXXX` sigue existiendo para el acceso de "visor" del tesorero  
  (acceso compartido al panel completo, no al estado de un alumno).

### ⚠️ Pendiente #2 — sin migración del acceso compartido a v9

El acceso compartido (`codigoCompartido`) sigue leyendo `DB.cursos` (modelo local).  
En un tenant 100% v9 relacional, `DB.cursos` estará vacío y `codigoCompartido`  
no se aplicará. No hay RPC v9 para acceso de tipo "visor" del tesorero.

**Trabajo pendiente:** decidir si el acceso compartido v9 debe reemplazarse por  
invitaciones en Supabase, o si el rol `visor` queda fuera del flujo v9 inicial.

---

## 3. Recordar acceso (apoderado_lector vs apoderado_v9)

### apoderado_lector (modelo local)

Checkbox `#ap-recordar` en el formulario de acceso. Si está marcado, `doAccesoCodigo()` guarda:

| Clave localStorage | Valor |
|--------------------|-------|
| `tesorero_ap_recordar` | `'1'` |
| `tesorero_ap_cursoId`  | id del curso |
| `tesorero_ap_aluId`    | id del alumno |
| `tesorero_ap_pin`      | PIN en texto plano |

En el próximo load, `bindLogin()` detecta la clave y hace auto-login.

⚠️ **El PIN se guarda en texto plano en localStorage.** Esto es un riesgo conocido  
del modelo antiguo. En v9 se corrige por diseño (no persistencia del PIN).

### apoderado_v9 (modelo relacional)

`doAccesoCodigoV9()` **deliberadamente no persiste el PIN**. La arquitectura de  
seguridad de v9 se basa en la no persistencia, no en la inaccesibilidad:

- `window._v9PinEnMemoria` **sí es accesible desde consola** (`window._v9PinEnMemoria()`  
  devuelve el PIN). Esto es una propiedad del closure de JS, no un bug:  
  cualquier variable global en un navegador es accesible desde la consola del mismo  
  navegador, en el mismo proceso, por el mismo usuario.
- La propiedad de seguridad real es que el PIN **no sobrevive al cierre de la pestaña**,  
  al refresco de la página, ni al logout (`logoutApoderadoV9()` hace `_v9PinEnMemoria = null`).
- No se escribe en `localStorage`, `sessionStorage`, ni en el DOM.

### ⚠️ Pendiente #3 — checkbox "Recordar mi acceso" en pantalla v9

En `doVerificarCodigoV9()`, si el formulario heredado muestra el checkbox `#ap-recordar`  
y el usuario lo marca, la marca se ignora silenciosamente. El usuario no recibe  
retroalimentación de que el acceso v9 no puede recordarse.

**Corrección recomendada:** ocultar el checkbox en el flujo v9, o reemplazar su label  
por: _"Por seguridad, el acceso con PIN no se puede recordar automáticamente."_

### ⚠️ Pendiente #4 — coexistencia `tesorero_ap_recordar` entre flujos

Si un usuario usó el flujo antiguo (apoderado_lector) y dejó `tesorero_ap_recordar=1`  
en localStorage, y luego el tesorero activa `V9_RELACIONAL`, `bindLogin()` intentará  
hacer auto-login con el flujo antiguo antes de evaluar si el flujo es v9.  
En la práctica esto falla graciosamente (el PIN incorrecto no pasa), pero el UX  
muestra un "panel de acceso rápido" que no debería aparecer.

**Corrección recomendada:** en `bindLogin()`, antes de mostrar el panel rápido,  
verificar `if (typeof V9_RELACIONAL === 'undefined' || !V9_RELACIONAL)` para omitir  
el bloque de auto-login del flujo antiguo cuando el tenant es v9.

---

## 4. Resumen de pendientes

| # | Área | Severidad | Descripción |
|---|------|-----------|-------------|
| 1 | `saveDB()` | Media | Agregar guard `if (rol === 'apoderado_v9') return` |
| 2 | Acceso compartido v9 | Alta | No existe RPC v9 para rol "visor" del tesorero; pendiente decisión de diseño |
| 3 | Checkbox recordar en v9 | Baja | Ocultar o cambiar label en flujo `V9_RELACIONAL` |
| 4 | Auto-login legado con V9 activo | Baja | Guard `V9_RELACIONAL` en bloque auto-login de `bindLogin()` |

Los pendientes #3 y #4 son de bajo riesgo y pueden resolverse en la misma iteración  
que la integración completa de la pantalla de acceso v9. El pendiente #2 requiere  
una decisión de arquitectura antes de implementar.
