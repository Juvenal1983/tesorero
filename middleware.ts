import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/** Rutas públicas que no requieren autenticación */
const PUBLIC_ROUTES = ['/auth/login', '/auth/codigo', '/auth/callback']

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request: { headers: request.headers } })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) { return request.cookies.get(name)?.value },
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set({ name, value, ...options })
          response = NextResponse.next({ request: { headers: request.headers } })
          response.cookies.set({ name, value, ...options })
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({ name, value: '', ...options })
          response = NextResponse.next({ request: { headers: request.headers } })
          response.cookies.set({ name, value: '', ...options })
        },
      },
    }
  )

  const { data: { session } } = await supabase.auth.getSession()
  const pathname = request.nextUrl.pathname

  // Permite rutas públicas
  if (PUBLIC_ROUTES.some(r => pathname.startsWith(r))) {
    // Si ya está autenticado, redirige al dashboard
    if (session && pathname !== '/auth/callback') {
      return NextResponse.redirect(new URL('/app/dashboard', request.url))
    }
    return response
  }

  // Ruta raíz → redirige según estado de autenticación
  if (pathname === '/') {
    return NextResponse.redirect(
      new URL(session ? '/app/dashboard' : '/auth/login', request.url)
    )
  }

  // Protege todas las rutas /app/*
  if (pathname.startsWith('/app') && !session) {
    return NextResponse.redirect(new URL('/auth/login', request.url))
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons|manifest.json|sw.js).*)'],
}
