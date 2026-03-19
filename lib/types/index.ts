// ─────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────
export type RolUsuario = 'superadmin' | 'tesorero' | 'apoderado_lector'
export type RolEnCurso = 'tesorero' | 'apoderado_lector' | 'colaborador'
export type EstadoAlumno = 'activo' | 'retirado' | 'suspendido'
export type TipoCuota = 'mensual' | 'anual' | 'extraordinaria'
export type EstadoPago = 'pagado' | 'anulado' | 'parcial'
export type TipoMovimiento = 'ingreso' | 'gasto'
export type MedioPago = 'Transferencia' | 'Efectivo' | 'Cheque' | 'Otro'

// ─────────────────────────────────────────────
// BASE DE DATOS
// ─────────────────────────────────────────────
export interface Usuario {
  id: string
  email: string
  nombre_completo: string
  rol: RolUsuario
  activo: boolean
  created_at: string
  updated_at: string
}

export interface Colegio {
  id: string
  nombre: string
  ciudad?: string
  region?: string
  activo: boolean
  created_at: string
}

export interface Curso {
  id: string
  colegio_id: string
  nombre: string
  anio_academico: number
  tesorero_id: string
  codigo_acceso: string
  cuota_mensual_clp: number
  cuota_anual_clp: number
  meta_anual_clp: number
  activo: boolean
  created_at: string
  updated_at: string
  // joins
  colegio?: Colegio
  tesorero?: Usuario
}

export interface CursoUsuario {
  id: string
  curso_id: string
  usuario_id: string
  rol_en_curso: RolEnCurso
  activo: boolean
  created_at: string
  // joins
  curso?: Curso
  usuario?: Usuario
}

export interface Alumno {
  id: string
  curso_id: string
  nombres: string
  apellidos: string
  estado: EstadoAlumno
  observaciones?: string
  created_at: string
  updated_at: string
  // joins
  apoderados?: Apoderado[]
}

export interface Apoderado {
  id: string
  alumno_id: string
  usuario_app_id?: string
  nombre_completo: string
  telefono?: string
  email?: string
  relacion?: string
  estado: 'activo' | 'inactivo'
  created_at: string
  updated_at: string
}

export interface Cuota {
  id: string
  curso_id: string
  tipo_cuota: TipoCuota
  nombre: string
  monto_clp: number
  fecha_vencimiento?: string
  periodo?: string
  anio: number
  activa: boolean
  observaciones?: string
  created_at: string
}

export interface Pago {
  id: string
  cuota_id: string
  alumno_id: string
  apoderado_id?: string
  monto_pagado: number
  periodo: string
  fecha_pago: string
  medio_pago: MedioPago
  estado: EstadoPago
  comprobante_url?: string
  observaciones?: string
  creado_por: string
  created_at: string
  updated_at: string
  // joins
  cuota?: Cuota
  alumno?: Alumno
}

export interface CategoriaMovimiento {
  id: string
  curso_id?: string
  nombre: string
  tipo: TipoMovimiento | 'ambos'
  activa: boolean
  orden: number
}

export interface MovimientoFinanciero {
  id: string
  curso_id: string
  tipo_movimiento: TipoMovimiento
  categoria_id?: string
  descripcion: string
  monto_clp: number
  fecha_movimiento: string
  responsable?: string
  observaciones?: string
  archivo_url?: string
  visible_para_apoderados: boolean
  creado_por: string
  created_at: string
  updated_at: string
  // joins
  categoria?: CategoriaMovimiento
}

export interface Auditoria {
  id: string
  usuario_id: string
  accion: string
  tabla_afectada: string
  registro_id?: string
  datos_anteriores?: Record<string, unknown>
  datos_nuevos?: Record<string, unknown>
  ip_address?: string
  created_at: string
}

// ─────────────────────────────────────────────
// DTOs / FORMULARIOS
// ─────────────────────────────────────────────
export interface CreateAlumnoDTO {
  nombres: string
  apellidos: string
  estado?: EstadoAlumno
  observaciones?: string
}

export interface CreateApoderadoDTO {
  nombre_completo: string
  telefono?: string
  email?: string
  relacion?: string
}

export interface CreateCuotaDTO {
  tipo_cuota: TipoCuota
  nombre: string
  monto_clp: number
  fecha_vencimiento?: string
  periodo?: string
  anio: number
  observaciones?: string
}

export interface CreatePagoDTO {
  cuota_id: string
  alumno_id: string
  apoderado_id?: string
  monto_pagado: number
  periodo: string
  fecha_pago: string
  medio_pago: MedioPago
  observaciones?: string
}

export interface CreateMovimientoDTO {
  tipo_movimiento: TipoMovimiento
  categoria_id?: string
  descripcion: string
  monto_clp: number
  fecha_movimiento: string
  responsable?: string
  observaciones?: string
  visible_para_apoderados?: boolean
}

// ─────────────────────────────────────────────
// RESÚMENES / CÁLCULOS
// ─────────────────────────────────────────────
export interface ResumenFinanciero {
  total_cuotas_cobradas: number
  total_ingresos_extra: number
  total_ingresos: number
  total_gastos: number
  saldo_disponible: number
  pagos_realizados: number
  pagos_esperados: number
  pct_cumplimiento: number
  total_alumnos: number
  proyeccion_anual: number
}

export interface ResumenAlumno {
  alumno: Alumno
  total_pagado: number
  pagos: Pago[]
  meses_pagados: string[]
  tiene_cuota_anual: boolean
  deuda_estimada: number
}

// ─────────────────────────────────────────────
// SESIÓN Y AUTENTICACIÓN
// ─────────────────────────────────────────────
export interface SesionUsuario {
  usuario: Usuario
  cursos: CursoUsuario[]
  cursoActivo?: Curso
  rolEnCurso?: RolEnCurso
}

export interface ContextoCurso {
  curso: Curso
  rolEnCurso: RolEnCurso
  esTesorero: boolean
  esLector: boolean
  esSuperadmin: boolean
}
