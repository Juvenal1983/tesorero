/**
 * supabase/functions/apoderado-comprobante/index.ts
 *
 * Edge Function: genera URL firmada de Storage para un apoderado.
 *
 * Flujo:
 *   1. Recibe {p_cuenta_id, p_alumno_id, p_pin, p_mov_id} vía POST.
 *   2. Llama a apoderado_abrir_comprobante() RPC con service_role.
 *      (La RPC valida PIN, alumno/curso activos, movimiento visible, ruta.)
 *   3. Si ok → genera URL firmada con supabase.storage.createSignedUrl().
 *   4. Devuelve {ok: true, url: "..."} o {ok: false, error: "..."}.
 *
 * No requiere configuración manual:
 *   - SUPABASE_URL             inyectado automáticamente por Supabase
 *   - SUPABASE_SERVICE_ROLE_KEY inyectado automáticamente por Supabase
 *
 * Despliegue:
 *   supabase functions deploy apoderado-comprobante --project-ref rucgmytyxpfowznowxwd
 *
 * URL resultante:
 *   https://rucgmytyxpfowznowxwd.supabase.co/functions/v1/apoderado-comprobante
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.0";

// ── CORS ──────────────────────────────────────────────────────────────────────
// La app puede servirse desde cualquier origen (PWA, file://, staging web).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  // Preflight CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "metodo_no_permitido" }, 405);
  }

  // ── 1. Parsear cuerpo ───────────────────────────────────────────────────────
  let body: {
    p_cuenta_id?: string;
    p_alumno_id?: string;
    p_pin?: string;
    p_mov_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "cuerpo_invalido" }, 400);
  }

  const { p_cuenta_id, p_alumno_id, p_pin, p_mov_id } = body;

  if (!p_cuenta_id || !p_alumno_id || !p_pin || !p_mov_id) {
    return json({ ok: false, error: "parametros_faltantes" }, 400);
  }

  // ── 2. Cliente con service_role (inyectado automáticamente por Supabase) ────
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    // No debería ocurrir en Supabase hosted; solo en entorno local sin setup
    return json({ ok: false, error: "entorno_no_configurado" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── 3. Validar PIN + permisos via RPC PostgreSQL ────────────────────────────
  // La RPC apoderado_abrir_comprobante valida:
  //   - PIN nulo/vacío rechazado explícitamente
  //   - PIN bcrypt (IS DISTINCT FROM — NULL-safe)
  //   - Bloqueo de intentos fallidos (5 → 15 min)
  //   - Alumno activo
  //   - Curso activo
  //   - Movimiento visible=TRUE del curso del alumno
  //   - storagePath empieza con {cuenta}/{curso}/{mov}/
  // Devuelve {ok: true, storage_path: "..."} o {ok: false, error: "..."}.
  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "apoderado_abrir_comprobante",
    { p_cuenta_id, p_alumno_id, p_pin, p_mov_id }
  );

  if (rpcError) {
    console.error("[apoderado-comprobante] RPC error:", rpcError);
    return json({ ok: false, error: "rpc_error", msg: rpcError.message }, 500);
  }

  if (!rpcData?.ok) {
    // Propagar el error de validación tal cual (pin_incorrecto, cuenta_bloqueada, etc.)
    return json(rpcData ?? { ok: false, error: "error_desconocido" });
  }

  const storagePath: string = rpcData.storage_path;

  // ── 4. Generar URL firmada con la API oficial de Supabase Storage ────────────
  // createSignedUrl usa service_role → bypasa las políticas RLS de Storage.
  // Vigencia: 300 segundos (5 minutos).
  const { data: signData, error: signError } = await supabase.storage
    .from("comprobantes")
    .createSignedUrl(storagePath, 300);

  if (signError) {
    console.error("[apoderado-comprobante] Storage error:", signError);
    return json({ ok: false, error: "storage_error", msg: signError.message }, 500);
  }

  if (!signData?.signedUrl) {
    return json({ ok: false, error: "storage_url_vacia" }, 500);
  }

  return json({ ok: true, url: signData.signedUrl });
});
