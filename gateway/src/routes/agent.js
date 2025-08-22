import fetch from 'node-fetch'
import { v4 as uuidv4 } from 'uuid'

const LLAMA_URL = process.env.LLAMA_URL || ''
// naive memory per process; replace with store if multi-instance
const sessions = new Map()

function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { history: [] })
  return sessions.get(id)
}

export default async function (fastify) {
  fastify.post('/agent', async (req, reply) => {
    const { text, sessionId } = req.body || {}
    if (!text) return reply.code(400).send({ error: 'text required' })
    const sid = sessionId || uuidv4()
    const session = getSession(sid)

    // keep last N turns
    const memTurns = Number(process.env.MEM_TURNS || 4)
    const context = session.history.slice(-memTurns*2)

    let answer = ''
    if (LLAMA_URL) {
      // llama.cpp chat
      const messages = [
        { role: 'system', content: 'Você é um assistente objetivo e cordial. Responda de forma clara e breve.' },
        ...context,
        { role: 'user', content: text }
      ]
      try {
        const res = await fetch(LLAMA_URL, {
          method: 'POST',
          headers: { 'Content-Type':'application/json' },
          body: JSON.stringify({ model: 'local', messages, stream: false })
        })
        const j = await res.json()
        answer = j?.choices?.[0]?.message?.content?.trim() || ''
      } catch (e) {
        fastify.log.error(e)
        answer = ''
      }
    }

    if (!answer) {
      // fallback echo
      answer = `Você disse: ${text}`
    }

    session.history.push({ role: 'user', content: text })
    session.history.push({ role: 'assistant', content: answer })
    session.history = session.history.slice(-memTurns*2)

    return { sessionId: sid, answer }
  })
}
