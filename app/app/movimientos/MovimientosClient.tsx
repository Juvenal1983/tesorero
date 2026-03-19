'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createMovimiento, deleteMovimiento } from '@/lib/actions/movimientos'
import Modal from '@/components/ui/Modal'
import { formatCLP, hoyISO, formatFecha } from '@/lib/utils/format'
import type { MovimientoFinanciero, CategoriaMovimiento } from '@/lib/types'

interface Props {
  movimientos: (MovimientoFinanciero & { categoria?: { nombre: string } })[]
  categorias: CategoriaMovimiento[]
  cursoId: string
  esLector: boolean
}

export default function MovimientosClient({ movimientos, categorias, cursoId, esLector }: Props) {
  const router = useRouter()
  const [modal, setModal] = useState(false)
  const [filtro, setFiltro] = useState<'todos' | 'ingreso' | 'gasto'>('todos')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [fTipo, setFTipo] = useState<'ingreso' | 'gasto'>('ingreso')
  const [fDesc, setFDesc] = useState('')
  const [fMonto, setFMonto] = useState('')
  const [fCat, setFCat] = useState(categorias[0]?.id || '')
  const [fFecha, setFFecha] = useState(hoyISO())
  const [fResp, setFResp] = useState('')
  const [fVisible, setFVisible] = useState(true)
  const [fObs, setFObs] = useState('')

  const lista = filtro === 'todos' ? movimientos : movimientos.filter(m => m.tipo_movimiento === filtro)
  const totIng = movimientos.filter(m => m.tipo_movimiento === 'ingreso').reduce((s, m) => s + m.monto_clp, 0)
  const totGas = movimientos.filter(m => m.tipo_movimiento === 'gasto').reduce((s, m) => s + m.monto_clp, 0)

  async function handleSave() {
    if (!fDesc.trim() || !fMonto || isNaN(Number(fMonto))) {
      setError('Descripción y monto son requeridos.'); return
    }
    setLoading(true); setError('')
    try {
      await createMovimiento(cursoId, {
        tipo_movimiento: fTipo,
        descripcion: fDesc,
        monto_clp: parseInt(fMonto),
        categoria_id: fCat || undefined,
        fecha_movimiento: fFecha,
        responsable: fResp,
        visible_para_apoderados: fVisible,
        observaciones: fObs,
      })
      setModal(false); setFDesc(''); setFMonto(''); setFObs(''); setFResp('')
      router.refresh()
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Eliminar este movimiento?')) return
    try { await deleteMovimiento(id, cursoId); router.refresh() }
    catch (e: any) { alert(e.message) }
  }

  return (
    <div className="space-y-4">
      {/* Banner lector */}
      {esLector && (
        <div className="bg-info-light border border-info/20 text-info-600 rounded-lg px-4 py-3 text-sm font-medium">
          👁️ Solo se muestran los movimientos marcados como públicos por el tesorero.
        </div>
      )}

      {/* Métricas */}
      <div className="grid grid-cols-3 gap-3">
        <div className="metric-card">
          <div className="metric-label">Ingresos extra</div>
          <div className="metric-value text-brand-600">{formatCLP(totIng)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Gastos</div>
          <div className="metric-value text-danger">{formatCLP(totGas)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Balance</div>
          <div className={`metric-value ${totIng - totGas >= 0 ? 'text-info' : 'text-danger'}`}>
            {formatCLP(totIng - totGas)}
          </div>
        </div>
      </div>

      {/* Header con filtros */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {(['todos', 'ingreso', 'gasto'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFiltro(f)}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold transition-colors ${
                filtro === f ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400'
              }`}
            >
              {f === 'todos' ? 'Todos' : f === 'ingreso' ? '↑ Ingresos' : '↓ Gastos'}
            </button>
          ))}
        </div>
        {!esLector && (
          <button className="btn btn-primary" onClick={() => setModal(true)}>+ Nuevo movimiento</button>
        )}
      </div>

      {/* Tabla */}
      <div className="card p-0 overflow-hidden">
        {lista.length === 0 ? (
          <div className="empty-state py-12">
            <div className="text-4xl mb-3">💸</div>
            <div>Sin movimientos registrados</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Descripción</th>
                  <th>Tipo</th>
                  <th>Categoría</th>
                  <th>Monto</th>
                  <th>Fecha</th>
                  {!esLector && <th>Visible</th>}
                  {!esLector && <th />}
                </tr>
              </thead>
              <tbody>
                {lista.map(m => (
                  <tr key={m.id}>
                    <td>
                      <div className="font-medium">{m.descripcion}</div>
                      {m.responsable && <div className="text-xs text-gray-400">{m.responsable}</div>}
                    </td>
                    <td>
                      <span className={`badge ${m.tipo_movimiento === 'ingreso' ? 'badge-green' : 'badge-red'}`}>
                        {m.tipo_movimiento === 'ingreso' ? '↑ Ingreso' : '↓ Gasto'}
                      </span>
                    </td>
                    <td>
                      {m.categoria ? (
                        <span className="badge badge-gray">{m.categoria.nombre}</span>
                      ) : '—'}
                    </td>
                    <td>
                      <span className={`font-bold ${m.tipo_movimiento === 'ingreso' ? 'text-brand-600' : 'text-danger'}`}>
                        {m.tipo_movimiento === 'gasto' ? '-' : '+'}{formatCLP(m.monto_clp)}
                      </span>
                    </td>
                    <td className="text-gray-400">{formatFecha(m.fecha_movimiento)}</td>
                    {!esLector && (
                      <td>
                        <span className={`badge ${m.visible_para_apoderados ? 'badge-green' : 'badge-gray'}`}>
                          {m.visible_para_apoderados ? 'Público' : 'Privado'}
                        </span>
                      </td>
                    )}
                    {!esLector && (
                      <td>
                        <button className="btn btn-sm btn-danger btn-ghost" onClick={() => handleDelete(m.id)}>🗑</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal nuevo movimiento */}
      <Modal open={modal} title="Nuevo movimiento" onClose={() => setModal(false)}>
        <div className="flex gap-2 mb-4">
          {(['ingreso', 'gasto'] as const).map(t => (
            <button
              key={t}
              onClick={() => setFTipo(t)}
              className={`flex-1 py-2 rounded-lg text-sm font-bold border transition-colors ${
                fTipo === t
                  ? t === 'ingreso' ? 'bg-brand-600 text-white border-brand-600' : 'bg-danger text-white border-danger'
                  : 'border-gray-200 text-gray-500'
              }`}
            >
              {t === 'ingreso' ? '↑ Ingreso' : '↓ Gasto'}
            </button>
          ))}
        </div>

        <div className="space-y-3 mb-4">
          <div className="form-group">
            <label className="form-label">Descripción *</label>
            <input className="form-input" value={fDesc} onChange={e => setFDesc(e.target.value)} placeholder="Ej: Rifa de chocolates" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="form-group">
              <label className="form-label">Monto CLP *</label>
              <input className="form-input" type="number" value={fMonto} onChange={e => setFMonto(e.target.value)} placeholder="0" />
            </div>
            <div className="form-group">
              <label className="form-label">Fecha</label>
              <input className="form-input" type="date" value={fFecha} onChange={e => setFFecha(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Categoría</label>
              <select className="form-input" value={fCat} onChange={e => setFCat(e.target.value)}>
                <option value="">Sin categoría</option>
                {categorias.filter(c => c.tipo === fTipo || c.tipo === 'ambos').map(c => (
                  <option key={c.id} value={c.id}>{c.nombre}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Responsable</label>
              <input className="form-input" value={fResp} onChange={e => setFResp(e.target.value)} placeholder="Nombre" />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Observaciones</label>
            <input className="form-input" value={fObs} onChange={e => setFObs(e.target.value)} placeholder="Opcional..." />
          </div>
          <div className="form-group">
            <label className="form-label">Visibilidad para apoderados</label>
            <select className="form-input" value={fVisible ? 'true' : 'false'} onChange={e => setFVisible(e.target.value === 'true')}>
              <option value="true">Público — visible para apoderados lectores</option>
              <option value="false">Privado — solo visible para el tesorero</option>
            </select>
          </div>
        </div>

        {error && <div className="bg-danger-light text-danger-600 text-sm px-3 py-2 rounded-lg mb-3">{error}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={() => setModal(false)}>Cancelar</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
            {loading ? 'Guardando...' : 'Guardar movimiento'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
