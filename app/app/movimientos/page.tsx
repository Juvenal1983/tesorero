import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MovimientosClient from './MovimientosClient'

export default async function MovimientosPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: cu } = await supabase
    .from('curso_usuarios').select('curso_id, rol_en_curso')
    .eq('usuario_id', user.id).eq('activo', true).single()
  if (!cu) return <div className="text-gray-400 p-8">Sin curso asignado.</div>

  const esLector = cu.rol_en_curso === 'apoderado_lector'

  let query = supabase
    .from('movimientos_financieros')
    .select('*, categoria:categorias_movimientos(nombre)')
    .eq('curso_id', cu.curso_id)
    .order('fecha_movimiento', { ascending: false })

  if (esLector) query = query.eq('visible_para_apoderados', true)

  const [{ data: movimientos }, { data: categorias }] = await Promise.all([
    query,
    supabase.from('categorias_movimientos').select('*')
      .or(`curso_id.is.null,curso_id.eq.${cu.curso_id}`)
      .eq('activa', true).order('orden'),
  ])

  return (
    <MovimientosClient
      movimientos={movimientos || []}
      categorias={categorias || []}
      cursoId={cu.curso_id}
      esLector={esLector}
    />
  )
}
