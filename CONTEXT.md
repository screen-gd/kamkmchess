# Chess against AI models

The owner's 2026-10-18 [Lichess rules amendment](docs/implementation/lichess-rules-research.md) supersedes exhaustive dead-position and timeout proof-search requirements below. Interactive games use chessops legal moves and material checks with bounded timeout handling; legacy exact-search tools are offline compatibility code.

A platform where people play chess against AI models that choose their own moves.

## Language

**Human player**:
A person who makes their own chess moves, whether against another human, a model opponent, or an engine.

**Model opponent**:
An AI model that plays one side of a chess game and chooses its own moves.

**Player agent**:
A model opponent owned and configured by a person to play on their behalf.

**Online agent**:
A player agent available while its owner's site session stays connected and responsive, including in a background tab. Player agents do not run while their owners are offline.

**Friend match**:
An online match arranged between two people, each playing directly or through their own player agent.

**Friend match invitation**:
An offer to arrange a friend match, delivered as a shareable link or a challenge addressed to an account.

**Link guest**:
A person who creates or joins a friend match through a shareable invitation link without signing in.

**Rematch**:
A new friend match proposed by its participants after a completed friend match.

**Casual online match**:
An online chess game whose result does not affect a rating or rank.

**Agent matchmaking queue**:
A queue that pairs a person playing directly with another person's player agent, or pairs agents belonging to different people.

**Queue entry**:
A signed-in person's request for one casual match, playing directly or through one selected player agent. A person can have multiple entries at the same time.

**Compatible queue entries**:
Entries owned by different people with identical time controls and at least one player-agent seat.

**Match assignment**:
The committed pairing for a queue entry, with another person's eligible entry or the fallback opponent.

**Match authority**:
The service that accepts and orders an online match's moves, clocks, and final result for all participants.

**Agent runner**:
The owner's browser session authorized to execute their player agent for a particular match seat.

**Match abort**:
An online match ended without awarding a win or loss.

**Abandonment claim**:
A participant's optional claim of victory after their opponent stays offline through the reconnect grace period.

**Fallback opponent**:
The built-in engine used as the opponent when agent matchmaking does not find a match.

**User profile**:
A person's public identity page, including their username, avatar, match results, and online game history.

**Public game history**:
The record of completed online matches, including results, game replays, and the AI models used. AI conversations and private connection details are excluded.

**Public replay**:
The shareable starting position, accepted moves, result, and declared human/agent/model control history of a completed online match. Private AI conversations and connection details are excluded.

**Anonymized game**:
A retained completed game whose deleted participant's public identity is replaced with Deleted player.

**AI connection**:
A human player's configured access to an AI provider or custom endpoint for their model opponents.

**Connected proxy**:
An AI connection through a human player's existing proxy, such as CLIProxyAPI.

**Model catalog**:
The model entries advertised through a human player's selected AI connection.

**Model routing ID**:
The exact model identifier accepted by an AI connection for requests. It may be an alias that routes to different backend models or accounts.

**Opponent selection**:
A human player's choice of an AI connection and an exact model routing ID for their model opponent.

**Compatibility check**:
A diagnostic model request that tests the chess client's conversation and reply contract through a selected AI connection and model routing ID.

**Model family**:
A named group of related AI models, such as GPT, Claude, Gemini, Grok, or Kimi.

**Model switch**:
A change of model opponent within an existing chess match, which may also change the AI connection.

**Control change**:
A change in who plays a participant's side during a match, between direct human play and a player agent or between selected models.

**Match conversation**:
The accumulated instructions, game inputs, and model replies on a match's current line of play, including any plans or reasoning the models returned.

**Match archive**:
The complete record of a match, including its current line of play, undone continuations, and earlier conversation segments.

**Undo**:
A takeback within an unfinished line of play that restores an earlier position and its corresponding match conversation without refunding elapsed clock time.

**Match clock**:
The remaining chess-playing time for one side of a timed match.

**Time control**:
The starting time for each side and any increment added after an accepted move.

**Loss on time**:
A final loss caused by a side exhausting its match clock when the opposing side can still possibly checkmate.

**Dead position**:
A position from which neither side can ever checkmate through any legal sequence of moves.

**Mating possibility**:
A side's ability to reach checkmate through some legal sequence of moves, with either side cooperating. The hypothetical sequence ignores repetition and move-count draw thresholds, while actual play still applies them.

**Pending adjudication**:
An unresolved exact check of a possible match ending. Play waits without a declared result, and any unexpired active clock continues to run.

**Move attempt**:
A chess move proposed by a model opponent that may be legal or illegal. A formatting error alone does not establish an illegal move.

**Post-loss continuation**:
Unscored practice from the playable position at which a model lost. The original loss remains final.

**Practice segment**:
An unscored continuation with its own match conversation and clocks, while the source game's final result remains unchanged.

**Model resignation**:
An explicit refusal by a model opponent to make a move, resulting in a loss for that model.

**Custom starting position**:
A chess position chosen by a player as the starting point for a chess game.

**Guest game**:
A game saved for a human player without being associated with an account.

**Account game**:
A game associated with a human player's account for access across devices.

**Unsynced continuation**:
Play saved on one device that has not yet joined an account game's accepted synced history.

**Conflicting continuation**:
An unsynced continuation retained separately because its starting point or ownership no longer matches the account game's accepted synced history.
