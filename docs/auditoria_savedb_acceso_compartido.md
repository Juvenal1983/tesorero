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

### ✅ Pendiente #1 — RESUELTO (commit 862bae2)

Guard de rol aplicado en `saveDB()` (`js/core/almacenamiento.js`):

```javascript
function saveDB(){
  if (S && S.session && S.session.rol === 'apoderado_v9') return;
  // … resto del código …
}
```

Un `apoderado_v9` jamás puede escribir en el localStorage del tesorero.

---

## 2. Acceso compartido (apoderado_lector / visor)

### Flujo actual

- Tesorero genera código `CC-XXXX-XXXX` con `generarCodigoCompartido()`  
  (`js/features/preferencias.js`); se almacena en `DB.cursos[i].codigoCompartido`.
- El código se sincroniza a la nube vía `saveDB()` → `saveToCloud()`.
- Quien ingresa con ese código recibe `rol: 'apoderado_lector'` con acceso de solo  
  lectura a dashboard, movimientos, reportes y mis-datos.

### Estado en v9

- El código `CC-XXXX-XXXX` es generado por el **tesorero** y permite que los  
  **apoderados y miembros del curso** consulten quién ha pagado y quién debe.  
  **No** es un "tesorero visor" ni un acceso al panel completo del tesorero.  
  Es una función de transparencia: cualquier miembro del curso puede ver el estado  
  de pagos del grupo completo usando ese código.
- En v9 el flujo de apoderado individual usa código `CUR-XXX` + PIN → `rol: 'apoderado_v9'`.  
  El código `CC-XXXX-XXXX` es **complementario**, no equivalente ni reemplazado.

### ⚠️ Pendiente #2 — sin RPC v9 para acceso compartido (CC-XXXX)

El acceso compartido (`codigoCompartido`) sigue leyendo `DB.cursos` (modelo local).  
En un tenant 100% v9 relacional, `DB.cursos` estará vacío y `codigoCompartido`  
no se aplicará.

**Trabajo pendiente:** implementar RPC v9 para consulta de estado de pagos del curso  
mediante código CC-XXXX. El rol de ese acceso es permitir transparencia a los  
miembros del curso, no reemplazar el modelo de invitaciones ni otorgar acceso de tesorero.  
Este pendiente queda separado del flujo de invitaciones.

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

### ✅ Pendiente #3 — RESUELTO

Checkbox `#ap-recordar` oculto (`display:none`) en `acceso.js`. El elemento sigue  
en el DOM para mantener compatibilidad, pero no es visible ni interactuable.  
Queda como pendiente futuro implementar recordatorio seguro de acceso para v9.

### ✅ Pendiente #4 — RESUELTO

Guard `!V9_RELACIONAL` agregado en el bloque de auto-login legacy de `bindLogin()`:

```javascript
if(!window._skipApAutoLogin && !V9_RELACIONAL && previewStorage.getItem('tesorero_ap_recordar')==='1'){
```

En tenants v9, el auto-login del flujo antiguo queda completamente inactivo.

---

## 4. Resumen de pendientes

| # | Área | Severidad | Estado | Descripción |
|---|------|-----------|--------|-------------|
| 1 | `saveDB()` | Media | ✅ RESUELTO (862bae2) | Guard `if (rol === 'apoderado_v9') return` aplicado |
| 2 | Acceso compartido v9 (CC-XXXX) | Alta | ⏳ Pendiente | RPC v9 para consulta de pagos del curso por código CC-XXXX; es transparencia para miembros, no "visor tesorero" |
| 3 | Checkbox recordar en v9 | Baja | ✅ RESUELTO | Oculto (`display:none`) en `acceso.js`; pendiente implementación segura futura |
| 4 | Auto-login legado con V9 activo | Baja | ✅ RESUELTO | Guard `!V9_RELACIONAL` en `bindLogin()` |

El pendiente #2 requiere decisión de arquitectura: implementar un RPC v9 que  
permita a miembros del curso ver el estado de pagos del grupo usando el código CC-XXXX.
