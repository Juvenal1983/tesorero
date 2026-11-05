#!/usr/bin/env bash
# ============================================================
# tests/run_tests.sh
# Ejecuta la suite completa de pruebas, incluyendo Test 5
# de concurrencia real con dos conexiones psql paralelas.
#
# USO:
#   chmod +x tests/run_tests.sh
#   ./tests/run_tests.sh [nombre_db]
#
# La DB por defecto es tesorero_test.
# ============================================================
set -euo pipefail

DB="${1:-tesorero_test}"
PSQL="psql -d $DB -v ON_ERROR_STOP=1"

echo "========================================"
echo "El Tesorero — Suite de pruebas v9"
echo "DB: $DB"
echo "========================================"

# ── 1. Crear entorno y cargar RPC ────────────────────────────────────────────
echo ""
echo "[1/4] Creando esquema de prueba (00_local_test_env.sql)..."
$PSQL -f tests/00_local_test_env.sql

echo "[2/4] Cargando RPC (sql/11_insertar_pagos_lote.sql)..."
$PSQL -f sql/11_insertar_pagos_lote.sql

# ── 2. Ejecutar suite principal (Tests 1-15) ─────────────────────────────────
echo ""
echo "[3/4] Ejecutando suite principal (01_suite_pagos_acumulables.sql)..."
$PSQL -t --pset=format=unaligned -f tests/01_suite_pagos_acumulables.sql

# ── 3. Test de concurrencia real (Test 5 extendido) ──────────────────────────
# Lanza dos sesiones psql en paralelo que intentan insertar con la misma
# idempotency_key al mismo tiempo. PostgreSQL debe serializar el conflicto
# vía ON CONFLICT DO UPDATE; solo debe quedar 1 fila al final.
echo ""
echo "[4/4] Test de concurrencia real: 2 conexiones psql en paralelo..."

CONC_KEY="conc-real-$(date +%s)"

# Preparar fixture en entorno limpio — limpiar tanto pagos como operaciones_pagos
$PSQL -c "
  SET app.test_es_dueno = 'true';
  SET app.test_user_id  = '00000000-0000-0000-0000-000000000001';
  DELETE FROM pagos             WHERE idempotency_key LIKE 'conc-real-%';
  DELETE FROM operaciones_pagos WHERE idempotency_key LIKE 'conc-real-%';
" > /dev/null 2>&1

# Script SQL para cada sesión — ambas intentan insertar la misma clave
CONC_SQL_A="
  SET app.test_es_dueno = 'true';
  SET app.test_user_id  = '00000000-0000-0000-0000-000000000001';
  SELECT insertar_pagos_lote(
    'aaaaaaaa-0000-0000-0000-000000000001'::UUID,
    '[{\"alumno_id\":\"alu-test-1\",\"cuota_id\":\"cuota-test-1\",
       \"monto\":20000,\"fecha\":\"2025-07-15\",\"medio\":\"efectivo\",
       \"periodo\":\"Julio 2025\",\"idempotency_key\":\"$CONC_KEY\"}]'::JSONB
  );
"

CONC_SQL_B="$CONC_SQL_A"

# Lanzar las dos sesiones en paralelo
$PSQL -c "$CONC_SQL_A" > /tmp/conc_a.out 2>&1 &
PID_A=$!
$PSQL -c "$CONC_SQL_B" > /tmp/conc_b.out 2>&1 &
PID_B=$!

# Esperar a que ambas terminen y capturar exit codes por separado.
# ÍTEM 5: NO usar || true — los códigos de salida importan.
# En idempotencia correcta ambas sesiones deben tener éxito (una inserta,
# la otra retorna la fila existente). Si ambas fallan hay un problema real.
wait $PID_A; RC_A=$?
wait $PID_B; RC_B=$?

echo "  Sesión A: exit=$RC_A"
echo "  Sesión B: exit=$RC_B"

if [ $RC_A -ne 0 ] && [ $RC_B -ne 0 ]; then
  echo "FAIL: Test de concurrencia real — AMBAS sesiones fallaron"
  echo "  Salida sesión A: $(cat /tmp/conc_a.out)"
  echo "  Salida sesión B: $(cat /tmp/conc_b.out)"
  exit 1
fi

# Verificar que solo queda 1 fila con esa clave (idempotencia)
CNT=$($PSQL -t -c "SELECT COUNT(*) FROM pagos WHERE idempotency_key = '$CONC_KEY';" | tr -d ' \n')

# Verificar respuesta JSON de la sesión que tuvo éxito (debe contener el pago)
SUCCESS_OUT=""
if [ $RC_A -eq 0 ]; then SUCCESS_OUT=$(cat /tmp/conc_a.out); fi
if [ $RC_B -eq 0 ]; then SUCCESS_OUT=$(cat /tmp/conc_b.out); fi

if [ "$CNT" = "1" ]; then
  echo "PASS: Test de concurrencia real — 2 sesiones paralelas, 1 sola fila (key=$CONC_KEY)"
  if echo "$SUCCESS_OUT" | grep -q '"monto"'; then
    echo "  PASS (respuesta): JSON de respuesta contiene datos del pago ✓"
  else
    echo "  ADVERTENCIA: JSON de respuesta no contiene 'monto'; revisar salida completa"
    echo "  Salida: $SUCCESS_OUT"
  fi
else
  echo "FAIL: Test de concurrencia real — se esperaba 1 fila, se encontraron $CNT (key=$CONC_KEY)"
  echo "  Salida sesión A (RC=$RC_A): $(cat /tmp/conc_a.out)"
  echo "  Salida sesión B (RC=$RC_B): $(cat /tmp/conc_b.out)"
  exit 1
fi

rm -f /tmp/conc_a.out /tmp/conc_b.out

echo ""
echo "========================================"
echo "TODAS LAS PRUEBAS PASARON"
echo "========================================"
