import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import cors from '@fastify/cors' 
import asrStream from './routes/asrStream.js'
import agentRoute from './routes/agent.js'
import ttsRoute from './routes/tts.js'

const fastify = Fastify({ logger: true })

// Plugins primeiro
await fastify.register(cors, {
  origin: true,                                   // libera do localhost:3000
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],               // o preflight pergunta por 'content-type'
  // strictPreflight fica true por padrão (bom para sanidade do preflight)
})
await fastify.register(fastifyWebsocket)
await fastify.register(asrStream)
await fastify.register(agentRoute)
await fastify.register(ttsRoute)

fastify.get('/health', async () => ({ ok: true }))

const port = Number(process.env.PORT || 4000)
fastify.listen({ port, host: '0.0.0.0' }).catch(err => {
  fastify.log.error(err); process.exit(1)
})