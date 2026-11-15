# Inventario de brechas V9 — 2026-11-15

**HEAD:** `4ffec7c` · rama `gran-cambio-v9-relacional`  
**Criterio:** listo para ensayo integral de migración cuando todas las brechas estén **Implementado + Probado**.

---

## Resumen ejecutivo

| Área | Schema SQL | datos_v9.js | Frontend V9 | Tests | Estado |
|------|:---:|:---:|:---:|:---:|--------|
| Alumnos CRUD | ✅ | ✅ | ✅ | ✅ E5 21/0 | **LISTO** |
| Cuotas CRUD | ✅ | ✅ | ✅ | ✅ E5 | **LISTO** |
| Pagos CRUD | ✅ | ✅ | ✅ | ✅ E5 | **LISTO** |
| Pagos lote (RPC) | ✅ | ✅ | ✅ | ✅ E5 | **LISTO** |
| Apoderados + PIN | ✅ | ✅ | ✅ | ✅ E5/E6 | **LISTO** |
| Movimientos + Storage | ✅ | ✅ | ✅ | ✅ E6 33/0 | **LISTO** |
| Fondo especial + Actividades | ✅ | ✅ | ✅ | ✅ E7 API 29/0 + UI 13/0 | **LISTO** |
| Código compartido (CC) | ✅ | ✅ | ✅ | ✅ E5 (v9CcVerificar…) | **LISTO** |
| Invitaciones (codigos_invitacion) | ✅ | ⚠️ sin CRUD V9 | ⚠️ usa fetch directo legacy | ❌ sin suite | **BRECHA B1** |
| Planes de pago | ✅ RLS lista | ❌ sin funciones | ❌ bloqueado en frontend | ❌ sin suite | **BRECHA B2** |
| Abonos | ✅ RLS lista | ❌ sin funciones | ❌ bloqueado en frontend | ❌ sin suite | **BRECHA B2** |
| Notas | ✅ schema+RLS | ❌ sin funciones | ❌ usa saveDB() local | ❌ sin suite | **BRECHA B3** |
| Configuración (config_cuenta) | ✅ schema | ❌ sin funciones | ❌ usa DB.config local | ❌ sin suite | **BRECHA B4** |
| Sesiones / usuarios_cuenta | ✅ schema | ⚠️ solo lectura en cargarSesionV9 | ✅ rol+delegado funciona | ✅ E5 | **LISTO (readonly)** |
| Respaldo/exportación | — | — | ⚠️ exporta blob local | — | **B5 (menor)** |

---

## Detalle de brechas

### B1 — Invitaciones (codigos_invitacion)

**Estado:** Schema ✅ · RLS: no detectada · datos_v9: ❌ · Frontend: usa fetch() directo

**Situación actual:**  
`invitaciones.js` llama directamente a `fetch(SUPA_URL+'/rest/v1/codigos_invitacion?...')` sin pasar por `_v9Fetch`. La tabla existe en staging y el flujo funcionaba en el modo legacy, pero:
- No hay funciones `cargarInvitacionesV9`, `crearInvitacionV9`, `eliminarInvitacionV9` en `datos_v9.js`
- `codigos_invitacion` no tiene RLS habilitada en `02_rls.sql` (solo `planes_pago`, `abonos`, `notas`, `movimientos`, `fondo_movimientos`, `actividades`)

**Impacto en migración:** Si la tabla tiene RLS habilitada en producción, el `fetch()` directo fallará silenciosamente o con 403. Si no tiene RLS, habrá acceso sin aislamiento de cuenta.

**Acción requerida:**
1. Verificar si `codigos_invitacion` necesita RLS en staging
2. Añadir funciones CRUD en `datos_v9.js` que pasen por `_v9Fetch`
3. Actualizar `invitaciones.js` para usar esas funciones
4. Test: crear, listar, eliminar código vía V9

---

### B2 — Planes de pago y abonos (planes_pago + abonos)

**Estado:** Schema ✅ · RLS ✅ (políticas `planes_select/insert/update/delete`, `abonos_*`) · datos_v9: ❌ · Frontend: **explícitamente bloqueado** con `alert()`

**Situación actual:**  
`pagos-formularios.js` tiene cuatro funciones bloqueadas en V9_RELACIONAL:
- `guardarPlanPago()` → alert "no disponible en modo relacional"
- `pagarAbono()` → alert "no disponible"
- `eliminarPlanPago()` → alert "no disponible"
- edición de abonos → alert "no disponible"

No existe ninguna función en `datos_v9.js` para `planes_pago` ni `abonos`.

**El SQL `10_codigo_compartido_v9.sql` YA cuenta los abonos en los RPCs de saldos.** Si se migran datos con planes/abonos existentes, el motor de saldos los verá correctamente, pero la UI no los podrá crear ni modificar.

**Impacto en migración:** Los usuarios que tenían planes de pago activos no podrán gestionarlos tras la migración. Es una **brecha funcional bloqueante** si hay usuarios con planes activos en producción.

**Acción requerida:**
1. Añadir en `datos_v9.js`:
   - `crearPlanPagoV9(cuentaId, cursoId, data, accessToken)`
   - `actualizarPlanPagoV9(cuentaId, planId, data, accessToken)`
   - `eliminarPlanPagoV9(cuentaId, planId, accessToken)`
   - `crearAbonoV9(cuentaId, cursoId, planId, data, accessToken)`
   - `actualizarAbonoV9(cuentaId, abonoId, data, accessToken)`
   - `cargarPlanesPagoV9(cuentaId, cursoId, accessToken)` (incluir en `recargarCursoV9`)
2. Actualizar `pagos-formularios.js`: reemplazar los cuatro bloques `alert()` con llamadas V9
3. Test suite E8 o extensión E5: CRUD planes + abonos + saldo integrado

---

### B3 — Notas

**Estado:** Schema ✅ (tabla `notas` con `cuenta_id`, `curso_id`, `texto`, `color`, `fijada`) · RLS ✅ · datos_v9: ❌ · Frontend: **usa `saveDB()`** (localStorage)

**Situación actual:**  
`notas.js` guarda todo en `DB.notas` vía `saveDB()`. En V9_RELACIONAL el arranque hace `DB.notas = []` al iniciar sesión, borrando cualquier nota migrada. Las notas no se cargan de Supabase.

**Impacto en migración:** Las notas existentes en producción no migrarían automáticamente. Después de la migración, todas las notas creadas en la app se perderían al recargar la página.

**Acción requerida:**
1. Añadir en `datos_v9.js`:
   - `cargarNotasV9(cuentaId, cursoId, accessToken)`
   - `crearNotaV9(cuentaId, cursoId, data, accessToken)`
   - `actualizarNotaV9(cuentaId, notaId, data, accessToken)`
   - `eliminarNotaV9(cuentaId, notaId, accessToken)`
2. En `recargarCursoV9`: poblar `DB.notas` desde Supabase
3. En `notas.js`: reemplazar `saveDB()` con llamadas V9 en `guardarNota/editarNota/eliminarNota/fijarNota`
4. Test: crear, editar, fijar, eliminar nota; verificar que persiste al recargar

---

### B4 — Configuración (config_cuenta)

**Estado:** Schema ✅ (tabla `config_cuenta` con `moneda`, `tipo_org`, `app_url`, `plantilla_pago`, `categorias`) · RLS: no verificada · datos_v9: ❌ · Frontend: **usa `DB.config` local**

**Situación actual:**  
`configuracion.js` lee y escribe completamente de/en `DB.config` (localStorage). En V9_RELACIONAL no hay carga de `config_cuenta` desde Supabase en el arranque. Los cambios de vocabulario, URL de app, plantilla de WhatsApp, etc., se pierden al cambiar de dispositivo.

**Impacto en migración:** Configuración no migra. Tesoreros que configuren la app en un dispositivo no verán esos ajustes en otro. Es **baja criticidad** si las config son por dispositivo a propósito, pero **alta** si se usa multi-dispositivo.

**Acción requerida (mínimo):**
1. Añadir `cargarConfigCuentaV9` / `guardarConfigCuentaV9` en `datos_v9.js`
2. Cargar en `cargarSesionV9` y poblar `DB.config` desde la tabla
3. Actualizar funciones de guardado en `configuracion.js`  
*(Puede diferirse a post-migración si se decide que config es por dispositivo)*

---

### B5 — Exportación/Respaldo (menor)

**Estado:** `configuracion.js` exporta el blob `DB` completo. Incluirá `DB.notas = []`, planes vacíos, etc. en V9_RELACIONAL.

**Impacto:** El respaldo exportado no es fiel a los datos reales (están en Supabase, no en el blob).  
**Acción requerida:** Diferir a post-migración o mostrar aviso en la UI de que el respaldo en modo V9 es parcial.

---

## Qué sí está implementado y probado

| Área | Suite | Casos |
|------|-------|-------|
| Alumnos, apoderados, PIN, cuotas, pagos, pagos-lote | E5 (`test_v9_staging.js`) | 21 ✅ |
| Movimientos, Storage, Edge Function, PIN bloqueo | E6 (`e6_movimientos_pin.js`) | 33 ✅ |
| Fondo especial + Actividades (REST) | E7-API (`e7_fondos_actividades.js`) | 29 ✅ |
| Fondo especial + Actividades (UI Playwright) | E7-UI (`e7_ui.js`) | 13 ✅ |
| **Total validado** | | **96 casos ✅** |

---

## Orden de implementación recomendado

```
B2 (planes/abonos) — bloqueante si hay datos en producción
B3 (notas)         — datos se pierden tras migración
B1 (invitaciones)  — puede fallar silenciosamente con RLS
B4 (config)        — menor, puede diferirse
B5 (export)        — aviso en UI, diferible
```

**La app puede declararse lista para ensayo de migración cuando B1, B2 y B3 estén implementados y cubiertos por tests.**  
B4 y B5 pueden diferirse a un sprint posterior sin bloquear la migración.

---

## Restricciones permanentes

- Producción `https://www.eltesorero.cl` / `tmjqzaakzhecbldebyeg.supabase.co` — **NO TOCAR**
- Staging `rucgmytyxpfowznowxwd.supabase.co` — solo datos ficticios
- Credenciales no deben aparecer en el chat ni en el repositorio
- Ninguna migración sobre producción sin aprobación explícita del usuario
