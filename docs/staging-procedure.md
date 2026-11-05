# Procedimiento de Despliegue en Staging

**Staging Supabase:** `rucgmytyxpfowznowxwd.supabase.co`  
**Producción:** `tmjqzaakzhecbldebyeg.supabase.co` — **NUNCA TOCAR**

---

## Estado actual conocido de Staging (consulta de solo lectura)

Según la consulta de auditoría previa, staging contiene:

| Tabla | Registros |
|-------|-----------|
| tesorero_cuentas | 2 |
| cursos | 3 |
| pagos | 3 |

Estos datos **deben conservarse intactos** al final del procedimiento.

---

## Precondiciones obligatorias

1. **Acceso a Supabase Studio** de staging con rol `service_role` o `postgres`.
   - URL: `https://app.supabase.com/project/rucgmytyxpfowznowxwd`
   - Acceso: SQL Editor → "SQL Editor" (esquina superior).

2. **Ninguna migración pendiente sobre producción.** Solo staging para este hito.

3. **Backup previo a staging** (Supabase Studio → Database → Backups → Download).
   - Hacer un backup on-demand antes de cualquier cambio.

4. **Variable de control:** antes de ejecutar cualquier archivo, correr el diagnóstico:
   ```sql
   SELECT 'cuentas' AS tabla, COUNT(*) FROM tesorero_cuentas
   UNION ALL SELECT 'cursos', COUNT(*) FROM cursos
   UNION ALL SELECT 'pagos',  COUNT(*) FROM pagos;
   ```
   Resultado esperado: 2 cuentas · 3 cursos · 3 pagos. Si no coincide, detener y verificar.

5. **Revisar que las migraciones previas NO están aplicadas** (para no re-ejecutar):
   ```sql
   -- M001: comprobar que el índice de idempotencia existe
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

Ejecutar en este orden exacto, **uno a la vez**, verificando el resultado de cada paso antes de continuar.

### Paso 1 — M001: Idempotency key en pagos

**Archivo:** `sql/migrations/M001_idempotency_key.sql`

**Qué hace:** Agrega la columna `pagos.idempotency_key TEXT` y un índice parcial UNIQUE donde no es NULL.

**Precondición:** `pagos.idempotency_key` no existe todavía.

```sql
-- Verificar antes:
SELECT column_name FROM information_schema.columns
 WHERE table_name='pagos' AND column_name='idempotency_key';
-- Si ya existe → omitir paso 1 (M001 tiene IF NOT EXISTS; re-ejecutar es seguro pero innecesario)
```

**Resultado esperado:**
```
NOTICE: M001 verificada: idempotency_key ✓, índice nuevo ✓, índice viejo eliminado ✓
```

**Verificación post:**
```sql
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name='pagos' AND column_name='idempotency_key';
-- Debe retornar: pagos | idempotency_key | text
```

---

### Paso 2 — M002: eximido NOT NULL

**Archivo:** `sql/migrations/M002_eximido_normalize.sql`

**Qué hace:** Convierte `alumnos.eximido` NULL→false, luego agrega NOT NULL con DEFAULT false.

**Precondición:** Tabla `alumnos` debe existir.

```sql
-- Verificar antes:
SELECT is_nullable FROM information_schema.columns
 WHERE table_name='alumnos' AND column_name='eximido';
-- 'YES' → procede; 'NO' → ya aplicada, omitir
```

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

**Precondición:** `tesorero_cuentas` debe existir. `auth.uid()` debe estar disponible (función de Supabase Auth).

```sql
-- Verificar antes:
SELECT to_regclass('public.operaciones_pagos');
-- NULL → no existe, procede; otro valor → ya aplicada, omitir
```

**Resultado esperado:**
```
NOTICE: M004 verificada: operaciones_pagos creada con identidad de autor ✓
```

**Verificación post:**
```sql
\d operaciones_pagos
-- Debe mostrar: cuenta_id, idempotency_key, auth_id, alumno_id, cuota_id,
--              monto, periodo, fecha, medio, estado, pago_id, creado_en
```

---

### Paso 4 — M003: Normalizar períodos históricos (OPCIONAL / CONDICIONAL)

**Archivo:** `sql/migrations/M003_normalizar_periodos.sql`

**⚠️ IMPORTANTE:** Esta migración modifica `pagos.periodo`. Solo ejecutarla si:
- Existen pagos con `periodo` en formato "Mes" (sin año).
- El usuario aprueba expresamente.

**Diagnóstico previo** (ejecutar antes, no hace cambios):
```sql
-- Contar pagos con período en formato antiguo (solo mes, sin año):
SELECT periodo, COUNT(*) 
  FROM pagos 
 WHERE periodo IN ('Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre')
 GROUP BY periodo
 ORDER BY periodo;
```
- Si el resultado está vacío → **no hay nada que normalizar**, omitir M003.
- Si hay filas → verificar que las cuotas asociadas tienen `anio` NOT NULL:
  ```sql
  SELECT p.alumno_id, p.cuota_id, p.periodo, cu.anio
    FROM pagos p
    LEFT JOIN cuotas cu ON cu.cuenta_id=p.cuenta_id AND cu.id=p.cuota_id
   WHERE p.periodo IN ('Enero','Febrero','Marzo','Abril','Mayo','Junio',
                       'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre')
   ORDER BY cu.anio NULLS LAST;
  ```
  - Filas con `cu.anio IS NULL` → quedarán marcadas como 'ambiguo' en la auditoría, **no se tocarán**.

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

**Reversión de M003** (si se detecta problema después de ejecutar):
```sql
-- Capturar el timestamp de esta ejecución primero:
SELECT MIN(migrado_en) FROM _auditoria_periodos_m003;
-- Reemplazar <ts> con ese valor

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

**Precondición:** M001 y M004 ya aplicadas (la función las referencia).

```sql
-- Verificar que las dependencias existen:
SELECT to_regclass('public.operaciones_pagos');  -- no NULL
SELECT indexname FROM pg_indexes WHERE indexname='pagos_idempotency_key_unico';
```

**Ejecutar:**
```sql
-- Copiar y pegar el contenido de sql/11_insertar_pagos_lote.sql completo
-- (incluye BEGIN...COMMIT)
```

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

## Fixtures aislados de prueba

Usar **IDs en el rango `test-stg-*`** para evitar colisiones con los 2 cuentas, 3 cursos y 3 pagos existentes.

```sql
-- ── Cuenta de prueba para staging ────────────────────────────────────────────
-- NOTA: auth_id debe ser un UUID de un usuario real en staging, o bien
-- usar el auth_id de uno de los usuarios existentes para que es_dueno() pase.
-- Para el test de staging del flujo de pago, usar la cuenta existente del operador.

-- Verificar las cuentas existentes:
SELECT id, nombre, auth_id FROM tesorero_cuentas;
-- Usar uno de esos IDs (ej: cuenta_id = <el id que muestra>) para los fixtures.

-- ── Alumno de prueba ─────────────────────────────────────────────────────────
INSERT INTO alumnos (id, cuenta_id, curso_id, nombres, apellidos, eximido)
SELECT 'alu-stg-test-001', id, 
  (SELECT id FROM cursos WHERE cuenta_id=tc.id LIMIT 1),
  'Test', 'Staging', false
  FROM tesorero_cuentas tc
 WHERE tc.nombre = '<nombre de la cuenta que ya existe>';

-- ── Pago de prueba vía RPC ───────────────────────────────────────────────────
-- (reemplazar <cuenta_id>, <cuota_id> con valores reales del staging)
SELECT insertar_pagos_lote(
  '<cuenta_id>'::uuid,
  '[{
    "alumno_id":"alu-stg-test-001",
    "cuota_id":"<cuota_id_existente>",
    "monto":100,
    "fecha":"2026-11-04",
    "medio":"test",
    "estado":"pagado",
    "periodo":"Test Staging",
    "idempotency_key":"stg-test-001-unico"
  }]'::jsonb
);

-- ── Verificar idempotencia (reintento) ───────────────────────────────────────
-- Volver a ejecutar la misma llamada → debe retornar el mismo pago sin duplicar
-- Verificar:
SELECT COUNT(*) FROM pagos WHERE idempotency_key='stg-test-001-unico';
-- Debe ser = 1

-- ── Limpiar fixtures de prueba ───────────────────────────────────────────────
DELETE FROM operaciones_pagos WHERE idempotency_key='stg-test-001-unico';
DELETE FROM pagos WHERE idempotency_key='stg-test-001-unico';
DELETE FROM alumnos WHERE id='alu-stg-test-001';
```

---

## Resultados esperados al finalizar

Después de ejecutar M001 → M002 → M004 → RPC (y M003 si corresponde):

```sql
-- Verificar que los datos originales se preservaron:
SELECT 'cuentas' AS tabla, COUNT(*) FROM tesorero_cuentas
UNION ALL SELECT 'cursos', COUNT(*) FROM cursos
UNION ALL SELECT 'pagos',  COUNT(*) FROM pagos;
-- cuentas: 2, cursos: 3, pagos: 3  ← mismos que antes
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
```sql
-- Ver qué índice existe actualmente:
SELECT indexname, indexdef FROM pg_indexes WHERE tablename='pagos';
-- Si hay un índice duplicado o incorrecto, eliminarlo:
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
```sql
-- Ver el error exacto:
\errverbose
-- Los errores más comunes:
--   "function es_dueno does not exist" → 01_schema.sql no fue cargado en staging
--   "function tiene_rol_en_curso does not exist" → mismo
--   "relation operaciones_pagos does not exist" → M004 no aplicado
-- Verificar las dependencias y re-ejecutar.
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
- Cada paso debe ejecutarse individualmente, no en bloque, para poder identificar errores.
- Los fixtures de prueba deben limpiarse antes de reportar resultados finales.
- La RLS (Row Level Security) está activa en staging: los tests de fixtures deben usar el token del usuario real de staging, no el superusuario de Supabase.
