# KHA-64 offline result controls

Implemented and locally verified on 2026-10-20.
Tested source commit: `692b1c60a7f169c88919a122210f1a40b3e5e12b` on `feature/online-foundations`.

## Behavior

The existing board, setup, clocks, move sidebar, Undo, keyboard review and local human/model/engine paths remain in place. Draw and resign icons join the existing board tools. Their accessible names and hover labels are "Agree a draw" and "Resign game".

Both actions open a confirmation dialog. Keep playing receives initial focus. Cancel returns focus to the invoking control; confirmation focuses the result heading. The phone toolbar fits at 390px and 320px without horizontal overflow, with 44px-high targets.

An agreed draw persists `winner: "draw"` and `reason: "draw-agreement"`. Resignation names the human side and records the opposing winner. Hot-seat resignation follows the side to move. Automated-only games expose neither action.

The serialized controller declaration reconciles clocks, records a final event, stops clocks, clears the model handoff and advances request/analysis fences. Accepted final results survive reload and cannot be undone. Late model effects and archive writes are rejected. Browser cancellation also stops pending generation. Final status and its accessible name take precedence over generation feedback; Retry and Stop controls disappear after a result.

The TypeScript checkpoint/archive validators and current Go private-save validator accept the new draw reason and require a draw winner. A real PostgreSQL private-save round trip verifies account-save compatibility.

## Verification

- `pnpm check`: lint, both TypeScript projects, 668 unit tests across 63 files, browser build, private worker build and license notices passed.
- `pnpm test:browser`: all 69 existing integration journeys passed, including human, model and engine play, Undo, keyboard review, reload, responsive layout and the four result-control cases.
- After the final UI corrections, four focused Playwright cases passed: cancel focus, confirmed-result focus/reload/Undo, and two new delayed-AI-reply races covering draw and resignation.
- The delayed-reply tests first reproduced lingering recovery controls after a final result, then passed after the correction. They verify the final result, accessible heading, one accepted move and reload.
- Controller tests cover durable declarations, stopped clocks, unchanged positions, final Undo refusal, stale fences, human eligibility and late model effects/archive writes.
- `TestPostgresPrivateSavePreservesAgreedDraw` first reproduced the private-save rejection, then passed after the Go validator change. A draw naming White as winner remains rejected.
- Desktop and 390px browser captures were compared with the incumbent layout. Dialog initial focus, labels, safe cancellation, touch targets and overflow were inspected. The Impeccable detector returned no findings for the original changed UI targets.

The full browser run preceded the final reply-race and confirmation-focus corrections; the changed flows were rerun afterward. Physical devices, NVDA/VoiceOver/TalkBack and native mobile Safari/Firefox acceptance remain with KHA-81/KHA-82. UX-03 and UX-05 receive local evidence here; this does not certify the complete online acceptance matrix.

## Files

Controller lifecycle and tests, result availability/copy helpers, App/Icon and narrow toolbar/dialog styles, persistence types/archive validation, the Go private-save validator and its PostgreSQL regression, and focused browser journeys.


## CLIProxy Luna review continuation

Completed on 2026-10-20 using OpenCode `cliproxy/gpt-6-luna`. Latest verified source commit: `00d9ae8d9689d2f1f11c2ab994a860d7723850aa`.

The failed DeepSeek reviews had later queued retry turns. Those retries were stopped, their remaining edits were inspected, and stale evidence claiming a missing timeout adapter was removed. The implemented move and timeout adapters remain verified.

Final combined verification passed:

- `pnpm check`: lint, strict TypeScript, 673 tests across 64 files, browser build, private worker build and notices.
- Six focused Playwright result cases, including a final AI result arriving while a confirmation is open, delayed replies after both declared outcomes, cancel focus, and confirmed result focus/reload.
- `go test -count=1 ./backend/... ./cmd/...` with isolated PostgreSQL and the built private worker.
- `go vet ./backend/... ./cmd/...` and `git diff --check`.

The earlier full 69-journey browser pass remains historical evidence; this continuation reran the changed flows. Native, assistive-technology, staging and release acceptance remain separate.

Luna fixed the focus path when another controller event finishes the game while the declaration dialog is open. The synthetic AI regression proves that the dialog closes and focuses the final result. Retained retry edits also keep an aborted generation idle once the game is final and assert resignation focus. The controller lifecycle review found no additional material issue.
