'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { generarCodigoCurso } from '@/lib/utils/format'

// ─── AUTH ─────────────────────────────────────────────────────────────

export async function login(email: string, password: string) {
  const supabase = createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error('Correo o contraseña incorrectos')
  revalidatePath('/', 'layout')
  redirect('/app/dashboard')
}

export async function logout() {
  const supabase = createClient()
  await supabase.auth.signOut()
  redirect('/auth/login')
}

export async function getUsuarioActual() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', user.id)
    .single()
  return data
}

// ─── ACCESO POR CÓDIGO ─────────────────────────────────────────────────

/**
 * Verifica un código de curso y devuelve el curso correspondiente.
 * Los apoderados lectores NO se crean como usuarios en Supabase Auth,
 * usan una sesión de solo lectura por cookie.
 */
export async function verificarCodigoCurso(codigo: string) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('cursos')
    .select('*, colegio:colegios(nombre)')
    .eq('codigo_acceso', codigo.trim().toUpperCase())
    .eq('activo', true)
    .single()
  if (error || !data) throw new Error('Código de curso inválido o curso no encontrado')
  return data
}

// ─── CURSOS ───────────────────────────────────────────────────────────

export async function getMisCursos() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []
  const { data, error } = await supabase
    .from('curso_usuarios')
    .select('*, curso:cursos(*, colegio:colegios(nombre))')
    .eq('usuario_id', user.id)
    .eq('activo', true)
  if (error) return []
  return data
}

export async function getCurso(cursoId: string) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('cursos')
    .select('*, colegio:colegios(nombre), tesorero:usuarios!tesorero_id(nombre_completo, email)')
    .eq('id', cursoId)
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function createCurso(formData: {
  colegio_nombre: string
  nombre: string
  anio_academico: number
  cuota_mensual_clp: number
  cuota_anual_clp: number
  meta_anual_clp?: number
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('No autenticado')

  // Crear o buscar colegio
  let colegioId: string
  const { data: colegioExistente } = await supabase
    .from('colegios')
    .select('id')
    .ilike('nombre', formData.colegio_nombre)
    .single()

  if (colegioExistente) {
    colegioId = colegioExistente.id
  } else {
    const { data: nuevoColegio, error: errCol } = await supabase
      .from('colegios')
      .insert({ nombre: formData.colegio_nombre, activo: true })
      .select()
      .single()
    if (errCol) throw new Error(errCol.message)
    colegioId = nuevoColegio.id
  }

  const codigo = generarCodigoCurso(formData.nombre, formData.anio_academico)

  const { data: curso, error } = await supabase
    .from('cursos')
    .insert({
      colegio_id: colegioId,
      nombre: formData.nombre,
      anio_academico: formData.anio_academico,
      tesorero_id: user.id,
      codigo_acceso: codigo,
      cuota_mensual_clp: formData.cuota_mensual_clp,
      cuota_anual_clp: formData.cuota_anual_clp,
      meta_anual_clp: formData.meta_anual_clp || 0,
      activo: true,
    })
    .select()
    .single()

  if (error) throw new Error(error.message)

  // Vincular al creador como tesorero
  await supabase.from('curso_usuarios').insert({
    curso_id: curso.id,
    usuario_id: user.id,
    rol_en_curso: 'tesorero',
    activo: true,
  })

  revalidatePath('/app')
  return curso
}

export async function updateCurso(
  cursoId: string,
  dto: Partial<{ nombre: string; cuota_mensual_clp: number; cuota_anual_clp: number; meta_anual_clp: number }>
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('No autenticado')

  const { error } = await supabase
    .from('cursos')
    .update({ ...dto, updated_at: new Date().toISOString() })
    .eq('id', cursoId)
    .eq('tesorero_id', user.id)  // Solo el tesorero puede editar su curso

  if (error) throw new Error(error.message)
  revalidatePath('/app/config')
}

export async function regenerarCodigo(cursoId: string) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('No autenticado')

  const { data: curso } = await supabase
    .from('cursos').select('nombre, anio_academico').eq('id', cursoId).single()
  if (!curso) throw new Error('Curso no encontrado')

  const nuevoCodigo = generarCodigoCurso(curso.nombre, curso.anio_academico)

  const { error } = await supabase
    .from('cursos')
    .update({ codigo_acceso: nuevoCodigo })
    .eq('id', cursoId)
    .eq('tesorero_id', user.id)

  if (error) throw new Error(error.message)
  revalidatePath('/app/config')
  return nuevoCodigo
}
