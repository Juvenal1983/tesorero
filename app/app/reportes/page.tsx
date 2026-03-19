import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ReportesClient from './ReportesClient'
import { calcularResumenFinanciero } from '@/lib/utils/format'

export default async function ReportesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: cu } = await supabase
    .from('curso_usuarios').select('curso_id, rol_en_curso')
    .eq('usuario_id', user.id).eq('activo', true).single()
  if (!cu) return <div className="text-gray-400 p-8">Sin curso asignado.</div>

  const esLector = cu.rol_en_curso === 'apoderado_lector'
  const cursoId = cu.curso_id

  const [
    { data: curso },
    { data: alumnos },
    { data: cuotas },
    { data: pagos },
    { data: movimientos },
  ] = await Promise.all([
    supabase.from('cursos').select('*, colegio:colegios(nombre)').eq('id', cursoId).single(),
    supabase.from('alumnos').select('*').eq('curso_id', cursoId),
    supabase.from('cuotas').select('*').eq('curso_id', cursoId).eq('activa', true),
    supabase.from('pagos').select('*, cuota:cuotas!inner(curso_id, tipo_cuota)')
      .eq('cuota.curso_id', cursoId).eq('estado', 'pagado'),
    supabase.from('movimientos_financieros').select('*, categoria:categorias_movimientos(nombre)')
      .eq('curso_id', cursoId)
      .eq(esLector ? 'visible_para_apoderados' : 'curso_id', esLector ? true : cursoId),
  ])

  const resumen = calcularResumenFinanciero(
    pagos || [], movimientos || [], alumnos || [], cuotas || [],
    curso.cuota_mensual_clp || 0, curso.cuota_anual_clp || 0
  )

  const resumenAlumnos = esLector ? [] : (alumnos || []).filter(a => a.estado === 'activo').map(a => {
    const ps = (pagos || []).filter((p: any) => p.alumno_id === a.id)
    return {
      alumno: a,
      total_pagado: ps.reduce((s: number, p: any) => s + p.monto_pagado, 0),
      pagos_count: ps.length,
      tiene_anual: ps.some((p: any) => p.cuota?.tipo_cuota === 'anual'),
    }
  })

  return (
    <ReportesClient
      curso={curso}
      resumen={resumen}
      movimientos={movimientos || []}
      resumenAlumnos={resumenAlumnos}
      esLector={esLector}
    />
  )
}
