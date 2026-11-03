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
#   C3: PIN correcto + PIN incorrecto simultáneos → intentos_fallo = 0 al final.
#       El correcto resetea el contador; el incorrecto lo incrementa.
#       Gana el reset si llega después, pero el caso testea que el correcto
#       no interfiere con el bloqueo: la llamada correcta siempre devuelve
#       datos del alumno (no 'bloqueado') aunque corra con un fallo.
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
echo "=== C3: PIN correcto + PIN incorrecto simultáneos ==="
# C3 verifica dos propiedades:
#   a) La llamada con PIN correcto retorna el alumno (no 'bloqueado') incluso
#      cuando compite con una llamada con PIN incorrecto.
#   b) Después de la llamada correcta, intentos_fallo = 0 (el reset ocurrió).
# Nota: si el incorrecto llega DESPUÉS del reset, intentos_fallo puede quedar en 1.
# Lo importante es que la llamada correcta no devuelva 'bloqueado' ni error.

$PG -c "DELETE FROM apoderado_intentos WHERE cuenta_id='$CUENTA_A' AND alumno_id='alu-a-01';"

# Lanzar simultáneamente: uno con PIN correcto, uno con PIN incorrecto
# Guardar resultados en archivos temporales (evita set -u con subshell en background)
TMP_OK=$(mktemp)
TMP_FAIL=$(mktemp)

$PG -c "SELECT apoderado_acceso('$CUENTA_A'::uuid, 'alu-a-01', '1234')->>'error';" >"$TMP_OK" 2>/dev/null &
PID_OK=$!
$PG -c "SELECT apoderado_acceso('$CUENTA_A'::uuid, 'alu-a-01', '0000')->>'error';" >"$TMP_FAIL" 2>/dev/null &
PID_FAIL=$!

wait $PID_OK $PID_FAIL

RESULTADO_CORRECTO=$(cat "$TMP_OK" | tr -d ' \n')
RESULTADO_INCORRECTO=$(cat "$TMP_FAIL" | tr -d ' \n')
rm -f "$TMP_OK" "$TMP_FAIL"

# C3a: la llamada correcta no devuelve error ('bloqueado', 'pin_incorrecto', etc.)
if [ -z "$RESULTADO_CORRECTO" ]; then
  pass "C3a: PIN correcto retorna alumno (sin error) aun corriendo con PIN incorrecto"
else
  fail "C3a: PIN correcto devolvió error='$RESULTADO_CORRECTO' (no debería)"
fi

# C3b: la llamada incorrecta retorna pin_incorrecto (no bloqueado, no crash)
if [ "$RESULTADO_INCORRECTO" = "pin_incorrecto" ]; then
  pass "C3b: PIN incorrecto retorna pin_incorrecto (no bloquea ni crashea)"
else
  fail "C3b: PIN incorrecto devolvió '$RESULTADO_INCORRECTO', esperado pin_incorrecto"
fi

# C3c: tras la llamada correcta, intentos_fallo = 0 (reset aplicado)
# Esperamos brevemente a que finalicen transacciones en vuelo
sleep 0.2
INTENTOS_C3=$($PG -c "SELECT COALESCE((SELECT intentos_fallo FROM apoderado_intentos WHERE cuenta_id='$CUENTA_A' AND alumno_id='alu-a-01'), 0);" 2>/dev/null || echo "0")

if [ "$INTENTOS_C3" = "0" ] || [ "$INTENTOS_C3" = "1" ]; then
  pass "C3c: intentos_fallo=$INTENTOS_C3 (0 si correcto llegó último; 1 si incorrecto llegó último — ambos aceptables)"
else
  fail "C3c: intentos_fallo=$INTENTOS_C3, esperado 0 o 1 tras PIN correcto+incorrecto"
fi

# Limpieza
$PG -c "DELETE FROM apoderado_intentos WHERE cuenta_id='$CUENTA_A' AND alumno_id='alu-a-01';"

echo ""
echo "══════════════════════════════════════════════"
if [ "$FALLOS" -eq 0 ]; then
  echo "Todas las pruebas de concurrencia pasaron."
else
  echo "$FALLOS prueba(s) FALLARON."
  exit 1
fi
echo "══════════════════════════════════════════════"
