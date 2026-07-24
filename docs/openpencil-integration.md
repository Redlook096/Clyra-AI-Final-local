# OpenPencil Integration

## Architecture

Clyra pins OpenPencil commit
`7686be652fee8d4d55c42e75b21ad2199d28a5e5` and clones it recursively into the
ignored `.cache/openpencil` directory. This keeps nested Git metadata and the
large Rust build outside the application source while preserving a reproducible
upstream checkout and its licence files.

The runtime flow is:

```text
Vibe Coder /design command
  -> Clyra /api/openpencil/design
  -> local OpenPencil /api/ai/standard
  -> OpenPencil model adapter
  -> Clyra /api/openpencil/v1/chat/completions
  -> existing OpenAI-compatible provider configuration
```

The OpenPencil editor itself is a Rust/WASM canvas served on loopback at
`http://127.0.0.1:3100`. Clyra embeds that editor as the live Vibe design
workspace. OpenPencil receives a localhost-only adapter token; the real
`DEEPSEEK_API_KEY` stays in the Clyra Node process.

## Setup And Startup

```bash
npm install
npm run setup:openpencil
npm run check:openpencil
npm run dev
```

`npm run setup:openpencil` clones the pinned commit, initializes submodules, and
provisions the built-in Clyra model adapter. `npm run dev` starts both Clyra and
the OpenPencil web host and shuts down the sibling process if either exits.

Use `npm run dev:openpencil` when only the canvas host is needed. Set
`OPENPENCIL_HOST`, `OPENPENCIL_PORT`, or `OPENPENCIL_URL` to resolve a local port
conflict. The default host must remain loopback for normal development.

## Vibe Workflow

- Send `/design Create ...` in Vibe Coder to open a new live design workspace.
- Choose Web app, Website, Desktop, or Mobile before generation.
- Send another prompt in the design workspace to refine the active document.
- Generation is streamed as OpenPencil canvas operations rather than replaced
  by a static mock preview.
- Projects and `.op` documents use OpenPencil's local persistence and export
  facilities.

OpenPencil's own keyboard and canvas controls remain available inside the
workspace. Screenshot understanding is not advertised when the configured
model is text-only.

## Health And Troubleshooting

- OpenPencil health: `GET http://127.0.0.1:3100/api/mcp/server`
- Clyra integration health: `GET http://localhost:3000/api/openpencil/health`
- Dependency doctor: `npm run check:openpencil`

If CanvasKit or WASM fails to load, remove `.cache/openpencil/crates/op-host-web/pkg`
and rerun `npm run dev:openpencil`. The first native build can take several
minutes; later starts reuse the release server and WASM bundle.

## Security And Limits

- Provider credentials are server-side and are not persisted in OpenPencil
  documents or browser storage.
- Imported design files and generated code must be treated as untrusted.
- The canvas host binds to `127.0.0.1` by default.
- One design generation is intended at a time on 8 GB systems.
- The configured text model can generate and edit structured designs but cannot
  inspect arbitrary screenshots without an already configured vision-capable
  provider.
- OpenPencil is an upstream project; its licence and submodule notices remain in
  the pinned checkout.
