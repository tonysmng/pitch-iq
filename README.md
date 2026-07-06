# Pitch IQ — World Cup 2026 companion

A single-file web app that makes you feel caught up on the World Cup in three minutes:
storylines and context first, numbers second. Built for someone new to following soccer.

**Live site:** https://tonysmng.github.io/pitch-iq/
(published from `index.html` via GitHub Pages)

Data snapshot: **July 5, 2026, ~8:00 PM ET** (Round of 16). Every stat was researched
and cross-checked; anything unverified is shown as `—` rather than guessed.

## What it does

- **Dashboard** — current stage, days to the final, the tournament's three biggest storylines, the leaders, next matches.
- **Players** — 56 players with photos and squad numbers. Filter, search, and sort by goals / assists / saves (a real leaderboard with rank badges). ★ follow players and they float to the top.
- **Player profile** — a broadcast-style photo hero, storylines written like a sharp friend, position-aware stats, and a **journey map** (born → club → country).
- **Ask about a player** — type any question; you get an answer *and* a one-line version is saved to that player's profile, so what you know about them grows over time with your curiosity.
- **Track a new player** — name anyone at the tournament and the app researches a full profile and starts following them.
- **Bracket + what-if simulator** — the live bracket plus title-odds bars; pin any upcoming winner and every downstream probability recomputes exactly.
- **Catch me up** — a 60-second briefing built from the data (with an optional AI-written version).

## AI features & your API key

The ask, track-a-player, AI digest, and live refresh features call Claude directly from
your browser. On this self-hosted site you supply your own Anthropic API key once, in
**Settings** (the gear, top right). The key is stored only in your browser (IndexedDB),
never in the code and never shared. Get one at console.anthropic.com → API Keys; a
question costs well under a cent. Everything else in the app works with no key at all.

## Refreshing the data through the July 19 final

Two ways to keep it current:

1. **In-app** (needs your key): the **Catch up → Refresh** panel re-searches results,
   leaders, and storylines and merges them in.
2. **Rebuild from research** (this repo): re-run the research, then
   `python3 gen_data.py && python3 build.py` regenerates `index.html`. Bump `meta.rev`
   in `gen_data.py` so browsers adopt the new data over their saved copy.

## Rebuilding locally

```
python3 fetch_photos.py     # optional: refresh player headshots (Wikipedia, CC-licensed)
python3 gen_data.py         # merge research JSON + photos + numbers -> src/data.js
python3 build.py            # assemble src/* + fonts + map -> index.html
```

- `src/app.js` — all app logic (vanilla JS, no framework, no build step)
- `src/style.css` — design system
- `src/data.js` — the `DATA` object (generated; do not hand-edit)
- `research/` — the verified source JSON the data was built from
- `fonts/`, `geo/` — embedded webfonts and the hand-simplified world map

No dependencies, no tracking, no backend. One HTML file.
