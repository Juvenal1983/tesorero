// js/core/arranque.js — Bootstrap de producción
// Reemplaza la función que hacía js/preview/inicio.js en la demo.
// Inicia la app cuando todos los scripts defer han cargado.

document.addEventListener('DOMContentLoaded', async function iniciarApp() {
  // 1. Cargar datos locales (localStorage vía previewStorage)
  try { initDB(); } catch(e) { console.warn('initDB falló:', e); }

  // 2. Detectar link de recuperación de contraseña en la URL
  //    Supabase añade #access_token=...&type=recovery cuando el usuario
  //    llega desde el email de recuperación
  if (authClient) {
    const hash = window.location.hash;
    if (hash.includes('type=recovery') || hash.includes('type=invite')) {
      try {
        // Supabase intercambia automáticamente el token del hash por una sesión
        const { data, error } = await authClient.auth.getSession();
        if (data?.session) {
          _authToken = data.session.access_token;
          mostrarPantallaResetPassword();
          return;
        }
      } catch(e) {}
      // Si falla, mostrar login normal
      render();
      return;
    }
  }

  // 3. Si hay sesión activa en Supabase Auth, reanudar sin pasar por login
  if (authClient) {
    try {
      const { data } = await authClient.auth.getSession();
      const session = data?.session;
      if (session?.user) {
        _authToken = session.access_token || null;
        const email  = session.user.email || '';
        const authId = session.user.id;

        // ── FLUJO RELACIONAL v9 ──────────────────────────────────────────
        if (typeof V9_RELACIONAL !== 'undefined' && V9_RELACIONAL) {
          try {
            const { cuenta, cuentaId, cursoIds, esDelegado, rolEfectivo } = await cargarSesionV9(authId, _authToken);
            const usuarioV9 = {
              id:         cuentaId,
              authId,
              email:      cuenta.email || email,
              nombre:     cuenta.nombre || email,
              rol:        rolEfectivo || 'tesorero',
              cursoIds,
              esDelegado: !!esDelegado,
              _v9:        true,
            };
            S.session     = usuarioV9;
            S._v9CuentaId = cuentaId;
            // En v9 sólo actualizamos KEY sin leer localStorage ni sobreescribir DB,
            // porque cargarSesionV9() ya pobló DB desde las tablas relacionales.
            if (typeof _setUserKeyV9 === 'function') { try { _setUserKeyV9(cuentaId); } catch(_) {} }
            if (cursoIds.length === 1) { S.cursoId = cursoIds[0]; go('dashboard'); }
            else { go(cursoIds.length > 1 ? 'selector' : 'dashboard'); }
            return;
          } catch (errV9) {
            console.error('[v9] arranque: cargarSesionV9 falló, mostrando login:', errV9);
            render();
            return;
          }
        }
        // ── FIN FLUJO RELACIONAL v9 ──────────────────────────────────────

        // Intentar cargar datos del usuario desde Supabase (blob legado)
        const legacy = await buscarUsuarioLegacyPorEmail(email, authId);
        if (legacy && legacy.datos) {
          DB = legacy.datos;
          previewStorage.setItem(KEY, JSON.stringify(DB));
          const u = { ...legacy.user, authId };
          S.session = u;
          setUserKey(u.id);
          // Cargar desde la nube (actualiza DB) y luego ir al dashboard
          loadFromCloud(authId).catch(() => {}).finally(() => {
            if (u.cursoIds && u.cursoIds.length === 1) {
              S.cursoId = u.cursoIds[0];
              go('dashboard');
            } else {
              go('selector');
            }
          });
          return;
        }
      }
    } catch (e) {
      console.warn('Error al verificar sesión Supabase:', e);
    }
  }

  // 3. Sin sesión activa → mostrar pantalla de login
  render();
});
