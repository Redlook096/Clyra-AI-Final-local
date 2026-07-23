# PageLM Evaluation

Evaluated: 2026-07-23

## Source

- Repository: `https://github.com/CaviraOSS/PageLM`
- Checked-out commit: `736f22b9b1b194fc50d90b29337d04d99ba81172`
- Local reference checkout: `vendor-src/PageLM`

## What PageLM Provides

PageLM is a separate Node/React study product with document chat, notes,
flashcards, quizzes, podcasts, transcription, planning, exam practice, and
study companion workflows. Its backend is built around LangChain/LangGraph and
supports multiple hosted providers, optional vector storage, and its own
file-based persistence model.

The most relevant reference areas are:

- `backend/src/agents/*` for grouping study agents by capability.
- `backend/src/core/router.ts` for a workspace-oriented routing boundary.
- `frontend/src/*` for a source -> transform -> study-tool flow.

## Compatibility Decision

PageLM cannot be embedded or used as a replacement application inside Clyra:

1. `LICENSE.md` is the PageLM Community License. Its README states that
   commercial use or resale requires prior written permission.
2. It is a standalone application with a separate React frontend, backend,
   persistence model, provider configuration, and API-key handling.
3. It requires Node `>=21.18.0` and brings a large LangChain/LangGraph and
   multi-provider dependency graph that conflicts with Clyra's 8 GB resource
   budget and existing provider router.
4. Importing its code would duplicate Clyra's model, audio, document, and
   workspace services rather than improve the existing Study Pal surface.

## Safe Integration Direction

Keep Clyra Study Pal as the product surface and use PageLM only as a design
and capability reference. Future additions should be native Clyra features:

- source-grounded document conversations;
- notes, flashcards, quizzes, and study plans from the existing backend;
- explicit source citations and workspace-scoped artifacts;
- optional narrated summaries through Clyra's existing voice service.

No PageLM source, dependency, model, credential handling, or UI assets were
copied into Clyra. The checkout remains a vendor reference pending explicit
licensing approval for any deeper integration.
