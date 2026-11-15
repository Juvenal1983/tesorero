# Evidencia E7-API — 2026-11-15

## Resultado: **29 OK / 0 fallidos / 0 pendientes**

| Capa | Archivo | Resultado |
|------|---------|-----------|
| API + cálculos | `tests/e7_fondos_actividades.js` | ✅ 29 / 0 |

## Commit ensayado

```
ff39015  fix(E7): reparto exacto en getFondoAlumno/Hasta; test usa funciones reales
8a62854  E7: SQL idempotente, reparto exacto, fondo_especial V9, test ensayo completo
```

Cadena completa: `a00039b → … → 00ea9cf → 8a62854 → ff39015`  
Rama: `gran-cambio-v9-relacional`  
Staging: `rucgmytyxpfowznowxwd.supabase.co`

## Comprobaciones validadas

### UNIT — Funciones reales cargadas con vm.runInNewContext
| ID | Descripción | Resultado |
|----|-------------|-----------|
| UNIT.1 | `getFondoAlumno` actividad divisible: `[10000,10000,10000]` suma=30000 | ✅ |
| UNIT.2 | `getFondoAlumno` actividad no-divisible 10100/3: `[3366,3366,3368]` suma=10100 | ✅ |
| UNIT.3 | `getFondoAlumno` rendimiento floor+resto 1000/3: `[333,333,334]` suma=1000 | ✅ |
| UNIT.4 | `getFondoAlumnoHasta` actividad no-divisible 10100/3: suma=10100 | ✅ |
| UNIT.5 | Multa no descuenta saldo individual; saldo ALU1 = 10000 exacto | ✅ |
| UNIT.6 | `ingMes[5]=15000` (jun), `ingMes[7]=20000` (ago), otro curso excluido | ✅ |

### CFG — Configuración de fondo especial (REST)
| ID | Descripción | Resultado |
|----|-------------|-----------|
| CFG.1 | Activar vía PATCH `cursos.fondo_especial` | ✅ |
| CFG.2 | Renombrar a "Fondo Egreso 2026" en PostgreSQL | ✅ |
| CFG.3 | GET fresco confirma persistencia | ✅ |

### FM — Fondo movimientos CRUD (REST + persistencia PostgreSQL)
| ID | Descripción | Resultado |
|----|-------------|-----------|
| FM.1 | Aporte 30000/3 alumnos; `sum(montoIndividual)=30000` exacto | ✅ |
| FM.2 | Aporte no-divisible 10100/3; `sum=10100` exacto | ✅ |
| FM.3 | Movimiento tipo actividad con 2 participantes | ✅ |
| FM.4 | Editar a 31000; reproporcional `[10333,10333,10334]` suma=31000 | ✅ |
| FM.5 | Recarga GET: ambos movimientos persisten | ✅ |
| FM.6 | Aislamiento de cursos: CURSO2 vacío | ✅ |
| FM.7 | Eliminar FM.3; ausente en PostgreSQL | ✅ |

### ACT — Actividades CRUD (REST + persistencia PostgreSQL)
| ID | Descripción | Resultado |
|----|-------------|-----------|
| ACT.1 | Crear actividad monto=48000 | ✅ |
| ACT.2 | Editar nombre + monto_total=50000 | ✅ |
| ACT.3 | Recarga GET: actividad editada persiste | ✅ |
| ACT.4 | Eliminar; ausente en PostgreSQL | ✅ |

### RPT — Saldos y reportes (funciones reales + REST)
| ID | Descripción | Resultado |
|----|-------------|-----------|
| RPT.1 | Saldo ALU1 = 10333 exacto (aporte 31000, proporcional, multa no resta) | ✅ |
| RPT.2 | `sum(saldos[ALU1,ALU2,ALU3]) = totalAportes = 31000` | ✅ |
| RPT.3 | Actividad de agosto: `ingMes[7] ≥ 20000` | ✅ |

### VIS — Visor no puede escribir (HTTP 403 / code=42501)
| ID | Descripción | Resultado |
|----|-------------|-----------|
| VIS.1 | Usuario C (visor) INSERT `fondo_movimiento` → HTTP 403 42501 | ✅ |
| VIS.2 | Usuario C (visor) INSERT `actividad` → HTTP 403 42501 | ✅ |
| VIS.3 | Usuario C (visor) PATCH `cursos.fondo_especial` → bloqueado | ✅ |

### ISO — Aislamiento entre cuentas
| ID | Descripción | Resultado |
|----|-------------|-----------|
| ISO.1 | Token B: 0 `fondo_movimientos` de cuenta A visibles | ✅ |
| ISO.2 | Token B: 0 `actividades` de cuenta A visibles | ✅ |

### LIMPIEZA
| ID | Descripción | Resultado |
|----|-------------|-----------|
| LIMPIEZA | `crs-apo-aislamiento-mwhzkhwm` ausente en staging | ✅ |

## Notas
- SQL `E7_fondos_actividades.sql` aún **no ejecutado en staging** (pendiente de aprobación).
- Capa UI (Playwright) pendiente — E7 no se declara completo.
- Producción `tmjqzaakzhecbldebyeg.supabase.co` no tocada.
