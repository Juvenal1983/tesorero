# Instalación limpia de staging — El Gran Cambio v9

> ⚠️ **Nunca ejecutar en producción** (`https://tmjqzaakzhecbldebyeg.supabase.co`)  
> Todos los datos son ficticios. Las credenciales administrativas se configuran
> en el entorno seguro; nunca aparecen en el chat ni en el repositorio.

---

## Archivos del esquema v9 validado

| Archivo | Líneas | Propósito |
|---|---|---|
| `sql/01_schema.sql` | 804 | Tablas, extensiones, funciones SECURITY DEFINER, triggers |
| `sql/02_rls.sql` | 573 | RLS ENABLE + 62 políticas por operación |
| `sql/07_grants_supabase.sql` | 472 | REVOKEs, GRANTs y verificación automática (43 checks) |
| `sql/08_seed_staging.sql` | 470 | Datos ficticios (2 cuentas, 3 membresías, 5 alumnos…) |
| `sql/09_fixture_usuario_c.sql` | — | Fixture adicional: Usuario C como visor en cur-a-01 |
| `sql/09c_fixture_uc_a_en_b_curso.sql` | — | Fixture adicional: asigna cur-b-01 a uc-a-en-b (test:03) |

Los archivos en `tests/sql/` están marcados **OBSOLETO** — no usar.

---

## Orden de ejecución obligatorio

```
01_schema.sql → 02_rls.sql → 07_grants_supabase.sql → 08_seed_staging.sql
```

Opcionalmente, después del seed base (independientes entre sí):
```
09_fixture_usuario_c.sql        ← Usuario C como visor en cur-a-01
09c_fixture_uc_a_en_b_curso.sql ← asigna cur-b-01 a uc-a-en-b (test:03)
```

---

## Requisitos previos

1. **Proyecto Supabase de staging limpio** — sin tablas previas en `public`.
   Si el staging actual tiene tablas, verificar primero si contiene datos
   reales antes de cualquier cambio (ver sección "Conservar staging actual"
   al final de este documento).

2. **Usuarios en Authentication** — crear manualmente en el dashboard de staging
   antes de ejecutar el seed:
   - `usuario_a@staging.test` — anota el UUID → `USER_A_UUID`
   - `usuario_b@staging.test` — anota el UUID → `USER_B_UUID`
   - `usuario_c@staging.test` — anota el UUID → `USER_C_UUID` (para fixtures 09 y 09c)
   
   Usar "Create user" con contraseña; **no** usar "Invite user" (el email
   `@staging.test` no existe y el link expira).

3. **SQL Editor del dashboard** del proyecto staging con privilegios de
   `postgres` (superuser). Todos los archivos se pegan directamente en el
   editor; no se usan metacomandos psql como `\i`.

---

## Cómo ejecutar cada archivo

Para cada archivo SQL, abrir el archivo en un editor de texto, copiar
el contenido completo y pegarlo en el **SQL Editor del proyecto staging**
(`https://supabase.com/dashboard/project/<project-ref>/sql/new`).

Ejecutar en el orden indicado y esperar confirmación antes de continuar
con el siguiente archivo.

> **Nota:** Los metacomandos psql como `\i` no funcionan en el SQL Editor
> del dashboard de Supabase. Pegar el contenido directamente es el método
> correcto.

---

## Paso a paso

### Paso 1 — Ejecutar `01_schema.sql`

Abrir `sql/01_schema.sql`, copiar el contenido completo y pegarlo en el
SQL Editor del proyecto staging. Ejecutar.

**Resultado esperado:** sin errores. Objetos creados en la base de staging:
- 18 tablas en `public` con claves compuestas `PRIMARY KEY (cuenta_id, id)`  
  (solo `tesorero_cuentas` tiene `PRIMARY KEY (id)`)
- Schema privado `_staging` con tabla `tesorero_datos`
- Extensión `pgcrypto` (instala 36 funciones criptográficas en `public`)
- 5 funciones SECURITY DEFINER (helpers RLS): `get_mis_cuentas`,
  `get_mis_cursos`, `es_dueno`, `tiene_rol_en_curso`, `_curso_de_cuota`
- 5 funciones de trigger: `_check_pago_mismo_curso`,
  `_check_abono_plan_consistente`, `_check_alumno_cambio_curso`,
  `_check_cuota_cambio_curso`, `_check_plan_cambio_titular`
- 7 triggers sobre `pagos`, `planes_pago`, `abonos`, `alumnos`, `cuotas`

Total de funciones en `public` (instalación local de referencia): 46
(10 de negocio + 36 de `pgcrypto`). En Supabase, `pgcrypto` puede
instalarse en el schema `extensions` en lugar de `public`; el recuento
de funciones en `public` varía según la configuración del proyecto.

### Paso 2 — Ejecutar `02_rls.sql`

Abrir `sql/02_rls.sql`, copiar el contenido completo y pegarlo en el
SQL Editor. Ejecutar.

**Resultado esperado:** sin errores. RLS habilitado en las 18 tablas de
`public`. `_curso_de_cuota` se redefine con `CREATE OR REPLACE` (esperado;
la primera definición está en `01_schema.sql`).

**62 políticas** creadas por tabla:

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
| `suscripciones` | (ninguna — accesible solo a service_role) |
| `alumnos_credenciales` | (ninguna — accesible solo a service_role) |

### Paso 3 — Ejecutar `07_grants_supabase.sql`

Abrir `sql/07_grants_supabase.sql`, copiar el contenido completo y pegarlo
en el SQL Editor. Ejecutar.

**Resultado esperado:**
```
07_grants_supabase.sql v3 aplicado y verificado correctamente.
══ Resultado: 43 OK, 0 error(es) ══
```

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

Abrir `sql/08_seed_staging.sql`. Antes de pegarlo en el SQL Editor,
sustituir los dos marcadores con los UUIDs reales del proyecto staging:

```
USER_A_UUID  →  UUID del usuario usuario_a@staging.test
USER_B_UUID  →  UUID del usuario usuario_b@staging.test
```

Los UUIDs se encuentran en el dashboard:
`Authentication → Users → columna "User UID"`.

Pegar el contenido modificado en el SQL Editor y ejecutar.

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

Abrir `sql/09_fixture_usuario_c.sql`. Sustituir el marcador:

```
USER_C_UUID  →  UUID del usuario usuario_c@staging.test
```

Pegar en el SQL Editor y ejecutar.

**Resultado esperado:**
```
Fixture OK: C (<uuid>) → visor en Cuenta A, curso cur-a-01
```

### Paso 6 (opcional) — Fixture acceso delegado A-en-B

Para probar el escenario de acceso delegado con visibilidad completa
(test:03 con verificación de cursos), ejecutar **después del seed base**:

Abrir `sql/09c_fixture_uc_a_en_b_curso.sql` y pegarlo directamente en el
SQL Editor (no requiere sustitución de marcadores).

**Resultado esperado:**
```
Fixture 09c OK: uc-a-en-b ahora tiene curso_id=cur-b-01 en Cuenta B.
```

Ver la sección "Asimetría curso_id=NULL" más abajo para entender qué
diferencia hace este fixture.

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

Resultado esperado: 18 tablas. 17 con `PRIMARY KEY (cuenta_id, id)` o
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

## Asimetría curso_id=NULL y permisos reales por tabla

El seed v3 crea Usuario A como tesorero en Cuenta B con `curso_id=NULL`.

### Lecturas (políticas SELECT)

`get_mis_cursos(cuenta_b)` filtra `WHERE curso_id IS NOT NULL`.
Con `curso_id=NULL`, A obtiene 0 filas de esa función para Cuenta B.

Las políticas `cursos_select`, `alumnos_select`, `cuotas_select`, etc.
dependen de `get_mis_cursos()` para miembros no-dueños. Resultado: **A
no ve ninguna fila** de cursos, alumnos ni cuotas de Cuenta B.

### Escrituras — los permisos dependen de cada tabla

Las políticas de escritura no son uniformes. `tiene_rol_en_curso()` evalúa
`AND (curso_id = p_curso_id OR curso_id IS NULL)`, lo que amplía el alcance
de A mientras tenga `curso_id=NULL`, pero **solo en las tablas cuya política
ya permite el rol `tesorero`**. Cursos y cuotas no están entre ellas:

| Tabla | INSERT | UPDATE | DELETE |
|---|---|---|---|
| `cursos` | `es_dueno` únicamente | `es_dueno` únicamente | `es_dueno` únicamente |
| `alumnos` | `es_dueno` **o** `tiene_rol_en_curso` [admin,editor,tesorero] | igual | `es_dueno` únicamente |
| `cuotas` | `es_dueno` únicamente | `es_dueno` únicamente | `es_dueno` únicamente |
| `pagos` | `es_dueno` **o** `tiene_rol_en_curso` [admin,tesorero] | igual | igual |
| `abonos` | `es_dueno` **o** `tiene_rol_en_curso` [admin,tesorero] | igual | `es_dueno` únicamente |
| `planes_pago` | `es_dueno` **o** `tiene_rol_en_curso` [admin,tesorero] | igual | `es_dueno` únicamente |

Rol **visor** (como C en Cuenta A): ninguna política de escritura incluye
`'visor'` en su array de roles. C puede leer su curso asignado pero
**no puede insertar, actualizar ni eliminar ningún dato**.

### Con `curso_id=NULL` (seed puro, sin fixture 09c)

A no ve ninguna fila por SELECT en Cuenta B. En las tablas que permiten
`tesorero` (alumnos INSERT/UPDATE, pagos y abonos INSERT/UPDATE/DELETE),
el `OR curso_id IS NULL` hace que A pueda operar sobre **cualquier curso
de B**, aunque no pueda leer las filas resultantes. Cursos y cuotas
permanecen fuera del alcance de A en todo caso.

### Con `curso_id=cur-b-01` (después de fixture 09c)

A ve cur-b-01 vía `get_mis_cursos()` y puede leer sus alumnos, cuotas
y pagos. Los permisos de escritura quedan acotados a cur-b-01.

### Verificar con identidad A simulada

Las consultas que usan `auth.uid()` deben ejecutarse **con identidad A
activa**, no como superuser. Como superuser, RLS no se aplica y los
resultados no reflejan lo que ve A en producción. Estructura requerida:

```sql
BEGIN;
SELECT set_config('request.jwt.claims',
  '{"sub":"<UUID_A>","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
-- consultas aquí
ROLLBACK;
```

### Impacto en test:03

| Estado fixture 09c | Comportamiento de A en Cuenta B como authenticated |
|---|---|
| **Sin 09c** (seed puro) | SELECT: 0 filas; alumnos/pagos INSERT/UPDATE: alcance general |
| **Con 09c** (cur-b-01 asignado) | SELECT y escritura acotados a cur-b-01 |

Documentación detallada de permisos por tabla: `sql/09b_nota_uc_a_en_b.sql`.

---

## Conservar staging actual

El staging actual **no debe eliminarse** ni reemplazarse sin revisión.
Antes de cualquier cambio al proyecto staging existente:

1. Verificar qué tablas tiene actualmente:
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' ORDER BY table_name;
   ```

2. Revisar qué datos contiene:
   ```sql
   -- emails registrados en auth
   SELECT id, email FROM auth.users;
   
   -- filas por tabla
   SELECT schemaname, tablename, n_live_tup
   FROM pg_stat_user_tables
   WHERE schemaname = 'public'
   ORDER BY n_live_tup DESC;
   ```

3. Si el staging tiene un esquema diferente al v9 (claves simples, sin
   triggers, sin helpers), no es compatible con los tests actuales.
   La decisión de cómo proceder —instalación paralela, migración o
   reemplazo respaldado— debe tomarse tras revisar el contenido real
   con el equipo. No autorizar el reemplazo únicamente por emails
   o recuentos de filas.

---

## Prueba local (referencia — instalación verificada 2026-10-29)

La secuencia `01 → 02 → 07 → 08 → 09 → 09c` fue ejecutada sobre
PostgreSQL 16 local con schema `auth` simulado (3 usuarios ficticios
con UUIDs `aaa…`, `bbb…`, `ccc…`).

### Recuentos de objetos confirmados

| Objeto | Cantidad |
|---|---|
| Tablas en `public` | 18 |
| Tablas en `_staging` | 1 |
| Índices en `public` | 26 |
| Funciones de negocio en `public` | 10 (5 SECURITY DEFINER + 5 trigger) |
| Funciones en `public` (instalación local) | 46 (10 de negocio + 36 de pgcrypto; en Supabase puede diferir) |
| Triggers en `public` | 7 |
| Políticas RLS | 62 |

### Log resumido

| Paso | Resultado |
|---|---|
| `01_schema.sql` | 18 tablas, 10 funciones de negocio, 7 triggers — sin errores |
| `02_rls.sql` | 18 tablas con RLS, **62 políticas** — sin errores |
| `07_grants_supabase.sql` | **43/43 verificaciones ✓** — COMMIT |
| `08_seed_staging.sql` | `Seed OK (v3): 2 cuentas | 3 membresías | 5 alumnos | 4 cuotas | 2 pagos | 1 planes | 1 abonos` — COMMIT |
| `09_fixture_usuario_c.sql` | `Fixture OK: C (ccc…) → visor en Cuenta A, curso cur-a-01` — COMMIT |
| `09c_fixture_uc_a_en_b_curso.sql` | `Fixture 09c OK: uc-a-en-b ahora tiene curso_id=cur-b-01` — COMMIT |
| RLS C — cur-a-01 (como authenticated) | C ve `cur-a-01` ✓, no ve `cur-a-02` ✓, no ve Cuenta B ✓; sin permisos de escritura |

### Log RLS como Usuario C (extracto real — BEGIN/ROLLBACK como `authenticated`)

La prueba se ejecutó con identidad C simulada dentro de una transacción.
Las consultas sin identidad activa omiten RLS y no son representativas.

```
Comando: sudo -u postgres psql tesorero_test2
```

```sql
BEGIN;

SELECT set_config('request.jwt.claims',
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}',
  true);
--  set_config → {"sub":"cccc...","role":"authenticated"}

SELECT (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
  AS uid_simulado;
--  cccccccc-cccc-cccc-cccc-cccccccccccc

SET LOCAL ROLE authenticated;

-- cursos visibles para C en Cuenta A (solo cur-a-01):
SELECT id, nombre FROM cursos
WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001';
--    id    |   nombre
--  cur-a-01 | 1° Básico A
--  (1 row)

-- alumnos visibles para C (solo los del cur-a-01):
SELECT id, nombres, curso_id FROM alumnos
WHERE cuenta_id = '00000000-0000-0000-aaaa-000000000001';
--    id    | nombres | curso_id
--  alu-a-01 | Sofía   | cur-a-01
--  alu-a-02 | Matías  | cur-a-01
--  (2 rows)

-- cursos de Cuenta B — C no tiene membresía en B:
SELECT id FROM cursos
WHERE cuenta_id = '00000000-0000-0000-bbbb-000000000002';
--  (0 rows)

-- get_mis_cursos() para C en Cuenta A:
SELECT * FROM get_mis_cursos('00000000-0000-0000-aaaa-000000000001');
--  curso_id
--  cur-a-01
--  (1 row)

ROLLBACK;
```

C (visor) ve únicamente los alumnos de su curso asignado. Rol `visor` no
aparece en ninguna política de escritura; no puede insertar, actualizar
ni eliminar datos.
