'use client'
import { useEffect, useState } from 'react'

export default function InstallPrompt() {
  const [prompt, setPrompt] = useState<any>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault()
      setPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  if (!prompt || dismissed) return null

  async function install() {
    prompt.prompt()
    const { outcome } = await prompt.userChoice
    if (outcome === 'accepted') setPrompt(null)
    else setDismissed(true)
  }

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-brand-600 text-white rounded-xl px-4 py-3 shadow-lg flex items-center gap-3 text-sm font-medium max-w-sm w-[calc(100%-2rem)]">
      <span className="text-xl">📲</span>
      <span className="flex-1">Instalar Tesorero como app</span>
      <button
        onClick={install}
        className="px-3 py-1.5 bg-white text-brand-600 rounded-lg text-xs font-bold hover:bg-brand-50 transition-colors"
      >
        Instalar
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="text-white/60 hover:text-white text-lg leading-none ml-1"
      >
        ×
      </button>
    </div>
  )
}
