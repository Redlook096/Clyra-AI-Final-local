<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Clyra AI

Clyra is a local-first AI workspace containing Chat, Vibe Coder, AI Browser,
AI Clip, creator tools, Study Pal, voice calling, and an OpenPencil-backed
design canvas.

## Run Locally

Prerequisites: Node.js 18+, Rust/Cargo, Bun 1+, `wasm-bindgen`, and `wasm-opt`.
FFmpeg is required for creator video exports.

1. Install JavaScript dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and set `DEEPSEEK_API_KEY`.
3. Prepare the pinned OpenPencil source: `npm run setup:openpencil`
4. Verify local prerequisites: `npm run check:openpencil`
5. Start the complete workspace: `npm run dev`

The application opens at `http://localhost:3000`. OpenPencil binds only to
`http://127.0.0.1:3100` by default and is mounted inside Vibe Coder with
`/design <request>`. It uses the existing Clyra server-side model adapter, so
users never enter another provider key and the configured key is never added to
the browser bundle.

## Commands

- `npm run dev`: start Clyra's Vite-middleware server plus OpenPencil.
- `npm run dev:source`: start Clyra with Vite middleware for frontend work.
- `npm run dev:openpencil`: start only the local design canvas.
- `npm run build`: build the frontend and Node server.
- `npm run lint`: run TypeScript checks.
- `npm run test:creator`: test creator project, gameplay, timing, and migration logic.
- `npm run test:browser`: test the real Playwright browser runtime against local fixtures.
- `npm run test:voice`: test speech normalization, phrase segmentation, PCM packets, and microphone cleanup.
- `npm run test:clipper`: test candidate extraction and clip diversity.

See [docs/openpencil-integration.md](docs/openpencil-integration.md) for the
design canvas architecture, setup, security boundaries, and limitations.
