#!/usr/bin/env bash
# ============================================================
# El Tesorero v9 — Pruebas de concurrencia (dos conexiones simultáneas)
# Ejecutar como: sudo bash sql/test_concurrencia.sh
#
# Prerrequisitos: tesorero_test con fixtures 09d y 09e cargados.
#
# Qué prueba:
#   C1: Dos PINs incorrectos simultáneos → intentos_fallo = 2 (no 1)
#       Verifica que el FOR UPDATE serializa el contador.
#   C2: Dos altas de contacto simultáneas → dos IDs distintos,
#       ambos registros persistidos.
# ============================================================

set -euo pipefail

DB="tesorero_test"
PG="sudo -u postgres psql -d $DB -tAq"
CUENTA_A="00000000-0000-0000-aaaa-000000000001"
FALLOS=0

pass() { echo "[OK]    $1"; }
fail() { echo "[FALLO] $1"; FALLOS=$((FALLOS + 1)); }

# ── Limpieza inicial ──────────────────────────────────────────
$PG -c "DELETE FROM apoderado_intentos WHERE cuenta_id='$CUENTA_A' AND alumno_id='alu-a-02';"
$PG -c "DELETE FROM apoderados WHERE cuenta_id='$CUENTA_A' AND id LIKE 'apo-concurrent-%';"

echo ""
echo "=== C1: Intentos concurrentes con PIN incorrecto ==="

# Lanzar dos conexiones simultáneas con PIN incorrecto
$PG -c "SELECT apoderado_acceso('$CUENTA_A'::uuid, 'alu-a-02', '0000');" &
PID1=$!
$PG -c "SELECT apoderado_acceso('$CUENTA_A'::uuid, 'alu-a-02', '0000');" &
PID2=$!

wait $PID1 $PID2

# Verificar que intentos_fallo = 2 (no 1 por race condition)
INTENTOS=$($PG -c "SELECT intentos_fallo FROM apoderado_intentos WHERE cuenta_id='$CUENTA_A' AND alumno_id='alu-a-02';")

if [ "$INTENTOS" = "2" ]; then
  pass "C1: intentos_fallo = 2 tras dos PINs simultáneos (FOR UPDATE funciona)"
else
  fail "C1: esperado intentos_fallo=2, obtenido=$INTENTOS (posible race condition)"
fi

# Limpiar
$PG -c "DELETE FROM apoderado_intentos WHERE cuenta_id='$CUENTA_A' AND alumno_id='alu-a-02';"

echo ""
echo "=== C2: Altas de contacto simultáneas ==="

# Dos altas simultáneas de contacto para el mismo alumno con PIN correcto
ID_A=$($PG -c "SELECT apoderado_agregar_contacto('$CUENTA_A'::uuid, 'alu-a-01', '1234', 'Contacto Concurrente A', NULL, NULL, NULL)->>'apoderado_id';" &)
ID_B=$($PG -c "SELECT apoderado_agregar_contacto('$CUENTA_A'::uuid, 'alu-a-01', '1234', 'Contacto Concurrente B', NULL, NULL, NULL)->>'apoderado_id';" &)

# Capturar IDs via subconsulta separada (los &-lanzados no retornan al script)
# Relanzar sincronizando salida:
ID_A=$($PG -c "SELECT apoderado_agregar_contacto('$CUENTA_A'::uuid, 'alu-a-01', '1234', 'Contacto CA', NULL, NULL, NULL)->>'apoderado_id';") &
PID_A=$!
ID_B=$($PG -c "SELECT apoderado_agregar_contacto('$CUENTA_A'::uuid, 'alu-a-01', '1234', 'Contacto CB', NULL, NULL, NULL)->>'apoderado_id';") &
PID_B=$!

wait $PID_A $PID_B

# Verificar que existen dos contactos con nombre Contacto CA y CB
COUNT_CA=$($PG -c "SELECT count(*) FROM apoderados WHERE cuenta_id='$CUENTA_A' AND alumno_id='alu-a-01' AND nombre='Contacto CA';")
COUNT_CB=$($PG -c "SELECT count(*) FROM apoderados WHERE cuenta_id='$CUENTA_A' AND alumno_id='alu-a-01' AND nombre='Contacto CB';")

if [ "$COUNT_CA" = "1" ] && [ "$COUNT_CB" = "1" ]; then
  pass "C2: ambos contactos insertados (IDs distintos por microsegundos)"
else
  fail "C2: esperado 1+1 contactos, obtenido CA=$COUNT_CA CB=$COUNT_CB"
fi

# Verificar que los IDs son distintos entre sí
COUNT_IDS=$($PG -c "SELECT count(DISTINCT id) FROM apoderados WHERE cuenta_id='$CUENTA_A' AND alumno_id='alu-a-01' AND nombre IN ('Contacto CA','Contacto CB');")
if [ "$COUNT_IDS" = "2" ]; then
  pass "C2b: los dos contactos tienen IDs distintos"
else
  fail "C2b: esperado 2 IDs distintos, obtenido=$COUNT_IDS (posible colisión de ID)"
fi

# Limpieza
$PG -c "DELETE FROM apoderados WHERE cuenta_id='$CUENTA_A' AND alumno_id='alu-a-01' AND nombre IN ('Contacto CA','Contacto CB');"

echo ""
echo "══════════════════════════════════════════════"
if [ "$FALLOS" -eq 0 ]; then
  echo "Todas las pruebas de concurrencia pasaron."
else
  echo "$FALLOS prueba(s) FALLARON."
  exit 1
fi
echo "══════════════════════════════════════════════"
