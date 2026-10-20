# KHA-69 finite authenticated match updates

Implemented on `feature/kha69-online-updates` from merged base `c31ef30`.
The tested implementation is `e1fd43ea6c9c8e3c9f6642cd24ae0284008d69ea`,
verified locally on 2026-10-20. The ticket is
[KHA-69](https://linear.app/kamkm/issue/KHA-69/deliver-finite-authenticated-updates-with-snapshot-and-polling).

## Implemented behavior

`GET /v1/online/matches/{matchID}/updates` authenticates the participant and
returns either finite fetch-SSE or one JSON snapshot. Both carry transport
schema 1 and the allowlisted match schema 2. The cursor equals the durable
match version and stays within the JavaScript safe integer range. Every
connection begins with the current snapshot, including requests with stale,
equal, future or skipped cursors.

Streams use a four-second heartbeat, one-second version probe and a hard
twenty-second maximum. Credential expiry and the authorization grant can
shorten that window. Every reopen checks credentials and membership again.
Database reads finish before the handler writes or waits. Reads cannot delay
heartbeats indefinitely, and socket write deadlines are capped by the stream
window. Failed writes close the stream.

The TypeScript subscriber validates complete snapshots, replaces whole views,
ignores duplicate and older versions, and accepts an equal stored cursor when
the local view is empty. It bounds request and body stalls, falls back to
authenticated polling, and retries with bounded backoff. Wake, disposal and
participant changes cancel the active work. Transport recovery sends no
state-changing commands.

Cursor storage defaults to page-local memory. The storage hook supports a
caller-owned durable adapter scoped by match and identity. Shared adapters
must atomically retain the larger cursor across writes from different tabs.
The built-in stores retain the larger cursor. A failed snapshot consumer
does not advance or persist its cursor.

No online UI is wired in this ticket. KHA-74 owns that integration, including
clock interpolation. Existing private sync and offline play remain covered by
the full frontend and Go checks.

## Local verification

- `pnpm check` passed with lint, 908 tests across 75 files, both TypeScript
  projects, the production build, rules-worker bundle and distribution
  notices. The existing large-chunk build warning remains.
- `go vet ./backend/... ./cmd/...` passed.
- `go test -json -count=1 ./backend/... ./cmd/...` passed with required
  PostgreSQL and the real rules worker. All 398 test outcomes passed,
  including subtests and 163 integration outcomes. No individual test was
  skipped. The integration package took 105.564 seconds.
- `go test -count=1 ./backend/httpapi` passed, including the actual polling
  response comparison against the JSON fixture shared with TypeScript.
- The focused PostgreSQL `OnlineUpdates` suite passed in 14.135 seconds,
  including the new API/service replacement recovery check.
- `git diff --check` passed.

PostgreSQL checks require `KHA41_REQUIRE_POSTGRES=1` and the local PostgreSQL
instance at `127.0.0.1:55467`. Fixtures create isolated schemas. The full Go
check uses the real bundled rules worker through `KHA66_WORKER_ENTRY`.

The stream tests exercise initial and changed snapshots, cursor gaps,
duplicates, malformed cursors, private-identity redaction, credential expiry,
revocation, foreign membership, heartbeats visible before stream completion,
blocked reads and writes, and an idle stream with zero acquired database
connections between known probe windows.

The recovery check replaces the HTTP server, writer and authorization service
while retaining PostgreSQL. A client with cursor 1 recovers cursor 2 and one
accepted move after losing its acknowledgement. The stored receipt remains
readable. Retrying the same operation preserves version 2, one move and the
single clock increment. This tests transport recovery over retained data;
service-outage clock adjustments belong to KHA-71.

## Review corrections

Parent regression checks first reproduced unsupported nested schemas,
connections that never answer, streams with no first byte, raw streaming
network failures and empty finite streams. The client now rejects the unknown
schema, bounds both stall phases and uses polling recovery for broken streams.
It also retains backoff after a request timeout and redelivers a snapshot when
its consumer throws. The focused client and shared-contract suite passes all
39 tests.

Server review bounded the initial authorization and snapshot reads and every
write by the finite window. It also corrected heartbeat gaps on busy matches,
bounded slow version reads and refused unsafe outgoing cursors. The idle-pool
test now checks known idle waits, replacing timing-dependent percentage
sampling.

The independent client reviewer confirmed the wire fixture and request/session
boundaries and identified out-of-order cursor storage writes. The built-in
stores now retain the maximum cursor. Its reported missing route reflected
the parent checkout before the parallel server commit was integrated. The
integrated HTTP contract check passes with that route present.

## OpenCode free-model findings

All delegated work used `opencode/minimax-m3.1-flash-free`. Four workers ran
concurrently at peak. No rate-limit error was reported by the completed
workers. These runs do not establish twenty-worker capacity or verify the
account's billing ledger.

[OpenCode's model pricing](https://opencode.ai/v2/docs/console/models/) lists
$0 input, output and cached reads for this model as a limited-time promotion.
There is no announced end date. Free usage has dynamic limits: maintainer
`thdxr` describes allowances that change with capacity and demand in
[issue 28055](https://github.com/anomalyco/opencode/issues/28055).
OpenCode's bot also describes limits shared across account/network usage in
[issue 56523](https://github.com/anomalyco/opencode/issues/56523).
Exact request, token and concurrency limits and reset times are unpublished.
No paid fallback or subscription purchase was used.

## Remaining acceptance

These are local implementation checks. `ARC-05` and `ARC-07` remain `not_run`
in the broader acceptance matrix. Hosted Apache flushing, delivered CORS/CSP,
runtime grants and capacity remain KHA-83. Windows has no configured C compiler
for the Go race detector; the existing Linux PostgreSQL CI job runs `-race`.
No deployment or production launch was performed.
