"""Test Mode "LLM": an in-process OpenAI-compatible endpoint that streams
back exactly what it was asked, instead of calling DeepSeek.

`bot.py` still uses the real, unmodified `OpenAILLMService` for this stage
when Test Mode is on -- it just points its `base_url` at this loopback route
instead of DeepSeek's. That means every other part of the LLM stage (context
aggregation, streaming, first-token metrics, barge-in cancelling the
in-flight request) runs through pipecat's real, tested code path; only the
network destination changes, and it never leaves the machine.
"""

from __future__ import annotations

import json
import time
import uuid

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter()


def _sse_chunk(request_id: str, model: str, content: str | None, finish_reason: str | None) -> str:
    payload = {
        "id": request_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": ({"content": content} if content is not None else {}),
                "finish_reason": finish_reason,
            }
        ],
    }
    return f"data: {json.dumps(payload)}\n\n"


async def _stream_echo(text: str, model: str):
    request_id = f"echo-{uuid.uuid4().hex[:12]}"
    words = text.split(" ") if text else [""]
    for index, word in enumerate(words):
        piece = word if index == 0 else f" {word}"
        yield _sse_chunk(request_id, model, piece, None)
    yield _sse_chunk(request_id, model, None, "stop")
    yield "data: [DONE]\n\n"


@router.post("/echo/v1/chat/completions")
async def echo_chat_completions(request: Request):
    body = await request.json()
    messages = body.get("messages") or []
    last_user = next(
        (m.get("content") for m in reversed(messages) if m.get("role") == "user" and m.get("content")),
        "",
    )
    text = str(last_user or "I didn't catch that.").strip()
    model = str(body.get("model") or "echo-1")
    return StreamingResponse(_stream_echo(text, model), media_type="text/event-stream")
