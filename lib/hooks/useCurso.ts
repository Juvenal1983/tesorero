'use client'
import { createContext, useContext } from 'react'
import type { ContextoCurso } from '@/lib/types'

export const CursoContext = createContext<ContextoCurso | null>(null)

export function useCurso(): ContextoCurso {
  const ctx = useContext(CursoContext)
  if (!ctx) throw new Error('useCurso debe usarse dentro de CursoProvider')
  return ctx
}
