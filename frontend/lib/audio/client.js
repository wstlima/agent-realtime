export async function connectAndRecord(_token, handlers = {}) {
  const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4000'
  const wsUrl = GATEWAY_URL.replace(/^http/i, 'ws') + '/asr/stream'
  const ws = new WebSocket(wsUrl)

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws_open_timeout')), 8000)
    ws.onopen = () => { clearTimeout(t); resolve() }
    ws.onerror = (e) => { clearTimeout(t); reject(e) }
  })

  ws.onmessage = (ev) => {
    try {
      const raw = (typeof ev.data === 'string') ? ev.data : new TextDecoder().decode(ev.data)
      const data = JSON.parse(raw)
      if (data.event === 'partial') handlers.onPartial?.(data.text || '')
      else if (data.event === 'final') handlers.onFinal?.(data.text || '')
      else if (data.event === 'error') handlers.onError?.(data)
    } catch {}
  }

  // microfone
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount:1, sampleRate:48000, echoCancellation:true, noiseSuppression:true, autoGainControl:true }
  })
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 })
  await ctx.audioWorklet.addModule('/worklet/recorder-worklet.js')
  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'recorder-worklet')

  let wasSpeaking = false
  let utterStartedAt = 0
  let flushTimer = null

  function armFlush(ms = 9000) {
    try { clearTimeout(flushTimer) } catch {}
    flushTimer = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ op:'flush' })) } catch {}
      }
    }, ms)
  }

  node.port.onmessage = (e) => {
    const msg = e.data
    if (msg && msg.evt === 'vad') {
      if (!wasSpeaking && msg.speaking) {
        utterStartedAt = Date.now()
        armFlush(9000) // failsafe de 9s por fala
      }
      if (wasSpeaking && !msg.speaking) {
        // fim de fala -> flush imediato
        try {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op:'flush' }))
          }
        } catch {}
        try { clearTimeout(flushTimer) } catch {}
      }
      wasSpeaking = msg.speaking
      return
    }
    if (ws && ws.readyState === WebSocket.OPEN && msg instanceof Uint8Array) {
      ws.send(msg) // 20ms @16k PCM16
    }
  }

  src.connect(node)
  // thresholds + calibração rápida (worklet decide fim de fala)
  try { node.port.postMessage({ vadThresholds: {
    minThresh:0.015, highK:3.5, lowK:1.4, preRollFrames:8, hangoverFrames:15, minStartFrames:5, boostK:2.0
  }}) } catch {}
  try { node.port.postMessage({ cmd: 'calibrate', durationMs: 1200 }) } catch {}
  node.port.postMessage('resume')

  function stop() {
    try { node.port.postMessage('pause') } catch {}
    try { src.disconnect() } catch {}

    // 🔸 flush antes do stop, com um pequeno atraso para garantir processamento
    try { ws.send(JSON.stringify({ op:'flush' })) } catch {}
    setTimeout(() => {
      try { ws.send(JSON.stringify({ op:'stop' })) } catch {}
      try { ws.close(1000, 'client_stop') } catch {}
    }, 60)

    try { stream.getTracks().forEach(t=>t.stop()) } catch {}
    try { ctx.close() } catch {}
  }
  function setVadThresholds(th) { try { node.port.postMessage({ vadThresholds: th }) } catch {} }
  function calibrateVAD(durationMs=1500) { try { node.port.postMessage({ cmd:'calibrate', durationMs }) } catch {} }
  function setAgentSpeaking(on) { try { node.port.postMessage({ agentSpeaking: !!on }) } catch {} }

  return { ws, ctx, stream, node, stop, setVadThresholds, calibrateVAD, setAgentSpeaking }
}
