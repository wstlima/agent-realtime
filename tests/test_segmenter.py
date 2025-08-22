import sys
from pathlib import Path

import numpy as np

sys.path.append(str(Path(__file__).resolve().parents[1]))
from asr.server import Segmenter


def generate_pcm(sr: int, speech_duration: float = 1.0, silence_duration: float = 1.0) -> bytes:
    t = np.arange(int(sr * speech_duration), dtype=np.float32) / sr
    speech = 0.5 * np.sin(2 * np.pi * 440 * t)
    speech_pcm = (speech * 32767).astype(np.int16)
    silence_pcm = np.zeros(int(sr * silence_duration), dtype=np.int16)
    audio = np.concatenate([speech_pcm, silence_pcm])
    return audio.tobytes()


def feed_audio(seg: Segmenter, pcm: bytes):
    out = None
    frame_bytes = seg.frame_bytes
    for i in range(0, len(pcm) - (len(pcm) % frame_bytes), frame_bytes):
        frame = pcm[i : i + frame_bytes]
        out = seg.push(frame)
        if out is not None:
            break
    return out


def _assert_detects(sr: int):
    seg = Segmenter(sr=sr)
    pcm = generate_pcm(sr)
    out = feed_audio(seg, pcm)
    assert out is not None
    audio = np.frombuffer(out, dtype=np.int16)
    # ensure there is speech content (non-zero amplitude)
    assert np.max(np.abs(audio)) > 0


def test_segmenter_detects_8kHz_and_16kHz():
    _assert_detects(8000)
    _assert_detects(16000)
