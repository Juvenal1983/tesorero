import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AlumnosClient from './AlumnosClient'

export default async function AlumnosPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: cursoUsuario } = await supabase
    .from('curso_usuarios')
    .select('curso_id, rol_en_curso')
    .eq('usuario_id', user.id)
    .eq('activo', true)
    .single()

  if (!cursoUsuario) return <div className="text-gray-400 p-8">Sin curso asignado.</div>
  if (cursoUsuario.rol_en_curso === 'apoderado_lector') redirect('/app/dashboard')

  const { data: alumnos } = await supabase
    .from('alumnos')
    .select('*, apoderados(*)')
    .eq('curso_id', cursoUsuario.curso_id)
    .order('apellidos')

  return (
    <AlumnosClient
      alumnos={alumnos || []}
      cursoId={cursoUsuario.curso_id}
    />
  )
}
