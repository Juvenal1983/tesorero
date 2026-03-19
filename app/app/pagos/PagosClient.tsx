'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createPago, anularPago } from '@/lib/actions/pagos'
import Modal from '@/components/ui/Modal'
import { formatCLP, hoyISO, MESES } from '@/lib/utils/format'
import type { Alumno, Cuota, Pago } from '@/lib/types'

interface Props {
  alumnos: Pick<Alumno, 'id' | 'nombres' | 'apellidos' | 'estado'>[]
  cuotas: Cuota[]
  pagos: Pago[]
  cursoId: string
  alumnoIdInicial?: string
}

export default function PagosClient({ alumnos, cuotas, pagos, cursoId, alumnoIdInicial }: Props) {
  const router = useRouter()
  const [aluId, setAluId] = useState(alumnoIdInicial || alumnos[0]?.id || '')
  const [modal, setModal] = useState(false)
  const [fCuotaId, setFCuotaId] = useState(cuotas[0]?.id || '')
  const [fPeriodo, setFPeriodo] = useState(MESES[new Date().getMonth()])
  const [fMonto, setFMonto] = useState('')
  const [fFecha, setFFecha] = useState(hoyISO())
  const [fMedio, setFMedio] = useState('Transferencia')
  const [fObs, setFObs] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const alu = alumnos.find(a => a.id === aluId)
  const cuotaMen = cuotas.find(q => q.tipo_cuota === 'mensual')
  const cuotaAnu = cuotas.find(q => q.tipo_cuota === 'anual')
  const pagosAlu = pagos.filter(p => p.alumno_id === aluId)
  const totalPagado = pagosAlu.reduce((s, p) => s + p.monto_pagado, 0)

  function getPago(cuotaId: string, periodo: string) {
    return pagosAlu.find(p => p.cuota_id === cuotaId && p.periodo === periodo)
  }

  function openModal(cuotaId: string, periodo: string) {
    const cuota = cuotas.find(q => q.id === cuotaId)
    setFCuotaId(cuotaId)
    setFPeriodo(periodo)
    setFMonto(String(cuota?.monto_clp || ''))
    setFObs('')
    setError('')
    setModal(true)
  }

  async function handlePago() {
    if (!fMonto || isNaN(Number(fMonto))) { setError('Ingresa un monto válido.'); return }
    setLoading(true); setError('')
    try {
      await createPago(cursoId, {
        cuota_id: fCuotaId,
        alumno_id: aluId,
        monto_pagado: parseInt(fMonto),
        periodo: fPeriodo,
        fecha_pago: fFecha,
        medio_pago: fMedio as any,
        observaciones: fObs,
      })
      setModal(false)
      router.refresh()
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function handleAnular(pagoId: string) {
    if (!confirm('¿Anular este pago?')) return
    try { await anularPago(pagoId, cursoId); router.refresh() }
    catch (e: any) { alert(e.message) }
  }

  return (
    <div className="space-y-4">
      {/* Selector de alumno */}
      <div className="card p-3">
        <div className="text-xs text-gray-400 font-semibold mb-2 uppercase tracking-wide">Seleccionar alumno</div>
        <div className="flex flex-wrap gap-2">
          {alumnos.map(a => (
            <button
              key={a.id}
              onClick={() => setAluId(a.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold border transition-colors ${
                aluId === a.id
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'bg-white border-gray-200 text-gray-600 hover:border-brand-400'
              }`}
            >
              {a.apellidos.split(' ')[0]}, {a.nombres.split(' ')[0]}
            </button>
          ))}
        </div>
      </div>

      {alu && (
        <>
          {/* Resumen del alumno */}
          <div className="card py-3 flex items-center gap-6">
            <div>
              <div className="text-lg font-black">{alu.nombres} {alu.apellidos}</div>
            </div>
            <div className="ml-auto">
              <div className="text-xs text-gray-400">Total pagado</div>
              <div className="text-xl font-black text-brand-600">{formatCLP(totalPagado)}</div>
            </div>
          </div>

          {/* Cuota mensual */}
          {cuotaMen && (
            <div className="card p-0 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                <div className="text-sm font-bold">
                  {cuotaMen.nombre}
                  <span className="badge badge-blue ml-2">mensual</span>
                </div>
                <span className="text-sm font-bold text-brand-600">{formatCLP(cuotaMen.monto_clp)}</span>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-0 divide-x divide-y divide-gray-50">
                {MESES.map(mes => {
                  const pago = getPago(cuotaMen.id, mes)
                  return (
                    <div key={mes} className="flex flex-col items-center p-3 gap-1.5">
                      <div className="text-xs font-semibold text-gray-500">{mes.slice(0, 3)}</div>
                      {pago ? (
                        <div className="text-center">
                          <div className="text-xs font-bold text-brand-600">{formatCLP(pago.monto_pagado)}</div>
                          <button
                            onClick={() => handleAnular(pago.id)}
                            className="text-[10px] text-danger hover:underline mt-0.5"
                          >
                            Anular
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => openModal(cuotaMen.id, mes)}
                          className="text-[10px] px-2 py-1 rounded bg-gray-100 text-gray-400 hover:bg-brand-light hover:text-brand-600 transition-colors font-semibold"
                        >
                          Pagar
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Cuota anual */}
          {cuotaAnu && (() => {
            const pagoAnu = getPago(cuotaAnu.id, `Anual ${cuotaAnu.anio}`)
            return (
              <div className="card flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-bold">
                    {cuotaAnu.nombre}
                    <span className="badge badge-amber ml-2">anual</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">{formatCLP(cuotaAnu.monto_clp)} · {cuotaAnu.anio}</div>
                </div>
                {pagoAnu ? (
                  <div className="flex items-center gap-3">
                    <span className="badge badge-green">Pagada ✓</span>
                    <button onClick={() => handleAnular(pagoAnu.id)} className="btn btn-sm btn-danger btn-ghost">Anular</button>
                  </div>
                ) : (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => openModal(cuotaAnu.id, `Anual ${cuotaAnu.anio}`)}
                  >
                    Registrar pago
                  </button>
                )}
              </div>
            )
          })()}

          {/* Cuotas extraordinarias */}
          {cuotas.filter(q => q.tipo_cuota === 'extraordinaria').map(q => {
            const pago = getPago(q.id, q.periodo || q.nombre)
            return (
              <div key={q.id} className="card flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-bold">
                    {q.nombre}
                    <span className="badge badge-gray ml-2">extraordinaria</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">{formatCLP(q.monto_clp)}</div>
                </div>
                {pago ? (
                  <span className="badge badge-green">Pagada ✓</span>
                ) : (
                  <button className="btn btn-primary btn-sm" onClick={() => openModal(q.id, q.periodo || q.nombre)}>
                    Registrar pago
                  </button>
                )}
              </div>
            )
          })}
        </>
      )}

      {/* Modal pago */}
      <Modal open={modal} title="Registrar pago" onClose={() => setModal(false)}>
        <div className="bg-brand-light rounded-lg px-4 py-3 mb-4 text-sm text-brand-600 font-medium">
          Alumno: <strong>{alu?.nombres} {alu?.apellidos}</strong> · Período: <strong>{fPeriodo}</strong>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="form-group">
            <label className="form-label">Monto (CLP)</label>
            <input className="form-input" type="number" value={fMonto} onChange={e => setFMonto(e.target.value)} placeholder="5000" />
          </div>
          <div className="form-group">
            <label className="form-label">Fecha de pago</label>
            <input className="form-input" type="date" value={fFecha} onChange={e => setFFecha(e.target.value)} />
          </div>
          <div className="form-group col-span-2">
            <label className="form-label">Medio de pago</label>
            <select className="form-input" value={fMedio} onChange={e => setFMedio(e.target.value)}>
              {['Transferencia', 'Efectivo', 'Cheque', 'Otro'].map(m => <option key={m}>{m}</option>)}
            </select>
          </div>
          <div className="form-group col-span-2">
            <label className="form-label">Observaciones</label>
            <input className="form-input" value={fObs} onChange={e => setFObs(e.target.value)} placeholder="Opcional..." />
          </div>
        </div>
        {error && <div className="bg-danger-light text-danger-600 text-sm px-3 py-2 rounded-lg mb-3">{error}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={() => setModal(false)}>Cancelar</button>
          <button className="btn btn-primary" onClick={handlePago} disabled={loading}>
            {loading ? 'Registrando...' : 'Registrar pago'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
