# YouTube Transcript Engine

Production transcript retrieval with automatic provider fallbacks for Clyra chat.

## Providers

1. **youtube-transcript-api** — manual captions preferred, then automatic
2. **caption-track** — YouTube player metadata + caption file endpoints
3. **youtube-data-api** — pluggable stub (enable with `YOUTUBE_DATA_API_KEY`)

## CLI

```bash
python3 -m youtube_transcript_engine "https://youtu.be/DZoeGR_tatA" --verbose
```

## API

`POST /api/research/youtube` with `{ "url": "...", "preferredLanguages": ["en"] }`

## Tests

```bash
python3 -m unittest youtube_transcript_engine.tests.test_engine -v
```
