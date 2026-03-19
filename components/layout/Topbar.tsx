'use client'
import { usePathname } from 'next/navigation'
import { iniciales } from '@/lib/utils/format'
import type { Usuario } from '@/lib/types'

const PAGE_TITLES: Record<string, string> = {
  '/app/dashboard':   'Dashboard',
  '/app/alumnos':     'Alumnos',
  '/app/cuotas':      'Cuotas',
  '/app/pagos':       'Pagos',
  '/app/movimientos': 'Movimientos',
  '/app/reportes':    'Reportes',
  '/app/config':      'Configuración',
  '/app/admin':       'Administración',
}

interface TopbarProps { usuario: Usuario | null }

export default function Topbar({ usuario }: TopbarProps) {
  const pathname = usePathname()
  const title = PAGE_TITLES[pathname] || 'Tesorero'
  const isLector = usuario?.rol === 'apoderado_lector'

  return (
    <header className="bg-white border-b border-gray-200 px-4 md:px-6 py-3 flex items-center justify-between gap-3 sticky top-0 z-40">
      <h1 className="text-base md:text-lg font-bold">{title}</h1>
      <div className="flex items-center gap-2">
        {isLector && (
          <span className="badge badge-gray hidden sm:inline-flex">Solo lectura</span>
        )}
        <div className="w-8 h-8 rounded-full bg-brand-light flex items-center justify-center text-xs font-bold text-brand-600">
          {iniciales(usuario?.nombre_completo || 'U')}
        </div>
      </div>
    </header>
  )
}
