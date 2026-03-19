'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const [tab, setTab] = useState<'login' | 'codigo'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [codigo, setCodigo] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const supabase = createClient()
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
      if (authError) throw new Error('Correo o contraseña incorrectos.')
      router.push('/app/dashboard')
      router.refresh()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleCodigo(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const supabase = createClient()
      const { data, error: dbErr } = await supabase
        .from('cursos')
        .select('id, nombre, anio_academico')
        .eq('codigo_acceso', codigo.trim().toUpperCase())
        .eq('activo', true)
        .single()
      if (dbErr || !data) throw new Error('Código inválido o curso no encontrado.')
      // Guardamos el acceso de lector en sessionStorage
      sessionStorage.setItem('lector_curso_id', data.id)
      sessionStorage.setItem('lector_rol', 'apoderado_lector')
      router.push(`/app/dashboard?curso=${data.id}&lector=1`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-100 to-gray-50 p-4">
      <div className="bg-white rounded-2xl border border-gray-200 p-8 w-full max-w-md shadow-sm">

        {/* Logo */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-10 h-10 rounded-xl bg-brand-light flex items-center justify-center text-2xl">💰</div>
            <span className="text-2xl font-black text-brand-600 tracking-tight">Tesorero</span>
          </div>
          <p className="text-sm text-gray-400 ml-1">Administración financiera de cursos escolares</p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 mb-6">
          <button
            onClick={() => { setTab('login'); setError('') }}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
              tab === 'login'
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            Acceso tesorero
          </button>
          <button
            onClick={() => { setTab('codigo'); setError('') }}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
              tab === 'codigo'
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            Código de curso
          </button>
        </div>

        {tab === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="form-group">
              <label className="form-label">Correo electrónico</label>
              <input
                className="form-input"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="correo@mail.cl"
                required
                autoComplete="email"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Contraseña</label>
              <input
                className="form-input"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>
            {error && (
              <div className="bg-danger-light text-danger-600 text-sm px-4 py-3 rounded-lg border border-danger/20">
                {error}
              </div>
            )}
            <button
              type="submit"
              className="btn btn-primary w-full justify-center py-2.5"
              disabled={loading}
            >
              {loading ? 'Ingresando...' : 'Ingresar'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleCodigo} className="space-y-4">
            <div className="bg-info-light text-info-600 text-sm px-4 py-3 rounded-lg border border-info/20">
              Ingresa el código único que te compartió el tesorero para acceder como apoderado lector.
            </div>
            <div className="form-group">
              <label className="form-label">Código del curso</label>
              <input
                className="form-input text-xl font-mono tracking-widest text-center uppercase"
                type="text"
                value={codigo}
                onChange={e => setCodigo(e.target.value.toUpperCase())}
                placeholder="5BA-2026-MK7X"
                maxLength={20}
                required
              />
            </div>
            {error && (
              <div className="bg-danger-light text-danger-600 text-sm px-4 py-3 rounded-lg border border-danger/20">
                {error}
              </div>
            )}
            <button
              type="submit"
              className="btn btn-primary w-full justify-center py-2.5"
              disabled={loading}
            >
              {loading ? 'Verificando...' : 'Acceder como apoderado'}
            </button>
          </form>
        )}

      </div>
    </div>
  )
}
