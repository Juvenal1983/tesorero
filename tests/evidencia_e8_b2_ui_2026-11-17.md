# Evidencia B2 — Recorrido UI aprobado

**Fecha:** 2026-11-17  
**Rama:** `gran-cambio-v9-relacional`  
**Commit definitivo:** `8595f24`  
**Entorno:** Staging — `https://rucgmytyxpfowznowxwd.supabase.co`  
**Producción (NO TOCADA):** `https://tmjqzaakzhecbldebyeg.supabase.co`

---

## Resultado: 48 ✅ / 0 ❌

Recorrido UI completo (Playwright headless, `tests/e8_planes_abonos_ui.js`).

---

## Alcance ensayado en este commit

| Paso | Descripción | Estado |
|------|-------------|--------|
| U01  | Servidor HTTP local | ✅ |
| U02  | App cargada (Chromium headless) | ✅ |
| U03  | Login tesorero vía UI | ✅ |
| U04  | Seleccionar curso de test | ✅ |
| U05  | Navegar a Pagos → alumno | ✅ |
| U06-b/c/d/e | Crear plan 2 abonos; planId vía DB; 2 abonos sin pagar | ✅ |
| U07-a | pagar_abono — abono pagado en DB (find, no index) | ✅ |
| U07-b | Botón ↩ exacto `data-abono="${paidAbonoId7}"` | ✅ |
| U07-c | 1 abono pagado en staging | ✅ |
| U08-a/b/c | Pagar abono 2; plan activo=false; 2/2 pagados | ✅ |
| U08-d/e | G05: tabla pagos sin filas; endpoint accesible 200 | ✅ |
| U12-pre-a/b/c | CC resumen al completar: monto_abonado=90000, pendiente=0 | ✅ |
| U09-a/b/c/d | Recarga: plan cerrado persiste; 2 abonos pagados | ✅ |
| U10-a | Botón 📅 en selector alumno+cuota+período ("Diciembre 2026") | ✅ |
| U10-b | Botón ↩ visible en plan COMPLETADO (getPlanPago sin &&p.activo) | ✅ |
| U10-c | revertir_abono: abono 0 pagado=false en DB | ✅ |
| U10-d/e | Botón 💰 reaparece; plan activo=true tras revertir | ✅ |
| U10-f/g/h/i | Saldos exactos: $45k pagado, $45k deuda | ✅ |
| U11-a/b/c | Post-revert reload: estado correcto persiste | ✅ |
| U12-a/b/c | CC resumen post-revert: 200; alumno presente; sin PIN/clave | ✅ |
| U12-d/e | CC resumen post-revert: monto_abonado=45000, pendiente=45000 | ✅ |
| U13-a/b | apoderado_acceso PIN correcto: 200, sin error | ✅ |
| U13-c/d | situacion_financiera: 200; contiene datos planes/balance | ✅ |
| U13-e | Plan: monto_pagado=45000, monto_pendiente=45000, activo=true | ✅ |
| U13-f | balance_curso.total_pagado exacto (si presente) | ✅ |
| U13-g | PIN incorrecto rechazado | ✅ |

---

## Commits que componen el resultado

| SHA | Descripción |
|-----|-------------|
| `8595f24` | fix(e8): mes_inicio/termino cuota, selector U10 exacto, U12 importes dobles |
| `7410498` | fix(e8-ui): U07-b exacto, U10 diagnóstico real, U13-e duro, limpieza verificada |
| `3b842ba` | fix(sql+test): 42702 en apoderado_cc_resumen_pagos + 4 issues E8 |
| `bcc08c8` | fix(b2): getPlanPago sin &&p.activo + recorrido UI corregido |

---

## Evidencias separadas (no parte de este resultado)

| Tipo | Archivo | Estado |
|------|---------|--------|
| Pruebas API (REST directo, sin UI) | `tests/e8_planes_abonos.js` | ⏳ pendiente staging |
| Rollback local PG (ISO.2) | `tests/evidencia_e8_matriz_2026-11-15.md` | ✅ `ca5fa4d` |
| SQL `11_rpc_b2_planes.sql` en staging | — | ⏳ requiere intervención manual |

> Las columnas "Staging API" y "PG local" de la matriz anterior siguen vigentes
> de forma independiente. No se declaran como ejecutadas por este recorrido UI.

---

## Correcciones incluidas en 8595f24

1. **Cuota fixture** `mes_inicio:11, mes_termino:11` → calendario genera un único
   período "Diciembre YYYY"; elimina los 11 botones 📅 espurios de enero–noviembre.

2. **U10 selector exacto** `[onclick*="showModal('planPago'"][onclick*="${CUOTA_ID}"][onclick*="${PERIODO}"]`
   → apunta al botón de Diciembre, no al primero que coincide con la cuota.

3. **U12-pre** (nuevo tras U08) → exige `monto_abonado=90000, monto_pendiente=0`
   cuando el plan acaba de completarse.

4. **U12-d/e** (post-revert) → exige `monto_abonado=45000, monto_pendiente=45000`;
   bloqueado automáticamente si `!revertEjecutado`.
