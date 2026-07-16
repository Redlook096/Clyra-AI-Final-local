"""Voice activity detection — Silero when available, energy VAD fallback."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

import config


@dataclass
class VadResult:
    is_speech: bool
    probability: float


class VoiceActivityDetector:
    def __init__(self, sample_rate: int = config.SAMPLE_RATE, threshold: float = config.VAD_THRESHOLD):
        self.sample_rate = sample_rate
        self.threshold = threshold
        self._model = None
        self._backend = "energy"
        self._load_silero()

    def _load_silero(self) -> None:
        import os

        # Energy is the reliable default for short streaming frames. Silero is
        # available via VOICE_VAD_BACKEND=silero|auto when it outperforms locally.
        backend = os.getenv("VOICE_VAD_BACKEND", "energy").lower()
        if backend == "energy":
            self._model = None
            self._backend = "energy"
            return
        if backend not in ("silero", "auto"):
            self._model = None
            self._backend = "energy"
            return
        try:
            import torch

            model, _utils = torch.hub.load(
                repo_or_dir="snakers4/silero-vad",
                model="silero_vad",
                trust_repo=True,
                onnx=False,
            )
            self._model = model
            self._backend = "silero"
        except Exception:
            self._model = None
            self._backend = "energy"

    @property
    def backend(self) -> str:
        return self._backend

    def _energy_prob(self, pcm: np.ndarray) -> float:
        if pcm.size == 0:
            return 0.0
        rms = float(np.sqrt(np.mean(np.square(pcm.astype(np.float32)))))
        return max(0.0, min(1.0, (rms - 0.01) / 0.12))

    def score(self, pcm_f32: np.ndarray) -> VadResult:
        if self._model is None:
            prob = self._energy_prob(pcm_f32)
            return VadResult(is_speech=prob >= self.threshold * 0.7, probability=prob)

        try:
            import torch

            audio = torch.from_numpy(pcm_f32.astype(np.float32))
            if audio.ndim > 1:
                audio = audio.mean(dim=-1)
            frame = 512
            if audio.numel() < frame:
                audio = torch.nn.functional.pad(audio, (0, frame - audio.numel()))
            elif audio.numel() > frame * 8:
                audio = audio[-frame * 8 :]
            rem = audio.numel() % frame
            if rem:
                audio = audio[:-rem]
            probs = []
            for i in range(0, audio.numel(), frame):
                chunk = audio[i : i + frame]
                if chunk.numel() < frame:
                    break
                with torch.no_grad():
                    probs.append(float(self._model(chunk, self.sample_rate).item()))
            prob = float(sum(probs) / len(probs)) if probs else 0.0
            return VadResult(is_speech=prob >= self.threshold, probability=prob)
        except Exception:
            prob = self._energy_prob(pcm_f32)
            return VadResult(is_speech=prob >= self.threshold * 0.7, probability=prob)
