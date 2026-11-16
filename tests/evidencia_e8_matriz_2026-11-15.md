# Matriz de evidencia — E8 Planes de pago y abonos (B2)

**Rama:** `gran-cambio-v9-relacional`  
**Staging Supabase:** `https://rucgmytyxpfowznowxwd.supabase.co`  
**Producción (NO TOCADA):** `https://tmjqzaakzhecbldebyeg.supabase.co`

---

## Historial de revisiones SQL

| Rev | SHA     | Cambio                                                        | Estado    |
|-----|---------|---------------------------------------------------------------|-----------|
| 4   | —       | `_sort_abonos` con `ORDER BY (val->>'fecha')::DATE`           | ❌ bug    |
| 5   | —       | `_sort_abonos` cambia a `ORDER BY val->>'fecha'` (texto)      | ✅ corregido |
| 6   | `6e141b7`| Bloque 1: check explícito `IF IS NULL` antes de `::DATE`     | ✅ en staging pendiente |

**Rev 6 pendiente de aplicar en staging** — el tesorero debe ejecutar
`sql/11_rpc_b2_planes.sql` en la consola SQL de staging antes de la ronda final.

---

## Matriz de casos de prueba

### ISO — Invariantes de atomicidad

| Caso   | Descripción                                      | PG local | Staging API | Recorrido UI |
|--------|--------------------------------------------------|----------|-------------|--------------|
| ISO.1a | Fecha no parseable → `abono_fecha_invalida`      | —        | ✅ rev 5    | —            |
| ISO.1b | Campo `fecha` ausente → `abono_fecha_invalida`   | —        | ⏳ rev 6 pendiente | —     |
| ISO.2  | Rollback mid-write (trigger fallo controlado)    | ✅ `ca5fa4d` | n/a (no API) | —       |

**ISO.2 — evidencia local (`ca5fa4d`):**
```
Comando: sudo -u postgres psql -d iso2_test -f /tmp/iso2_test.sql
Salida:
  NOTICE:  ERROR esperado recibido: fault_inject_mid_write
  NOTICE:  planes_pago con id=plan-iso2-test: 0 (esperado: 0)
  NOTICE:  abonos con plan_id=plan-iso2-test: 0 (esperado: 0)
  NOTICE:  ✓ ISO.2 PASÓ: rollback completo verificado
```

---

### PLAN — Gestión de planes

| Caso    | Descripción                                          | PG local | Staging API | Recorrido UI  |
|---------|------------------------------------------------------|----------|-------------|---------------|
| PLAN.15 | Crear plan → `planes_pago` + `abonos` insertados     | —        | ⏳ pendiente | Paso 1       |
| PLAN.16 | Plan duplicado → error `plan_ya_existe`              | —        | ⏳ pendiente | —            |
| PLAN.17 | Eliminar plan sin abonos pagados → OK                | —        | ⏳ pendiente | —            |
| PLAN.17b| Eliminar plan con abonos pagados → error bloqueante  | —        | ⏳ pendiente | —            |
| PLAN.18 | Pagar abono → `pagado=true`, `fecha_pago=hoy`        | —        | ⏳ pendiente | Pasos 2–3    |
| PLAN.G04| Completar todos → plan se cierra (`activo=false`)    | —        | ⏳ pendiente | Paso 3       |
| PLAN.G05| `crear_plan_con_abonos` NO inserta en tabla `pagos`  | —        | ⏳ pendiente | —            |
| PLAN.G06| Recarga: estado persiste en staging (no localStorage)| —        | ⏳ pendiente | Paso 4       |
| PLAN.G07| Revertir abono pagado → `pagado=false`               | —        | ⏳ pendiente | Paso 6       |

---

### SEC — Seguridad de acceso

| Caso  | Descripción                                              | PG local | Staging API | Recorrido UI |
|-------|----------------------------------------------------------|----------|-------------|--------------|
| SEC.1 | Usuario B sin rol en curso → no puede crear plan         | —        | ⏳ pendiente | —           |
| SEC.2 | Tesorero sin JWT → `401`                                 | —        | ⏳ pendiente | —           |
| SEC.3 | Tesorero en cuenta ajena → error de autorización         | —        | ⏳ pendiente | —           |

---

### SALDO — Vista apoderado (anon)

| Caso    | Descripción                                            | PG local | Staging API | Recorrido UI |
|---------|--------------------------------------------------------|----------|-------------|--------------|
| SALDO.1 | `apoderado_cc_resumen_pagos` devuelve alumnos/cuotas   | —        | ⏳ pendiente | Paso 5      |
| SALDO.2 | Plan completado aparece como pagado en resumen         | —        | ⏳ pendiente | Paso 5      |
| SALDO.3 | CC inválido → error                                    | —        | ⏳ pendiente | —           |

---

## Estado de los handlers UI

| Handler              | Archivo               | Estado              | Validado (Node sim) |
|----------------------|-----------------------|---------------------|---------------------|
| `guardarPlanPago`    | pagos-formularios.js  | ✅ implementado     | ⏳ pendiente        |
| `pagarAbono`         | pagos-formularios.js  | ✅ implementado     | ⏳ pendiente        |
| `eliminarPlanPago`   | pagos-formularios.js  | ✅ implementado     | ⏳ pendiente        |
| `revertirAbono`      | pagos-formularios.js  | ✅ **añadido** `402e0d9` | ⏳ pendiente   |
| Vista apoderado CC   | (pantalla apoderado)  | ✅ existe           | ⏳ pendiente        |

---

## Commits relevantes

| SHA       | Descripción                                                  |
|-----------|--------------------------------------------------------------|
| `6e141b7` | sql rev 6: NULL fecha check explícito en Bloque 1            |
| `ca5fa4d` | ISO.2 ejecutado en PG local; `checkNoPagos` sin catch→[]     |
| `402e0d9` | UI: botón ↩ Revertir en abono pagado; handler `revertirAbono`|

---

## Próximos pasos

1. **Tesorero aplica** `sql/11_rpc_b2_planes.sql` rev 6 en staging (consola SQL).
2. **Tesorero ejecuta** `node tests/e8_planes_abonos.js` → suite API completa.
3. **Tesorero ejecuta** `node tests/e8_seed_demo.js` → siembra datos ficticios.
4. **Recorrido manual** siguiendo `tests/e8_walkthrough.md` (pasos 1–7).
5. Columnas "Staging API" y "Recorrido UI" se completan con resultados reales.
6. Tras B2 aprobado: continuar con B3 (notas), B1 (invitaciones), B4 (configuración), B5 (respaldo).
