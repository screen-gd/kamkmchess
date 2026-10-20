# kamkm chess

The homepage introduces the game with the original knight-versus-models artwork, animated black dither, a responsive sidebar and an interactive opening preview. Choose **Play against AI** to open the existing playable workspace at `/play`. Landing and gameplay share six themes and a saved light, dark or system appearance. Choose Appearance from the landing navigation or the game settings. They load separate styles and entry chunks. See [landing design notes](docs/design/landing.md) for the artwork, Quartz components and preview scope.

Chess against AI models that choose their own moves. The Classic workspace supports local two-player games and AI opponents, with device-local saves, continuous clocks, automatic connection checks, compact chess requests, complete conversation archives, Undo, and request recovery. Optional account storage remains disabled until its deployment is configured and verified.

**New game** also supports human versus engine, engine versus engine, engine versus AI, and AI versus AI. Choose each opponent independently. Stockfish Lite and full Stockfish download and check themselves when selected and run directly in your browser, with hardware-based recommendations, cached downloads, and adjustable thinking time. Only available engines appear in the picker. See [browser engine setup and implementation](docs/browser-engines.md).

The board uses Lichess's [Chessground](https://github.com/lichess-org/chessground) for animated moves, square-wide mouse and touch dragging, legal destinations, and previous-move highlights. The project is licensed under GPL-3.0-or-later, including its original application code. See [dependency and artwork notices](docs/dependency-notices.md). Distributions must include the exact corresponding source, available in this repository, along with the generated license notices.

Use Left/Right to review earlier or later moves, Home for the starting position, and End or **Live** to return to play. Moves in the list are clickable. Reviewing history leaves the live game and clocks running. During an AI turn, drag or click your piece to queue one premove. It plays only if legal after the reply; Escape, right-click, and **Cancel premove** clear it. Entering history or starting another game also clears queued input.

Right-drag draws green arrows and right-click marks circles. Hold Shift for red, Control for blue, or Alt for amber. Repeat a drawing to remove it, or left-click an empty square to clear drawings.

Legal moves, king safety, SAN and material checks use Lichess's **chessops 0.15.1**. Positions are classified synchronously; normal play creates no proof-search worker or graph. Draws use practical insufficient-material rules, repetition and the fifty-move rule. Timeouts use side-specific material and a bounded one-ply forced-outcome check. This replaces the former exhaustive dead-position search: unusual blocked positions can remain playable. Older pending saves are migrated automatically and their search data is dropped. The legacy proof tools remain for archive compatibility and offline fixtures. See [rules research and sources](docs/implementation/lichess-rules-research.md).

Each model move receives the current FEN and side, starting FEN with SAN move history, remaining clocks and increment, repeated-position counts when relevant, current-turn retry feedback, and the latest plan and returned reasoning for that side. Replies are asked to include a brief plan for the next turn. This rolling memory survives reloads and follows Undo; raw provider traffic and older thinking stay in the archive. Existing saved games use the same compact requests. See [model input policy](docs/spec/compact-model-input.md).

Choose **New** to set up a match in short steps. For AI play, connect a provider or proxy, choose an available model, and allow the destination once. The app loads the model list and checks the selected model automatically. Saved games automatically recheck their model before the next request after reload. Failed checks block play and offer a retry. The UI never asks for a model ID.

CLIProxyAPI defaults to `http://127.0.0.1:8317/v1`. OpenAI, OpenRouter, Anthropic, and custom connections are also available. Advanced connection settings include protocol, authentication, and catalog overrides. Custom endpoints default to a `/models` catalog. A provider must expose a reachable catalog to appear in the picker. Diagnostics and moves can use provider quota. Saved connections and credentials stay in the browser. Remote HTTPS endpoints outside the native provider origins use this site's stateless `/api/provider-relay`, including catalogs, diagnostics and streamed moves. The relay forwards the connection's API key per request without storing or logging it. It rejects private-network destinations, nonstandard ports and redirects. Native provider origins and local endpoints remain browser-direct.

For Ollama Cloud, choose **Custom**, enter `https://ollama.com/v1` and your API key, connect, and choose an advertised model. No CORS configuration is needed on the provider. Deploy the repository to Vercel, or run `pnpm dev` / `pnpm preview`, to serve the relay. Hosting only the contents of `dist/` does not include it.

To investigate a failed model selection, open the browser's developer console, enable Info and Warning messages, filter for `[model-diagnostic]`, and select the model or click **Try again**. Entries sharing a `diagnosticId` describe one check. `response` records HTTP status, content type, and request ID or retry delay when browser-accessible. `result` records `failureKind`, provider error code/message, stream completion, finish reasons, answer/reasoning lengths, and individual contract checks. `credits` identifies HTTP/provider code 402; `rate-limit` identifies 429; `output-limit` identifies a token-length stop; `contract` identifies a completed reply that failed the required format or markers. For malformed Chat streams, `validationIssues` records the exact rejection reason and zero-based event index. JSON contract checks inspect the accumulated answer independently of stream validity; selection still requires a complete stream. `request-failed` records network/read failures and cancellation; `blocked` identifies checks stopped locally. Logs stay in the browser console. They omit request bodies, model answers, raw provider metadata, and credential headers, and redact known request credentials from error messages. A catalog listing alone does not establish generation access or sufficient credits.

Screens contain at most 20 words of interface copy, and engine screens at most 10. Chess coordinates, notation, clocks, and numeric values are game data. A scrollable moves sidebar pairs White and Black moves, follows the selected move, and lets you review any position without changing live play. It sits below the board on phones. Coordinate entry, appearance, and position editing open as focused screens. Conversation pages show eight words at a time; download the complete match archive from Settings for full messages, reasoning, usage, and undone lines. Icons retain accessible names and hover labels; keyboard history shortcuts remain available.

## Local development

Use Node **24.22.0** and pnpm **12.14.0**. `.node-version` pins the Node runtime and `packageManager` pins pnpm. Run these commands at the repository root in PowerShell or another Corepack-compatible shell:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Vite prints the local URL. The development server binds to loopback. Keep `pnpm dev` running while playing. For the production build:

```sh
pnpm check
pnpm preview
```

The browser tests can start a temporary preview at port 5175 and stop it when they finish; an already-open page at that address cannot reload assets after the server stops. For a persistent production preview, run `pnpm build` followed by `pnpm preview --port 5175 --strictPort` and leave that process running.

Browser files are in `dist/`. The build includes the application license and production dependency notices. Vercel hosts the frontend. The Go API and private PostgreSQL database run on the server; see [API contracts](docs/architecture/go-api.md) and the [deployment runbook](deploy/README.md). No hosting or account service is needed for guest play. Running the app locally does not provision infrastructure.

## Checks

| Command | Purpose |
| --- | --- |
| `corepack pnpm typecheck` | Strict TypeScript checks for browser code, tools and fixtures. |
| `corepack pnpm lint` | ESLint, TypeScript and React Hooks/refresh checks; warnings fail. |
| `corepack pnpm test` | Run deterministic fixtures once. |
| `corepack pnpm test -- src/rules/rules.test.ts` | Run the strict rules fixtures. |
| `corepack pnpm test:watch` | Rerun selected fixtures during development. |
| `corepack pnpm build` | Typecheck, compile static assets and collect runtime license notices. |
| `corepack pnpm check` | Lint, full fixture suite and production build. |
| `pnpm test:browser` | Run Chromium playthroughs against the built app with an offline provider fixture. Run `pnpm build` first and install Chromium with `pnpm exec playwright install chromium`. |
| `node --test scripts/release/readiness-audit.test.mjs` | Verify the offline release audit and synthetic secret scanner. |
| `node scripts/release/readiness-audit.mjs` | Inspect the actual distribution and hosting files for release blockers. |
| `go test ./backend/... ./cmd/...` | Compile the Go API and run its offline fixtures. PostgreSQL integration fixtures require a separate local database. |
| `go vet ./backend/... ./cmd/...` | Check production Go source for common errors. |

Vitest runs offline fixtures for strict rules, clock calculations, proof checking and search, archive validation, local storage, provider connections and protocols, and serialized controller decisions. A missing fixture suite fails the test command. Fixture coverage does not certify native browser or product acceptance. See [the fixture guide](tests/README.md), [KHA-29 controller evidence](docs/implementation/KHA-29-controller-evidence.md), [KHA-31 proof-search evidence](docs/implementation/KHA-31-evidence.md), [KHA-34 connection API](docs/implementation/KHA-34-api.md) and [evidence](docs/implementation/KHA-34-evidence.md), and [KHA-35 protocol-core evidence](docs/implementation/KHA-35-evidence.md).

The browser suite verifies a full legal game through checkmate and reload, compact requests with archived plans, Black-side starts and practice, Stop/Retry, Undo retention, and another game with the same model. It also exercises queued model changes and automatic connection rechecks after reload. Browser and Go CI run automatically for pull requests and `main`. Native screen readers, real provider routes, and hosted account storage still require separate acceptance runs.

## Implementation references

- [Module responsibilities and authority](docs/architecture/modules.md)
- [KHA-29 serialized controller evidence](docs/implementation/KHA-29-controller-evidence.md)
- [KHA-32 pending adjudication API and evidence](docs/implementation/KHA-32-pending-adjudication.md)
- [KHA-33 guest lifecycle, Undo and practice evidence](docs/implementation/KHA-33-lifecycle.md)
- [KHA-31 proof-search evidence](docs/implementation/KHA-31-evidence.md)
- [KHA-34 connection API](docs/implementation/KHA-34-api.md) and [evidence](docs/implementation/KHA-34-evidence.md)
- [KHA-35 protocol-core evidence](docs/implementation/KHA-35-evidence.md)
- [Durable model request and conversation API](docs/implementation/KHA-37-api.md)
- [Opponent catalogs and diagnostic API](docs/implementation/KHA-38-api.md)
- [Controller model handoffs](docs/implementation/KHA-38-controller-api.md)
- [Optional Clerk account API](docs/implementation/KHA-42-api.md) and [cloud sync API](docs/implementation/KHA-43-api.md)
- [Online participant authorization](docs/architecture/online-authorization.md), including guest seat credentials and identity fencing. Online invitations, transport and board integration continue in their dependent tickets.
- [Encrypted backups and local restore rehearsal](docs/implementation/MVP-operations.md)
- [Exact position checks and resource limits](docs/implementation/MVP-position-checks.md)
- [Go API and PostgreSQL storage](docs/architecture/go-api.md)
- [Dependency and artwork inventory](docs/dependency-notices.md)
- [Approved specification](docs/spec/mvp-handoff.md) and [acceptance cases](docs/spec/mvp-acceptance.json)
- [Implementation roadmap](docs/spec/implementation-plan.md) and [canonical Linear tracker](docs/agents/issue-tracker.md)

The owner selected the Classic workspace in [the KHA-12 Linear issue](https://linear.app/kamkm/issue/KHA-12/validate-the-connection-and-chess-match-interface). The disposable prototype source and captures are not included in this repository. That decision does not pass native screen-reader acceptance; see the MVP handoff for the remaining criteria.

## Configuration and distribution

Guest play needs no build environment variables. Provider profiles and credentials are configured deliberately in the browser. Vite's general environment-prefix exposure is disabled. Only three public build settings are allowlisted: `KAMKM_PUBLIC_ACCOUNTS_ENABLED`, `KAMKM_PUBLIC_CLERK_PUBLISHABLE_KEY`, and `KAMKM_PUBLIC_API_BASE_URL`. Invalid publishable keys and insecure remote API origins cannot enable accounts. Server secrets stay in the server process environment; see `.env.example`. Never place private keys in browser source, `public/`, or any public setting.

Vercel's CSP permits direct HTTPS and loopback provider connections, the deployed Clerk scripts and account frames, and Clerk's inline styles. Application Workers remain on the application origin. Browser CORS and local-network permission rules still apply. The server API requires a verified Clerk session and configured origins. Clerk email sign-in is configured; Google sign-in needs a production OAuth client. [The deployment runbook](deploy/README.md) records the server services, private credentials, backups, and verification.

Exact position checks run in a Worker and only accept independently checked evidence. Common openings resolve quickly. A difficult position can remain saved with adjudication pending and a continuously running clock; Continue and Stop analysis are explicit actions. A search cutoff never invents a result.

Run `pnpm install --frozen-lockfile` after checkout. Use exact package versions and review changes to `pnpm-lock.yaml`. Recheck notices and bundle contents when dependencies or assets change. Research and experiment dependencies are separate from the production root package.

Copyright (c) 2026 kamkmchess contributors. This project is free software under the [GNU General Public License](LICENSE), version 3 or, at your option, any later version (`GPL-3.0-or-later`). It comes without any warranty, including implied warranties of merchantability or fitness for a particular purpose. The owner adopted this license on 2026-10-18.

Third-party code and artwork retain their own licenses and attribution. The [previous MIT notice](docs/licenses/kamkmchess-MIT.txt) is retained for previously published kamkmchess code; earlier MIT grants remain valid. The current project and its combined browser distribution use GPL-3.0-or-later.
