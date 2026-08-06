# Study Brain rebuild plan

## Checkpoint

Work continues on `cursor/cloud-agent-1785967706511-z2oxf` (existing cloud agent branch). No second Google OAuth.

## Goal

Replace Study Pal’s tabbed prototype with **Clyra Study Brain**: an XYFlow infinite canvas where sources connect to a central Brain node, with chat-parity Ask UI and generation tools that reuse existing Clyra YouTube + Google + `/api/study/*` paths.

## Reuse (do not reinvent)

| Capability | Existing path |
| --- | --- |
| YouTube captions / analysis | `POST /api/research/youtube` + `youtube_transcript_engine` |
| Google Docs / Slides / Sheets / Drive | Electron `desktop.google.execute` (same as chat) |
| Study LLM tools | `/api/study/ask|quiz|flashcards|notes|fetch` |
| Chat visual language | `#fbfbfa`, `#18212f`, `#0052fb`, `#aec7f1`, thin borders |
| Canvas library | `@xyflow/react` (already in package.json) |

## Architecture

```
src/components/study-brain/
  StudyBrainWorkspace.tsx     # shell: sidebar + canvas + inspector + composer
  BrainCanvas.tsx             # React Flow graph, edges, toolbar
  nodes/BrainNode.tsx         # central node + drag-out action fan
  nodes/SourceNode.tsx        # thin document tiles
  InspectorPanel.tsx          # source detail / materials
  AskComposer.tsx             # chat-parity bottom ask
  materials/*.tsx             # quiz / flashcards / guide panels
lib/study-brain/
  types.ts                    # Brain, Source, Edge, Materials
  storage.ts                  # localStorage autosave (v4)
  ingest.ts                   # client helpers: youtube, url, text, google
server.ts                     # thin /api/study/ingest router (youtube + url + text)
```

## Source ingestion

1. **URL / website** → existing `/api/study/fetch`
2. **YouTube** → `/api/research/youtube` → transcript body + timestamps in metadata
3. **Google Docs/Slides/Sheets/Drive** → `desktop.google.execute` with a read prompt; surface needsAuth like chat
4. **Text / Markdown / paste** → local FileReader
5. **PDF / images** → extract text when possible (`pdftotext` / OCR fallback); otherwise guided paste with clear status

Every source becomes structured text chunks stored on the node; Ask uses selected/connected sources only (citation indexes `[S1]`… as today).

## Canvas UX

- Pan / zoom / minimap / snap / multi-select
- Connect sources → Brain with smooth bezier edges
- Drag outward from Brain to reveal action fan: Ask · Quiz · Flashcards · Study guide · Notes
- Processing states: Uploading → Extracting → Indexing → Ready (real, not fake)

## UI rules

Warm off-white, white canvas, charcoal text, thin 1px borders, 8–12px controls, no AI slop (no neon glow, thick cards, sparkle clutter). Brain pulse only while processing.

## Tests

1. Unit: storage round-trip, ingest URL classification, citation parsing
2. Playwright smoke: create brain, add source card, connect edge, open ask
3. Manual: Electron Google + YouTube when credentials available

## Out of scope for this pass (follow-ups)

- Full WhisperX local transcription pipeline (use YouTube captions path first)
- Persistent vector DB (chunk+keyword retrieval over connected bodies first; wire embeddings later)
- FSRS full scheduler (confidence + due date fields in flashcards; expand later)
