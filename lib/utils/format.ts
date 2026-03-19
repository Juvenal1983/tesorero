import { format, parseISO, isValid } from 'date-fns'
import { es } from 'date-fns/locale'

// ─────────────────────────────────────────────
// MONEDA CLP
// ─────────────────────────────────────────────

/**
 * Formatea un número como moneda CLP chilena.
 * Ej: 25000 → "$25.000"
 */
export function formatCLP(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '$0'
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(amount))
}

/**
 * Formatea CLP compacto para gráficos. Ej: 25000 → "$25k"
 */
export function formatCLPCompact(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}k`
  return `$${Math.round(amount)}`
}

/**
 * Parsea un string de CLP a número. Ej: "$25.000" → 25000
 */
export function parseCLP(value: string): number {
  return parseInt(value.replace(/[^0-9]/g, ''), 10) || 0
}

// ─────────────────────────────────────────────
// FECHAS
// ─────────────────────────────────────────────

/**
 * Formatea una fecha ISO a formato chileno. Ej: "2026-03-15" → "15/03/2026"
 */
export function formatFecha(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  try {
    const date = parseISO(dateStr)
    if (!isValid(date)) return dateStr
    return format(date, 'dd/MM/yyyy', { locale: es })
  } catch {
    return dateStr
  }
}

/**
 * Formatea fecha larga. Ej: "15 de marzo de 2026"
 */
export function formatFechaLarga(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "d 'de' MMMM 'de' yyyy", { locale: es })
  } catch {
    return dateStr
  }
}

/**
 * Fecha de hoy en formato ISO (YYYY-MM-DD)
 */
export function hoyISO(): string {
  return new Date().toISOString().split('T')[0]
}

// ─────────────────────────────────────────────
// MESES EN ESPAÑOL
// ─────────────────────────────────────────────
export const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

export const MESES_CORTOS = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
]

/**
 * Devuelve el índice (0-11) de un mes por nombre
 */
export function mesAIndice(mes: string): number {
  return MESES.findIndex(m => m.toLowerCase() === mes.toLowerCase())
}

// ─────────────────────────────────────────────
// PORCENTAJES
// ─────────────────────────────────────────────
export function formatPct(value: number): string {
  return `${Math.round(value)}%`
}

/**
 * Color semáforo según porcentaje
 */
export function colorPorcentaje(pct: number): string {
  if (pct >= 75) return '#0F6E56'
  if (pct >= 40) return '#EF9F27'
  return '#E24B4A'
}

// ─────────────────────────────────────────────
// CÓDIGO ÚNICO DE CURSO
// ─────────────────────────────────────────────

/**
 * Genera un código único para el curso.
 * Ej: curso="5° Básico A", anio=2026 → "5BA-2026-MK7X"
 */
export function generarCodigoCurso(nombreCurso: string, anio: number): string {
  const prefix = nombreCurso
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase()
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `${prefix}-${anio}-${rand}`
}

// ─────────────────────────────────────────────
// INICIALES
// ─────────────────────────────────────────────
export function iniciales(nombre: string): string {
  return (nombre || '?')
    .split(' ')
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() || '')
    .join('')
}

// ─────────────────────────────────────────────
// CÁLCULOS FINANCIEROS
// ─────────────────────────────────────────────
import type { Pago, MovimientoFinanciero, Alumno, Cuota, ResumenFinanciero } from '@/lib/types'

export function calcularResumenFinanciero(
  pagos: Pago[],
  movimientos: MovimientoFinanciero[],
  alumnos: Alumno[],
  cuotas: Cuota[],
  cuotaMensual: number,
  cuotaAnual: number
): ResumenFinanciero {
  const pagosValidos = pagos.filter(p => p.estado === 'pagado')
  const total_cuotas_cobradas = pagosValidos.reduce((s, p) => s + p.monto_pagado, 0)
  const total_ingresos_extra = movimientos
    .filter(m => m.tipo_movimiento === 'ingreso')
    .reduce((s, m) => s + m.monto_clp, 0)
  const total_gastos = movimientos
    .filter(m => m.tipo_movimiento === 'gasto')
    .reduce((s, m) => s + m.monto_clp, 0)
  const total_ingresos = total_cuotas_cobradas + total_ingresos_extra
  const saldo_disponible = total_ingresos - total_gastos

  const alumnosActivos = alumnos.filter(a => a.estado === 'activo')
  const cuotaMen = cuotas.find(q => q.tipo_cuota === 'mensual')
  const pagos_realizados = cuotaMen
    ? pagosValidos.filter(p => p.cuota_id === cuotaMen.id).length
    : 0
  const pagos_esperados = alumnosActivos.length * 12
  const pct_cumplimiento = pagos_esperados > 0
    ? Math.min(100, Math.round((pagos_realizados / pagos_esperados) * 100))
    : 0

  const proyeccion_anual =
    (alumnosActivos.length * cuotaMensual * 12) +
    (alumnosActivos.length * cuotaAnual)

  return {
    total_cuotas_cobradas,
    total_ingresos_extra,
    total_ingresos,
    total_gastos,
    saldo_disponible,
    pagos_realizados,
    pagos_esperados,
    pct_cumplimiento,
    total_alumnos: alumnosActivos.length,
    proyeccion_anual,
  }
}

/**
 * Agrupa pagos por mes para gráficos (array de 12 valores)
 */
export function pagosPorMes(pagos: Pago[]): number[] {
  const result = Array(12).fill(0)
  pagos
    .filter(p => p.estado === 'pagado')
    .forEach(p => {
      const m = parseInt(p.fecha_pago?.split('-')[1] || '0', 10)
      if (m >= 1 && m <= 12) result[m - 1] += p.monto_pagado
    })
  return result
}

/**
 * Agrupa movimientos por mes para gráficos
 */
export function movimientosPorMes(
  movimientos: MovimientoFinanciero[],
  tipo: 'ingreso' | 'gasto'
): number[] {
  const result = Array(12).fill(0)
  movimientos
    .filter(m => m.tipo_movimiento === tipo)
    .forEach(m => {
      const mo = parseInt(m.fecha_movimiento?.split('-')[1] || '0', 10)
      if (mo >= 1 && mo <= 12) result[mo - 1] += m.monto_clp
    })
  return result
}
