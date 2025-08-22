// Proxy WS <-> ASR
import WebSocket from 'ws'

const ASR_URL = process.env.ASR_URL || 'ws://localhost:9000/asr'
const PREBUFFER_CAP_BYTES = 64 * 1024 // ~2s @16k PCM16
const HEARTBEAT_MS = 30000
const SILENCE_FLUSH_MS = Number(process.env.SILENCE_FLUSH_MS || 1000)

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

export default async function (fastify) {
  // Handler do @fastify/websocket:
  // Em algumas versões o 1º arg já é o ws; em outras é um wrapper com { socket }.
  fastify.get('/asr/stream', { websocket: true }, (connection, req) => {
    const client = (connection && typeof connection.send === 'function')
      ? connection
      : connection?.socket

    const reqId = Math.random().toString(36).slice(2)
    fastify.log.info({ reqId }, 'asr_stream_open')

    const upstream = new WebSocket(ASR_URL, { perMessageDeflate: false })

    let upstreamOpen = false
    let started = false
    const prebuf = []
    let prebufSize = 0
    let silenceTimer

    function resetSilenceTimer() {
      if (silenceTimer) clearTimeout(silenceTimer)
      silenceTimer = setTimeout(() => {
        silenceTimer = undefined
        try {
          if (upstream && upstream.readyState === WebSocket.OPEN) {
            upstream.send(JSON.stringify({ op: 'flush' }))
          }
        } catch {}
      }, SILENCE_FLUSH_MS)
    }

    const hb = setInterval(() => {
      try { if (client && client.readyState === WebSocket.OPEN) client.ping() } catch {}
      try { if (upstream.readyState === WebSocket.OPEN) upstream.ping() } catch {}
    }, HEARTBEAT_MS)

    upstream.on('open', () => {
      upstreamOpen = true
      // Envia 'start' com VAD do lado do servidor (encerra com ~400 ms de silêncio)
      const startMsg = JSON.stringify({
        op: 'start',
        format: 'pcm16le',
        sample_rate: 16000,
        language: 'pt',
        vad: { aggr: 1, pre_ms: 240, silence_ms: 400 }
      })
      try { upstream.send(startMsg) } catch {}
      started = true
      // Drena o prebuffer
      for (const b of prebuf) {
        try { upstream.send(b, { binary: true }) } catch {}
      }
      prebuf.length = 0; prebufSize = 0
    })

    upstream.on('message', (data) => {
      try {
        if (client && client.readyState === WebSocket.OPEN) client.send(data) // forward JSON events
      } catch (err) {
        fastify.log.error({ reqId, err }, 'asrStream forward-to-client failed')
      }
    })

    upstream.on('close', (code, reason) => {
      try {
        if (client && client.readyState === WebSocket.OPEN) {
          client.close(code, reason?.toString?.())
        }
      } catch {}
      clearInterval(hb)
    })

    upstream.on('error', (err) => {
      fastify.log.error({ reqId, err }, 'asr_upstream_error')
      try {
        if (client && client.readyState === WebSocket.OPEN) client.close(1011, 'asr_error')
      } catch {}
      clearInterval(hb)
    })

    // Cliente -> Upstream (com prebuffer enquanto upstream não abriu)
    client.on('message', (data) => {
      if (!started || !upstreamOpen) {
        const b = toBuffer(data)
        prebuf.push(b); prebufSize += b.length
        while (prebufSize > PREBUFFER_CAP_BYTES) {
          const head = prebuf.shift()
          if (head) prebufSize -= head.length
        }
        resetSilenceTimer()
        return
      }
      try { upstream.send(data, { binary: !(typeof data === 'string') }) } catch (err) {
        fastify.log.error({ reqId, err }, 'asrStream forward-to-upstream failed')
      }
      resetSilenceTimer()
    })

    client.on('close', (code, reason) => {
      // Opcional: pedir um flush antes de fechar o upstream
      try {
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({ op: 'flush' }))
        }
      } catch {}
      setTimeout(() => {
        try { upstream?.close(code, reason?.toString?.()) } catch {}
      }, 40)
      clearInterval(hb)
      if (silenceTimer) clearTimeout(silenceTimer)
    })

    client.on('error', (err) => {
      fastify.log.error({ reqId, err }, 'client_error')
      try { upstream?.close(1011, 'client_error') } catch {}
      clearInterval(hb)
      if (silenceTimer) clearTimeout(silenceTimer)
    })
  })
}
