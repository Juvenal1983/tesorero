# Evidencia — E6: Movimientos + PIN + Storage + Edge Function

**Fecha:** 2026-11-15  
**Rama:** `gran-cambio-v9-relacional`  
**SHA ejecutado:** `00ea9cf`  
**Cadena de commits E6:** `a00039b` → `93b5b8f` → `5cc2bb3` → `b728354` → `7d4a89a` → `00ea9cf`  
**Staging Supabase:** `https://rucgmytyxpfowznowxwd.supabase.co`  
**Usuario de prueba:** `usuario_a@staging.test`  
**Producción (NO TOCADA):** `https://tmjqzaakzhecbldebyeg.supabase.co`

## Resultado

```
33 ✅ OK   0 ❌ FALLIDOS
```

## Alcance probado

### Movimientos (M1–M6)

| # | Comprobación | Resultado |
|---|---|---|
| M1 | Movimiento tipo ingreso creado vía UI | ✅ |
| M2 | Movimiento tipo gasto creado con comprobante (Storage) | ✅ |
| M3 | Comprobante subido a Supabase Storage (bucket privado) | ✅ |
| M4 | Ruta de 4 segmentos `{cuentaId}/{cursoId}/{movId}/{uid}.{ext}` validada | ✅ |
| M5a | URL firmada generada vía RPC `apoderado_abrir_comprobante` | ✅ |
| M5b | URL firmada normalizada (`/storage/v1` agregado cuando falta) | ✅ |
| M6 | Movimiento eliminado — Storage limpiado antes del DELETE PostgreSQL | ✅ |

### PIN y bloqueo (PIN1–PIN2)

| # | Comprobación | Resultado |
|---|---|---|
| PIN1 | PIN incorrecto registra intento en `apoderado_intentos` | ✅ |
| PIN2 | 5 intentos fallidos → bloqueo activo (`bloqueado_hasta` en el futuro) | ✅ |

### Apoderado completo (APO.NULL–APO.3)

| # | Comprobación | Resultado |
|---|---|---|
| APO.NULL | Alumno sin PIN → `sin_credencial` | ✅ |
| APO.EMPTY | PIN vacío → `pin_vacio` | ✅ |
| APO.1 | PIN correcto → `ok:true` + `storage_path` devuelto | ✅ |
| APO.CONTADOR | 3 fallos vía `apoderado_acceso` + 2 vía `apoderado_abrir_comprobante` = 5 total; 6° con PIN correcto → `bloqueado` (fixture independiente ALU2) | ✅ |
| APO.2 | PIN incorrecto tras reseteo → `pin_incorrecto` | ✅ |
| APO.3 | Movimiento de un curso distinto rechazado → aislamiento de cursos verificado | ✅ |

### Edge Function (APO.EDGE)

| # | Comprobación | Resultado |
|---|---|---|
| APO.EDGE | Edge Function `apoderado-comprobante` retorna URL firmada con duración 300 s (Deno + service_role) | ✅ |

### Storage teardown

- Listado de 2 niveles (`{cuenta}/{curso}/` → movId folders → archivos reales) funciona correctamente  
- Rutas recuperadas antes del DELETE PostgreSQL para evitar huérfanos en Storage  
- Verificación post-eliminación (`listarStoragePrefix`) confirma que los archivos desaparecen  

## Correcciones incorporadas en esta cadena de commits

| Commit | Fix |
|---|---|
| `a00039b` | Storage RLS, URLs firmadas on-demand, acceso apoderado |
| `93b5b8f` | pgjwt, PIN null-safe, bloqueo intentos, validación ruta |
| `5cc2bb3` | 3 bloqueantes de seguridad (SQL + Edge Function) |
| `b728354` | JWT, service_role, prefijo literal, contador compartido |
| `7d4a89a` | ALU2 fixture independiente para APO.CONTADOR; teardown 2-niveles Storage; M6 limpieza previa |
| `00ea9cf` | M5b URL `/storage/v1` normalizado en app + test; APO.3 fixture `id` + `finally` para limpieza garantizada |

## Limpieza

Los fixtures creados por el ensayo fueron eliminados al finalizar:

- `movimientos` (todos los de CURSO_ID + `mov-apo3-{EXEC_ID}`)
- `alumnos` (ALU_ID + ALU2_ID)
- `cursos` (CURSO_ID + `crs-apo-aislamiento-{EXEC_ID}`)
- Storage: todos los archivos bajo `{cuentaId}/{cursoId}/` eliminados vía API

> **Nota:** El cursor `crs-apo-aislamiento-mwhzkhwm` del run anterior (antes del fix `finally`) puede
> requerir limpieza manual:
> ```sql
> DELETE FROM movimientos WHERE curso_id = 'crs-apo-aislamiento-mwhzkhwm';
> DELETE FROM cursos WHERE id = 'crs-apo-aislamiento-mwhzkhwm';
> ```

## Pendiente

- SQL `sql/E6_storage_comprobantes.sql` pendiente de ejecutar en staging (no ejecutado aún)
- Edge Function `apoderado-comprobante` pendiente de deploy a staging
- E5/E6 UI: pruebas manuales desde interfaz staging (checklist pendiente)
- **Aprobación explícita antes de cualquier cambio en producción**
- E7 Fondos especiales, actividades y reportes (siguiente etapa)
