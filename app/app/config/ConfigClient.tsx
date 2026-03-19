'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { updateCurso, regenerarCodigo } from '@/lib/actions/cursos'
import { formatCLP } from '@/lib/utils/format'

export default function ConfigClient({ curso }: { curso: any }) {
  const router = useRouter()
  const [nombre, setNombre] = useState(curso.nombre || '')
  const [cuotaMen, setCuotaMen] = useState(String(curso.cuota_mensual_clp || ''))
  const [cuotaAnu, setCuotaAnu] = useState(String(curso.cuota_anual_clp || ''))
  const [meta, setMeta] = useState(String(curso.meta_anual_clp || ''))
  const [loading, setLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  const [codigo, setCodigo] = useState(curso.codigo_acceso || '')

  async function handleSave() {
    setLoading(true); setSaved(false)
    try {
      await updateCurso(curso.id, {
        nombre,
        cuota_mensual_clp: parseInt(cuotaMen) || 0,
        cuota_anual_clp: parseInt(cuotaAnu) || 0,
        meta_anual_clp: parseInt(meta) || 0,
      })
      setSaved(true); setTimeout(() => setSaved(false), 3000)
      router.refresh()
    } catch (e: any) { alert(e.message) }
    finally { setLoading(false) }
  }

  async function handleRegen() {
    if (!confirm('¿Regenerar el código? El código anterior dejará de funcionar inmediatamente.')) return
    try {
      const nuevo = await regenerarCodigo(curso.id)
      setCodigo(nuevo); router.refresh()
    } catch (e: any) { alert(e.message) }
  }

  function copyCodigo() {
    navigator.clipboard?.writeText(codigo).then(() => alert(`Código copiado: ${codigo}`))
      .catch(() => alert(`Código: ${codigo}`))
  }

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Datos del curso */}
      <div className="card">
        <div className="text-sm font-bold mb-5">Datos del curso</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
          <div className="form-group sm:col-span-2">
            <label className="form-label">Nombre del colegio</label>
            <input className="form-input bg-gray-50" value={(curso.colegio as any)?.nombre || ''} disabled />
          </div>
          <div className="form-group sm:col-span-2">
            <label className="form-label">Nombre o nivel del curso</label>
            <input className="form-input" value={nombre} onChange={e => setNombre(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Año académico</label>
            <input className="form-input bg-gray-50" value={curso.anio_academico} disabled />
          </div>
          <div className="form-group">
            <label className="form-label">Tesorero</label>
            <input className="form-input bg-gray-50" value={(curso.tesorero as any)?.nombre_completo || ''} disabled />
          </div>
          <div className="form-group">
            <label className="form-label">Cuota mensual (CLP)</label>
            <input className="form-input" type="number" value={cuotaMen} onChange={e => setCuotaMen(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Cuota anual (CLP)</label>
            <input className="form-input" type="number" value={cuotaAnu} onChange={e => setCuotaAnu(e.target.value)} />
          </div>
          <div className="form-group sm:col-span-2">
            <label className="form-label">Meta de recaudación anual (CLP)</label>
            <input className="form-input" type="number" value={meta} onChange={e => setMeta(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
            {loading ? 'Guardando...' : 'Guardar cambios'}
          </button>
          {saved && <span className="text-brand-600 text-sm font-semibold">✓ Cambios guardados</span>}
        </div>
      </div>

      {/* Código de acceso */}
      <div className="card">
        <div className="text-sm font-bold mb-2">Código de acceso para apoderados</div>
        <p className="text-sm text-gray-400 mb-4">
          Comparte este código con los apoderados del curso para que accedan como lectores. Solo podrán ver información financiera general, nunca datos individuales.
        </p>
        <div className="bg-brand-light border border-brand-200 rounded-xl px-6 py-5 mb-4">
          <div className="font-mono text-3xl font-black tracking-widest text-brand-600 text-center">
            {codigo}
          </div>
          <div className="text-xs text-brand-400 text-center mt-2">
            Curso: {nombre} · {curso.anio_academico}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn" onClick={copyCodigo}>📋 Copiar código</button>
          <button className="btn btn-danger" onClick={handleRegen}>🔄 Regenerar código</button>
        </div>
      </div>

      {/* Zona de peligro */}
      <div className="card border-danger/30">
        <div className="text-sm font-bold text-danger mb-2">Zona de peligro</div>
        <p className="text-sm text-gray-400 mb-4">
          Estas acciones son irreversibles. Procede solo si estás seguro.
        </p>
        <div className="flex flex-col gap-2">
          <button
            className="btn btn-danger"
            onClick={() => {
              if (confirm('¿Desactivar este curso? Los apoderados no podrán acceder con el código actual.')) {
                updateCurso(curso.id, {}).then(() => router.refresh())
              }
            }}
          >
            ⚠️ Desactivar curso
          </button>
        </div>
      </div>
    </div>
  )
}
