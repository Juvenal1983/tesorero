import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import PagosClient from './PagosClient'

export default async function PagosPage({ searchParams }: { searchParams: { alumno?: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: cu } = await supabase
    .from('curso_usuarios')
    .select('curso_id, rol_en_curso')
    .eq('usuario_id', user.id)
    .eq('activo', true)
    .single()

  if (!cu) return <div className="text-gray-400 p-8">Sin curso asignado.</div>
  if (cu.rol_en_curso === 'apoderado_lector') redirect('/app/dashboard')

  const cursoId = cu.curso_id

  const [
    { data: alumnos },
    { data: cuotas },
    { data: pagos },
  ] = await Promise.all([
    supabase.from('alumnos').select('id, nombres, apellidos, estado').eq('curso_id', cursoId).eq('estado', 'activo').order('apellidos'),
    supabase.from('cuotas').select('*').eq('curso_id', cursoId).eq('activa', true),
    supabase.from('pagos').select('*').in(
      'alumno_id',
      (await supabase.from('alumnos').select('id').eq('curso_id', cursoId)).data?.map(a => a.id) || []
    ).eq('estado', 'pagado'),
  ])

  return (
    <PagosClient
      alumnos={alumnos || []}
      cuotas={cuotas || []}
      pagos={pagos || []}
      cursoId={cursoId}
      alumnoIdInicial={searchParams.alumno}
    />
  )
}
