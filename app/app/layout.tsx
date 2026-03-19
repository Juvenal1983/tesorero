import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import Sidebar from '@/components/layout/Sidebar'
import BottomNav from '@/components/layout/BottomNav'
import Topbar from '@/components/layout/Topbar'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Los apoderados lectores acceden sin sesión Supabase (solo sessionStorage)
  // El middleware ya protege las rutas autenticadas
  if (!user) {
    redirect('/auth/login')
  }

  // Obtener datos del usuario
  const { data: usuario } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', user.id)
    .single()

  // Obtener cursos del usuario
  const { data: cursosUsuario } = await supabase
    .from('curso_usuarios')
    .select('*, curso:cursos(*, colegio:colegios(nombre))')
    .eq('usuario_id', user.id)
    .eq('activo', true)

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Sidebar — oculto en móvil */}
      <div className="hidden md:flex">
        <Sidebar
          usuario={usuario}
          cursosUsuario={cursosUsuario || []}
        />
      </div>

      {/* Contenido principal */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <Topbar usuario={usuario} />
        <main className="flex-1 overflow-y-auto pb-20 md:pb-0">
          <div className="p-4 md:p-6 max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>

      {/* Bottom nav — solo en móvil */}
      <div className="md:hidden">
        <BottomNav />
      </div>
    </div>
  )
}
