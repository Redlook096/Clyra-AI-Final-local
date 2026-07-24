# Browser Agent UI

The agent chat lives in Clyra's existing right-side panel. The user input bar
at the bottom is unchanged.

## Cards

1. **Task goal** — goal text + live status pill + Pause / Resume / Take Control / Stop.
2. **Plan checklist** — ✓ done / ● active / ○ pending; completed steps collapse.
3. **Reasoning** — verdict icon, `next_goal` headline, muted memory.
4. **Action rows** — one-line labels with icons; expandable raw details.
5. **Recovery** — amber card describing the next attempt.
6. **Strategy change** — shown when loop detection fires.
7. **Ask user** — permission / clarification card with the existing reply path.
8. **Completion** — green/rose summary with final URL, title, and evidence checks.

Thinking states use `ShiningText` / `ThinkingDots`. Density stays compact for
the ~310–430px panel width. Theme is light: white / slate-50 surfaces,
slate-200 borders, sky accents.

## Visible cursor

The overlay cursor, action card, and real CDP click share the same event
coordinates. The cursor has a sky glow halo, trailing motion, click ripple,
and an action label chip. While the agent is active the preview shows a soft
sky inner glow ring.
