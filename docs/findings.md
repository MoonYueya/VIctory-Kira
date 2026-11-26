# What was learned on the RX 7900 XTX (2026-11-23 to 2026-11-25)

One PC: i9-12900K (8 fast cores, 8 slow ones, 24 threads), 64 GB, Radeon RX 7900 XTX
24 GB, Windows 11, 1440p, Series X profile. Figures are of diagnostics builds with a
screenshot a second. Scenes are not the same from run to run, so read differences
under about 5 % as nothing. What a switch does is in the comment where it is read.

## Where a frame goes

Median of whole runs, same part of the prologue: 280 ms, then 124, 103, 75, now 46-65.
On the water (first boat mission) 46-53 ms.

The title needs 33 ms. Of a 55 ms frame on the water:

- **The thread that prepares submissions: 48 ms.** It is the wall. Steps of the lists
  18 (refreshes of host copies 10), steps done on the card 7, waiting for descriptor
  records 6, asking the write watch 5, copies in the card's memory 4, the title's bytes
  under shader writes 4.
- **The card: about 41 ms busy**, the next wall.
- **List calls: 36,000 a frame, 230 ms of work** spread over eight threads. In a street
  chase 67,000 calls and 430 ms.
- Descriptor records copied as plain bytes: 400,000 slots looked at, 40,000 mirrored a
  frame, most of them empty.
- Landing what shaders wrote: 16 MB a frame put as dwords, on a thread of its own.

## The one idea behind most of it

On the console the CPU and the graphics processor share memory. Here they do not, so
everything one writes and the other reads must be noticed and moved. Every large cost
is one of four: **noticing** writes of the title (write watch, guards), **noticing**
writes of shaders (hashes on the card, compares on the CPU), **moving** them, and
**waiting** until an order is safe. Gains came from making each of them narrower
(dwords, not pages), wider (threads, AVX2) or later (on the card, behind the frame),
in that order of size:

| What | Frame before | after |
|---|---|---|
| Descriptor records of draws' tables left to the draws | 280 ms | about 124 |
| Our hash passes over card copies, 64 threads a piece | card 79 ms | 66 |
| Preparing on a thread of its own, refreshes and records spread | 103 | 75 |
| List calls written down and translated by eight threads (`VICTORY_THIN`) | 75 | 68 |
| Submissions joined, card steps, textures sent ahead | 68 | about 63 |
| Title bytes under shader writes compared with AVX2 on six threads | 14 ms of it | 4-7 |
| Stores into guarded memory looked at first, fewer guards reset | 69 ms of threads' time | about 6 |

(Each figure is from the run in which it was measured; they overlap and do not add up.)

## Faults found, and what they were

- **Boats sank, the sea plane went under.** The ocean's height and displacement maps are
  textures that compute passes write and the title's physics sample on the CPU. They were
  never brought back to title memory. Fixed by Geckomacabre's read-back as merged in
  fxceless/victory-fork f5c03f3b; on by default here (`VICTORY_TEXTURE_BACK=0`: off).
  With it the boat stays up through a whole run; without it sank in every one.
- **A device loss about every 16 minutes**: a page fault inside a texture made in the same
  tenth of a second. A slot showed it before its upload had run.
  `VICTORY_SHOW_AFTER=1`; none in the sessions since (likely fixed, not proven).
- **A rare lost write** (6 of 200 runs of a stress test): a view was mapped between our
  look at its guards and our lock, and views were opened one after another. None in 603
  runs after.
- **Blocky patches**: indirect dispatches cut at 65,535 groups.
- **Square holes and dashed edges in shadows**: pixel shaders that read their quad's
  neighbours with wave reads; on AMD helper lanes take no part in them.
- **Cube reflections too blurred, wrong materials**: DXIL's `Log` is base 2, and
  normalized buffer codes were one step off.
- **Every ray missed**: the dispatch flag that says counts are threads, not groups.

## Measured and not worth it

- Unordered early pipelines for everything (AMD's compiler crashed).
- Series S profile, smaller textures, a second drawing queue, `ASYNC_SUBMIT` off.
- Mapping pages on sixteen threads: no more pages mapped, frames longer.
- Scalar buffer loads four dwords a call (`VICTORY_SHADER_OPT=127`): no gain on this card.
- Wave sizes, fused multiply-adds, fast reciprocals, raw picked buffers, leaving out
  barriers: nothing to 0.1 ms each. Exact RDNA float rules (`VICTORY_RDNA_FLOAT`): 0.8 ms.
- Running the console's shader code natively on the card: the Windows driver takes no raw
  code, the two generations differ, and a Vulkan host layer ends at the same compiler. What
  is left to gain from shader code was guessed at under 1 ms.
- An on-screen panel of numbers (`VICTORY_PANEL`): it helps finding where a frame goes but
  costs some, so it is off and F3 shows it.

## What is next

1. The preparing thread: split what one submission does over two threads in a row; ask
   for the next submission while this one is sent; view the card's own buffers where fills
   copy them now.
2. The card: small buffers' copies in its own memory (`VICTORY_CARD_BUFFERS_MIN_KB=64`,
   after fxceless c36971b2; not measured here yet), and the passes that run for nothing
   without rays.
3. Stalls: 270-660 s of a session were full of frames over 200 ms, almost all while new
   pipelines were made. `victory warm`, and a quarter of the workers for the slow ones.
4. Outdoor flicker: suspected to be one bad indirect record that uses up its list's
   budget, so that every later draw of it is empty. The log's frame line counts them;
   `VICTORY_INDIRECT_REST=0` is the experiment.
5. Memory, 40-46 GB private: lists' allocators 9 GB, windows 7, uploads 4
   (`VICTORY_MEMORY_MAP=1` lists it).

## The other repositories, compared

Read up to 2026-11-25: Marvisak/VIctory, fxceless/victory-fork, DexNom/VIctory,
Belobug/VIctory-Belobug-AMD, FQY55kai/ZJOU-VICTORY. What was taken is in the history,
each commit naming its source. In short:

- Marvisak's commits hardly apply any more; nearly all of what they fix is here, often
  another way. Taken: nearest normalized codes, d16 views, shader model flags.
- fxceless: the base. Newest taken: texture read-back, small buffers on the card, hashes
  over a buffer's own bytes.
- DexNom: thread counts of ray dispatches, cube gradients, joined sparse ranges.
- Belobug: pipeline workers for screen passes, the ambient stand-in's idea, pipeline and
  constant buffer bookkeeping (romainhedouin).
- ZJOU: render targets not set again; some shader corrections are being looked at.

## RTX 3080 (NVIDIA Ampere) notes

Measured on **this fork at `0a43566`** (the commit before the current one) on one PC:
RTX 3080 10 GB, driver 32.0.16.1742, **AMD Ryzen 7 7700** (8 cores), **31.1 GB** physical,
Windows 11 build 26300, 2560x1440, Series X profile, `scripts/play.ps1` switches. Nothing
here is carried over from another tree: the numbers of the fork this one came from, and of
upstream VIctory, are different versions and are not comparable with these.

**What the runs did.** Five, all unattended, no window brought to the front and no input
sent to the desktop: the keys went in through `VICTORY_KEYS`, which the title reads inside
its own process. Entry used a copy of a save folder that had already been through the first
setup. Each run was capped (600, 600, 600, 480, 270 s) and ended with `taskkill /T /F`.

| # | run id | switches |
|---|---|---|
| A | `xtx-a-default` | `play.ps1` as written |
| B | `xtx-b-safe` | `-Safe` |
| C | `xtx-c-debug` | default + `VICTORY_D3D12_DEBUG=1` |
| D | `xtx-d-audio` | default + `VICTORY_AUDIO_CAPTURE` |
| E | `xtx-e-slots` | default, minus the fast paths, + `VICTORY_LIST_SLOTS` |

One local change was in every run and is **not** in `0a43566`: 21 lines in
`crates/victory-hle/src/modules/gameinput.rs` that give pad slot 0 a stand-in carrying the
scripted keys, because with no pad plugged in the keys never reached slot 0. It changes
which input the title sees, and nothing else.

### Confirmed

| What | Grade | Evidence |
|---|---|---|
| It builds: `cargo build --locked --profile diag -p victory --features diagnostics`, exit 0, 6 warnings that were already there | measured | build log, the same commit |
| Tests: 916 passed, 0 failed, 45 ignored over 27 test binaries, no crash | measured | `cargo test --workspace --locked` |
| All five runs reached the world, with no crash and no device removal | measured | A-E: a frame line under 5 frames a second, and the title's own package files opened in the log |
| A world frame costs **577 ms** (median, A), 310 ms in its best draws bucket, against 50-75 ms on the 7900 XTX | measured | A: 52 world frame lines; the buckets are in the table below |
| Private memory reaches **29,973 MB of 31.1 GB** (C); the fork's own README says 40-46 GB | measured | A 28,974, B 25,604, C 29,973, D 27,232 MB |
| The host view heap is capped at 1,000,000 views, and **737,855** of them are addressable by the title once the 262,144 dynamic slots are taken out | read from source | `descriptor/host.rs:1424-1436`, `:1481-1488` |
| No title slot ever went past the host heap in these runs: the warning for it never fired | measured | A, B, C: 0 occurrences of `title slot past the host heap` |
| **Dynamic descriptor slots run out on this card, and only with the fast-path switches on**: A asked 774,254 and was refused **120,350**; B (`-Safe`) asked 37,485 and was refused **0** | measured | `copystat`'s `DynamicRefused`; A, B, C, D |
| `VICTORY_DYNAMIC_SLOTS` cannot raise that ceiling on NVIDIA: below the portable limit the function returns a fixed 2^18 before reading the variable | read from source | `descriptor/host.rs:1424-1436` |
| Texture upload falls behind under memory pressure: A had 22,046 waiting and 8,404 passed over unmapped; D had **36,466** waiting | measured | A, D: the frame line's texture counts |
| Of 3,074 material texture slots in 953 world G-buffer draws, **none** was null, "no view" or "never written" | measured | E, `VICTORY_LIST_SLOTS` over 37 frame files |
| **64 of those 3,074 (2.1%) had been only partly uploaded**, the lowest at 7% of its bytes | measured | E, per-slot `mapped/total` |
| No graphics pipeline was refused and no shader failed to translate for those draws (the refused ones were 8 compute shaders) | measured | E |
| **The character's skin is missing**: hair and a collar are drawn, no face, no neck, no ears. **Why is not known** — the 2.1% of material slots only partly uploaded is a candidate, not a cause | measured (symptom), unknown (cause) | B's saved frames, looked at closely; E's per-slot data for the material side |
| The debugging layer's `id=645` messages come from our own probe heap, not from the title | read from source | `descriptor/host.rs:1384-1392`, two probes, each released at once |
| Audio out carries sound for 435 of 476 s (91.4%), 48 kHz stereo 16-bit, first sound at 26 s | measured | D, the recorder's own file |

### World frame cost, by draws per frame

The runs reached different depths, so the same bucket is the only fair comparison.

| draws/frame | A default | B `-Safe` | C +debug layer | D +audio |
|---|---|---|---|---|
| under 500 | 491.5 ms (n=3) | 715.9 (n=5) | 1,039.6 (n=4) | 581.0 (n=2) |
| 500-1500 | **310.1** (n=5) | 916.3 (n=6) | 853.1 (n=5) | 2,644 (n=3) |
| 1500-3000 | 576.9 (n=9) | 739.7 (n=3) | 655.3 (n=3) | 858.7 (n=6) |
| 3000 and up | 606.1 (n=35) | 836.8 (n=1) | **423.9** (n=7) | 1,305.4 (n=7) |

The two sorts of dropped draw on the same line are not the same thing: `(M being made)`
is a pipeline still being built and goes away, `and N indirect` is work that is lost for the
frame and did not converge in any of these runs (median 1,839 in A).

### Refuted, on this hardware

An earlier reading of ours said the title asks for 2,097,152 views, that 1,245,184 of them
read a null slot, and that this is why character materials are missing. None of the three
holds at `0a43566`: the 2,097,152 is our own probe heap, the 1,245,184 is the number of
slots the title **asks for**, and the warning that would show slots going past the heap
never fired. What the runs do show is 2.1% of material slots only partly uploaded — a
candidate, not a proven cause. The account of the missing skin itself is in the issue below.

### Where the texture shortage comes from, and what moves it (3 runs, 480 s each)

Three runs of one build with one switch changed at a time, one cache shared between them
(a cold run translates over two thousand shaders and builds thousands of pipelines first,
so its first minute is not the run being compared). The card is 10 GB; the system's budget
for it moved between 9,283 MB and 4,850 MB during a single run, thirty-five times.

The texture queue refuses a texture it has not made yet when
"used < budget × room percent" is false (`crates/victory-gpu/src/resource.rs`: the
	exttt{room} function, nine tenths of the budget by default). On this card the budget falls
below the use often enough that the refusal is what a world full of missing texture is made
of, not space itself.

| | default (90 %) | `VICTORY_TEXTURE_ROOM_PERCENT=97` | `VICTORY_CARD_ROOM_FOR_TARGETS_MB=1024` |
|---|---|---|---|
| world frames / median frame | 75 / 364.8 ms | 75 / 371.4 ms | 72 / 386.8 ms |
| textures uploaded (total) | 65,569 (3,692 MB) | **78,940 (4,331 MB)** | 63,008 (3,560 MB) |
| slots passed over, unmapped | 13,608 | **11,173 (-17.9 %)** | 14,083 (+3.5 %) |
| texture slots sampled, full | 49 of 51 (96.1 %) | **66 of 67 (98.5 %)** | 83 of 105 (79.1 %) |
| lowest single slot | 58.1 % of its bytes | **74.9 %** | 52.4 % |
| frame picture, mean / sd | 62.8 / 49.1 | 63.4 / 49.2 | 69.2 / 51.7 |
| black frames | 5 of 274 | 6 of 253 | 0 of 136 |

What it says:
- **The textures that are there are complete.** Ninety-six to ninety-eight per cent of the
  slots sampled have every byte of their memory mapped; the missing ones are textures not
  made at all, not textures half sent.
- **Giving the texture queue a larger share helps** and costs nothing measurable: a fifth
  more textures up, a sixth fewer slots passed over, complete slots from 96 % to 98.5 %,
  frame time and picture within noise.
- **Taking room away from render targets makes it worse**: the slots sampled that are
  complete fall to 79 %, more slots are passed over, and the frame is 6 % slower. A render
  target refused the card reads over the bus instead, which is the same road the textures
  use.

Not measured here: whether the visible skin returns with the larger share (the sampled
slots say the shaders' textures are complete, but the picture was not read back for a
face). A fence-gated LRU of cached textures (avatarmanz/VIctory-7900XTX pull request #72)
is the structural form of the same fix and is not in this tree.

### Filed upstream

Written up as avatarmanz/VIctory-7900XTX
[#75](https://github.com/avatarmanz/VIctory-7900XTX/issues/75). The dynamic-slot
exhaustion was already filed there as #35 by someone else on an RTX 5080; the numbers above
are an independent reproduction, not a new report.

### Performance and memory baseline, 2026-11-26

Two unattended runs of the same build, the same switch set and the same warm cache, 480 s
each, reaching the world and stopping there: 78 and 75 one-second frame lines. What they
say about a world frame (median; the two runs differed by under 5 % everywhere below):

| | run 1 | run 2 |
|---|---|---|
| Frame | 355 ms | 362 ms |
| On the GPU | 85 ms | 88 ms |
| Preparing (title-memory copies and textures) | 43 ms | 44 ms |
| Copying back | 36 ms | 36 ms |
| **The card with nothing of ours queued** | **138 ms** | **140 ms** |
| The card busy, by that count | 60 % | 61 % |
| draws per frame | 4,809 | 4,881 |

**The card is idle about 38 % of every frame, and almost none of that is us working while
it waits** (21.7 and 22.2 ms of it): the title has not submitted. Of the 4,809 draws a frame,
the submitting thread spends 2,056 ms a frame in 41,663 list calls, and 90 ms waiting for
the submission lock. A world frame costs 355 ms while the GPU is asked for 85.

**Memory is over the budget the whole time.** The card held 8,967 and 8,719 MB against a
budget that DXGI gave as 7,602 and 7,473 MB; 481 and 491 passes made no texture for lack of
room, and 9,962 and 10,194 textures a frame were passed over unmapped. Host copies let go
during the runs: 36,458 and 33,700 (1,993 and 1,632 MB). Free physical memory at the end:
665 and 546 MB of 31.1 GB, with 4.5 GB of title-window copies and 2.8 GB of texture host
copies held in system memory.

**What this says about where to look next.** Shader work is not the first thing to try: the
GPU has a quarter of the frame and the card is idle for a third of it. The first is what the
title and the layer do between submissions; the second is the memory budget. A switch for
submitting off the title's thread already exists here (`VICTORY_ASYNC_SUBMIT`, off by
default) and lines up with the first; nothing in this tree does least-recently-used
eviction of card memory, which lines up with the second.

Two earlier runs of this build were thrown away: one ran while another build of the layer
was playing on the same card, and one used a shader cache that the other build had written
to. Both are excluded above, and neither is a number in this note.
### `VICTORY_ASYNC_SUBMIT` is already on with `play.ps1`'s switches, and a larger
### texture share holds up over ten minutes (2026-11-26, `f59a315`)

**One correction to the paragraph above.** `VICTORY_ASYNC_SUBMIT` is described there as
off by default. It is off by its own variable, but it is **on** whenever `VICTORY_THIN=1`
is set, which `scripts/play.ps1` does: `queue/behind.rs` reads

```rust
(std::env::var_os("VICTORY_ASYNC_SUBMIT").is_some_and(|v| v == "1")
 || crate::list::thin::wanted()) && started()
```

and `list/thin.rs`'s `wanted()` is `VICTORY_THIN == "1"`. Every run under `play.ps1`'s
default switches therefore already has its submissions prepared on a thread of ours; the
log says so (`submissions are prepared and sent by a thread of ours`). Its preconditions —
`host::late_free_present()`, which the relay sets, and `queue::cuts()`, on by default — are
met by the same switch set, so the relay is a **dependency** of it, not a competitor.

**Turning it off costs nothing measurable here, and empties the card.** With
`VICTORY_THIN=0` (which turns it off) the median world frame was 341.8 ms against 344.5 ms
with it on — inside noise — while the time the card spent on the frame fell from 58.6 ms to
14.2 ms. On this PC the frame is CPU-bound on the 3080, so the switch's own effect cannot be
seen at the frame line; it should be measured in a switch set where `VICTORY_THIN` is off,
where it is a switch of its own.

**The larger texture share holds over ten minutes.** A 605 s run with
`VICTORY_TEXTURE_ROOM_PERCENT=97` (against the 90 of the run before it, same build, same
cache, same 480 s window):

| | 90 % (480 s) | 97 % (605 s) |
|---|---|---|
| world frames / median frame | 73 / 367.5 ms | 101 / **344.5 ms** |
| worst frame | 11,440.3 ms | **465.8 ms** |
| the card with nothing of ours queued | 176.3 ms | **162.7 ms** |
| textures uploaded / waiting | 3,482 MB / 3,188 | 3,483 MB / 5,786 |
| slots passed over, unmapped | 9,996 | 11,075 |
| frame picture, mean / sd (median) | 67.1 / 51.2 | 65.2 / 50.9 |
| black frames | 0 of 51 | 0 of 90 |
| card in use / budget | 8,946 / 8,033 MB | 9,136 / 7,981 MB |
| device removals, panics, refused translations | 0 | 0 |

Both runs are over the budget the system gives the card, as the note above this one says
they are; 97 adds three points to that. **`scripts/play.ps1` now sets 97 on NVIDIA cards
only** (vendor `0x10DE`, read from the display adapter's PNP id), and leaves AMD at 90.

**Not measured:** whether 97 is safe on an NVIDIA card with less than 10 GB, and whether the
frame-time gain repeats (one run each; read differences under 5 % as nothing, and this one is
6 %).


### Upstream VRAM GC and RAM-budget PRs, evaluated on RTX 3080, 2026-11-26

Two open pull requests against `avatarmanz/VIctory-7900XTX` were merged into this
fork one at a time and measured here, each against the same control (this fork's
`main`, which has neither): **#72** (`4f0d563`, fence-tracked LRU VRAM collection and
upload pooling, on unless `VICTORY_GC`/`VICTORY_UPLOAD_POOL` are set to `0`) and **#77**
(`ffc2cf6`, an opt-in system-RAM pressure band, off unless `VICTORY_WINDOW_BUDGET_MB`
is set). Same save, same switch set, one prewarmed cache per build (25,764 shaders
translated, 206 that do not translate), 480 s per run, unattended into the world.

Both merged without a conflict even though #47, #48 and #42 are already in this fork:
they touch the same three files, not the same hunks.

| | control | #72 | #77 @ 256 MiB |
|---|---|---|---|
| World frame time, median | 450 ms | **1,951 ms** | 390 ms |
| Passes that made none for lack of room (last) | 535 | 492 | **113** |
| Textures passed over unmapped (last) | 2,516 | **18,436** | 12,000 |
| Card use / DXGI budget (last) | 9,194 / 7,790 MB | 9,172 / 7,689 MB | 8,254 / 7,545 MB |
| Private memory (last) | 28,019 MB | 26,913 MB | 25,985 MB |
| Picture mean / spatial sd, world median | 74.1 / 53.7 | 50.0 / 63.2 | 73.1 / 52.7 |
| Device removed / panic / untranslated shaders | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

**#72 is a regression here and is not kept.** It was merged, built and run twice; the
first run was discarded because a workspace test was using the same card. The second,
alone on the machine, costs 4.3 times the frame time, raises `passed over unmapped`
from 2,516 to 18,436, uploads 27 % more bytes and darkens the picture by a third, for a
`lack of room` that falls 8 %. The log gives the reason: the sweep's watermark is 75 %
of the DXGI local budget, which on a 10 GB card is 5.5-5.9 GB, while the renderer's own
admission test already fills the card to 90 % of that same budget. The sweep therefore
takes away host copies the renderer would still use, and the next frame uploads them
again; five sweeps in 480 s evicted 12,798, 299, 2,130 and 4,501 objects at a time.
The over-budget path bypasses the 120-frame idle floor and the 64-per-frame cap, so
the fraction is all that stands between a sweep and an eviction that size.

**#77 is kept, default off as it is.** With `VICTORY_WINDOW_BUDGET_MB=256` the frame
time falls 13 %, `lack of room` falls 79 %, the card holds 8,254 MB instead of 9,194 MB,
and the picture is within 2 % of the control. At 2048 MiB the cap never engaged - the
log has no sweep line and the live window copies were only 1.6-2.0 GB - so that run
only proves the merge does not regress. Unset, the variable is read in exactly one
place and the sweep is the one it was.

Two things this measurement does not settle. `passed over unmapped` rose under #77
(2,516 to 11,298 and 12,000) while frame time and `lack of room` both improved; the two
were not isolated. And the 2048 MiB run had 3 black frames of 51 world pictures where
the 256 MiB run and the control had none; the control's own black-frame warnings are
all inside the first 22 frames (menu and loading), and one picture every 8 world frames
is a thin sample, so it is recorded as unresolved rather than as a defect.

**A more complete implementation already exists elsewhere.** Marvisak/VIctory at
`63bcca4` collects card texture copies on a budget in `resource.rs` (`evict_unused`, and
`BUDGET_HIGH = 0.90` / `BUDGET_LOW = 0.85`, `IDLE_MS = 120_000`, only textures that can
be rebuilt from title memory, plus a counter for copies evicted and remade soon after),
called before every submission from `host.rs`. Neither this fork's upstream `main`
(`39031cb`) nor `fxceless/victory-gta6` has it: fxceless solves the same problem with
allocation budgets (`VICTORY_TEXTURE_BUDGET_MB`, `VICTORY_TEXTURE_ROOM_PERCENT`,
`VICTORY_STAGING_POOL_MB`) and has no eviction pass at all. That 90/85 pair is the
shape a next attempt should take, not #72's 75/67.5.

Full numbers, run ids and grades: `VIctory-Kira-reports/GC72-PR-EVAL-2026-11-26.md`
(outside this repository).

### The Marvisak eviction water marks, ported and measured on RTX 3080, 2026-11-26

A port of the policy of Marvisak/VIctory `63bcca4`, behind `VICTORY_EVICT=1`, was tried on branch [`experiment/evict`](https://github.com/MoonYueya/VIctory-Kira/commits/experiment/evict) (`da0e7bb`) and **not merged into `main`**. It ports
(`crates/victory-gpu/src/resource.rs`, `evict_unused`: `BUDGET_HIGH` 0.90,
`BUDGET_LOW` 0.85, `IDLE_MS` 120,000, `IDLE_FRAMES` 300, `SOON_FRAMES` 10, only
textures rebuildable from title memory) onto this fork's own sweep, which already gave
up the same copies on its own water level (88/95 % down to 85 %, `IDLE_MS` 5,000,
four frames) and already spared what the host wrote. The port is the water marks, the
idle time and frame count, and a counter for copies made again soon after being given
up. (That counter only reached a log written on device removal, so it was not observed
in these runs; the existing `let go / made again` counts below stand in for it.)

Measured against this fork's `main` switch-off path from the same binary (so the
control is the same code with the branch not taken), one prewarmed cache, 480 s per
run, unattended into the world.

| | control | `VICTORY_EVICT=1` |
|---|---|---|
| World frame time, median | 319.5 ms | **308.5 ms** (−3.4 %) |
| World frames sampled | 76 | 69 |
| Draws/frame, median | 4,771 | 4,767 |
| Passes that made none for lack of room (last) | 565 | **1,221** |
| Textures passed over unmapped (last) | 9,912 | **10,477** |
| Card use / DXGI budget (last) | 9,224 / 7,835 MB | **8,530 / 7,847 MB** |
| Copies let go / made again (since start) | 36,942 / 1,612 | 40,165 / 1,729 |
| Device removed / panic / untranslated | 0 / 0 / 0 | 0 / 0 / 0 |

**Not kept, and not made a default.** The port does what it says: the card holds about
700 MB less through the whole world segment, and frame time does not regress. But it
does not reach either half of the goal. The card stays 683 MB over its budget, so the
over-budget condition that the whole line of work is about is still there; and both of
the shortage counters the goal names move the wrong way — `lack of room` more than
doubles (565 to 1,221) and `passed over unmapped` rises (9,912 to 10,477). A change
that frees memory while more passes fail for lack of room is moving copies the renderer
is about to ask for again, only more slowly than #72's 75 % water mark did.

What this does not settle: the 0.90 water mark is above the renderer's own admission
test, which fills the card to 90 % of the same budget, so on a card whose budget the
system keeps lowering under it (7.6-8.0 GB here, against 9.2 GB in use) the pass runs
under a budget that is below what is already committed — the water mark is crossed by
construction and the idle time is all that holds it back. Whether a water mark below
the admission test can free memory without causing the re-upload it is meant to avoid
is exactly what #72 answered in the negative at 75 %, and what this run answers for
0.90/0.85 on this card: it frees, but the counters still get worse.

`VICTORY_WINDOW_BUDGET_MB=512` (#77) was run a third time and again never engaged —
no sweep line, and the live window copies were under the cap. Its band only acts when
system RAM is under pressure, and this host had 22 GB free, so the run is a
control-equivalent, not a measurement of the cap.

### The DXGI budget under an RTX 3080: what it follows, and what does not bring it back, 2026-11-26

The system's budget for the card's own memory is not a fixed line and not a
function of what this process submits. Three 480 s runs of the diagnostics build
(`9beb553`), the same switches and the same warm cache, logging both memory groups
every second and at every 16 MB move (`VICTORY_BUDGET_LOG=1`, off by default):

| | run `budget-ctl` | run `budget-ctl2` | run `budget-reserve` |
|---|---|---|---|
| local budget | 7,215-9,283 MB, 157 values | 7,305-9,283 MB, 249 values | 6,590-9,283 MB, 264 values |
| largest single fall | -1,853 MB at frame 1101 | -1,785 MB at frame 1381 | same order |
| local use, peak | 8,743 MB | 9,521 MB | 8,838 MB |
| samples over budget | 78 % | 86 % | 91 % |
| non-local use, peak | 8,209 MB | 8,637 MB | 7,481 MB |
| process private, peak | 27,980 MB | 28,681 MB | 26,667 MB |
| free physical, least | 108 MB | 33 MB | 305 MB |
| `CurrentReservation` | 0 | 0 | **4,769 MB** |

**What the budget follows.** Over 600 and 881 paired samples the local budget
correlates with the process's working set at -0.91 and -0.79, with its private
bytes at -0.80 and -0.88, with the use of the PC's memory shared with the card at
-0.82 and -0.88, and with free physical memory at +0.89 and +0.78. The largest
fall of each run is at the first world frame, where the process goes from 6 GB to
17 GB private; the hundred falls after it happen while free physical memory sits
in the hundreds of MB and neither the card's use nor any other process's moved.
This is the semantics the documents give: `Budget` is what the OS assigns the
process under whole-system pressure, not a grant that follows the process's own
requests.

**A reservation does not hold it.** `SetVideoMemoryReservation` is called nowhere
in this tree, in Marvisak/VIctory (`63bcca4`), in avatarmanz/VIctory-7900XTX
(`74f9cf1`) or in fxceless/victory-gta6 (`461c55b`) — nor is
`RegisterVideoMemoryBudgetChangeNotificationEvent`; every one of them polls
`QueryVideoMemoryInfo`. With `VICTORY_BUDGET_RESERVE_MB=-1` the reserved amount
shows as 4,769 MB for the whole run, `AvailableForReservation` stays at 4,769 MB
throughout (so what the system *could* give never changes), and the budget still
falls to 6,590 MB — lower than either run without a reservation — with 91 % of
samples over it. The document's own wording is that a reservation tells the OS
what the application "cannot go without", to "quickly minimize the impact of large
memory pressure situations": it decides who is trimmed first, not what the budget is.

**Who else holds the card.** From the performance counters
(`GPU Process Memory(*)\Dedicated Usage`, 5 s) the card is at 2,291 MiB idle and
9,599-9,699 MiB in a run. Of that, this process takes 7.4-7.9 GB; the desktop
compositor (dwm) 1.3-1.8 GB; the input method 408 MB; QQ 275-285 MB; an Edge
WebView 188 MB; iCloud 184-187 MB; the harness itself 144-261 MB. Apart from dwm's
+250-450 MB when the window appears, none of them moves during a run.

**What this leaves.** Nothing in the layer's own switches brings the budget back;
what it can do is stay under a budget it does not control, and the largest term it
controls is the 7.3-8.6 GB it puts in the PC's shared memory beside the 28 GB it
holds privately.


### Where the 8.9 GB the card holds actually goes, by class, 2026-11-26 (`1c67de7`)

One unattended 480 s run into the world (`vram-ctl`), the `scripts/play.ps1` switch set plus
`VICTORY_MEMORY_CATEGORIES=1` and a new opt-in ledger (`VICTORY_VRAM_LEDGER=1`,
`crates/victory-gpu/src/vram.rs`): 67 world frames, no device removal, no panic, median world
frame 450.9 ms. The ledger counts live bytes, ending when the resource does (a small COM object
in the resource's private data, the way `book` does it), because the caller keeps the resource
for as long as the title or a list names it.

| What holds card memory | median MB | peak MB | things |
|---|---|---|---|
| in use, as the system counts it | **8,905** | 8,960 | — |
| DXGI local budget | 7,644 | 7,964 | — |
| of the budget | **116 %** | — | — |
| title textures the title fills | 1,582 | 2,268 | 19,452 |
| render targets and unordered-access textures | 2,823 | 2,823 | 723 |
| blocks of texture memory, whole | 3,136 | 3,136 | 49 |
| card sides of title buffers | 492 | 492 | 10 |
| card sides of windows | 0 | 0 | 0 |
| card memory the CPU maps | 0 | 0 | 0 |
| unordered-access and scratch buffers | 592 | 624 | 4,211 |
| accounted | 5,498 | 5,641 | |
| **unaccounted** | **3,420** | 3,442 | |
| the PC's memory the CPU maps (not counted above) | 5,819 | 5,973 | 10,763 |

What it says, and what it does not:

- **The card is 1,262 MB over the budget the system gives it**, which is the condition the
  texture queue's admission test is asked under.
- **The largest single item is the block pool, and most of it was empty.** 49 blocks of 64 MiB
  are 3,136 MB; the textures cut from them held about 1,578 MB, so roughly 1.5 GB was blocks
  kept with nothing in them. `pool.rs` keeps up to 64 empty blocks (4 GiB) while the card is
  under 85 % of its budget. No run has yet been made with that lowered.
- **A piece inside a block has no card memory of its own.** The first version of this line
  counted the blocks whole *and* the pieces in them, which counted the same 1,578 MB twice;
  the numbers above are from that version and its `accounted` is too high by that much. The
  arithmetic is fixed (blocks whole, textures only outside them) and not yet re-measured.
- **The buffer copies and the scratch buffers are the movable part, and they are small**:
  492 MB of card sides of title buffers and 592 MB of unordered-access scratch, against
  4,405 MB of the title's own textures and render targets, which cannot be moved anywhere.
  Every one of the movable classes answers to an existing switch; the plan table is in
  `VIctory-Kira-reports/VK-VRAM-MIX-1-2026-11-26.md` (outside this repository).
- **The unaccounted 3.4 GB is the driver's own account** — command allocators, pipeline
  objects, the pipeline library's mapped file (217 MB in this run), descriptor heaps (56 MB),
  and allocations no call of ours can see. It is printed as a difference rather than explained.

**One A/B was attempted and is void.** `VICTORY_CARD_BUFFERS=0` was run against the same
switch set, and the process died at 166 s with `0xC0000409`: `memory allocation of 3686400
bytes failed`, with `private 79777 MB ... the PC has 1113 MB free and 644 MB left to commit`
on a 31.1 GB machine. That is the process running out of **system** memory, not of card
memory, and it is not attributable to the switch; the run is not a measurement and no
comparison is drawn from it. Any longer VRAM experiment on this host has to deal with that
first.

Fixed by this work: the ledger itself. Not settled: whether lowering the empty-block reserve
gives the textures the room back without making the pool re-create blocks, and what the
buffer copies cost in frame time when they are not on the card.
\n## RTX 3080: lowering the empty-block reserve frees nothing, because the blocks are not empty\n\nThe block pool was the largest single item the VRAM ledger named on this card, and about\n1.5 GB of it looked empty. It is not a reserve that can be given back: it is holes inside\nblocks that are still in use.\n\n- **The two  constants are different things.**  counts empty 64 MiB\n  heaps of texture memory (64 of them, 4 GiB);  counts bytes of upload scratch\n  chunks (1 GiB of the PC's memory). Separate pools, separate units, no shared meaning.\n- ** caps the first of them, and unset it changes nothing.** It lowers\n  whichever of the two the card's room picked and never raises it; the blocks made ahead\n  follow the same cap, so a low cap cannot turn into make-and-drop churn. Two runs, one\n  switch apart, the same diag build and cache, 480 s of world each:\n\n| | control |  |\n|---|---|---|\n| card in use / budget | 8,668 / 7,532 MB | 8,938 / 7,711 MB |\n| blocks, whole | 2,624 MB / 41 | 2,752 MB / 43 |\n| bytes of blocks no piece holds | 1,006 MB | 1,114 MB |\n| blocks with nothing in them at all | 2 | 2 |\n| blocks made in all, let go | 41 / 2 | 43 / 0 |\n| passes that made none for lack of room | 409 | 334 |\n| world frame, median | 546.6 ms | 552.5 ms |\n\n- **The 1 GB was never reclaimable.** A run made 41 blocks and let go of 2; the rest stayed\n  held by textures the whole time. The ledger's "empty and kept" is block bytes no piece\n  covers, and  only lets go of a block whose free ranges are the whole block.\n  Holes inside a block are invisible to it, so a cap of 2 changed nothing: the wholly empty\n  blocks were 2 all along, and the pool let go of none.\n- **So the reserve is not where the room is.** Lowering it does not give the textures\n  anything back, and no default was changed for it. What the numbers point at instead is\n  fragmentation: 1 GB of holes across 41 blocks, which wants blocks of more than one size,\n  not a smaller reserve.\n


## The console profile: what Series S costs and saves, RTX 3080 (two runs)

`victory run --console series-s` tells the title it is on a Series S. In this tree that
changes three things the title can see, and nothing else:

| What | Series X | Series S | Where |
|---|---|---|---|
| `ConsoleMode` under `HKLM\Software\Microsoft\Windows NT\CurrentVersion\OEM` | `0x64` | `0x60` | `crates/victory-hle/src/modules/xsystem.rs:164-169` |
| `AnalyticsInfo.form` | `"Xbox Series X"` | `"Xbox Series S"` | `crates/victory-hle/src/modules/xsystem.rs:110` |
| Title memory: `XMemGetWorkingSetStatistics` and the DXGI adapter's memory | `(10 GiB, 3.5 GiB)` | `(0, 7,776 MiB)` | `crates/victory-gpu/src/console.rs:22-27`, read at `xmem.rs:1819` and `dxgi.rs:154` |

GPU capability is **not** part of it: every `D3D12_FEATURE` query reports the host card's
own answer (`device.rs`, `host.rs`), and `console::current()` is not on any of those paths.
Saves and the cache do not carry the console either (`run.rs:92` keys storage by title id
alone; the pipeline fingerprint is translation version + driver, `known.rs:202-209`), so one
data folder and one cache serve both.

**Two runs, one each, same switches, same warm cache, 600 s, world reached in both, no
device removal and no panic in either.** Numbers are the world section's medians from
`VICTORY_VRAM_LEDGER=1`:

| | Series X | Series S | |
|---|---|---|---|
| Card in use (as the system counts it) | 9,248 MB | **6,790 MB** | −27 % |
| Of its budget | **120.5 %** | **90.5 %** | over → under |
| Render targets and unordered-access textures | 3,038 MB | **1,371 MB** | −55 % |
| Blocks of texture memory, whole | 3,008 MB | 3,136 MB | +4 % |
| — of them empty and kept | 1,396 MB | 1,763 MB | +26 % |
| Title textures the title fills | 1,612 MB | 1,373 MB | −15 % |
| Passes that made none for lack of room | 565 | **74** | |
| Passes over unmapped slots | 12,140 | 27,307 | |
| Private memory, peak | 27,813 MB | **23,426 MB** | −4.4 GB |
| World frame, median | 396.8 ms | 425.0 ms | +7 % |

**The saving is the resolution, not a better use of the same pixels.** The same logs show
the title's main render targets fall from 3840×2160 and 2560×1440 to 1920×1080 and
1280×720, and the captured frames' presentation size halves from 1920×1080 to 960×540
(captures are written at half size, `capture.rs:163-166`, so 4K → 1080p). The render-target
class shrinks by exactly the factor the pixel count does. **No class of card memory got
smaller at the same resolution** — the block pool, which the console does not touch
(`pool.rs` keeps its empty blocks whatever the profile), grew slightly instead.

The frame time does not improve even though the GPU side does: `gpu` falls from 83.2 ms to
36.6 ms median while `prepare` rises from 50.6 ms to 64.9 ms, and the frame is 7 % longer.
At this stage the world is limited by preparation and copy-back, not by shading, so taking
half the pixels away buys nothing. Series S is a memory measure here, not a speed one.

One thing Series S alone brings: **three compute shaders do not translate under it** that do
under Series X (`GFX10 code at 0x218: a lane mask exchanged where not every lane runs is not
supported`), so their draws are dropped. Series X translated 2,528 shaders with none
refused; Series S translated 2,690 with those three. That is a picture risk on top of the
resolution.

**Not worth making the default.** On a 4K display the picture is visibly softer, and the
frame time does not pay for it. It is worth having as an explicit choice for a card with
8 GB or a machine short of system memory — which is what `scripts/play.ps1 -SeriesS` is, and
it changes nothing when the switch is not given.

Not settled: whether lowering the empty-block reserve under Series S gives the textures that
room back (1,763 MB of empty blocks were still held), and how much picture the three dropped
compute shaders cost. Both need runs of their own.
