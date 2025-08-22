// Optional TTS route. For now, returns 501 to signal that frontend is using browser TTS.
// If you want to proxy to Wyoming Piper, implement a WS client here to piper (ws://piper:10200).
export default async function (fastify) {
  fastify.get('/tts', async (req, reply) => {
    return reply.code(501).send({ error: 'TTS handled on client (Web Speech). Configure Wyoming proxy if needed.' })
  })
}
