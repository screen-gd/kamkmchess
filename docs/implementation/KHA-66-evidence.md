# KHA-66 private rules worker

Implemented and locally verified on 2026-10-20.
Tested source commit: `692b1c60a7f169c88919a122210f1a40b3e5e12b` on `feature/online-foundations`.

## Rules and protocol

The private Node/TypeScript process reuses unchanged pure `src/rules` wrappers and locked `chessops 0.15.1`. Protocol version is `1`; policy version `online-rules/1` matches the shared Go/TypeScript contracts and the October 18 bounded ending policy.

Requests contain correlation ID, match version, policy, FEN, ordered authoritative FEN history and optional move/timeout intent. The worker parses every position, requires history to end at the evaluated FEN and derives repetition counts itself.

Replies return evaluated-input identity, deterministic facts and optional move candidates. Terminal precedence is mate, stalemate, insufficient material, third repetition and 100 halfmoves. Timeout uses current material and bounded one-ply policy.

The Go client recomputes the semantic SHA-256 fingerprint, including history and intent. It validates request/version/policy/engine/FEN/candidate correlation and returns no usable response on stale, malformed, crashed, canceled or timed-out work.

One deadline covers queue wait, process exchange and retry. Queued cancellation leaves the active request alone; an already-canceled request starts no worker. Input/output lines are bounded at 256 KiB / 1 MiB. Oversized input is discarded through its newline.

The worker environment uses an explicit runtime allowlist. Database credentials, provider credentials, proxy settings and private archives are not supplied. The worker has no listening socket or database writer.

## Go integration

`rulesworker.NewOnlineEvaluator` implements `online.Evaluator` and `online.TimeoutEvaluator`. It verifies shared inputs, translates history/intents, maps checkmate to the mover, and returns version-bound timeout material facts.

The service evaluates outside locks, then re-locks and validates the current version, hash, epoch and deadline. Real PostgreSQL/process tests verify mating results, timeout wins/draws, exact retry receipts and failure refusal. Crashes, timeouts and malformed replies leave canonical state unchanged.

Authenticated HTTP bootstrap, service recovery and the deployed Node runtime remain in later tickets. Local tests compose the actual service and process directly.

## Build and packaging

```sh
pnpm build:rules-worker
pnpm start:rules-worker
```

The self-contained artifact is `build/rules-worker/worker.mjs`, outside public `dist/`. Its verified size was 81,040 bytes. The directory includes `LICENSE.txt`, `THIRD_PARTY_NOTICES.txt` and `DEPENDENCY_INVENTORY.json`.

The builder verifies the chessops pin and rejects remaining external packages. It bundles existing chessops and `@badrap/result` dependencies. The private build directory is ignored by Git/ESLint. Go CI builds the worker using pinned Node/pnpm and sets `KHA66_WORKER_ENTRY`, so real-process checks run there.

## Verification

- `pnpm check`: lint, both TypeScript projects, all 668 tests, browser/private-worker builds and notices passed.
- Worker fixtures cover strict FEN/counters, en passant, castling/check, promotions, repetition, mate/draw precedence, material/timeout boundaries, framing, invalid input, oversize rejection and recovery.
- Go fixtures cover wrong fingerprints/history/timeout side, version/policy/FEN/engine drift, malformed/oversized responses, crash/restart, cancellation, queued deadlines, canceled-before-start behavior and adapter mappings.
- `go test -count=1 ./backend/... ./cmd/...` with real PostgreSQL and the absolute built-worker path passed.
- `go vet ./backend/... ./cmd/...` passed.
- Integration regressions first exposed the inverted mating winner and missing timeout adapter, then passed after correction.
- Local `-race` requires a missing C compiler; Linux CI retains the race run.

ARC-01 has local rules/process/database evidence. Native accessibility, deployed command paths, hosting capacity and staged release remain separate acceptance work.

DeepSeek V4.1 Flash Free through OpenCode implemented the slice and most review edits. Its final review response was blocked; the other review tasks later hit rate limits. The parent inspected and completed the partial edits and ran the final checks above.


## CLIProxy Luna review continuation

Completed on 2026-10-20 using OpenCode `cliproxy/gpt-6-luna`. Latest verified source commit: `00d9ae8d9689d2f1f11c2ab994a860d7723850aa`.

The failed DeepSeek reviews had later queued retry turns. Those retries were stopped, their remaining edits were inspected, and stale evidence claiming a missing timeout adapter was removed. The implemented move and timeout adapters remain verified.

Final combined verification passed:

- `pnpm check`: lint, strict TypeScript, 673 tests across 64 files, browser build, private worker build and notices.
- Six focused Playwright result cases, including a final AI result arriving while a confirmation is open, delayed replies after both declared outcomes, cancel focus, and confirmed result focus/reload.
- `go test -count=1 ./backend/... ./cmd/...` with isolated PostgreSQL and the built private worker.
- `go vet ./backend/... ./cmd/...` and `git diff --check`.

The earlier full 69-journey browser pass remains historical evidence; this continuation reran the changed flows. Native, assistive-technology, staging and release acceptance remain separate.

Luna reported a clean worker review with no new material defect. The retained input-reader correction checks byte length before concatenation; unit/process cases cover streamed oversized lines, bounded retention, UTF-8 framing and recovery. The rebuilt artifact is 81,113 bytes. A parallel test run had hit a 150 ms cold-start fixture limit; the fixture now allows 500 ms while retaining its two-second bound and the fake worker's five-second stall. The final serial Go suite passed.
