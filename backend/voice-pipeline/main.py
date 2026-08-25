"""Clyra voice worker: Pipecat + SmallWebRTCTransport + Fish Audio + DeepSeek.

Started by `server.ts`'s `ensureVoicePipelineWorker()` (uvicorn main:app on
127.0.0.1:8787, unreachable from outside localhost). Node's
`POST /voice/offer` route is the only caller of `/api/offer`; it forwards the
browser's WebRTC SDP offer plus the session's system prompt/history/model
choice that Node already built.

Request/response shape matches `@pipecat-ai/small-webrtc-transport`'s wire
protocol exactly (it builds this request itself): the offer's `pc_id` is
omitted on a first connect and present on a reconnect/renegotiation, and our
app-specific fields travel inside `requestData` rather than at the top level.
"""

from __future__ import annotations

import asyncio

from aiortc.sdp import candidate_from_sdp
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from config import load_config
from echo_llm import router as echo_router
from bot import run_bot

from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection

app = FastAPI(title="Clyra Voice Pipeline", version="3.0.0")
app.include_router(echo_router)

config = load_config()

# pc_id -> connection, so a reconnect/renegotiate offer (same pc_id) attaches
# to the existing bot pipeline instead of starting a second one.
connections: dict[str, SmallWebRTCConnection] = {}


class VoiceRequestData(BaseModel):
    sessionId: str
    systemPrompt: str = ""
    history: list[dict] = []
    testMode: bool = False
    llmModel: str | None = None


class OfferRequest(BaseModel):
    sdp: str
    type: str = "offer"
    pc_id: str | None = None
    requestData: VoiceRequestData


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "architecture": {
            "transport": "pipecat-smallwebrtc",
            "stt": "fish-audio",
            "tts": "fish-audio",
            "llm": "deepseek (or in-process echo route in Test Mode)",
        },
        "fish_configured": bool(config.fish_api_key),
        "llm_configured": bool(config.llm_api_key),
        "sample_rate": config.sample_rate,
    }


@app.post("/api/offer")
async def offer(body: OfferRequest) -> JSONResponse:
    existing = connections.get(body.pc_id) if body.pc_id else None
    if existing:
        await existing.renegotiate(sdp=body.sdp, type=body.type)
        return JSONResponse(existing.get_answer())

    connection = SmallWebRTCConnection()
    await connection.initialize(sdp=body.sdp, type=body.type)
    connections[connection.pc_id] = connection
    answer = connection.get_answer()

    @connection.event_handler("closed")
    async def _forget(_connection: SmallWebRTCConnection):
        connections.pop(connection.pc_id, None)

    asyncio.create_task(
        run_bot(
            connection,
            config,
            system_prompt=body.requestData.systemPrompt,
            history=body.requestData.history,
            test_mode=body.requestData.testMode,
            llm_model=body.requestData.llmModel,
        )
    )

    return JSONResponse(answer)


class IceCandidateEntry(BaseModel):
    candidate: str
    sdp_mid: str | None = None
    sdp_mline_index: int | None = None


class IceCandidatesRequest(BaseModel):
    # The client can PATCH a trickled candidate before its own POST /api/offer
    # response (carrying pc_id) has come back, in which case it sends null.
    pc_id: str | None = None
    candidates: list[IceCandidateEntry]


@app.patch("/api/offer")
async def ice_candidates(body: IceCandidatesRequest) -> JSONResponse:
    # Trickle-ICE candidates sent after the initial offer/answer. Our
    # `initialize()` above already waits for full ICE gathering, so this is
    # a non-fatal best-effort add for candidates discovered afterward (e.g.
    # after a network change) rather than something the call depends on.
    connection = connections.get(body.pc_id) if body.pc_id else None
    if not connection:
        return JSONResponse({"ok": False}, status_code=404)
    for entry in body.candidates:
        try:
            candidate = candidate_from_sdp(entry.candidate.split(":", 1)[-1])
            candidate.sdpMid = entry.sdp_mid
            candidate.sdpMLineIndex = entry.sdp_mline_index
            await connection.add_ice_candidate(candidate)
        except Exception:
            continue
    return JSONResponse({"ok": True})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=config.port)
