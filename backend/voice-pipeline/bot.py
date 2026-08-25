"""Builds and runs one Clyra voice call as a Pipecat pipeline.

    transport.input() -> Silero VAD/turn detection -> Fish STT
    -> user context aggregator -> LLM (DeepSeek, or the Test Mode echo route)
    -> Fish TTS -> transport.output() -> assistant context aggregator

RTVI state/transcript events (connection, user/bot speaking, transcripts) are
emitted automatically by `PipelineTask(enable_rtvi=True)` over the WebRTC
data channel, which the `@pipecat-ai/client-react` frontend consumes.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.fish.tts import FishAudioTTSService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from config import VoiceConfig
from fish_stt import FishASRSTTService

ECHO_MODEL = "echo-1"


def _build_llm(config: VoiceConfig, test_mode: bool, llm_model: str | None) -> OpenAILLMService:
    if test_mode:
        # Loopback route served by this same process (see echo_llm.py) --
        # DeepSeek is never contacted while Test Mode is on.
        return OpenAILLMService(
            api_key="test-mode",
            base_url=f"http://127.0.0.1:{config.port}/echo/v1",
            model=ECHO_MODEL,
        )
    return OpenAILLMService(
        api_key=config.llm_api_key,
        base_url=config.llm_base_url,
        model=llm_model or config.llm_model,
    )


async def run_bot(
    connection: SmallWebRTCConnection,
    config: VoiceConfig,
    *,
    system_prompt: str,
    history: list[dict[str, Any]],
    test_mode: bool,
    llm_model: str | None,
) -> None:
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
        ),
    )

    stt = FishASRSTTService(
        api_key=config.fish_api_key,
        sample_rate=config.sample_rate,
    )

    llm = _build_llm(config, test_mode, llm_model)

    tts = FishAudioTTSService(
        api_key=config.fish_api_key,
        reference_id=config.fish_reference_id,
        model_id=config.fish_tts_model,
    )

    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for turn in history[-24:]:
        role = turn.get("role")
        content = turn.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            messages.append({"role": role, "content": content.strip()})

    context = OpenAILLMContext(messages)
    context_aggregator = llm.create_context_aggregator(context)

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            context_aggregator.user(),
            llm,
            tts,
            transport.output(),
            context_aggregator.assistant(),
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            allow_interruptions=True,
            audio_in_sample_rate=config.sample_rate,
        ),
        enable_rtvi=True,
    )

    @connection.event_handler("closed")
    async def _on_closed(_connection: SmallWebRTCConnection):
        logger.info(f"[voice] connection closed ({connection.pc_id})")
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)
