"""Configuration for the Clyra voice Pipecat worker.

STT + TTS: Fish Audio (https://fish.audio). LLM: existing DeepSeek /
OpenAI-compatible endpoint (unchanged from the rest of Clyra).
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class VoiceConfig:
    port: int
    sample_rate: int
    fish_api_key: str
    fish_reference_id: str | None
    fish_tts_model: str | None
    llm_base_url: str
    llm_api_key: str
    llm_model: str


def load_config() -> VoiceConfig:
    llm_api_key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("MY_LLM_API_KEY") or ""
    llm_base_url = (
        os.environ.get("MY_LLM_BASE_URL")
        or ("https://api.deepseek.com" if os.environ.get("DEEPSEEK_API_KEY") else "https://api.openai.com/v1")
    )
    llm_model = (
        os.environ.get("MY_LLM_MODEL")
        or os.environ.get("DEEPSEEK_MODEL")
        or ("deepseek-v4-flash" if os.environ.get("DEEPSEEK_API_KEY") else "gpt-4o-mini")
    )
    return VoiceConfig(
        port=int(os.environ.get("PIPELINE_PORT", os.environ.get("VOICE_PIPELINE_PORT", "8787"))),
        sample_rate=int(os.environ.get("VOICE_SAMPLE_RATE", "16000")),
        fish_api_key=os.environ.get("FISH_AUDIO_API_KEY", ""),
        fish_reference_id=os.environ.get("FISH_TTS_REFERENCE_ID") or None,
        fish_tts_model=os.environ.get("FISH_TTS_MODEL") or None,
        llm_base_url=llm_base_url,
        llm_api_key=llm_api_key,
        llm_model=llm_model,
    )
