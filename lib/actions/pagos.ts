'use server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import type { CreateCuotaDTO, CreatePagoDTO } from '@/lib/types'

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
    throw new Error('Sin permisos de tesorero')
  return user.id
}

// ─── CUOTAS ───────────────────────────────────────────────────────────

export async function getCuotas(cursoId: string) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('cuotas')
    .select('*')
    .eq('curso_id', cursoId)
    .eq('activa', true)
    .order('tipo_cuota')
  if (error) throw new Error(error.message)
  return data
}

export async function createCuota(cursoId: string, dto: CreateCuotaDTO) {
  const userId = await requireTesorero(cursoId)
  const supabase = createClient()
  const { data, error } = await supabase
    .from('cuotas')
    .insert({ ...dto, curso_id: cursoId, activa: true })
    .select()
    .single()
  if (error) throw new Error(error.message)
  await supabase.from('auditoria').insert({
    usuario_id: userId, accion: 'CREATE_CUOTA',
    tabla_afectada: 'cuotas', registro_id: data.id, datos_nuevos: dto,
  })
  revalidatePath('/app/cuotas')
  return data
}

export async function updateCuota(cuotaId: string, cursoId: string, dto: Partial<CreateCuotaDTO>) {
  await requireTesorero(cursoId)
  const supabase = createClient()
  const { error } = await supabase.from('cuotas').update(dto).eq('id', cuotaId)
  if (error) throw new Error(error.message)
  revalidatePath('/app/cuotas')
}

export async function deleteCuota(cuotaId: string, cursoId: string) {
  await requireTesorero(cursoId)
  const supabase = createClient()
  await supabase.from('pagos').delete().eq('cuota_id', cuotaId)
  const { error } = await supabase.from('cuotas').delete().eq('id', cuotaId)
  if (error) throw new Error(error.message)
  revalidatePath('/app/cuotas')
}

// ─── PAGOS ────────────────────────────────────────────────────────────

export async function getPagos(cursoId: string) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('pagos')
    .select(`*, cuota:cuotas!inner(*, curso_id), alumno:alumnos(nombres, apellidos)`)
    .eq('cuota.curso_id', cursoId)
    .order('fecha_pago', { ascending: false })
  if (error) throw new Error(error.message)
  return data
}

/** Resumen agregado — SIN nombres individuales. Seguro para cualquier rol. */
export async function getResumenPagos(cursoId: string) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('pagos')
    .select('monto_pagado, estado, fecha_pago, cuota:cuotas!inner(tipo_cuota, curso_id)')
    .eq('cuota.curso_id', cursoId)
    .eq('estado', 'pagado')
  if (error) throw new Error(error.message)
  return data
}

export async function createPago(cursoId: string, dto: CreatePagoDTO) {
  const userId = await requireTesorero(cursoId)
  const supabase = createClient()

  // Verificar que la cuota pertenece al curso
  const { data: cuota } = await supabase
    .from('cuotas').select('curso_id').eq('id', dto.cuota_id).single()
  if (!cuota || cuota.curso_id !== cursoId)
    throw new Error('Cuota no válida para este curso')

  const { data, error } = await supabase
    .from('pagos')
    .insert({ ...dto, estado: 'pagado', creado_por: userId })
    .select()
    .single()
  if (error) throw new Error(error.message)

  await supabase.from('auditoria').insert({
    usuario_id: userId, accion: 'CREATE_PAGO',
    tabla_afectada: 'pagos', registro_id: data.id, datos_nuevos: dto,
  })

  revalidatePath('/app/pagos')
  return data
}

export async function anularPago(pagoId: string, cursoId: string) {
  const userId = await requireTesorero(cursoId)
  const supabase = createClient()
  const { error } = await supabase
    .from('pagos')
    .update({ estado: 'anulado', updated_at: new Date().toISOString() })
    .eq('id', pagoId)
  if (error) throw new Error(error.message)
  await supabase.from('auditoria').insert({
    usuario_id: userId, accion: 'ANULAR_PAGO',
    tabla_afectada: 'pagos', registro_id: pagoId,
  })
  revalidatePath('/app/pagos')
}

export async function deletePago(pagoId: string, cursoId: string) {
  await requireTesorero(cursoId)
  const supabase = createClient()
  const { error } = await supabase.from('pagos').delete().eq('id', pagoId)
  if (error) throw new Error(error.message)
  revalidatePath('/app/pagos')
}

// ─── SUBIDA DE COMPROBANTES ───────────────────────────────────────────

export async function uploadComprobante(
  pagoId: string,
  cursoId: string,
  formData: FormData
): Promise<string> {
  await requireTesorero(cursoId)
  const supabase = createClient()
  const file = formData.get('file') as File
  if (!file) throw new Error('No se recibió archivo')

  const ext = file.name.split('.').pop()
  const path = `${cursoId}/${pagoId}.${ext}`

  const { error: upError } = await supabase.storage
    .from('comprobantes')
    .upload(path, file, { upsert: true })

  if (upError) throw new Error(upError.message)

  const { data: { publicUrl } } = supabase.storage
    .from('comprobantes')
    .getPublicUrl(path)

  await supabase.from('pagos')
    .update({ comprobante_url: publicUrl })
    .eq('id', pagoId)

  revalidatePath('/app/pagos')
  return publicUrl
}
