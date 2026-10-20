# Online update transport

KHA-69 adds participant-only updates beside the existing command and receipt
routes. It does not change the private account sync API or make live matches
public. The Go writer remains authoritative for accepted actions and clocks.

## Wire contract

`GET /v1/online/matches/{matchID}/updates` uses the direct API origin. Send
`Accept: text/event-stream` for fetch-SSE, or `Accept: application/json` for a
single canonical snapshot. Both paths authenticate the account bearer token or
the match-scoped guest credential in request headers.

Each update has this envelope:

```json
{
  "schemaVersion": 1,
  "cursor": 12,
  "snapshot": {
    "matchId": "example-match",
    "version": 12
  }
}
```

The example abbreviates `snapshot`. The actual payload is the complete
participant live-state projection from `GET /v1/online/matches/{matchID}`.
It excludes participant authentication identifiers, credentials, connection
settings and private provider conversations.

The cursor is the durable match version, a positive safe integer. An optional
`Last-Event-ID` request header carries the last accepted cursor as a decimal
integer. A stream starts with the current canonical snapshot, even when the
cursor is missing, old, ahead of the server or separated by a gap. Clients
replace their view with a validated newer snapshot rather than applying moves
from notifications. Duplicate and older versions cannot repeat a move or
regress the displayed state.

SSE snapshots use the same envelope:

```text
event: snapshot
id: 12
data: {"schemaVersion":1,"cursor":12,"snapshot":{...}}

```

Heartbeat comments carry no authority and do not advance the cursor. Every
stream ends within 20 seconds and by credential expiry. Reopening acquires a
fresh credential and repeats membership checks. The server releases each
database read before waiting for another update or writing to a slow client.
The default probe interval is one second and heartbeat interval is four
seconds. Reads and writes share the finite window; individual writes also
have a ten-second timeout. Credential expiry shortens the window by a
one-second margin.

## Client lifetime and command recovery

The subscriber belongs to one selected participant and match. Disposal,
sign-out, credential removal and identity changes cancel its work. A reply
from an earlier lifetime cannot install a snapshot or save a cursor. Persist
cursor state under the selected identity and match; never save credentials
alongside it.
The subscriber defaults to page-local memory. A caller may supply durable
storage through `OnlineCursorStorage`; a shared adapter must atomically
retain the larger cursor when tabs write out of order. A cursor loaded
without a local snapshot still accepts the snapshot at that same version.
The subscriber advances its cursor after the snapshot consumer returns
successfully. A failed consumer receives the same version again.

Network and stream failures use bounded retries and authenticated polling.
Polling returns the same envelope and follows the same version checks. An
authorization or membership denial stops recovery until the owner explicitly
restores access. Tab wake may request an immediate reconnect and snapshot.

Transport recovery never repeats a state-changing command automatically.
After a lost acknowledgement, query the existing participant receipt route
`GET /v1/online/matches/{matchID}/operations/{operationID}`. Retain the original
operation ID and exact command when retrying an uncertain operation. The
writer's stored receipt prevents a second accepted move or increment.

## Deployment evidence

Local HTTP and database checks establish application behavior. Before enabling
online play on a host, verify actual Apache flushing, finite stream duration,
CORS, delivered CSP and concurrent connection capacity. These checks belong
to KHA-83. Presence and service-interruption behavior remain KHA-70 and KHA-71;
an SSE heartbeat alone does not establish opponent presence or service health.
