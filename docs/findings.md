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
