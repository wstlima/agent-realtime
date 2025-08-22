import asyncio, json, os, time, logging
from typing import Optional
from contextlib import asynccontextmanager

import numpy as np, webrtcvad
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

LOG_LEVEL = os.environ.get("LOG_LEVEL","INFO").upper()
logging.basicConfig(level=LOG_LEVEL)
log = logging.getLogger("asr")

HOST = os.environ.get("HOST","0.0.0.0")
PORT = int(os.environ.get("PORT","9000"))
DEFAULT_LANG = os.environ.get("ASR_LANG","pt")

@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.environ.get("ASR_EAGER_LOAD","false").lower() in ("1","true","yes"):
        get_model()
    yield

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_model = None
def get_model():
    global _model
    if _model is None:
        mname = os.environ.get("ASR_MODEL","base")
        log.info(f"loading whisper model: {mname}")
        _model = WhisperModel(mname, device="cpu", compute_type="int8")
    return _model

def pcm16_to_float32(pcm16: bytes):
    a = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32)
    return a / 32768.0

class Segmenter:
    def __init__(self, sr=16000, aggr=1, pre_ms=200, silence_ms=600):
        self.sr = sr
        self.vad = webrtcvad.Vad(int(aggr))
        self.frame_bytes = int(sr*0.02)*2
        self.pre_frames = pre_ms // 20
        self.sil_frames = silence_ms // 20
        from collections import deque
        self.pre = deque(maxlen=self.pre_frames)
        self.buf = bytearray()
        self.in_speech = False
        self.sil_count = 0

    def push(self, frame: bytes) -> Optional[bytes]:
        if len(frame) != self.frame_bytes:
            return None
        is_speech = False
        try:
            is_speech = self.vad.is_speech(frame, sample_rate=self.sr)
        except Exception:
            pass
        if not self.in_speech:
            self.pre.append(frame)
            if is_speech:
                self.in_speech = True
                self.buf.extend(b"".join(self.pre))
                self.pre.clear()
        else:
            self.buf.extend(frame)
            if not is_speech:
                self.sil_count += 1
                if self.sil_count >= self.sil_frames:
                    out = bytes(self.buf)
                    self.buf.clear()
                    self.sil_count = 0
                    self.in_speech = False
                    return out
            else:
                self.sil_count = 0
        return None

@app.get("/health")
async def health():
    return {"status":"ok"}

@app.websocket("/asr")
async def asr_socket(ws: WebSocket):
    await ws.accept()
    cfg = {"sample_rate":16000, "language":DEFAULT_LANG}
    seg = Segmenter(sr=16000)
    closed = False

    async def safe_close(code: int = 1000, reason: str = "normal"):
        nonlocal closed
        if closed:
            return
        closed = True
        try:
            await ws.close(code=code, reason=reason)
        except Exception:
            pass

    try:
        prebuf = bytearray()
        start = None
        # Aguarda 'start' e pré-bufferiza bytes iniciais
        while True:
            m = await ws.receive()
            if m.get("text") is not None:
                try: j = json.loads(m["text"])
                except Exception: continue
                if j.get("op") == "start":
                    start = j
                    vad = (start or {}).get("vad", {}) or {}
                    seg = Segmenter(sr=16000,
                                    aggr=int(vad.get("aggr",1)),
                                    pre_ms=int(vad.get("pre_ms",200)),
                                    silence_ms=int(vad.get("silence_ms",600)))
                    break
            elif m.get("bytes"):
                prebuf.extend(m["bytes"])
            else:
                continue

        # Sinaliza pronto
        try:
            await ws.send_text(json.dumps({"event":"status","state":"ready"}))
        except Exception:
            await safe_close(); return

        # Drena pré-buffer em frames de 20ms
        frame_bytes = int(cfg["sample_rate"]*0.02)*2
        usable = len(prebuf) - (len(prebuf)%frame_bytes)
        if usable > 0:
            mem = memoryview(prebuf)[:usable]
            for i in range(0, usable, frame_bytes):
                out = seg.push(mem[i:i+frame_bytes].tobytes())
                if out:
                    await handle_segment(ws, out, cfg["language"])

        # Loop principal
        while True:
            m = await ws.receive()

            # Cliente desconectou → flush final antes de sair
            if m.get("type") == "websocket.disconnect":
                if seg.buf:
                    out = bytes(seg.buf)
                    seg.buf.clear(); seg.in_speech = False; seg.sil_count = 0
                    await handle_segment(ws, out, cfg["language"])
                break

            if m.get("text") is not None:
                try: j = json.loads(m["text"])
                except Exception: continue
                op = j.get("op")

                if op == "flush":
                    if seg.buf:
                        out = bytes(seg.buf)
                        seg.buf.clear(); seg.in_speech = False; seg.sil_count = 0
                        await handle_segment(ws, out, cfg["language"])

                elif op == "stop":
                    # flush antes de parar
                    if seg.buf:
                        out = bytes(seg.buf)
                        seg.buf.clear(); seg.in_speech = False; seg.sil_count = 0
                        await handle_segment(ws, out, cfg["language"])
                    break

                else:
                    try:
                        await ws.send_text(json.dumps({"event":"error","message":"bad_op"}))
                    except Exception:
                        pass

            elif m.get("bytes"):
                b = m["bytes"]
                usable = len(b) - (len(b)%frame_bytes)
                if usable <= 0: continue
                mem = memoryview(b)[:usable]
                for i in range(0, usable, frame_bytes):
                    out = seg.push(mem[i:i+frame_bytes].tobytes())
                    if out:
                        await handle_segment(ws, out, cfg["language"])

    except Exception as e:
        log.exception("asr_ws_error")
        try: await ws.send_text(json.dumps({"event":"error","message":str(e)}))
        except Exception: pass
    finally:
        await safe_close()

async def handle_segment(ws: WebSocket, pcm16: bytes, language: str):
    audio = pcm16_to_float32(pcm16)
    t0 = time.perf_counter()
    segments, info = get_model().transcribe(
        audio, language=language, vad_filter=False, beam_size=1
    )
    text = "".join(s.text for s in segments).strip()
    dt_ms = int((time.perf_counter()-t0)*1000)
    try:
        if text:
            await ws.send_text(json.dumps({"event":"final","text":text,"dt_ms":dt_ms}))
        else:
            await ws.send_text(json.dumps({"event":"partial","text":""}))
    except Exception:
        # se o cliente fechou, ignore
        pass
