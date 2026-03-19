'use server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import type { CreateMovimientoDTO } from '@/lib/types'

async function requireTesorero(cursoId: string) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('No autenticado')
  const { data } = await supabase
    .from('curso_usuarios')
    .select('rol_en_curso')
    .eq('curso_id', cursoId)
    .eq('usuario_id', user.id)
    .eq('activo', true)
    .single()
  if (!data || data.rol_en_curso === 'apoderado_lector')
    throw new Error('Sin permisos')
  return user.id
}

export async function getMovimientos(cursoId: string, soloPublicos = false) {
  const supabase = createClient()
  let query = supabase
    .from('movimientos_financieros')
    .select('*, categoria:categorias_movimientos(nombre, tipo)')
    .eq('curso_id', cursoId)
    .order('fecha_movimiento', { ascending: false })

  if (soloPublicos) query = query.eq('visible_para_apoderados', true)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data
}

export async function createMovimiento(cursoId: string, dto: CreateMovimientoDTO) {
  const userId = await requireTesorero(cursoId)
  const supabase = createClient()
  const { data, error } = await supabase
    .from('movimientos_financieros')
    .insert({
      ...dto,
      curso_id: cursoId,
      creado_por: userId,
      visible_para_apoderados: dto.visible_para_apoderados ?? true,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  await supabase.from('auditoria').insert({
    usuario_id: userId, accion: 'CREATE_MOVIMIENTO',
    tabla_afectada: 'movimientos_financieros', registro_id: data.id, datos_nuevos: dto,
  })
  revalidatePath('/app/movimientos')
  return data
}

export async function updateMovimiento(
  movId: string,
  cursoId: string,
  dto: Partial<CreateMovimientoDTO>
) {
  await requireTesorero(cursoId)
  const supabase = createClient()
  const { error } = await supabase
    .from('movimientos_financieros')
    .update({ ...dto, updated_at: new Date().toISOString() })
    .eq('id', movId)
    .eq('curso_id', cursoId)
  if (error) throw new Error(error.message)
  revalidatePath('/app/movimientos')
}

export async function deleteMovimiento(movId: string, cursoId: string) {
  await requireTesorero(cursoId)
  const supabase = createClient()
  const { error } = await supabase
    .from('movimientos_financieros')
    .delete()
    .eq('id', movId)
    .eq('curso_id', cursoId)
  if (error) throw new Error(error.message)
  revalidatePath('/app/movimientos')
}

export async function getCategorias(cursoId?: string) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('categorias_movimientos')
    .select('*')
    .or(cursoId ? `curso_id.is.null,curso_id.eq.${cursoId}` : 'curso_id.is.null')
    .eq('activa', true)
    .order('orden')
  if (error) throw new Error(error.message)
  return data
}
