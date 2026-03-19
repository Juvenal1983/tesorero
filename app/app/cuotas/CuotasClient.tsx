'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createCuota, updateCuota, deleteCuota } from '@/lib/actions/pagos'
import Modal from '@/components/ui/Modal'
import { formatCLP, formatFecha } from '@/lib/utils/format'
import type { Cuota, TipoCuota } from '@/lib/types'

type CuotaConCount = Cuota & { pagos_count: number }

interface Props {
  cuotas: CuotaConCount[]
  cursoId: string
}

const TIPO_LABELS: Record<TipoCuota, string> = {
  mensual: 'Mensual',
  anual: 'Anual',
  extraordinaria: 'Extraordinaria',
}

const TIPO_BADGE: Record<TipoCuota, string> = {
  mensual: 'badge-blue',
  anual: 'badge-amber',
  extraordinaria: 'badge-green',
}

export default function CuotasClient({ cuotas: initial, cursoId }: Props) {
  const router = useRouter()
  const [modal, setModal] = useState<'add' | 'edit' | null>(null)
  const [sel, setSel] = useState<CuotaConCount | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Form fields
  const [fNombre, setFNombre]   = useState('')
  const [fTipo, setFTipo]       = useState<TipoCuota>('mensual')
  const [fMonto, setFMonto]     = useState('')
  const [fAnio, setFAnio]       = useState(String(new Date().getFullYear()))
  const [fPeriodo, setFPeriodo] = useState('')
  const [fVence, setFVence]     = useState('')
  const [fObs, setFObs]         = useState('')

  function openAdd() {
    setFNombre(''); setFTipo('mensual'); setFMonto(''); setFAnio(String(new Date().getFullYear()))
    setFPeriodo(''); setFVence(''); setFObs('')
    setError(''); setModal('add')
  }

  function openEdit(q: CuotaConCount) {
    setSel(q)
    setFNombre(q.nombre); setFTipo(q.tipo_cuota); setFMonto(String(q.monto_clp))
    setFAnio(String(q.anio)); setFPeriodo(q.periodo || ''); setFVence(q.fecha_vencimiento || '')
    setFObs(q.observaciones || '')
    setError(''); setModal('edit')
  }

  async function handleSave() {
    if (!fNombre.trim()) { setError('El nombre es requerido.'); return }
    const monto = parseInt(fMonto)
    if (!monto || monto <= 0) { setError('El monto debe ser mayor a 0.'); return }

    setLoading(true); setError('')
    try {
      const dto = {
        nombre: fNombre, tipo_cuota: fTipo, monto_clp: monto,
        anio: parseInt(fAnio) || new Date().getFullYear(),
        periodo: fPeriodo || undefined,
        fecha_vencimiento: fVence || undefined,
        observaciones: fObs || undefined,
      }
      if (modal === 'add') {
        await createCuota(cursoId, dto)
      } else if (sel) {
        await updateCuota(sel.id, cursoId, dto)
      }
      setModal(null); router.refresh()
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function handleDelete(q: CuotaConCount) {
    if (q.pagos_count > 0) {
      if (!confirm(`Esta cuota tiene ${q.pagos_count} pagos registrados. ¿Eliminarla de todas formas? Se eliminarán también los pagos.`)) return
    } else {
      if (!confirm('¿Eliminar esta cuota?')) return
    }
    try { await deleteCuota(q.id, cursoId); router.refresh() }
    catch (e: any) { alert(e.message) }
  }

  const byTipo = (tipo: TipoCuota) => initial.filter(q => q.tipo_cuota === tipo)

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-400">
          {initial.length} cuota{initial.length !== 1 ? 's' : ''} configurada{initial.length !== 1 ? 's' : ''}
        </div>
        <button className="btn btn-primary" onClick={openAdd}>+ Nueva cuota</button>
      </div>

      {initial.length === 0 ? (
        <div className="card">
          <div className="empty-state py-14">
            <div className="text-4xl mb-3">💳</div>
            <div className="font-semibold">Sin cuotas configuradas</div>
            <div className="text-sm text-gray-400 mt-1 mb-4">
              Crea las cuotas del curso para comenzar a registrar pagos
            </div>
            <button className="btn btn-primary" onClick={openAdd}>+ Crear primera cuota</button>
          </div>
        </div>
      ) : (
        <>
          {(['mensual', 'anual', 'extraordinaria'] as TipoCuota[]).map(tipo => {
            const lista = byTipo(tipo)
            if (lista.length === 0) return null
            return (
              <div key={tipo} className="card p-0 overflow-hidden">
                <div className="px-5 py-3.5 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                  <span className={`badge ${TIPO_BADGE[tipo]}`}>{TIPO_LABELS[tipo]}</span>
                  <span className="text-sm text-gray-400">{lista.length} cuota{lista.length !== 1 ? 's' : ''}</span>
                </div>
                <table className="data-table w-full">
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>Monto</th>
                      <th>Año</th>
                      <th>Vencimiento</th>
                      <th>Pagos</th>
                      <th>Estado</th>
                      <th className="text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lista.map(q => (
                      <tr key={q.id}>
                        <td>
                          <div className="font-semibold">{q.nombre}</div>
                          {q.observaciones && (
                            <div className="text-xs text-gray-400 mt-0.5">{q.observaciones}</div>
                          )}
                        </td>
                        <td>
                          <span className="font-bold text-brand-600">{formatCLP(q.monto_clp)}</span>
                        </td>
                        <td className="text-gray-500">{q.anio}</td>
                        <td className="text-gray-400 text-sm">
                          {q.fecha_vencimiento ? formatFecha(q.fecha_vencimiento) : '—'}
                        </td>
                        <td>
                          <span className={`badge ${q.pagos_count > 0 ? 'badge-green' : 'badge-gray'}`}>
                            {q.pagos_count} pago{q.pagos_count !== 1 ? 's' : ''}
                          </span>
                        </td>
                        <td>
                          <span className={`badge ${q.activa ? 'badge-green' : 'badge-gray'}`}>
                            {q.activa ? 'Activa' : 'Inactiva'}
                          </span>
                        </td>
                        <td>
                          <div className="flex items-center justify-end gap-1">
                            <button className="btn btn-sm btn-ghost" onClick={() => openEdit(q)}>✏️</button>
                            <button className="btn btn-sm btn-danger btn-ghost" onClick={() => handleDelete(q)}>🗑</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}
        </>
      )}

      {/* Tip informativo */}
      <div className="bg-info-light border border-info/20 rounded-lg px-4 py-3 text-sm text-info-600">
        <strong>💡 Tip:</strong> Crea una cuota mensual y una cuota anual para tener el control completo de pagos.
        Las cuotas extraordinarias son para cobros puntuales como paseos o eventos.
      </div>

      {/* Modal agregar/editar */}
      <Modal
        open={modal !== null}
        title={modal === 'add' ? 'Nueva cuota' : 'Editar cuota'}
        onClose={() => setModal(null)}
      >
        <div className="space-y-3 mb-4">
          {/* Selector de tipo */}
          <div className="form-group">
            <label className="form-label">Tipo de cuota</label>
            <div className="grid grid-cols-3 gap-2">
              {(['mensual', 'anual', 'extraordinaria'] as TipoCuota[]).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setFTipo(t)}
                  className={`py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    fTipo === t
                      ? 'bg-brand-600 text-white border-brand-600'
                      : 'border-gray-200 text-gray-500 hover:border-brand-400'
                  }`}
                >
                  {TIPO_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Nombre de la cuota *</label>
            <input
              className="form-input"
              value={fNombre}
              onChange={e => setFNombre(e.target.value)}
              placeholder={
                fTipo === 'mensual' ? 'Ej: Cuota mensual 2026' :
                fTipo === 'anual' ? 'Ej: Cuota anual 2026' :
                'Ej: Cuota paseo de fin de año'
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="form-group">
              <label className="form-label">Monto (CLP) *</label>
              <input
                className="form-input"
                type="number"
                min="1"
                value={fMonto}
                onChange={e => setFMonto(e.target.value)}
                placeholder="5000"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Año vigencia *</label>
              <input
                className="form-input"
                type="number"
                min="2020"
                max="2099"
                value={fAnio}
                onChange={e => setFAnio(e.target.value)}
              />
            </div>
          </div>

          {fTipo === 'extraordinaria' && (
            <div className="form-group">
              <label className="form-label">Período / Descripción</label>
              <input
                className="form-input"
                value={fPeriodo}
                onChange={e => setFPeriodo(e.target.value)}
                placeholder="Ej: Noviembre 2026"
              />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Fecha de vencimiento</label>
            <input
              className="form-input"
              type="date"
              value={fVence}
              onChange={e => setFVence(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Observaciones</label>
            <textarea
              className="form-input"
              value={fObs}
              onChange={e => setFObs(e.target.value)}
              placeholder="Ej: Vence el día 10 de cada mes"
              rows={2}
              style={{ resize: 'vertical' }}
            />
          </div>
        </div>

        {/* Preview del monto */}
        {fMonto && parseInt(fMonto) > 0 && (
          <div className="bg-brand-light rounded-lg px-4 py-3 mb-4 text-sm">
            <span className="text-brand-600 font-medium">Vista previa: </span>
            <span className="font-black text-brand-600 text-base">{formatCLP(parseInt(fMonto))}</span>
            {fTipo === 'mensual' && (
              <span className="text-brand-400 ml-2">
                · {formatCLP(parseInt(fMonto) * 12)} / año (12 meses)
              </span>
            )}
          </div>
        )}

        {error && (
          <div className="bg-danger-light text-danger-600 text-sm px-3 py-2 rounded-lg mb-3">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn" onClick={() => setModal(null)}>Cancelar</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
            {loading ? 'Guardando...' : modal === 'add' ? 'Crear cuota' : 'Guardar cambios'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
