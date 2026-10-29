#!/bin/sh
# generate_env.sh — Script de build para generar __env.js y fijar la CSP de staging.
# Ejecutar en el paso de build del hosting (Netlify, Vercel, etc.).
#
# Variables de entorno requeridas en el hosting:
#   STAGING_SUPA_URL   — URL completa del proyecto Supabase de staging
#                        Ejemplo: https://abcdefghijklmnopqrst.supabase.co
#   STAGING_SUPA_KEY   — anon key del proyecto Supabase de staging (no service_role)
#
# NUNCA usar credenciales de producción:
#   Producción: https://tmjqzaakzhecbldebyeg.supabase.co  ← NUNCA AQUÍ

set -e

if [ -z "$STAGING_SUPA_URL" ] || [ -z "$STAGING_SUPA_KEY" ]; then
  echo "ERROR: Define STAGING_SUPA_URL y STAGING_SUPA_KEY en las variables de entorno del hosting." >&2
  exit 1
fi

# Rechazar URL de producción
case "$STAGING_SUPA_URL" in
  *tmjqzaakzhecbldebyeg*)
    echo "CRÍTICO: STAGING_SUPA_URL contiene el project-ref de producción. Abortando." >&2
    exit 1
    ;;
esac

# Extraer el host (sin esquema ni barra final) para la CSP
# Ejemplo: https://abcdef.supabase.co → abcdef.supabase.co
STAGING_SUPA_HOST=$(echo "$STAGING_SUPA_URL" | sed 's|^https\?://||' | sed 's|/.*||')

if [ -z "$STAGING_SUPA_HOST" ]; then
  echo "ERROR: No se pudo extraer el host de STAGING_SUPA_URL='$STAGING_SUPA_URL'" >&2
  exit 1
fi

# ── 1. Generar __env.js ───────────────────────────────────────────────────────
cat > __env.js << EOF
// Generado automáticamente por generate_env.sh — NO editar manualmente.
// Fuente: variables de entorno del hosting de staging.
window.STAGING_SUPA_URL = '${STAGING_SUPA_URL}';
window.STAGING_SUPA_KEY = '${STAGING_SUPA_KEY}';
EOF
echo "  [ok] __env.js generado (URL: $STAGING_SUPA_URL)"

# ── 2. Sustituir el placeholder STAGING_SUPA_HOST en index.html ───────────────
# index.html contiene: connect-src 'self' https://STAGING_SUPA_HOST wss://STAGING_SUPA_HOST
# El resultado final tiene el host exacto del proyecto de staging.
if grep -q 'STAGING_SUPA_HOST' index.html; then
  sed -i "s|STAGING_SUPA_HOST|${STAGING_SUPA_HOST}|g" index.html
  echo "  [ok] CSP de index.html actualizada con host: $STAGING_SUPA_HOST"
else
  echo "  [aviso] No se encontró el placeholder STAGING_SUPA_HOST en index.html — CSP no modificada"
fi

# ── 3. Generar _headers para Netlify (sobreescribe meta CSP con header HTTP) ──
# El header HTTP tiene precedencia sobre la meta etiqueta; es la defensa principal.
cat > _headers << EOF
/*
  Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src 'self'; connect-src 'self' https://${STAGING_SUPA_HOST} wss://${STAGING_SUPA_HOST}; worker-src 'none'; manifest-src 'self'; base-uri 'none'; form-action 'none'
EOF
echo "  [ok] _headers de Netlify generado (CSP exacta para $STAGING_SUPA_HOST)"
echo ""
echo "Resumen:"
echo "  STAGING_SUPA_URL  = $STAGING_SUPA_URL"
echo "  STAGING_SUPA_HOST = $STAGING_SUPA_HOST"
echo "  CSP connect-src   = https://${STAGING_SUPA_HOST} wss://${STAGING_SUPA_HOST}"
