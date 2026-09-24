---
name: minimax-h3
description: MiniMax H3 video generation. Submit t2va / i2va / fl2va / l2va / ref2va tasks through the local /h3/videos endpoint, poll status, and download MP4. Use h3-prompt-writing to rewrite prompts and the 8 video style skills (3d-animation, brand-promo, etc.) for visual flavor. No local GPU; generation is delegated to the MiniMax Open Platform via H3_API_KEY.
---

# minimax-h3 (local skill)

## Endpoints (exposed by server.js on :8082)

| Method | Path                       | Purpose                                          |
|--------|----------------------------|--------------------------------------------------|
| GET    | `/h3/health`               | Liveness, shows `apiKeySet`                      |
| POST   | `/h3/videos`               | Submit a video job                               |
| GET    | `/h3/videos/:id`           | Poll job status (Pending / Processing / Completed / Failed) |
| GET    | `/h3/videos/:id/download`  | Stream the MP4 once Completed                    |

## Auth

Set `H3_API_KEY` in `config/skills.json` (or as environment variable) before invoking.
The Open Platform base URL defaults to `https://api.minimaxi.com` and is overridable via `H3_API_BASE`.

## Workflow

1. Use `h3-prompt-writing` SKILL to rewrite the user's natural language into H3's required
   `integrated_multimodal_description` + `overall_soundscape` + `non_diegetic_music` structure.
2. Optionally load one of the eight `*-generator` SKILL.md files for visual flavor:
   `3d-animation-short-generator`, `brand-promo-video-generator`, `co-op-game-intro-generator`,
   `handdrawn-live-video-generator`, `minimalist-product-ad-generator`,
   `music-video-subtitle-generator`, `paper-collage-explainer-generator`,
   `papercraft-stop-motion-explainer`.
3. POST to `/h3/videos` with the rewritten prompt and a target spec:
   ```json
   { "task": "t2va",
     "prompt": "<rewritten prompt>",
     "target": { "short_edge": 768, "aspect_ratio": "16:9", "duration_seconds": 10 },
     "seed": 0 }
   ```
4. Poll `/h3/videos/:id` until `status === "completed"`.
5. GET `/h3/videos/:id/download` to fetch the MP4 into `outputs/<id>.mp4`.

## Constraints

- Output duration must be 4–15 seconds.
- `short_edge` 256–2048; aspect_ratio ∈ {21:9, 16:9, 4:3, 1:1, 3:4, 9:16}.
- Conditions (images, videos, audio refs) are passed as a list — see `lib/h3/client.js`.

## What this skill does NOT do

- It does not run the 33B model locally (this container has no GPU).
- It does not download HuggingFace weights; use Open Platform for inference.