# Evidencia E7-UI — Playwright — 2026-11-15

## Resultado: **13 OK / 0 fallidos / 0 pendientes**

| Capa | Archivo | SHA local | Resultado |
|------|---------|-----------|-----------|
| UI Playwright | `tests/e7_ui.js` | `4ffec7c` | ✅ 13 / 0 |

## Commits ensayados

```
4ffec7c  chore: actualizar package-lock.json
1d1b3e9  test(e7): seleccionar participantes y capturar alertas en ACT.1 y ACT.2
d7e86fb  fix(e7-ui): corregir condición de carrera en seleccionarCurso
c00ee0b  fix(e7-ui): corregir 4 fallos mwi2lwri + añadir casos modal actividad
```

Rama: `gran-cambio-v9-relacional`  
Staging: `rucgmytyxpfowznowxwd.supabase.co`  
Producción (NO TOCADA): `tmjqzaakzhecbldebyeg.supabase.co`

---

## Casos validados

### Infraestructura
| ID | Descripción | Resultado |
|----|-------------|-----------|
| INF.1 | Servidor local arranca en puerto 8792 | ✅ |
| INF.2 | Login staging + selección de curso | ✅ |

### FM — Fondo movimientos UI
| ID | Descripción | Resultado |
|----|-------------|-----------|
| FM.1 | Crear movimiento fondo vía modal | ✅ |
| FM.2 | Editar movimiento fondo | ✅ |
| FM.3 | Verificar persistencia recargando | ✅ |
| FM.4 | Recargar datos del curso | ✅ |
| FM.5 | Eliminar movimiento (dos confirm) | ✅ |

### ACT — Actividades UI
| ID | Descripción | Resultado |
|----|-------------|-----------|
| ACT.1 | Crear actividad: abrir modal, marcar participantes, guardar → POST confirmado | ✅ |
| ACT.2 | Editar actividad | ✅ |
| ACT.3 | Verificar que actividad editada aparece en lista | ✅ |
| ACT.4 | Eliminar actividad | ✅ |

### RPT — Reporte fondo especial
| ID | Descripción | Resultado |
|----|-------------|-----------|
| RPT.1 | Totales del reporte ≥ MONTO_RPT | ✅ |

### VIS — Visor no puede escribir
| ID | Descripción | Resultado |
|----|-------------|-----------|
| VIS.1 | Actividad visible en vista de visor | ✅ |

---

## Correcciones aplicadas en esta sesión

| Commit | Problema | Solución |
|--------|----------|----------|
| `c00ee0b` | `buildModal()` sin cases `addActividad`/`editActividad` → modal vacío | Añadir `case 'addActividad': return modalActividad()` y `case 'editActividad': return modalActividad(data.id)` |
| `c00ee0b` | FM.5: `page.once()` solo maneja primer `confirm` → delete bloqueado | Handler persistente `page.on()` + espera DOM disappear |
| `c00ee0b` | Fixture RPT en tabla equivocada (`fondo_movimientos`) | Mover a `/actividades` donde lee `drawReporteCharts()` |
| `c00ee0b` | ACT.3 falso positivo cuando `actId` era `null` | Guard `if (!actId) pend(...)` |
| `d7e86fb` | Condición de carrera: `recargarCursoV9` completando después de navegar | Esperar `S.cursoId === id && S.route === 'dashboard'` |
| `1d1b3e9` | `saveActividad()` exige participantes; test no marcaba ninguno | `evaluateAll` para marcar todos los `.act-check`; alert handler; `waitForFunction(S.route==='actividades' && !S.modal)` |

---

## Estado E7 — CERRADO para flujos probados

| Suite | Resultado | Notas |
|-------|-----------|-------|
| E7-API (29 casos) | ✅ Cerrado | Commit `ff39015` — `431b125` |
| E7-UI (13 casos)  | ✅ Cerrado | Commit `1d1b3e9` — `4ffec7c` |

**E7 completo.** La capa de fondos especiales y actividades está validada en REST y en UI.

> Nota: SQL `E7_fondos_actividades.sql` no ha sido ejecutado en staging — las tablas
> ya existían por el schema base. Producción no tocada.
