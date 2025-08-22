function currentTime(){ try { return currentFrame / sampleRate * 1000 } catch { return Date.now() } }
class RecorderWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.factor = 3 // 48k -> 16k
    this.acc = []
    // VAD state
    this.inSpeech = false
    this.noiseEma = 0.0
    this.emaAlpha = 0.12
    this.minThresh = 0.02
    this.highK = 3.5
    this.lowK  = 1.4
    this.preRollFrames = 8
    this.hangoverFrames = 15
    this.maxUtterFrames = 400  // ~8s máx por fala
    this.silenceCount = 0
    this.preBuf = []
    this._paused = false
    // extras
    this.suspendVad = false
    this.boostK = 2.0
    this.startCount = 0
    this.framesInSpeech = 0

    this.port.onmessage = (e) => {
      const msg = e.data || {}
      if (msg === 'pause') { this._paused = true; return }
      if (msg === 'resume') { this._paused = false; return }
      if (msg.cmd === 'calibrate') { this.noiseEma = 0.0; return }
      if (msg.agentSpeaking !== undefined) { this.suspendVad = !!msg.agentSpeaking; return }
      if (msg.vadThresholds) {
        const t = msg.vadThresholds
        if (typeof t.minThresh === 'number') this.minThresh = t.minThresh
        if (typeof t.highK === 'number') this.highK = t.highK
        if (typeof t.lowK === 'number') this.lowK = t.lowK
        if (typeof t.preRollFrames === 'number') this.preRollFrames = t.preRollFrames|0
        if (typeof t.hangoverFrames === 'number') this.hangoverFrames = t.hangoverFrames|0
        if (typeof t.minStartFrames === 'number') this.startCount = 0 // reset on change
        if (typeof t.boostK === 'number') this.boostK = t.boostK
      }
    }
  }

  setVadState(s) {
    this.inSpeech = s
    this.port.postMessage({ evt:'vad', speaking: s })
  }

  process(inputs, outputs) {
    if (this._paused) return true
    const input = inputs[0]
    if (!input || !input[0]) return true
    const ch0 = input[0]

    for (let i = 0; i < ch0.length; i++) {
      const sample = ch0[i]
      const abs = Math.abs(sample)
      this.noiseEma = this.emaAlpha*abs + (1-this.emaAlpha)*this.noiseEma

      // downsample to 16k
      this.acc.push(sample)
      if (this.acc.length === this.factor) {
        const v = (this.acc[0] + this.acc[1] + this.acc[2]) / 3.0
        this.acc.length = 0
        // PCM16
        const s = Math.max(-1, Math.min(1, v))
        const i16 = (s < 0 ? s * 0x8000 : s * 0x7FFF) | 0
        if (!this._pcm) this._pcm = new Int16Array(0)
        if (!this._buf) this._buf = []
        this._buf.push(i16)
        if (this._buf.length >= 320) { // 20ms @16k
          const rms = Math.sqrt(this._buf.reduce((a,c)=>a + (c*c),0) / this._buf.length) / 32768.0
          const kH = this.suspendVad ? (this.highK * this.boostK) : this.highK
          const kL = this.suspendVad ? (this.lowK  * this.boostK) : this.lowK
          const entry = Math.max(this.minThresh, this.noiseEma * kH)
          const exit  = Math.max(this.minThresh*0.8, this.noiseEma * kL)

          if (!this.inSpeech) {
            this.startCount = (rms > entry) ? (this.startCount + 1) : 0
            if (this.startCount >= 5) {
              this.setVadState(true)
              this.preBuf.length = 0
              this.startCount = 0
              this.framesInSpeech = 0
            } else {
              // keep small pre-roll
              this.preBuf.push(...this._buf)
              if (this.preBuf.length > (320*8)) this.preBuf.splice(0, this.preBuf.length - 320*8)
            }
          } else {
            this.framesInSpeech++
            const hardFloor = this.minThresh * 0.9
            const isSilent = (rms < hardFloor) || (rms < exit)
            if (isSilent) {
              this.silenceCount += 1
            } else {
              this.silenceCount = 0
            }
            if (this.silenceCount >= this.hangoverFrames || this.framesInSpeech >= this.maxUtterFrames) {
              this.setVadState(false)
              this.silenceCount = 0
              this.preBuf.length = 0
              this.framesInSpeech = 0
            }
          }

          // ship 20ms frame
          const frame = new Int16Array(this._buf)
          this.port.postMessage(new Uint8Array(frame.buffer))
          this._buf.length = 0
        }
      }
    }
    return true
  }
}
registerProcessor('recorder-worklet', RecorderWorkletProcessor)
