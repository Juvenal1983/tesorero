'use client'
import { useState } from 'react'
import { formatFecha } from '@/lib/utils/format'

interface Props {
  colegios: any[]
  cursos: any[]
  usuarios: any[]
}

type Tab = 'colegios' | 'cursos' | 'usuarios'

export default function AdminClient({ colegios, cursos, usuarios }: Props) {
  const [tab, setTab] = useState<Tab>('cursos')

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'cursos',   label: 'Cursos',   count: cursos.length },
    { id: 'colegios', label: 'Colegios', count: colegios.length },
    { id: 'usuarios', label: 'Usuarios', count: usuarios.length },
  ]

  return (
    <div className="space-y-4">
      {/* Métricas rápidas */}
      <div className="grid grid-cols-3 gap-3">
        <div className="metric-card text-center">
          <div className="metric-value text-brand-600">{colegios.length}</div>
          <div className="metric-label mt-1">Colegios</div>
        </div>
        <div className="metric-card text-center">
          <div className="metric-value text-info">{cursos.length}</div>
          <div className="metric-label mt-1">Cursos</div>
        </div>
        <div className="metric-card text-center">
          <div className="metric-value text-gray-700">{usuarios.length}</div>
          <div className="metric-label mt-1">Usuarios</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
              tab === t.id
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            {t.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${tab === t.id ? 'bg-brand-light text-brand-600' : 'bg-gray-100 text-gray-400'}`}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Cursos */}
      {tab === 'cursos' && (
        <div className="card p-0 overflow-hidden">
          {cursos.length === 0 ? (
            <div className="empty-state py-12">Sin cursos registrados</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table w-full">
                <thead>
                  <tr>
                    <th>Curso</th>
                    <th>Colegio</th>
                    <th>Año</th>
                    <th>Tesorero</th>
                    <th>Código</th>
                    <th>Estado</th>
                    <th>Creado</th>
                  </tr>
                </thead>
                <tbody>
                  {cursos.map((c: any) => (
                    <tr key={c.id}>
                      <td className="font-semibold">{c.nombre}</td>
                      <td className="text-gray-500">{c.colegio?.nombre || '—'}</td>
                      <td className="text-gray-500">{c.anio_academico}</td>
                      <td>
                        <div className="text-sm">{c.tesorero?.nombre_completo || '—'}</div>
                        <div className="text-xs text-gray-400">{c.tesorero?.email}</div>
                      </td>
                      <td>
                        <code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono tracking-wider">
                          {c.codigo_acceso}
                        </code>
                      </td>
                      <td>
                        <span className={`badge ${c.activo ? 'badge-green' : 'badge-gray'}`}>
                          {c.activo ? 'Activo' : 'Inactivo'}
                        </span>
                      </td>
                      <td className="text-gray-400 text-xs">{formatFecha(c.created_at?.slice(0, 10))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Colegios */}
      {tab === 'colegios' && (
        <div className="card p-0 overflow-hidden">
          {colegios.length === 0 ? (
            <div className="empty-state py-12">Sin colegios registrados</div>
          ) : (
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Ciudad</th>
                  <th>Región</th>
                  <th>Estado</th>
                  <th>Creado</th>
                </tr>
              </thead>
              <tbody>
                {colegios.map((col: any) => (
                  <tr key={col.id}>
                    <td className="font-semibold">{col.nombre}</td>
                    <td className="text-gray-500">{col.ciudad || '—'}</td>
                    <td className="text-gray-500">{col.region || '—'}</td>
                    <td>
                      <span className={`badge ${col.activo ? 'badge-green' : 'badge-gray'}`}>
                        {col.activo ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="text-gray-400 text-xs">{formatFecha(col.created_at?.slice(0, 10))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Usuarios */}
      {tab === 'usuarios' && (
        <div className="card p-0 overflow-hidden">
          {usuarios.length === 0 ? (
            <div className="empty-state py-12">Sin usuarios registrados</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table w-full">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Email</th>
                    <th>Rol</th>
                    <th>Estado</th>
                    <th>Creado</th>
                  </tr>
                </thead>
                <tbody>
                  {usuarios.map((u: any) => (
                    <tr key={u.id}>
                      <td className="font-semibold">{u.nombre_completo}</td>
                      <td className="text-gray-500 text-sm">{u.email}</td>
                      <td>
                        <span className={`badge ${
                          u.rol === 'superadmin' ? 'badge-red' :
                          u.rol === 'tesorero' ? 'badge-blue' : 'badge-gray'
                        }`}>
                          {u.rol}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${u.activo ? 'badge-green' : 'badge-gray'}`}>
                          {u.activo ? 'Activo' : 'Inactivo'}
                        </span>
                      </td>
                      <td className="text-gray-400 text-xs">{formatFecha(u.created_at?.slice(0, 10))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Nota de seguridad */}
      <div className="bg-warning-light border border-warning/20 rounded-lg px-4 py-3 text-sm text-warning-600">
        <strong>⚠️ Panel de administración</strong> — Las acciones destructivas (eliminar colegios, cursos o usuarios)
        deben ejecutarse directamente en Supabase Dashboard para mayor seguridad y control de auditoría.
      </div>
    </div>
  )
}
