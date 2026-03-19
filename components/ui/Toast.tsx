'use client'
import type { Toast, ToastType } from '@/lib/hooks/useToast'

const STYLES: Record<ToastType, string> = {
  success: 'bg-brand-light border-brand-200 text-brand-600',
  error:   'bg-danger-light border-danger/20 text-danger-600',
  info:    'bg-info-light border-info/20 text-info-600',
  warning: 'bg-warning-light border-warning/20 text-warning-600',
}

const ICONS: Record<ToastType, string> = {
  success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️',
}

interface Props {
  toasts: Toast[]
  onDismiss: (id: string) => void
}

export default function ToastContainer({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-20 md:bottom-6 right-4 z-[200] flex flex-col gap-2 max-w-sm w-full">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`flex items-start gap-3 px-4 py-3 rounded-xl border shadow-lg text-sm font-medium animate-in ${STYLES[t.type]}`}
        >
          <span className="text-base flex-shrink-0">{ICONS[t.type]}</span>
          <span className="flex-1">{t.message}</span>
          <button
            onClick={() => onDismiss(t.id)}
            className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity text-lg leading-none"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
