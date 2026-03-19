'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const ITEMS = [
  { href: '/app/dashboard',   icon: '📊', label: 'Dashboard' },
  { href: '/app/alumnos',     icon: '👥', label: 'Alumnos' },
  { href: '/app/pagos',       icon: '✅', label: 'Pagos' },
  { href: '/app/movimientos', icon: '💸', label: 'Movimientos' },
  { href: '/app/reportes',    icon: '📄', label: 'Reportes' },
]

export default function BottomNav() {
  const pathname = usePathname()
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-50 bottom-nav-safe">
      <div className="flex">
        {ITEMS.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] font-semibold transition-colors
              ${pathname === item.href ? 'text-brand-600' : 'text-gray-400'}`}
          >
            <span className="text-xl leading-none">{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
