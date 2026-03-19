import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { calcularResumenFinanciero, formatCLP, formatFecha, formatPct } from '@/lib/utils/format'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const cursoId = searchParams.get('curso')
  const formato = searchParams.get('formato') || 'json'

  if (!cursoId) {
    return NextResponse.json({ error: 'Parámetro curso requerido' }, { status: 400 })
  }

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 })
  }

  // Verificar acceso al curso
  const { data: cu } = await supabase
    .from('curso_usuarios')
    .select('rol_en_curso')
    .eq('curso_id', cursoId)
    .eq('usuario_id', user.id)
    .eq('activo', true)
    .single()

  if (!cu) {
    return NextResponse.json({ error: 'Sin acceso a este curso' }, { status: 403 })
  }

  const esLector = cu.rol_en_curso === 'apoderado_lector'

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

  if (formato === 'json') {
    return NextResponse.json({
      curso: {
        nombre: curso.nombre,
        anio: curso.anio_academico,
        colegio: (curso.colegio as any)?.nombre,
      },
      resumen,
      movimientos: movimientos?.map(m => ({
        descripcion: m.descripcion,
        tipo: m.tipo_movimiento,
        monto: m.monto_clp,
        fecha: formatFecha(m.fecha_movimiento),
        categoria: (m.categoria as any)?.nombre,
      })),
      // Los datos individuales NUNCA se exponen en la API pública
      ...(esLector ? {} : {
        alumnos_resumen: (alumnos || []).map(a => ({
          nombre: `${a.apellidos}, ${a.nombres}`,
          total_pagado: (pagos || [])
            .filter((p: any) => p.alumno_id === a.id)
            .reduce((s: number, p: any) => s + p.monto_pagado, 0),
        }))
      })
    })
  }

  return NextResponse.json({ error: 'Formato no soportado' }, { status: 400 })
}
