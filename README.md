# Review Room — unlimited chess game review PWA

A self-hosted, install-anywhere game review tool. Upload your chess.com PGN export (one game or fifty), pick a game, and step through every move with engine verdicts, best-move arrows, an eval bar, coach commentary, and a "guess the move" training mode. No daily limit, no account, everything runs on your device.

## What's inside

- **Engine**: Stockfish (WebAssembly) bundled locally — analyzes in your browser, works offline.
- **Verdicts**: Brilliant / Great / Best / Excellent / Good / Inaccuracy / Mistake / Missed win / Blunder, using the same win-percentage model Lichess uses.
- **Accuracy %** per player, per game.
- **Coach panel**: instant plain-language explanation for every move (both sides), plus an optional "Ask coach (AI)" button that calls the AI provider of your choice with your own key.
- **Guess mode**: at each of your mistakes, the board pauses and asks you to find the better move before revealing it.
- **Multi-game picker**: opponent, ratings, your color, W/L/D, result, and date for every game in the file.
- **PWA**: installable on macOS, Windows, Android, and iOS; fully offline after first load (except AI calls).

## Hosting (one-time, ~3 minutes)

A PWA must be served over **HTTPS** (or `localhost`). Opening `index.html` directly from disk will not work — the engine worker and service worker require a server.

### Option A — GitHub Pages (recommended: free, HTTPS, all your devices)
1. Create a repo (public or private with Pages enabled), e.g. `review-room`.
2. Push the contents of this folder to the repo root (or a `/docs` folder).
3. Repo → Settings → Pages → deploy from branch → select branch/folder → Save.
4. Open `https://<your-username>.github.io/review-room/` on any device.

### Option B — local network (quick test)
```bash
cd review-room
python3 -m http.server 8080
# open http://localhost:8080
```
Note: on `localhost` everything works including install; other devices on your LAN will get HTTP, which blocks PWA install but the app itself still runs.

### Option C — Netlify / Vercel / Cloudflare Pages
Drag-and-drop the folder. Done.

## Installing as an app

- **Desktop Chrome/Edge**: install icon in the address bar → Install.
- **Android Chrome**: menu → "Add to Home screen" / "Install app".
- **iOS Safari**: Share → "Add to Home Screen".

## AI coach setup (optional)

Settings (⚙) → pick a provider, paste your API key, save. Keys are stored in `localStorage` on that device only and are sent only to the provider you chose.

| Provider | Works from browser? | Notes |
|---|---|---|
| Anthropic | Yes | Uses the direct-browser-access header |
| Google Gemini | Yes | Key goes in the request URL |
| OpenRouter | Yes | Easiest way to try many models with one key |
| OpenAI | Usually | Some org policies block browser (CORS) calls |
| Custom | Depends | Any OpenAI-compatible endpoint (Ollama, LM Studio, your own proxy) |

If a provider blocks browser calls, use OpenRouter or a small proxy.

## Usage tips

- Set your username in Settings once — the board auto-orients to your side and the game list tags your wins/losses.
- Keyboard: `←` `→` step, `Home`/`End` jump, `F` flip, `G` toggle guess mode.
- Analysis is cached per game per depth — re-opening an analyzed game is instant. Changing depth re-analyzes.
- Depth 12 is the sweet spot. Depth 14 on a phone takes a few minutes per game.

## Privacy

Games, analysis, settings, and API keys never leave the device except the AI calls you explicitly trigger, which go directly from your browser to your chosen provider.
