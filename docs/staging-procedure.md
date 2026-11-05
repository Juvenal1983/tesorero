# Procedimiento de Despliegue en Staging

**Staging Supabase:** `rucgmytyxpfowznowxwd.supabase.co`  
**Producción:** `tmjqzaakzhecbldebyeg.supabase.co` — **NUNCA TOCAR**

> **Regla permanente:** Ninguna migración sobre producción ni activación de la versión nueva
> hasta revisión y aprobación explícita del operador.

---

## Estado de referencia en Staging

Según la consulta de auditoría previa, staging contiene:

| Tabla | Registros |
|-------|-----------|
| tesorero_cuentas | 2 |
| cursos | 3 |
| pagos | 3 |

Estos datos **deben conservarse intactos** al final del procedimiento.
El conteo previo es el punto de comparación "antes".

---

## Precondiciones obligatorias

### 1. Acceso a Supabase Studio de staging

- URL: `https://app.supabase.com/project/rucgmytyxpfowznowxwd`
- Usar: **SQL Editor** (menú lateral izquierdo → "SQL Editor").
- Rol requerido: `service_role` o `postgres` (disponible en SQL Editor de Supabase Studio).

### 2. Backup previo (plan gratuito de Supabase)

El plan gratuito de Supabase **no ofrece backups on-demand desde la interfaz**.
Las alternativas disponibles son:

**Opción A — pg_dump por CLI** (requiere `psql` y `pg_dump` instalados localmente):
```bash
# Obtener la connection string en: Project Settings → Database → Connection string (URI)
pg_dump "postgresql://postgres:<password>@db.rucgmytyxpfowznowxwd.supabase.co:5432/postgres" \
  --no-password \
  --clean \
  --if-exists \
  --format=plain \
  --no-owner \
  > staging_backup_$(date +%Y%m%d_%H%M%S).sql
```

**Opción B — Exportar tablas clave como CSV desde SQL Editor**
(ejecutar en SQL Editor; copiar resultado y guardarlo localmente):
```sql
-- Exportar una tabla a la vez usando el botón "Export CSV" del SQL Editor
SELECT * FROM pagos ORDER BY id;
SELECT * FROM alumnos ORDER BY id;
SELECT * FROM tesorero_cuentas ORDER BY id;
SELECT * FROM cursos ORDER BY id;
```
En el SQL Editor de Supabase Studio hay un botón **"Export CSV"** sobre los resultados.
Descargar y guardar cada tabla antes de continuar.

### 3. Conteo de referencia "ANTES"

Ejecutar en SQL Editor y registrar los resultados:
```sql
-- ═══ CONTEO ANTES — guardar este resultado ═══
SELECT 'tesorero_cuentas' AS tabla, COUNT(*) AS n FROM tesorero_cuentas
UNION ALL SELECT 'cursos',              COUNT(*) FROM cursos
UNION ALL SELECT 'alumnos',             COUNT(*) FROM alumnos
UNION ALL SELECT 'cuotas',              COUNT(*) FROM cuotas
UNION ALL SELECT 'pagos',               COUNT(*) FROM pagos
UNION ALL SELECT 'operaciones_pagos',   COUNT(*) FROM operaciones_pagos
ORDER BY tabla;
-- Si operaciones_pagos no existe aún, omitir esa línea o envolver en DO $$.
```

Resultado esperado base: cuentas=2 · cursos=3 · pagos=3.
Si no coincide, detener y verificar antes de continuar.

### 4. Revisar migraciones ya aplicadas

```sql
-- M001: comprobar índice de idempotencia
SELECT indexname FROM pg_indexes
 WHERE tablename='pagos' AND indexname='pagos_idempotency_key_unico';

-- M002: comprobar NOT NULL en eximido
SELECT is_nullable FROM information_schema.columns
 WHERE table_name='alumnos' AND column_name='eximido';

-- M004: comprobar tabla operaciones_pagos
SELECT to_regclass('public.operaciones_pagos');
```

---

## Orden de ejecución

Ejecutar en este orden exacto, **uno a la vez**, verificando el resultado antes de continuar.

### Paso 1 — M001: Idempotency key en pagos

**Archivo:** `sql/migrations/M001_idempotency_key.sql`

**Qué hace:** Agrega la columna `pagos.idempotency_key TEXT` y un índice parcial UNIQUE donde no es NULL.

**Verificar antes:**
```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name='pagos' AND column_name='idempotency_key';
-- Vacío → no existe, procede. Una fila → ya aplicada, omitir.
```

**Ejecutar:** copiar y pegar el contenido completo de `sql/migrations/M001_idempotency_key.sql` en SQL Editor.

**Resultado esperado:**
```
NOTICE: M001 verificada: idempotency_key ✓, índice nuevo ✓, índice viejo eliminado ✓
```

**Verificación post:**
```sql
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name='pagos' AND column_name='idempotency_key';
-- Debe retornar: idempotency_key | text

SELECT indexname FROM pg_indexes
 WHERE tablename='pagos' AND indexname='pagos_idempotency_key_unico';
-- Debe retornar: pagos_idempotency_key_unico
```

---

### Paso 2 — M002: eximido NOT NULL

**Archivo:** `sql/migrations/M002_eximido_normalize.sql`

**Qué hace:** Convierte `alumnos.eximido` NULL→false, luego agrega NOT NULL con DEFAULT false.

**Verificar antes:**
```sql
SELECT is_nullable FROM information_schema.columns
 WHERE table_name='alumnos' AND column_name='eximido';
-- 'YES' → procede; 'NO' → ya aplicada, omitir.
```

**Ejecutar:** copiar y pegar el contenido completo de `sql/migrations/M002_eximido_normalize.sql`.

**Resultado esperado:**
```
NOTICE: M002 diagnóstico: N fila(s) con eximido IS NULL encontrada(s)
NOTICE: M002 verificada: alumnos.eximido NOT NULL DEFAULT false ✓
```

**Verificación post:**
```sql
SELECT is_nullable, column_default FROM information_schema.columns
 WHERE table_name='alumnos' AND column_name='eximido';
-- is_nullable=NO, column_default=false
```

---

### Paso 3 — M004: Tabla operaciones_pagos (idempotencia durable)

**Archivo:** `sql/migrations/M004_operaciones_idempotentes.sql`

**Qué hace:** Crea la tabla `operaciones_pagos(cuenta_id, idempotency_key)` con `auth_id` y los 7 campos de identidad de contenido. También crea `pago_id` como referencia débil (sin FK) para permitir que el pago se elimine sin perder el slot.

**Verificar antes:**
```sql
SELECT to_regclass('public.operaciones_pagos');
-- NULL → no existe, procede; otro valor → ya aplicada, omitir.
```

**Ejecutar:** copiar y pegar el contenido completo de `sql/migrations/M004_operaciones_idempotentes.sql`.

**Resultado esperado:**
```
NOTICE: M004 verificada: operaciones_pagos creada con identidad de autor ✓
```

**Verificación post — estructura de la tabla (compatible SQL Editor):**
```sql
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'operaciones_pagos'
 ORDER BY ordinal_position;
-- Debe mostrar: cuenta_id, idempotency_key, auth_id, alumno_id, cuota_id,
--              monto, periodo, fecha, medio, estado, pago_id, creado_en
```

---

### Paso 4 — M003: Normalizar períodos históricos (OPCIONAL / CONDICIONAL)

**Archivo:** `sql/migrations/M003_normalizar_periodos.sql`

**⚠️ IMPORTANTE:** Esta migración modifica `pagos.periodo`. Solo ejecutarla si:
- Existen pagos con `periodo` en formato "Mes" (sin año).
- El usuario aprueba expresamente.

**Diagnóstico previo** (solo lectura, no hace cambios):
```sql
-- Contar pagos con período en formato antiguo (solo mes, sin año):
SELECT periodo, COUNT(*) 
  FROM pagos 
 WHERE periodo IN ('Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre')
 GROUP BY periodo
 ORDER BY periodo;
-- Vacío → no hay nada que normalizar, omitir M003.
```

Si hay filas, verificar que las cuotas asociadas tienen `anio` NOT NULL:
```sql
SELECT p.alumno_id, p.cuota_id, p.periodo, cu.anio
  FROM pagos p
  LEFT JOIN cuotas cu ON cu.cuenta_id=p.cuenta_id AND cu.id=p.cuota_id
 WHERE p.periodo IN ('Enero','Febrero','Marzo','Abril','Mayo','Junio',
                     'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre')
 ORDER BY cu.anio NULLS LAST;
-- Filas con cu.anio IS NULL → quedarán marcadas como 'ambiguo'; no se tocarán.
```

**Resultado esperado (si se ejecuta):**
```
NOTICE: M003 diagnóstico [pagos]: N con período no-nulo
NOTICE: M003 actualizado N registro(s) de pagos
NOTICE: M003 actualizado N registro(s) de planes_pago
NOTICE: M003 COMPLETADA
```

**Tabla de auditoría creada:** `_auditoria_periodos_m003`
```sql
SELECT estado, COUNT(*) FROM _auditoria_periodos_m003 GROUP BY estado;
-- actualizado: N (transformados)
-- ambiguo:     N (mes sin año de cuota — no tocados)
```

**Reversión de M003:**
```sql
-- Capturar el timestamp de esta ejecución primero:
SELECT MIN(migrado_en) FROM _auditoria_periodos_m003;
-- Reemplazar <ts> con ese valor en la query de reversión:

UPDATE pagos p
   SET periodo = a.periodo_original
  FROM _auditoria_periodos_m003 a
 WHERE a.entity_type  = 'pago'
   AND a.pago_id      = p.id
   AND a.cuenta_id    = p.cuenta_id
   AND a.estado       = 'actualizado'
   AND p.periodo      = a.periodo_nuevo   -- PROTECCIÓN: no revertir si fue modificado después
   AND a.migrado_en   >= '<ts>';          -- delimitar por ejecución
```

---

### Paso 5 — RPC: insertar_pagos_lote (función transaccional)

**Archivo:** `sql/11_insertar_pagos_lote.sql`

**Qué hace:** Crea o reemplaza la función `insertar_pagos_lote(cuenta_id UUID, pagos JSONB)` con:
- Serialización por advisory lock
- Patrón slot-reservation en `operaciones_pagos`
- Verificación de identidad de autor y contenido
- GRANT EXECUTE a `authenticated`

**Verificar que las dependencias existen:**
```sql
SELECT to_regclass('public.operaciones_pagos');  -- no NULL
SELECT indexname FROM pg_indexes WHERE indexname='pagos_idempotency_key_unico';
```

**Ejecutar:** copiar y pegar el contenido completo de `sql/11_insertar_pagos_lote.sql`.

**Verificación post:**
```sql
-- Verificar que la función existe:
SELECT pg_get_function_identity_arguments(oid) 
  FROM pg_proc WHERE proname='insertar_pagos_lote';
-- Debe retornar: p_cuenta_id uuid, p_pagos jsonb

-- Test básico de sintaxis (no hace cambios reales):
SELECT insertar_pagos_lote(
  '00000000-0000-0000-0000-000000000000'::uuid,
  '[]'::jsonb
);
-- Debe retornar: []
```

---

## Pruebas con JWT real

> **Por qué es necesario:** `insertar_pagos_lote` verifica `auth.uid()` contra `operaciones_pagos.auth_id`.
> Sin un JWT real, la verificación de autor no se puede testear; cualquier llamada desde SQL Editor
> con rol `service_role` omite RLS y el `auth.uid()` retorna NULL.

### Obtener un JWT de usuario real desde el navegador

1. Abrir la aplicación en staging: `https://[tu-staging-domain]`
2. Iniciar sesión con una cuenta de prueba (no la de producción).
3. Abrir DevTools → Application → Local Storage → buscar la clave `sb-rucgmytyxpfowznowxwd-auth-token`.
4. Copiar el valor del campo `access_token` (empieza con `eyJ...`).

Alternativamente desde la consola del navegador:
```javascript
const { data: { session } } = await window.supabase.auth.getSession();
console.log(session.access_token);
```

### Llamar a la RPC con el JWT real (curl)

```bash
# Reemplazar <JWT> y <cuenta_id> con los valores reales:
curl -sS "https://rucgmytyxpfowznowxwd.supabase.co/rest/v1/rpc/insertar_pagos_lote" \
  -H "apikey: <anon-key>" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "p_cuenta_id": "<cuenta_id>",
    "p_pagos": [{
      "alumno_id": "alu-stg-v9-test-01",
      "cuota_id":  "<cuota_id_exclusiva_de_prueba>",
      "monto":     1000,
      "fecha":     "2026-11-05",
      "medio":     "test",
      "estado":    "pagado",
      "periodo":   "Test V9 2026",
      "idempotency_key": "stg-v9-test-<EXEC_ID>-01"
    }]
  }'
# Reemplazar <EXEC_ID> con la fecha del día: ej. 20261105
```

**Qué verificar:**
- Primera llamada → retorna array con el pago creado.
- Segunda llamada con el mismo `idempotency_key` → retorna el mismo pago sin duplicar.
- Verificar con:
  ```sql
  SELECT auth_id FROM operaciones_pagos
   WHERE idempotency_key LIKE 'stg-v9-test-%';
  -- auth_id debe coincidir con el UUID del usuario del JWT, no NULL.
  ```

---

## Fixtures aislados de prueba

### Identificadores exclusivos de prueba

Usar estos identificadores, que **no colisionan** con los datos de staging existentes:

| Campo | Valor |
|-------|-------|
| alumno_id | `alu-stg-v9-test-01` |
| cuota_id | `cuo-stg-v9-test-01` (crear cuota exclusiva) |
| idempotency_key prefix | `stg-v9-test-<EXEC_ID>-` donde `<EXEC_ID>` = fecha (`20261105`) |
| período | `Test V9 2026` |

El `<EXEC_ID>` delimita la limpieza: todo lo creado en esta ejecución lleva ese prefijo.

### Crear fixtures

```sql
-- ═══ CONTEO ANTES de insertar fixtures ═══
SELECT 'alumnos' AS tabla, COUNT(*) FROM alumnos
UNION ALL SELECT 'cuotas', COUNT(*) FROM cuotas
UNION ALL SELECT 'pagos',  COUNT(*) FROM pagos
UNION ALL SELECT 'operaciones_pagos', COUNT(*) FROM operaciones_pagos;

-- ── Verificar cuenta_id disponible ────────────────────────────────────────────
SELECT id, nombre FROM tesorero_cuentas;
-- Elegir una cuenta existente; usar ese id en <CUENTA_ID> más abajo.

-- ── Alumno exclusivo de prueba ────────────────────────────────────────────────
INSERT INTO alumnos (id, cuenta_id, curso_id, nombres, apellidos, eximido)
SELECT 'alu-stg-v9-test-01',
       '<CUENTA_ID>',
       (SELECT id FROM cursos WHERE cuenta_id='<CUENTA_ID>' LIMIT 1),
       'Test', 'V9 Staging', false
 WHERE NOT EXISTS (SELECT 1 FROM alumnos WHERE id='alu-stg-v9-test-01');

-- ── Cuota exclusiva de prueba ─────────────────────────────────────────────────
INSERT INTO cuotas (id, cuenta_id, curso_id, nombre, tipo, monto, anio, activa)
SELECT 'cuo-stg-v9-test-01',
       '<CUENTA_ID>',
       (SELECT id FROM cursos WHERE cuenta_id='<CUENTA_ID>' LIMIT 1),
       'Cuota Test V9', 'extraordinaria', 1000, 2026, true
 WHERE NOT EXISTS (SELECT 1 FROM cuotas WHERE id='cuo-stg-v9-test-01');
```

### Ejecutar prueba de idempotencia vía RPC

```sql
-- ── Primer intento (debe crear) ───────────────────────────────────────────────
-- (Desde SQL Editor con service_role — sin validación auth_id)
-- Para validación auth_id real, usar curl con JWT (ver sección anterior).
SELECT insertar_pagos_lote(
  '<CUENTA_ID>'::uuid,
  '[{
    "alumno_id":       "alu-stg-v9-test-01",
    "cuota_id":        "cuo-stg-v9-test-01",
    "monto":           1000,
    "fecha":           "2026-11-05",
    "medio":           "test",
    "estado":          "pagado",
    "periodo":         "Test V9 2026",
    "idempotency_key": "stg-v9-test-20261105-01"
  }]'::jsonb
);

-- ── Segundo intento con mismo idempotency_key (debe deduplicar) ───────────────
SELECT insertar_pagos_lote(
  '<CUENTA_ID>'::uuid,
  '[{
    "alumno_id":       "alu-stg-v9-test-01",
    "cuota_id":        "cuo-stg-v9-test-01",
    "monto":           1000,
    "fecha":           "2026-11-05",
    "medio":           "test",
    "estado":          "pagado",
    "periodo":         "Test V9 2026",
    "idempotency_key": "stg-v9-test-20261105-01"
  }]'::jsonb
);

-- ── Verificar idempotencia ────────────────────────────────────────────────────
SELECT COUNT(*) AS n_pagos FROM pagos
 WHERE idempotency_key LIKE 'stg-v9-test-20261105-%';
-- Debe ser = 1 (no duplicado)

SELECT COUNT(*) AS n_ops FROM operaciones_pagos
 WHERE idempotency_key LIKE 'stg-v9-test-20261105-%';
-- Debe ser = 1 (el slot está ocupado — protección durable)
```

### Conteo DESPUÉS y comparación

```sql
-- ═══ CONTEO DESPUÉS de fixtures ═══
SELECT 'alumnos' AS tabla, COUNT(*) FROM alumnos
UNION ALL SELECT 'cuotas', COUNT(*) FROM cuotas
UNION ALL SELECT 'pagos',  COUNT(*) FROM pagos
UNION ALL SELECT 'operaciones_pagos', COUNT(*) FROM operaciones_pagos;

-- Los deltas esperados vs el conteo ANTES:
-- alumnos:            +1  (alu-stg-v9-test-01)
-- cuotas:             +1  (cuo-stg-v9-test-01)
-- pagos:              +1  (pago de prueba)
-- operaciones_pagos:  +1  (slot de idempotencia)
-- tesorero_cuentas:    0  (sin cambio)
-- cursos:              0  (sin cambio)
```

### Limpiar fixtures de prueba

> **IMPORTANTE:** La protección de idempotencia se basa en que el slot en `operaciones_pagos`
> persiste aunque el pago sea eliminado. Limpiar `operaciones_pagos` **destruye esa protección**
> y permitiría reinsertar el mismo `idempotency_key` en el futuro.
>
> En staging, limpiar el slot es aceptable porque los fixtures de prueba no deben persistir.
> **En producción, nunca borrar filas de `operaciones_pagos`.**

```sql
-- ── Limpieza delimitada por cuenta_id + EXEC_ID ───────────────────────────────
-- Reemplazar '<CUENTA_ID>' y el prefijo 'stg-v9-test-20261105' con los valores reales.

-- 1. Eliminar pagos de prueba (referencia débil — no afecta a operaciones_pagos)
DELETE FROM pagos
 WHERE cuenta_id = '<CUENTA_ID>'
   AND idempotency_key LIKE 'stg-v9-test-20261105-%';

-- 2. Eliminar slot de idempotencia de prueba (staging únicamente)
DELETE FROM operaciones_pagos
 WHERE cuenta_id = '<CUENTA_ID>'
   AND idempotency_key LIKE 'stg-v9-test-20261105-%';

-- 3. Eliminar cuota exclusiva de prueba
DELETE FROM cuotas
 WHERE id = 'cuo-stg-v9-test-01'
   AND cuenta_id = '<CUENTA_ID>';

-- 4. Eliminar alumno exclusivo de prueba
DELETE FROM alumnos
 WHERE id = 'alu-stg-v9-test-01'
   AND cuenta_id = '<CUENTA_ID>';

-- ── Verificar que los datos originales se preservaron ─────────────────────────
SELECT 'tesorero_cuentas' AS tabla, COUNT(*) FROM tesorero_cuentas
UNION ALL SELECT 'cursos', COUNT(*) FROM cursos
UNION ALL SELECT 'pagos',  COUNT(*) FROM pagos;
-- Resultado esperado: cuentas=2 · cursos=3 · pagos=3  (igual que el conteo ANTES)
```

---

## Resultados esperados al finalizar

Después de ejecutar M001 → M002 → M004 → RPC (y M003 si corresponde) y limpiar fixtures:

```sql
-- Verificar que los datos originales se preservaron:
SELECT 'tesorero_cuentas' AS tabla, COUNT(*) FROM tesorero_cuentas
UNION ALL SELECT 'cursos',              COUNT(*) FROM cursos
UNION ALL SELECT 'pagos',               COUNT(*) FROM pagos;
-- cuentas: 2  ·  cursos: 3  ·  pagos: 3  ← mismos que antes
```

```sql
-- Verificar migraciones aplicadas:
SELECT indexname FROM pg_indexes WHERE indexname='pagos_idempotency_key_unico';
-- pagos_idempotency_key_unico

SELECT is_nullable FROM information_schema.columns
 WHERE table_name='alumnos' AND column_name='eximido';
-- NO

SELECT to_regclass('public.operaciones_pagos');
-- operaciones_pagos

SELECT to_regproc('public.insertar_pagos_lote(uuid, jsonb)');
-- insertar_pagos_lote
```

---

## Recuperación si algo falla

### Si M001 falla (index creation error)

Ver el mensaje de error en el panel inferior del SQL Editor y luego:
```sql
-- Ver qué índices existen en pagos:
SELECT indexname, indexdef FROM pg_indexes WHERE tablename='pagos';
-- Si hay un índice duplicado o incorrecto:
DROP INDEX IF EXISTS idx_pagos_idempotency_key;
-- Luego re-ejecutar M001.
```

### Si M002 falla (NOT NULL error)

```sql
-- Ver si hay NULLs pendientes:
SELECT COUNT(*) FROM alumnos WHERE eximido IS NULL;
-- Si hay NULLs, normalizarlos primero:
UPDATE alumnos SET eximido = false WHERE eximido IS NULL;
-- Luego re-ejecutar M002.
```

### Si M004 falla (FK error o tabla ya existe)

```sql
-- Si la tabla existe pero incompleta:
DROP TABLE IF EXISTS operaciones_pagos;
-- Luego re-ejecutar M004.
-- ATENCIÓN: esto borra todas las operaciones idempotentes guardadas.
-- Solo hacer si staging no tiene datos de operaciones_pagos que valgan la pena conservar.
```

### Si el RPC falla (function error)

El SQL Editor muestra el detalle del error en el panel inferior. Leer el mensaje completo ahí.

Los errores más comunes y su causa:
```sql
-- Verificar dependencias:
SELECT to_regclass('public.operaciones_pagos');
-- NULL → M004 no fue aplicada → aplicar M004 primero.

SELECT pg_get_function_identity_arguments(oid)
  FROM pg_proc WHERE proname='es_dueno';
-- Sin resultado → 01_schema.sql no fue cargado en staging → cargar el schema primero.

SELECT pg_get_function_identity_arguments(oid)
  FROM pg_proc WHERE proname='tiene_rol_en_curso';
-- Sin resultado → mismo problema de schema.
```

### Si M003 produce resultados inesperados

```sql
-- Ver auditoría:
SELECT * FROM _auditoria_periodos_m003 ORDER BY migrado_en DESC LIMIT 20;

-- Revertir con la protección histórica:
UPDATE pagos p
   SET periodo = a.periodo_original
  FROM _auditoria_periodos_m003 a
 WHERE a.entity_type = 'pago'
   AND a.pago_id = p.id
   AND a.cuenta_id = p.cuenta_id
   AND a.estado = 'actualizado'
   AND p.periodo = a.periodo_nuevo
   AND a.migrado_en >= (SELECT MIN(migrado_en) FROM _auditoria_periodos_m003);
-- Verificar filas afectadas antes de confirmar.
```

---

## Notas finales

- **No ejecutar nada en producción** (`tmjqzaakzhecbldebyeg`) hasta revisión y aprobación explícita.
- Cada paso debe ejecutarse individualmente en el SQL Editor, no en bloque, para poder identificar errores.
- Los fixtures de prueba deben limpiarse antes de reportar resultados finales.
- La RLS (Row Level Security) está activa en staging: para testear la validación de `auth_id`, usar el JWT de un usuario real (ver sección "Pruebas con JWT real").
- El SQL Editor de Supabase Studio ejecuta como `service_role` por defecto, lo que omite RLS y retorna `auth.uid() = NULL`. Esto es suficiente para verificar el esquema y la lógica transaccional, pero no reemplaza la prueba con JWT real para validar el aislamiento por usuario.
