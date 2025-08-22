'use client'
import Link from 'next/link'
export default function Page() {
  return (
    <main style={{ padding: 24 }}>
      <h1>ASR Conversational</h1>
      <p>Vá para a experiência de voz:</p>
      <ul>
        <li><Link href="/voice">/voice</Link></li>
      </ul>
    </main>
  )
}
