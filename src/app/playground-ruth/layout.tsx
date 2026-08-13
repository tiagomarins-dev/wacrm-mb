// ============================================================
// /playground-ruth — shell standalone do playground da Ruth.
//
// Fora de (auth)/(dashboard) de propósito: o middleware protege por
// deny-list de prefixos (protectedPaths em middleware.ts) e esta rota
// se protege sozinha por senha via env, enviada no header
// x-playground-password das rotas de API. Reusar os route groups
// forçaria o redirect de login, que não se aplica aqui.
//
// noindex: página interna de teste do agente, nunca deve ser indexada.
// ============================================================

import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: 'Playground da Ruth',
  robots: { index: false, follow: false },
}

export default function PlaygroundRuthLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-background">{children}</div>
}
