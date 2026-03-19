'use client'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { logout } from '@/lib/actions/cursos'
import { iniciales } from '@/lib/utils/format'
import type { Usuario, CursoUsuario } from '@/lib/types'

const NAV_TESORERO = [
  { href: '/app/dashboard',    icon: '📊', label: 'Dashboard' },
  { href: '/app/alumnos',      icon: '👥', label: 'Alumnos' },
  { href: '/app/cuotas',       icon: '💳', label: 'Cuotas' },
  { href: '/app/pagos',        icon: '✅', label: 'Pagos' },
  { href: '/app/movimientos',  icon: '💸', label: 'Movimientos' },
  { href: '/app/reportes',     icon: '📄', label: 'Reportes' },
  { href: '/app/config',       icon: '⚙️', label: 'Configuración' },
]

const NAV_LECTOR = [
  { href: '/app/dashboard',   icon: '📊', label: 'Dashboard' },
  { href: '/app/movimientos', icon: '💸', label: 'Movimientos' },
  { href: '/app/reportes',    icon: '📄', label: 'Reportes' },
]

const NAV_ADMIN = [
  ...NAV_TESORERO,
  { href: '/app/admin', icon: '🏫', label: 'Administración' },
]

interface Props {
  usuario: Usuario | null
  cursosUsuario: CursoUsuario[]
}

export default function Sidebar({ usuario, cursosUsuario }: Props) {
  const pathname = usePathname()

  const isLector = usuario?.rol === 'apoderado_lector'
  const isAdmin  = usuario?.rol === 'superadmin'
  const navItems = isAdmin ? NAV_ADMIN : isLector ? NAV_LECTOR : NAV_TESORERO

  // Curso activo (primer curso del usuario)
  const cursoActivo = (cursosUsuario[0] as any)?.curso

  return (
    <aside className="w-56 flex flex-col bg-white border-r border-gray-200 h-full">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-gray-100">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-brand-light flex items-center justify-center text-lg">💰</div>
          <span className="text-xl font-black text-brand-600 tracking-tight">Tesorero</span>
        </div>
        {cursoActivo && (
          <div className="mt-2 text-xs text-gray-400 font-medium truncate">
            {cursoActivo.nombre} · {cursoActivo.anio_academico}
          </div>
        )}
      </div>

      {/* Navegación */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        <p className="text-[10px] font-bold text-gray-300 uppercase tracking-widest px-2 mb-2">Menú</p>
        {navItems.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={`sidebar-item ${pathname === item.href ? 'active' : ''}`}
          >
            <span className="text-base w-5 text-center">{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}

        {/* Selector de curso si tiene más de uno */}
        {cursosUsuario.length > 1 && (
          <>
            <div className="pt-4">
              <p className="text-[10px] font-bold text-gray-300 uppercase tracking-widest px-2 mb-2">Cursos</p>
              {cursosUsuario.map((cu: any) => (
                <Link
                  key={cu.curso_id}
                  href={`/app/dashboard?curso=${cu.curso_id}`}
                  className="sidebar-item text-xs"
                >
                  <span className="text-sm">🏫</span>
                  <span className="truncate">{cu.curso?.nombre}</span>
                </Link>
              ))}
            </div>
          </>
        )}
      </nav>

      {/* Footer usuario */}
      <div className="px-4 py-4 border-t border-gray-100">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-brand-light flex items-center justify-center text-xs font-bold text-brand-600 flex-shrink-0">
            {iniciales(usuario?.nombre_completo || 'U')}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate">{usuario?.nombre_completo}</div>
            <div className="text-xs text-gray-400 truncate">
              {usuario?.rol === 'superadmin' ? 'Superadmin' : usuario?.rol === 'apoderado_lector' ? 'Apoderado lector' : 'Tesorero'}
            </div>
          </div>
          <form action={logout}>
            <button type="submit" className="text-gray-300 hover:text-gray-500 transition-colors" title="Cerrar sesión">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
          </form>
        </div>
      </div>
    </aside>
  )
}
