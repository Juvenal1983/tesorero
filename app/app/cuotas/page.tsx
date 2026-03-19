import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import CuotasClient from './CuotasClient'

export default async function CuotasPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: cu } = await supabase
    .from('curso_usuarios').select('curso_id, rol_en_curso')
    .eq('usuario_id', user.id).eq('activo', true).single()

  if (!cu) return <div className="text-gray-400 p-8">Sin curso asignado.</div>
  if (cu.rol_en_curso === 'apoderado_lector') redirect('/app/dashboard')

  const { data: cuotas } = await supabase
    .from('cuotas').select('*')
    .eq('curso_id', cu.curso_id)
    .order('tipo_cuota').order('anio')

  // Contar pagos por cuota para mostrar uso
  const { data: pagosCount } = await supabase
    .from('pagos').select('cuota_id')
    .in('cuota_id', (cuotas || []).map(q => q.id))
    .eq('estado', 'pagado')

  const countMap: Record<string, number> = {}
  ;(pagosCount || []).forEach((p: any) => {
    countMap[p.cuota_id] = (countMap[p.cuota_id] || 0) + 1
  })

  return (
    <CuotasClient
      cuotas={(cuotas || []).map(q => ({ ...q, pagos_count: countMap[q.id] || 0 }))}
      cursoId={cu.curso_id}
    />
  )
}
