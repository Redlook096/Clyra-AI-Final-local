# Intelligent Clipper Architecture

```text
validated source
  -> source-metadata.json
  -> transcript-words.json
  -> speech-regions.json + sentence/topic artifacts
  -> candidate generation + boundary repair
  -> ranked-clips.json (local transparent score + optional LLM enrichment)
  -> optional scene / visual tracks
  -> canonical edit-plan.json
  -> proxy preview / final FFmpeg render
  -> render-report.json
```

Artifacts are keyed by a source fingerprint and live under the clipper cache,
so an interrupted job can reuse completed analysis. The pipeline is sequential
on low-memory hardware: it never loads transcription, active-speaker analysis,
and final rendering together. The initial implementation preserves the current
renderer and installs no heavy dependency. Optional scene, VAD, and face-track
adapters must be feature-detected, bounded to selected ranges, and released
before final rendering.
