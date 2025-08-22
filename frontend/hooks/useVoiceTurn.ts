'use client'
import { useRef, useState } from 'react'
import { connectAndRecord } from '../lib/audio/client'

type Turn = 'idle' | 'user_speaking' | 'agent_thinking' | 'agent_speaking'

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000'
const TTS_MODE = process.env.NEXT_PUBLIC_TTS_MODE || 'browser' // 'browser' | 'wyoming'

export function useVoiceTurn() {
  const [turn, setTurn] = useState<Turn>('idle')
  const [lines, setLines] = useState<string[]>([])
  const [partial, setPartial] = useState<string>('')
  const recRef = useRef<any>(null)

  function stopTTS() {
    try { window.speechSynthesis.cancel() } catch {}
  }

  async function speak(text: string) {
    if (TTS_MODE === 'wyoming') {
      // TODO: tocar via /tts quando implementado; por ora usa browser
    }
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'pt-BR'
    return new Promise<void>((resolve) => {
      u.onend = () => resolve()
      window.speechSynthesis.speak(u)
    })
  }

  async function askAgent(text: string) {
    setTurn('agent_thinking')
    const res = await fetch(GATEWAY + '/agent', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ text })
    })
    const j = await res.json()
    const answer = j?.answer || ''
    setLines(prev => [...prev, 'Agente: ' + answer])
    // speak
    setTurn('agent_speaking')
    try {
      recRef.current?.setAgentSpeaking?.(true)
      await speak(answer)
    } finally {
      recRef.current?.setAgentSpeaking?.(false)
      setTurn('idle')
    }
  }

  async function start(textIfAny?: string | null) {
    if (textIfAny && textIfAny.trim()) {
      setLines(prev=>[...prev, 'Você: ' + textIfAny])
      await askAgent(textIfAny)
      return
    }
    // barge-in: cancelar TTS e começar a escutar
    stopTTS()
    setTurn('user_speaking')
    const rec = await connectAndRecord(null, {
      onPartial: (t: string) => setPartial(t),
      onFinal: async (t: string) => {
        if (!t?.trim()) return
        setPartial('')
        setLines(prev => [...prev, 'Você: ' + t])
        await askAgent(t)
      },
      onError: (e: any) => console.error(e)
    })
    recRef.current = rec
  }

  function stopAll() {
    stopTTS()
    try { recRef.current?.stop?.() } catch {}
    try { recRef.current?.setAgentSpeaking?.(false) } catch {}
    setTurn('idle')
  }

  return { turn, lines, partial, start, stopAll }
}
