# Instalación limpia de staging — El Gran Cambio v9

> ⚠️ **Nunca ejecutar en producción** (`https://tmjqzaakzhecbldebyeg.supabase.co`)  
> Todos los datos son ficticios. Las credenciales administrativas se configuran
> en el entorno seguro; nunca aparecen en el chat ni en el repositorio.

---

## Archivos del esquema v9 validado

| Archivo | Líneas | Propósito |
|---|---|---|
| `sql/01_schema.sql` | 804 | Tablas, extensiones, funciones SECURITY DEFINER, triggers |
| `sql/02_rls.sql` | 573 | RLS ENABLE + políticas por operación |
| `sql/07_grants_supabase.sql` | 472 | REVOKEs, GRANTs y verificación automática (43 checks) |
| `sql/08_seed_staging.sql` | 470 | Datos ficticios (2 usuarios, 3 cursos, 5 alumnos…) |
| `sql/09_fixture_usuario_c.sql` | — | Fixture adicional: Usuario C como visor en cur-a-01 |

Los archivos en `tests/sql/` están marcados **OBSOLETO** — no usar.

---

## Orden de ejecución obligatorio

```
01_schema.sql → 02_rls.sql → 07_grants_supabase.sql → 08_seed_staging.sql
```

Opcionalmente, después del seed base:
```
09_fixture_usuario_c.sql
```

---

## Requisitos previos

1. **Proyecto Supabase de staging limpio** — sin tablas previas en `public`.
   Si el staging actual tiene datos, confirmar primero que son todos ficticios
   (ver sección "Verificar staging actual" al final).

2. **Usuarios en Authentication** — crear manualmente en el dashboard de staging
   antes de ejecutar el seed:
   - `usuario_a@staging.test` — anota el UUID → `USER_A_UUID`
   - `usuario_b@staging.test` — anota el UUID → `USER_B_UUID`
   - `usuario_c@staging.test` — anota el UUID → `USER_C_UUID` (para fixture 09)
   
   Usar "Create user" con contraseña; **no** usar "Invite user" (el email
   `@staging.test` no existe y el link expira).

3. **SQL Editor del dashboard** con privilegios de `postgres` (superuser).

---

## Paso a paso

### Paso 1 — Ejecutar `01_schema.sql`

```sql
-- En SQL Editor del proyecto staging, como postgres
\i sql/01_schema.sql
```

**Resultado esperado:** sin errores. Objetos creados:
- 18 tablas en `public` con claves compuestas `PRIMARY KEY (cuenta_id, id)`
- Schema privado `_staging` con tabla `tesorero_datos`
- Extensión `pgcrypto`
- 5 funciones SECURITY DEFINER: `get_mis_cuentas`, `get_mis_cursos`,
  `es_dueno`, `tiene_rol_en_curso`, `_curso_de_cuota`
- 5 funciones de trigger: `_check_pago_mismo_curso`,
  `_check_abono_plan_consistente`, `_check_alumno_cambio_curso`,
  `_check_cuota_cambio_curso`, `_check_plan_cambio_titular`
- 7 triggers sobre `pagos`, `planes_pago`, `abonos`, `alumnos`, `cuotas`

### Paso 2 — Ejecutar `02_rls.sql`

```sql
\i sql/02_rls.sql
```

**Resultado esperado:** sin errores. RLS habilitado en 18 tablas.
`_curso_de_cuota` se redefine con `CREATE OR REPLACE` (normal).

Políticas creadas por tabla:

| Tabla | Políticas |
|---|---|
| `tesorero_cuentas` | tc_select, tc_update |
| `colegios` | colegios_select/insert/update/delete |
| `cursos` | cursos_select/insert/update/delete |
| `alumnos` | alumnos_select/insert/update/delete |
| `apoderados` | apoderados_select/insert/update/delete |
| `cuotas` | cuotas_select/insert/update/delete |
| `pagos` | pagos_select/insert/update/delete |
| `abonos` | abonos_select/insert/update/delete |
| `planes_pago` | planes_select/insert/update/delete |
| `movimientos` | mov_select/insert/update/delete |
| `fondo_movimientos` | fondo_select/insert/update/delete |
| `notas` | notas_select/insert/update/delete |
| `usuarios_cuenta` | uc_select/insert/update/delete |
| `usuarios_externos` | ext_select/insert/update/delete |
| `codigos_invitacion` | ci_select/insert/update/delete |
| `config_cuenta` | cfg_select/insert/update/delete |
| `suscripciones` | (ninguna — solo service_role) |
| `alumnos_credenciales` | (ninguna — solo service_role) |

### Paso 3 — Ejecutar `07_grants_supabase.sql`

```sql
\i sql/07_grants_supabase.sql
```

**Resultado esperado:** `07_grants_supabase.sql v3 aplicado y verificado correctamente.`

El script se ejecuta dentro de una transacción `BEGIN/COMMIT`. Si alguna
de las 43 verificaciones falla, hace `ROLLBACK` automático y muestra el
error. En ese caso revisar el paso fallido antes de continuar.

Verificaciones incluidas:
- 5 helpers RLS: `authenticated` DEBE tener EXECUTE; `anon` NO debe tenerlo
- 5 funciones trigger: ningún cliente debe tener EXECUTE
- 2 tablas protegidas (`suscripciones`, `alumnos_credenciales`): sin SELECT para clientes
- 16 tablas de negocio: `authenticated` DEBE tener SELECT
- `service_role`: USAGE en schema public
- Schema `_staging`: clientes sin USAGE

### Paso 4 — Ejecutar `08_seed_staging.sql` (con UUIDs reales)

Sustituir los marcadores antes de ejecutar:

```bash
# Ejemplo (reemplazar con los UUIDs reales de tu proyecto):
sed 's/USER_A_UUID/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/g; \
     s/USER_B_UUID/yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy/g' \
  sql/08_seed_staging.sql > /tmp/seed_con_uuids.sql
```

O editar el archivo en el SQL Editor directamente reemplazando los marcadores.

**Resultado esperado:**
```
Seed OK (v3): 2 cuentas | 3 membresías | 5 alumnos | 4 cuotas | 2 pagos | 1 planes | 1 abonos
```

El seed verifica:
- UUIDs existen en `auth.users`
- Recuentos exactos por tabla
- `auth_id` correcto en `tesorero_cuentas` y `usuarios_cuenta`
- Relaciones `plan → alumno → cuota` y `abono → plan → alumno → cuota`

### Paso 5 (opcional) — Fixture Usuario C

```bash
sed 's/USER_C_UUID/zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz/g' \
  sql/09_fixture_usuario_c.sql > /tmp/fixture_c.sql
```

**Resultado esperado:**
```
Fixture OK: C (...) → visor en Cuenta A, curso cur-a-01
```

---

## Verificaciones post-instalación

### Claves compuestas (todas deben mostrar `cuenta_id`)

```sql
SELECT c.relname AS tabla, pg_get_constraintdef(con.oid, true) AS pk
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND con.contype = 'p'
ORDER BY c.relname;
```

Resultado esperado: 17 tablas con `PRIMARY KEY (cuenta_id, id)` o
`PRIMARY KEY (cuenta_id)` (para `config_cuenta` y `suscripciones`).
Solo `tesorero_cuentas` tiene `PRIMARY KEY (id)`.

### Triggers (7 triggers en 4 tablas)

```sql
SELECT t.tgname, c.relname AS tabla, p.proname AS funcion
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_proc p ON p.oid = t.tgfoid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;
```

Resultado esperado: 7 filas — `trg_pagos_mismo_curso`, `trg_planes_mismo_curso`,
`trg_abonos_mismo_curso`, `trg_abonos_plan_consistente`,
`trg_alumno_cambio_curso`, `trg_cuota_cambio_curso`, `trg_plan_cambio_titular`.

### RLS habilitado en todas las tablas

```sql
SELECT relname, relrowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT relrowsecurity;
```

Resultado esperado: 0 filas (todas con RLS habilitado).

---

## Problema conocido: membresía A-en-B con `curso_id=NULL`

El seed v3 crea Usuario A como tesorero en Cuenta B con `curso_id=NULL`.

`get_mis_cursos(cuenta_b)` filtra `WHERE curso_id IS NOT NULL`, por lo que A
no obtiene cursos visibles en Cuenta B bajo las políticas RLS actuales.

**Esto no es un bug**: un rol no-dueño con `curso_id=NULL` es una membresía
registrada sin asignación de curso. Ver `sql/09b_nota_uc_a_en_b.sql`.

**Impacto en tests:** si `test:03` verifica que A ve cursos de Cuenta B,
fallará con el seed actual. Opciones antes de correr los tests:
- a) Añadir un fixture que asigne `cur-b-01` a la membresía `uc-a-en-b`.
- b) Ajustar `test:03` para verificar que A aparece como miembro de B
     (vía `uc_select`), no que ve sus cursos.

Decidir con el equipo cuál es el comportamiento esperado antes de correr tests.

---

## Verificar staging actual antes de reemplazarlo

Antes de borrar el staging actual, confirmar que solo contiene datos ficticios:

```sql
-- 1. Revisar emails en tesorero_cuentas
SELECT id, email, nombre FROM tesorero_cuentas;

-- 2. Revisar usuarios en auth (requiere service_role o postgres)
SELECT id, email FROM auth.users;

-- 3. Contar filas por tabla
SELECT schemaname, tablename, n_live_tup
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY n_live_tup DESC;
```

Si todas las filas corresponden a `@staging.test` o datos claramente ficticios,
el staging puede ser reemplazado. De lo contrario, consultar al equipo.

---

## Prueba local (referencia — instalación verificada `2026-10-29`)

La secuencia `01 → 02 → 07 → 08 → 09` fue ejecutada sobre PostgreSQL 16 local
con schema `auth` simulado. Resultados:

| Paso | Resultado |
|---|---|
| `01_schema.sql` | 18 tablas, 5 funciones SECURITY DEFINER, 7 triggers — sin errores |
| `02_rls.sql` | 18 tablas con RLS, 78 políticas — sin errores |
| `07_grants_supabase.sql` | **43/43 verificaciones ✓** — COMMIT |
| `08_seed_staging.sql` | Seed OK (v3): 2/3/5/4/2/1/1 — COMMIT |
| `09_fixture_usuario_c.sql` | Fixture OK: C → visor cur-a-01 — COMMIT |
| RLS C (cur-a-01 solamente) | `cur-a-01` ✓, `cur-a-02` no visible ✓ |
