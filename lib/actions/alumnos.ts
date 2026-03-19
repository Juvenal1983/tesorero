'use server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import type { CreateAlumnoDTO, CreateApoderadoDTO } from '@/lib/types'

async function getCursoIdAuthorized(cursoId: string) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('No autenticado')

  const { data, error } = await supabase
    .from('curso_usuarios')
    .select('rol_en_curso')
    .eq('curso_id', cursoId)
    .eq('usuario_id', user.id)
    .eq('activo', true)
    .single()

  if (error || !data) throw new Error('Sin acceso a este curso')
  if (data.rol_en_curso === 'apoderado_lector') throw new Error('Sin permisos de escritura')
  return user.id
}

// ─── ALUMNOS ──────────────────────────────────────────────────────────

export async function getAlumnos(cursoId: string) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('alumnos')
    .select(`*, apoderados(*)`)
    .eq('curso_id', cursoId)
    .order('apellidos')

  if (error) throw new Error(error.message)
  return data
}

export async function createAlumno(cursoId: string, dto: CreateAlumnoDTO) {
  const userId = await getCursoIdAuthorized(cursoId)
  const supabase = createClient()

  const { data, error } = await supabase
    .from('alumnos')
    .insert({ ...dto, curso_id: cursoId })
    .select()
    .single()

  if (error) throw new Error(error.message)

  await supabase.from('auditoria').insert({
    usuario_id: userId,
    accion: 'CREATE_ALUMNO',
    tabla_afectada: 'alumnos',
    registro_id: data.id,
    datos_nuevos: dto,
  })

  revalidatePath('/app/alumnos')
  return data
}

export async function updateAlumno(
  alumnoId: string,
  cursoId: string,
  dto: Partial<CreateAlumnoDTO>
) {
  const userId = await getCursoIdAuthorized(cursoId)
  const supabase = createClient()

  const { data: prev } = await supabase.from('alumnos').select().eq('id', alumnoId).single()

  const { error } = await supabase
    .from('alumnos')
    .update({ ...dto, updated_at: new Date().toISOString() })
    .eq('id', alumnoId)
    .eq('curso_id', cursoId)

  if (error) throw new Error(error.message)

  await supabase.from('auditoria').insert({
    usuario_id: userId,
    accion: 'UPDATE_ALUMNO',
    tabla_afectada: 'alumnos',
    registro_id: alumnoId,
    datos_anteriores: prev,
    datos_nuevos: dto,
  })

  revalidatePath('/app/alumnos')
}

export async function deleteAlumno(alumnoId: string, cursoId: string) {
  const userId = await getCursoIdAuthorized(cursoId)
  const supabase = createClient()

  // Primero eliminamos pagos asociados (cascade manual)
  await supabase.from('pagos').delete().eq('alumno_id', alumnoId)
  await supabase.from('apoderados').delete().eq('alumno_id', alumnoId)

  const { error } = await supabase
    .from('alumnos')
    .delete()
    .eq('id', alumnoId)
    .eq('curso_id', cursoId)

  if (error) throw new Error(error.message)

  await supabase.from('auditoria').insert({
    usuario_id: userId,
    accion: 'DELETE_ALUMNO',
    tabla_afectada: 'alumnos',
    registro_id: alumnoId,
  })

  revalidatePath('/app/alumnos')
}

// ─── APODERADOS ───────────────────────────────────────────────────────

export async function getApoderados(alumnoId: string) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('apoderados')
    .select('*')
    .eq('alumno_id', alumnoId)
    .eq('estado', 'activo')

  if (error) throw new Error(error.message)
  return data
}

export async function createApoderado(
  alumnoId: string,
  cursoId: string,
  dto: CreateApoderadoDTO
) {
  await getCursoIdAuthorized(cursoId)
  const supabase = createClient()

  const { data, error } = await supabase
    .from('apoderados')
    .insert({ ...dto, alumno_id: alumnoId, estado: 'activo' })
    .select()
    .single()

  if (error) throw new Error(error.message)
  revalidatePath('/app/alumnos')
  return data
}

export async function deleteApoderado(apoderadoId: string, cursoId: string) {
  await getCursoIdAuthorized(cursoId)
  const supabase = createClient()
  const { error } = await supabase.from('apoderados').delete().eq('id', apoderadoId)
  if (error) throw new Error(error.message)
  revalidatePath('/app/alumnos')
}
