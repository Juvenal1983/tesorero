#!/bin/sh
# generate_env.sh — Script de build para generar __env.js desde variables de entorno.
# Ejecutar en el paso de build del hosting (Netlify, Vercel, etc.).
#
# Variables de entorno requeridas en el hosting:
#   STAGING_SUPA_URL   — URL del proyecto Supabase de staging
#   STAGING_SUPA_KEY   — anon key del proyecto Supabase de staging
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

cat > __env.js << EOF
// Generado automáticamente por generate_env.sh — NO editar manualmente.
// Fuente: variables de entorno del hosting de staging.
window.STAGING_SUPA_URL = '${STAGING_SUPA_URL}';
window.STAGING_SUPA_KEY = '${STAGING_SUPA_KEY}';
EOF

echo "  __env.js generado correctamente (URL: $STAGING_SUPA_URL)"
