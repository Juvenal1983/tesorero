import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AdminClient from './AdminClient'

export default async function AdminPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: perfil } = await supabase
    .from('usuarios').select('rol').eq('id', user.id).single()

  if (perfil?.rol !== 'superadmin') redirect('/app/dashboard')

  const [
    { data: colegios },
    { data: cursos },
    { data: usuarios },
  ] = await Promise.all([
    supabase.from('colegios').select('*').order('nombre'),
    supabase.from('cursos').select('*, colegio:colegios(nombre), tesorero:usuarios!tesorero_id(nombre_completo, email)').order('anio_academico', { ascending: false }),
    supabase.from('usuarios').select('*').order('nombre_completo'),
  ])

  return (
    <AdminClient
      colegios={colegios || []}
      cursos={cursos || []}
      usuarios={usuarios || []}
    />
  )
}
