'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createAlumno, updateAlumno, deleteAlumno, createApoderado, deleteApoderado } from '@/lib/actions/alumnos'
import Modal from '@/components/ui/Modal'
import type { Alumno, Apoderado } from '@/lib/types'

interface Props { alumnos: (Alumno & { apoderados: Apoderado[] })[]; cursoId: string }

type ModalType = 'add' | 'edit' | 'apoderados' | null

export default function AlumnosClient({ alumnos: initial, cursoId }: Props) {
  const router = useRouter()
  const [modal, setModal] = useState<ModalType>(null)
  const [selAlumno, setSelAlumno] = useState<(Alumno & { apoderados: Apoderado[] }) | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busqueda, setBusqueda] = useState('')

  // Form states
  const [fNombres, setFNombres] = useState('')
  const [fApellidos, setFApellidos] = useState('')
  const [fEstado, setFEstado] = useState<'activo' | 'retirado'>('activo')
  const [fObs, setFObs] = useState('')
  const [fApNombre, setFApNombre] = useState('')
  const [fApRel, setFApRel] = useState('Madre')
  const [fApTel, setFApTel] = useState('')
  const [fApEmail, setFApEmail] = useState('')

  const alumnos = initial.filter(a =>
    busqueda === '' ||
    `${a.nombres} ${a.apellidos}`.toLowerCase().includes(busqueda.toLowerCase())
  )

  function openAdd() {
    setFNombres(''); setFApellidos(''); setFEstado('activo'); setFObs('')
    setError(''); setModal('add')
  }

  function openEdit(a: typeof selAlumno) {
    setSelAlumno(a); setFNombres(a!.nombres); setFApellidos(a!.apellidos)
    setFEstado(a!.estado as any); setFObs(a!.observaciones || '')
    setError(''); setModal('edit')
  }

  function openApoderados(a: typeof selAlumno) {
    setSelAlumno(a)
    setFApNombre(''); setFApRel('Madre'); setFApTel(''); setFApEmail('')
    setError(''); setModal('apoderados')
  }

  async function handleSave() {
    if (!fNombres.trim() || !fApellidos.trim()) { setError('Nombre y apellidos son requeridos.'); return }
    setLoading(true); setError('')
    try {
      if (modal === 'add') {
        await createAlumno(cursoId, { nombres: fNombres, apellidos: fApellidos, estado: fEstado, observaciones: fObs })
      } else if (modal === 'edit' && selAlumno) {
        await updateAlumno(selAlumno.id, cursoId, { nombres: fNombres, apellidos: fApellidos, estado: fEstado, observaciones: fObs })
      }
      setModal(null); router.refresh()
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Eliminar este alumno? Se eliminarán también sus pagos.')) return
    setLoading(true)
    try { await deleteAlumno(id, cursoId); router.refresh() }
    catch (e: any) { alert(e.message) }
    finally { setLoading(false) }
  }

  async function handleAddAp() {
    if (!fApNombre.trim()) { setError('El nombre del apoderado es requerido.'); return }
    setLoading(true); setError('')
    try {
      await createApoderado(selAlumno!.id, cursoId, {
        nombre_completo: fApNombre, relacion: fApRel, telefono: fApTel, email: fApEmail,
      })
      setFApNombre(''); setFApTel(''); setFApEmail('')
      router.refresh()
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function handleDelAp(apId: string) {
    if (!confirm('¿Eliminar este apoderado?')) return
    try { await deleteApoderado(apId, cursoId); router.refresh() }
    catch (e: any) { alert(e.message) }
  }

  const activos = initial.filter(a => a.estado === 'activo').length
  const retirados = initial.filter(a => a.estado === 'retirado').length

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex gap-4">
          <div className="metric-card px-4 py-3 flex-1 text-center">
            <div className="text-xl font-black text-brand-600">{activos}</div>
            <div className="text-xs text-gray-400">activos</div>
          </div>
          <div className="metric-card px-4 py-3 flex-1 text-center">
            <div className="text-xl font-black text-gray-400">{retirados}</div>
            <div className="text-xs text-gray-400">retirados</div>
          </div>
        </div>
        <div className="flex gap-2">
          <input
            className="form-input w-48 text-sm"
            placeholder="Buscar alumno..."
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
          />
          <button className="btn btn-primary" onClick={openAdd}>+ Agregar alumno</button>
        </div>
      </div>

      {/* Tabla */}
      <div className="card p-0 overflow-hidden">
        {alumnos.length === 0 ? (
          <div className="empty-state py-14">
            <div className="text-4xl mb-3">👥</div>
            <div className="font-semibold">Sin alumnos {busqueda ? 'encontrados' : 'registrados'}</div>
            {!busqueda && <button className="btn btn-primary mt-4" onClick={openAdd}>+ Agregar primer alumno</button>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Alumno</th>
                  <th>Estado</th>
                  <th>Apoderados</th>
                  <th>Observaciones</th>
                  <th className="text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {alumnos.map(a => (
                  <tr key={a.id}>
                    <td>
                      <div className="font-semibold">{a.apellidos}, {a.nombres}</div>
                    </td>
                    <td>
                      <span className={`badge ${a.estado === 'activo' ? 'badge-green' : 'badge-gray'}`}>
                        {a.estado}
                      </span>
                    </td>
                    <td>
                      <span className="text-gray-400 text-sm">
                        {a.apoderados?.length || 0} apoderado{(a.apoderados?.length || 0) !== 1 ? 's' : ''}
                      </span>
                    </td>
                    <td className="text-gray-400 text-sm max-w-[150px] truncate">{a.observaciones || '—'}</td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        <button className="btn btn-sm btn-ghost" onClick={() => openApoderados(a)} title="Ver apoderados">👤</button>
                        <button className="btn btn-sm btn-ghost" onClick={() => openEdit(a)} title="Editar">✏️</button>
                        <button className="btn btn-sm btn-danger btn-ghost" onClick={() => handleDelete(a.id)} title="Eliminar">🗑</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal: Agregar / Editar alumno */}
      <Modal
        open={modal === 'add' || modal === 'edit'}
        title={modal === 'add' ? 'Agregar alumno' : 'Editar alumno'}
        onClose={() => setModal(null)}
      >
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="form-group">
            <label className="form-label">Nombres</label>
            <input className="form-input" value={fNombres} onChange={e => setFNombres(e.target.value)} placeholder="Nombre(s)" />
          </div>
          <div className="form-group">
            <label className="form-label">Apellidos</label>
            <input className="form-input" value={fApellidos} onChange={e => setFApellidos(e.target.value)} placeholder="Apellido(s)" />
          </div>
        </div>
        <div className="form-group mb-3">
          <label className="form-label">Estado</label>
          <select className="form-input" value={fEstado} onChange={e => setFEstado(e.target.value as any)}>
            <option value="activo">Activo</option>
            <option value="retirado">Retirado</option>
          </select>
        </div>
        <div className="form-group mb-4">
          <label className="form-label">Observaciones</label>
          <input className="form-input" value={fObs} onChange={e => setFObs(e.target.value)} placeholder="Opcional..." />
        </div>
        {error && <div className="bg-danger-light text-danger-600 text-sm px-3 py-2 rounded-lg mb-3">{error}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={() => setModal(null)}>Cancelar</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
            {loading ? 'Guardando...' : modal === 'add' ? 'Agregar' : 'Guardar cambios'}
          </button>
        </div>
      </Modal>

      {/* Modal: Apoderados */}
      <Modal
        open={modal === 'apoderados'}
        title={`Apoderados — ${selAlumno?.nombres} ${selAlumno?.apellidos}`}
        onClose={() => setModal(null)}
        wide
      >
        {/* Lista de apoderados existentes */}
        <div className="space-y-2 mb-5">
          {(selAlumno?.apoderados || []).length === 0 ? (
            <p className="text-sm text-gray-400">Sin apoderados registrados.</p>
          ) : (
            selAlumno!.apoderados.map(ap => (
              <div key={ap.id} className="flex items-start justify-between p-3 border border-gray-100 rounded-lg">
                <div>
                  <div className="font-semibold text-sm">{ap.nombre_completo}</div>
                  <div className="text-xs text-gray-400">
                    {ap.relacion} · {ap.telefono || '—'} · {ap.email || '—'}
                  </div>
                </div>
                <button className="btn btn-sm btn-danger btn-ghost ml-3" onClick={() => handleDelAp(ap.id)}>🗑</button>
              </div>
            ))
          )}
        </div>

        {/* Agregar apoderado */}
        <div className="border-t border-gray-100 pt-4">
          <div className="text-sm font-bold mb-3">Agregar apoderado</div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="form-group">
              <label className="form-label">Nombre completo</label>
              <input className="form-input" value={fApNombre} onChange={e => setFApNombre(e.target.value)} placeholder="Nombre apoderado" />
            </div>
            <div className="form-group">
              <label className="form-label">Relación</label>
              <select className="form-input" value={fApRel} onChange={e => setFApRel(e.target.value)}>
                {['Madre','Padre','Tutor/a','Abuelo/a','Otro'].map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Teléfono</label>
              <input className="form-input" value={fApTel} onChange={e => setFApTel(e.target.value)} placeholder="+56 9 XXXX XXXX" />
            </div>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-input" type="email" value={fApEmail} onChange={e => setFApEmail(e.target.value)} placeholder="email@mail.cl" />
            </div>
          </div>
          {error && <div className="bg-danger-light text-danger-600 text-sm px-3 py-2 rounded-lg mb-3">{error}</div>}
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={() => setModal(null)}>Cerrar</button>
            <button className="btn btn-primary" onClick={handleAddAp} disabled={loading}>
              {loading ? 'Guardando...' : 'Agregar apoderado'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
