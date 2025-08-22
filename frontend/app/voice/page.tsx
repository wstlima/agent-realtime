'use client'
import { useVoiceTurn } from '../../hooks/useVoiceTurn'
import { useState, useRef } from 'react'

export default function VoicePage() {
  const { turn, lines, partial, start, stopAll } = useVoiceTurn()
  const [input, setInput] = useState('')
  const sRef = useRef<string | null>(null)

  return (
    <main style={{ padding: 24, maxWidth: 720, margin:'0 auto' }}>
      <h2>Voz + Chat (Barge-in)</h2>
      <div style={{ margin:'16px 0' }}>
        <button onClick={() => start()} disabled={turn==='user_speaking'}>🎤 Falar</button>
        <button onClick={() => stopAll()}>⏹️ Parar</button>
      </div>

      <div style={{ padding:12, border:'1px solid #ddd', minHeight:120 }}>
        {lines.map((l,i) => <div key={i}>{l}</div>)}
        {partial && <div style={{ opacity:0.6 }}>Você: {partial}</div>}
      </div>

      <h3 style={{ marginTop:24 }}>Chat</h3>
      <form onSubmit={async (e)=>{e.preventDefault(); sRef.current=input; setInput(''); await start(sRef.current)}}>
        <input value={input} onChange={e=>setInput(e.target.value)} placeholder="Digite sua mensagem"/>
        <button type="submit">Enviar</button>
      </form>
    </main>
  )
}
