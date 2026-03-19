import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import DashboardClient from './DashboardClient'
import { calcularResumenFinanciero, pagosPorMes, movimientosPorMes } from '@/lib/utils/format'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { curso?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  // Determinar cursoId activo
  const { data: cursosUsuario } = await supabase
    .from('curso_usuarios')
    .select('curso_id, rol_en_curso, curso:cursos(*)')
    .eq('usuario_id', user.id)
    .eq('activo', true)

  if (!cursosUsuario || cursosUsuario.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
        <div className="text-5xl mb-4">🏫</div>
        <h2 className="text-xl font-bold mb-2">Sin cursos asignados</h2>
        <p className="text-gray-400 text-sm">Contacta al administrador para que te asigne un curso.</p>
      </div>
    )
  }

  const cursoId = searchParams.curso || (cursosUsuario[0] as any).curso_id
  const cursoUsuario = cursosUsuario.find((cu: any) => cu.curso_id === cursoId) || cursosUsuario[0]
  const rolEnCurso = (cursoUsuario as any).rol_en_curso
  const esLector = rolEnCurso === 'apoderado_lector'
  const curso = (cursoUsuario as any).curso

  // Cargar datos del curso
  const [
    { data: alumnos },
    { data: cuotas },
    { data: pagos },
    { data: movimientos },
  ] = await Promise.all([
    supabase.from('alumnos').select('*').eq('curso_id', cursoId),
    supabase.from('cuotas').select('*').eq('curso_id', cursoId).eq('activa', true),
    supabase.from('pagos').select('*, cuota:cuotas!inner(curso_id, tipo_cuota)')
      .eq('cuota.curso_id', cursoId).eq('estado', 'pagado'),
    supabase.from('movimientos_financieros').select('*')
      .eq('curso_id', cursoId)
      .eq(esLector ? 'visible_para_apoderados' : 'curso_id', esLector ? true : cursoId),
  ])

  const resumen = calcularResumenFinanciero(
    pagos || [],
    movimientos || [],
    alumnos || [],
    cuotas || [],
    curso.cuota_mensual_clp || 0,
    curso.cuota_anual_clp || 0
  )

  const ingMes = pagosPorMes(pagos || [])
  const ingExtraMes = movimientosPorMes(movimientos || [], 'ingreso')
  const gasMes = movimientosPorMes(movimientos || [], 'gasto')
  const ingTotalMes = ingMes.map((v, i) => v + ingExtraMes[i])

  // Últimos movimientos (nunca con nombres si es lector)
  const ultimos = [
    ...(pagos || []).slice(-5).map((p: any) => ({
      id: p.id, tipo: 'cuota' as const,
      desc: esLector ? 'Cuota recaudada' : `Cuota ${p.periodo}`,
      monto: p.monto_pagado, fecha: p.fecha_pago,
    })),
    ...(movimientos || []).slice(-5).map((m: any) => ({
      id: m.id, tipo: m.tipo_movimiento as 'ingreso' | 'gasto',
      desc: m.descripcion, monto: m.monto_clp, fecha: m.fecha_movimiento,
    })),
  ].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()).slice(0, 7)

  return (
    <DashboardClient
      curso={curso}
      resumen={resumen}
      esLector={esLector}
      ingTotalMes={ingTotalMes}
      gasMes={gasMes}
      distribucion={{
        cuotasMen: pagos?.filter((p: any) => p.cuota?.tipo_cuota === 'mensual')
          .reduce((s: number, p: any) => s + p.monto_pagado, 0) || 0,
        cuotasAnu: pagos?.filter((p: any) => p.cuota?.tipo_cuota === 'anual')
          .reduce((s: number, p: any) => s + p.monto_pagado, 0) || 0,
        extras: resumen.total_ingresos_extra,
      }}
      ultimos={ultimos}
      totalAlumnos={alumnos?.length || 0}
    />
  )
}
