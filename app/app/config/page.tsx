import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ConfigClient from './ConfigClient'

export default async function ConfigPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: cu } = await supabase
    .from('curso_usuarios').select('curso_id, rol_en_curso')
    .eq('usuario_id', user.id).eq('activo', true).single()
  if (!cu) return <div className="text-gray-400 p-8">Sin curso asignado.</div>
  if (cu.rol_en_curso === 'apoderado_lector') redirect('/app/dashboard')

  const { data: curso } = await supabase
    .from('cursos').select('*, colegio:colegios(nombre)')
    .eq('id', cu.curso_id).single()

  return <ConfigClient curso={curso} />
}
