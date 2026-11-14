# Evidencia — test:v9 aprobado

**Fecha:** 2026-11-14  
**Rama:** `gran-cambio-v9-relacional`  
**SHA ejecutado:** `3239820`  
**Staging Supabase:** `https://rucgmytyxpfowznowxwd.supabase.co`  
**Usuario de prueba:** `usuario_a@staging.test`  
**Producción (NO TOCADA):** `https://tmjqzaakzhecbldebyeg.supabase.co`

## Resultado

```
21 ✅ OK   0 ❌ FALLIDOS
```

## Detalle

| # | Comprobación | Resultado |
|---|---|---|
| 1 | Login | ✅ |
| 2 | Cuenta encontrada (autodiscovery) | ✅ |
| 3 | Curso fixture creado | ✅ |
| **T1** | **Alumno + PIN** | |
| 4 | Alumno creado | ✅ |
| 5 | PIN null → pin_vacio | ✅ |
| 6 | PIN vacío → pin_vacio | ✅ |
| 7 | PIN solo espacios → pin_vacio (trim en servidor) | ✅ |
| 8 | PIN 3 chars → pin_muy_corto | ✅ |
| 9 | PIN válido guardado (ok:true) | ✅ |
| 10 | PIN correcto aceptado por apoderado_acceso (bcrypt en servidor) | ✅ |
| 11 | PIN incorrecto rechazado (error: pin_incorrecto) | ✅ |
| **T2** | **Apoderado** | |
| 12 | Apoderado creado | ✅ |
| 13 | Apoderado reaparece en carga completa (simula cargarTodosApoderadosV9) | ✅ |
| **T3** | **Movimiento + comprobante** | |
| 14 | Movimiento creado | ✅ |
| 15 | comprobante persistido en PostgreSQL (campo TEXT) | ✅ |
| 16 | archivos (JSONB) persistidos en PostgreSQL | ✅ |
| 17 | comprobante reaparece al recargar (simula cargarMovimientosV9) | ✅ |
| **T4** | **retryPin** | |
| 18 | PIN original válido antes del cambio | ✅ |
| 19 | RPC tesorero_set_pin ok:true (alumno existente) | ✅ |
| 20 | PIN anterior rechazado tras el cambio (ON CONFLICT DO UPDATE efectivo) | ✅ |
| 21 | PIN nuevo aceptado (bcrypt verificado en servidor) | ✅ |

## Limpieza

Los 4 fixtures creados fueron eliminados correctamente al finalizar:
- `movimientos`
- `apoderados`
- `alumnos`
- `cursos`

## Estado de E5

- `sql/E5_pin_rpc.sql` ejecutado en staging ✅
- RPC `tesorero_set_pin` validado end-to-end ✅
- Verificación bcrypt vía `apoderado_acceso` (anon, sin JWT del tesorero) ✅

## Pendiente

- E5/E6 UI: pruebas manuales desde la interfaz staging (ver checklist abajo)
- Aprobación explícita antes de cualquier cambio en producción
