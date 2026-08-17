# local-fugu

A hand-written stand-in for Fugu's orchestrator: one OpenAI-compatible endpoint
that fans a turn out to a pool of local models, fuses the results, and answers
as a single model. opencode talks to it as an ordinary provider.

The part of Fugu that cannot be copied is the *learned* query-adaptive routing.
Here the routing policy is a hand-written table in `src/router.ts`.

## Install

```bash
brew install aosanori/tap/local-fugu
```

Gives you `local-fugu` (the gateway) and `magi` (the console). The pool config
lands in `$(brew --prefix)/etc/local-fugu/config.json` and survives upgrades.

## Running

```bash
./scripts/load-models.sh   # load the pool (see "Gotchas" — this matters)
./scripts/serve.sh         # gateway on http://localhost:4141/v1
```

From a Homebrew install, `local-fugu` and `magi` replace the two scripts.

```bash
curl -s http://localhost:4141/health
```

## The console

A MAGI-style live view of the pool: one panel per member, lit while it
deliberates, settling to 可決 for the candidate that was returned, 否決 for the
ones that lost a selection, and 参考 for drafts that fed a synthesis. Verifier
scores land on the panels as they are computed, so a turn shows *why* a patch
won, not just which model won.

In the terminal:

```bash
./scripts/magi.sh
```

```
 FRONT  OPENAI-COMPATIBLE ENDPOINT http://localhost:4141/v1

提訴 ─────────────────────────────── 決議 ───────────────────────────────

CODE : 0GEWIG                                                  ┤ 待機中 ├
FILE:MAGI.SYS  ROUTE:FANOUT  PRIORITY:AAA

Explain in Japanese why calling setState during build throws in Flutter…

                              BALTHASAR·2
                           google/gemma-4-31b
                                 参考
                           229 chars · 73.0s
                                M A G I
        CASPER·3                                  MELCHIOR·1
    meta/muse-glimmer                          qwen/qwen3.8-27b
          参考                                        可決
   267 chars · 69.0s                           203 chars · 89.1s

DECISION synthesize → qwen   BASELINE -   BEST -   ELAPSED 202.2s
```

Or in a browser at `http://localhost:4141/`.

Both read `GET /events` (server-sent events), which replays the last 40 events
on connect — attach mid-task and the current turn is already on screen. The
console is read-only and holds no state the gateway needs; closing it costs
nothing.

| endpoint | |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible, streaming and tools |
| `GET /v1/models` | the three virtual models |
| `GET /events` | live SSE feed of routing, proposals and scores |
| `GET /api/models` | every model the runtimes have, and which are in the pool |
| `POST /api/pool` | swap the pool; loads what is not resident and persists |
| `GET /health` | pool availability |
| `GET /` | the console |

## Choosing the pool

The **POOL** button lists everything LM Studio holds — resident or merely
downloaded — and lets you pick the members, the primary and the aggregator.
Applying loads anything that is not resident (`lms load` with an explicit
context and no TTL, for the reasons in Gotchas), rebuilds the pool, and writes
it back to `config.json`. Ids and MAGI seats are derived from the model names,
so nothing has to be named by hand.

The same thing from a terminal:

```bash
curl -s localhost:4141/api/models | jq '.models[] | {model, state, inPool}'
curl -s localhost:4141/api/pool -X POST -H 'content-type: application/json' \
  -d '{"members":[{"upstream":"lmstudio","model":"qwen/qwen3.8-27b"},
                  {"upstream":"lmstudio","model":"google/gemma-4-31b"}],
       "primary":"qwen/qwen3.8-27b"}'
```

## Debate

The proposal round is blind on purpose — independent errors are what make
selection worth anything. But on a turn with no score to appeal to, blindness
is all downside, so text turns get a round of cross-examination: every model
reads the others' answers and writes its own again. Only then does the
aggregator synthesize.

The console draws a bar in the gap between each pair that is actually talking.
That is not always the whole pool: a proposer that failed, timed out, or
returned nothing never enters the round, and with two members it is a
two-way link.

It costs a full extra fan-out per round — a design question measured 295 s for
propose + one debate round on this machine, against ~110 s without. Turn it off
or raise `rounds` in `config.json`:

```json
"debate": { "enabled": true, "rounds": 1, "maxPeerChars": 2000 }
```

Tool turns never debate. When a verifier can answer the question, an argument
between models is a worse instrument than running the tests.

In opencode (`~/.config/opencode/opencode.json` already has the provider):

```bash
opencode run --model fugu/fugu-auto "fix the bug in math.dart"
```

## The three virtual models

| id | behaviour |
|---|---|
| `fugu-auto` | routed: fan out on decision turns, single model on the tool loop |
| `fugu-moa` | always fan out (slow, for hard one-shot questions) |
| `fugu-fast` | primary model only, no fusion |

## How a turn is handled

```
request
  ├─ route()                                    src/router.ts
  │    trivial turn, no tools  → passthrough (primary, streamed)
  │    tool-loop continuation  → speculative
  │    otherwise               → fan out
  ├─ speculative                                src/server.ts
  │    primary answers once
  │    ├─ not an edit  → return it, done (one model, one call)
  │    └─ an edit      → fan out to the rivals, then VERIFY
  └─ fan out                                    src/fuse.ts
       propose()  all proposers in parallel, non-streaming
       ├─ majority proposed a tool call → VERIFY, else SELECT
       │     verifiable edit  → score every candidate, highest wins
       │     identical calls  → take it, no judge
       │     disagreement     → aggregator picks one candidate whole
       └─ otherwise                     → SYNTHESIZE
             aggregator streams a fresh answer with the drafts as reference
```

**Tool calls are selected, never merged.** A blended tool call is a broken tool
call, so on tool turns one candidate is emitted verbatim, `tool_calls` intact.
Only prose goes through MoA-style synthesis.

**Fan-out is spent where decisions are made.** Most turns in an agentic loop
just carry a tool result back, and paying three models for those is waste.

**…but the edit is always one of those turns.** The agent reads first and edits
second, so the interesting turn — the only one a verifier can score — is a
continuation. A router that unconditionally passes continuations through can
never put competing patches in front of the scorer. Hence `speculative`: answer
once with the primary, look at what came back, and buy rival candidates only
when an edit is actually on the table.

The cost of that is streaming. A continuation turn has to be buffered before it
can be inspected, so its text arrives in one burst rather than token by token.

## Verification

`verify` in `config.json` replaces the judge with something that cannot be
talked into a wrong answer. Each candidate edit is materialized into full file
content, applied to an APFS clone of the project (`cp -Rc`, free on this
filesystem), and scored by real commands. The working tree is never touched.

A scorer contributes `weight` when its command exits 0, and `penaltyWeight` per
line matching `penaltyPattern` — so the score keeps a gradient instead of
collapsing to pass/fail. Defaults score Dart with `dart analyze` and `dart test`
(swap in `flutter analyze` / `flutter test` for a Flutter app; `match` is a
regex on the edited path, so several toolchains can coexist).

```bash
bun run ./scripts/verify-selftest.ts
```

```
ok   baseline (bug present)                 10  analyze=10 test=0 exit!=0
ok   guard the empty list                   30  analyze=10 test=20
ok   fold instead of reduce (0/0 = NaN)     10  analyze=10 test=0 exit!=0
ok   does not compile                       -1  analyze=-1(1 hits) exit!=0 test=0 exit!=0
```

The third row is the one that matters: an edit that reads perfectly well and is
still wrong. No judge model reliably catches that; `dart test` catches it every
time. Scoring one candidate costs ~2.5 s on the fixture, and a verified turn
scores the baseline plus up to `maxCandidates`.

Observed live, on the fixture bug:

```
route=speculative escalated=yes candidates=3 baseline=10 best=30 regression=false
  scores="qwen:30[analyze=10 test=20] gemma:30[analyze=10 test=20] muse:30[analyze=10 test=20]"
```

`regression=true` means every candidate scored below the untouched project. The
best one is still returned — the agent will meet the failure on its next test
run — but that flag is the signal a search loop would act on.

## Measured on this machine (M4 Max, 128 GB)

Same task each time — a one-line bug in `math.dart` that the agent has to find,
read and fix. Pool of three, all on LM Studio.

| | fan-out turn | full opencode task |
|---|---|---|
| cold — first fan-out after loading a model | 133 s | 2 m 33 s |
| warm, serialized (`maxConcurrency: 1`) | 20.3 s | 36.8 s |
| warm, parallel (`maxConcurrency: 3`) | 12.4–15.9 s | 34.5–40.8 s |

Every run produced the identical correct edit.

**Prefix cache warmth dominates everything else.** The first fan-out after a
model loads costs ~10× the steady-state one, because opencode's system prompt
has to be prefilled from scratch on every member. Any benchmark that does not
say whether the cache was warm is measuring the cache.

**Parallel fan-out is worth ~35% on the fan-out turn, and roughly nothing
end-to-end.** One GPU is the bottleneck whether the three prefills are issued
together or in sequence. `maxConcurrency` is a real but modest knob — the reason
it exists is correctness under load, not speed.

## Gotchas found while building this

- **LM Studio serves three loaded models concurrently** — but only once they are
  all resident with a sane context. Early failures (`Engine protocol predict
  request failed`) were the resource guardrail, not a concurrency limit.
- **Loading a new model can evict a resident one.** Adding the third member
  silently unloaded gemma; `lms ps` is the only way to notice. `load-models.sh`
  reloads all three explicitly for that reason.
- **A per-model TTL is poison for a pool.** An idle member gets unloaded, and
  the reload is attempted in the middle of a fan-out. qwen ships configured at
  262144 context, which made its reload ask for ~87 GB and get refused.
- **Reasoning models can spend the whole proposer budget on `reasoning_content`
  and return empty text.** Empty drafts are dropped in `propose()`; keep
  `proposerMaxTokens` generous. Related: a client's `max_tokens` must not be
  inherited by the proposers. A request with `max_tokens: 400` produced three
  empty drafts and a degraded fan-out until proposers were given
  `max(client, proposerMaxTokens)` — the client's cap governs the answer it
  receives, not the drafts it never sees.
- **The pool's usable context is its smallest member** (65536 here). That is
  what `limit.context` in the opencode provider is set to.

## The pool

`config.json` drives everything. Members are probed at boot; `optional` members
that are not loaded are dropped silently, required ones abort the boot, and
`"enabled": false` keeps a member configured but out of the pool.

| id | family | upstream | model |
|---|---|---|---|
| qwen | Qwen | LM Studio :1234 | `qwen/qwen3.8-27b` — proposer, aggregator, primary |
| gemma | Gemma | LM Studio :1234 | `google/gemma-4-31b` — proposer |
| muse | Muse | LM Studio :1234 | `meta/muse-glimmer` — proposer |
| qwen36 | Qwen | Ollama :11434 | `qwen3.6:35b-mlx` — disabled |

Three distinct families, which is the point: MoA pays off on *differing error
modes*, so a third family beats a second Qwen generation. `qwen36` is kept in
the config but disabled for exactly that reason — flip `enabled` to add it back
as a fourth proposer.

All three run on one LM Studio instance with `maxConcurrency: 3`. Ollama is only
needed if `qwen36` is re-enabled.

## Next step

The scorer exists, so search now has something to climb. Two moves from here,
in order of payoff:

1. **Retry on regression.** When every candidate scores at or below baseline,
   fan out once more with the scorer's output fed back in. That is the smallest
   loop that turns a score into an improvement rather than a report.
2. **Replace best-of-N with AB-MCTS.** Best-of-N spends its whole budget on one
   round of breadth. TreeQuest (Apache 2.0, Multi-LLM AB-MCTS) decides per node
   whether to widen or deepen, and `scoreWorkspace` is already the reward
   function it needs.

Neither helps on turns with no automatic score — design discussion, requirement
shaping. Those stay MoA-with-a-judge, and that is the honest ceiling of this
approach.
