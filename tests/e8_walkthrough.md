# Recorrido B2 — Planes de pago en staging

**Propósito:** Validar los handlers reales de la app (pagos-formularios.js + datos_v9.js)
contra el entorno de staging con datos ficticios, sin tocar producción.

**Prerequisito:** SQL rev 6 (`sql/11_rpc_b2_planes.sql`) aplicado en staging.

---

## 0. Preparación (desde la terminal)

```bash
# 1. Configurar .env con credenciales de staging (ver .env.example)
#    STAGING_KEY, STAGING_EMAIL, STAGING_PASS, STAGING_CUENTA_ID

# 2. Sembrar datos ficticios
node tests/e8_seed_demo.js
# → imprime CURSO_ID, CUOTA_ID, CC_CODE, 3 alumnos; guarda tests/e8_demo_ids.json

# 3. Abrir la app apuntando a staging
#    En __env.js (no committear):
#    window.STAGING_SUPA_URL = 'https://rucgmytyxpfowznowxwd.supabase.co'
#    window.STAGING_SUPA_KEY = '<anon key de staging>'
```

---

## 1. Crear plan de pago (3 abonos)

**Pantalla:** Pagos → curso "5° Básico A — DEMO" → fila del alumno "Valentina Morales Pérez"
→ columna "Cuota Marzo 2026 — DEMO" → botón **📅 Plan de pago**

1. Se abre modal "📅 Plan de pago — Valentina Morales Pérez".
2. Número de abonos: **3**. Fecha primer abono: **2026-12-01** (o la fecha que prefieras).
3. Verificar que aparecen 3 filas de abono con montos $30.000 c/u y fechas auto-completadas.
4. Clic **💾 Crear plan**.
5. ✅ Toast "Plan de pago creado". Modal se reabre mostrando el plan activo con 3 abonos sin pagar.

**Verifica G01/G02:** El modal muestra "0 de 3 abonos pagados".

---

## 2. Pagar primer abono (parcial)

**Pantalla:** Modal sigue abierto (o reabrirlo desde la fila del alumno).

1. Fila "Abono 1: $30.000" → botón **💰 Pagar**.
2. Confirmar diálogo "¿Marcar abono 1 de $30.000 como pagado?".
3. ✅ Toast "✅ Abono registrado". Modal se refresca.
4. Abono 1 muestra badge verde ✅ con fecha de hoy + botón ↩ a su derecha.
5. Alerta de plan: "1 de 3 abonos pagados".

**Verifica G03:** `abonos.pagado = true` para abono 1; plan sigue activo.

---

## 3. Completar el plan (pagar abonos 2 y 3)

1. Botón **💰 Pagar** en Abono 2 → confirmar → ✅ "Abono registrado".
2. Botón **💰 Pagar** en Abono 3 → confirmar → ✅ **"✅ Plan completado — todos los abonos pagados"**.
3. Modal muestra "3 de 3 abonos pagados". Alerta cambia de color.
4. Botón **🗑 Eliminar plan** pasa a mostrar advertencia "tiene abonos pagados".

**Verifica G04:** Plan cerrado (activo=false en staging) tras completar.

---

## 4. Recargar la página

1. Recargar (F5 / Cmd+R).
2. Volver a Pagos → "5° Básico A — DEMO" → "Valentina Morales Pérez".
3. Abrir el modal del plan.
4. ✅ Los 3 abonos siguen marcados como pagados (datos persistidos en staging, no en localStorage).

**Verifica G06:** snapshot `solicitud_json` inmutable; recarga muestra estado real.

---

## 5. Consultar situación financiera (vista apoderado)

**Pantalla:** Menú Apoderado → ingresar **Código CC** (obtenido del seed: `CC_CODE`)

1. Navegar a la sección apoderado de la app (o URL directa si existe link).
2. Ingresar el `CC_CODE` impreso por el seed.
3. ✅ Aparece resumen del alumno "Valentina Morales Pérez":
   - Cuota "Marzo 2026": **pagada** (vía plan de 3 abonos).
   - Total abonado: $90.000.

**Verifica SALDO.1/2/3:** `apoderado_cc_resumen_pagos` devuelve estado correcto vía `rpcAnon`.

---

## 6. Revertir un abono

**Pantalla:** Volver al modal del plan de Valentina.

> ⚠ El botón ↩ solo aparece si el plan está activo (`activo !== false`).
> Después de completarse el plan se cierra (`activo=false`). Para demostrar revertir,
> usar el alumno "Matías González Riquelme" con un plan parcial (solo 1 abono pagado).

1. Crear plan para **Matías** (misma cuota, 2 abonos de $45.000).
2. Pagar Abono 1 → badge ✅ + botón ↩.
3. Clic **↩** en Abono 1 → confirmar "¿Revertir el pago del abono 1 ($45.000)?".
4. ✅ Toast "↩ Pago revertido". Abono 1 vuelve a mostrar botón 💰.
5. Plan sigue activo.

**Verifica G07:** `revertir_abono` RPC ejecutado; `abonos.pagado=false` en staging.

---

## 7. Limpieza post-recorrido

```bash
node tests/e8_seed_demo.js --cleanup
# Elimina cursos, alumnos, cuotas, planes y abonos de demo.
# Borra tests/e8_demo_ids.json.
```

---

## Cobertura del recorrido

| Paso | Handler real invocado         | RPC staging            | Caso E8     |
|------|-------------------------------|------------------------|-------------|
| 1    | `guardarPlanPago`             | `crear_plan_con_abonos`| PLAN.15–17  |
| 2    | `pagarAbono`                  | `pagar_abono`          | PLAN.18     |
| 3    | `pagarAbono` × 2              | `pagar_abono`          | PLAN.18/G04 |
| 4    | (recarga)                     | REST GET               | G06         |
| 5    | (vista apoderado)             | `apoderado_cc_resumen_pagos` | SALDO.1–3 |
| 6    | `revertirAbono` ← **nuevo**   | `revertir_abono`       | —           |
| —    | `eliminarPlanPago`            | `eliminar_plan`        | PLAN.17     |

---

## Suite automatizada (previa al recorrido manual)

```bash
# Ejecutar ANTES del recorrido manual para validar la capa API
node tests/e8_planes_abonos.js
```

Asegura que todos los invariantes (ISO.1a/b, PLAN.15–17b, SEC.1–3, SALDO.1–3)
pasan contra staging antes de abrir el navegador.
