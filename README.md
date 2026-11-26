# VIctory-Kira: VIctory on NVIDIA (RTX 3080 10 GB)

A fork of [avatarmanz/VIctory-7900XTX](https://github.com/avatarmanz/VIctory-7900XTX)
(itself a fork of [VIctory](https://github.com/Marvisak/VIctory)), a compatibility
layer that runs an Xbox Series title natively on Windows from files the user
supplies. This branch is about **32-lane NVIDIA cards with 10 GB of memory**: it
carries the open NVIDIA pull requests from upstream, a few fixes of its own, and
measurements of what helps and what does not on one RTX 3080.

**This repository contains no game files, code or assets.** You need your own copy
of the game. It is not affiliated with or endorsed by the game's developer or
publisher.

## Where it stands (2026-11-26)

Tested on one machine only: Windows 11, Ryzen 7 7700, 31 GB RAM, **RTX 3080 10 GB**
(driver 32.0.16.1742), the Series X profile, `scripts\play.ps1` defaults. Each line
below is from single runs of 360-480 s in the world, not long sessions.

| | |
|---|---|
| Into the world, unattended | yes, every run so far; no device removal |
| World frame time, median | 320-550 ms a frame (about 2-3 fps), depending on the scene |
| Where a frame goes | GPU work ~85 ms, GPU idle ~140 ms, CPU preparing ~45-65 ms; the rest is copies and waits |
| Card memory | ~8.9 GB in use against a DXGI budget of ~7.6 GB, which falls further when system RAM is tight |
| System memory | 27-29 GB private: **a 32 GB machine is at its limit**; free physical memory drops to tens of MB |
| Series S profile (`-SeriesS`) | card memory -27 %, private memory -4.4 GB, rendered at 1080p instead of 4K, no faster |

What is known to be wrong here:

- Some textures, skin in particular, come in late or not at all: the card is over
  its budget, so new textures are passed over for lack of room.
- The frame rate is far from playable; the bottleneck is on the CPU side
  (submission, copies, synchronisation), not GPU arithmetic.
- The first run with a new build or driver is dark and stutters until the pipeline
  cache is warm (`victory warm --used`).

## How to run it

Requirements are as upstream's below (Windows 10/11 x64, AVX2, Direct3D 12 with
shader model 6.6 and mesh shaders, the pinned Rust toolchain, MSVC build tools,
your own dump of the title).

```powershell
git clone https://github.com/MoonYueya/VIctory-Kira
cd VIctory-Kira
copy victory.example.toml victory.toml      # then set your paths, outside this folder
cargo build --locked --profile diag -p victory --features diagnostics
target\diag\victory.exe shaders <the shader archives>   # once, translates every shader
target\diag\victory.exe warm --used                     # for a new build or driver
scripts\play.ps1 -Exe <path of your copy's executable>
```

Use the `diag` build: the plain default build has frame capture and scripted keys
compiled out, and a run of it never leaves the menu. On an NVIDIA card (vendor
`0x10DE`) `play.ps1` sets `VICTORY_TEXTURE_ROOM_PERCENT=97` (AMD keeps its 90).
`-Safe` leaves the newer, faster ways out; `-SeriesS` plays the Series S profile.
Closing heavy background programs before a run gives the card's budget back some room.

[tools/kira-harness](tools/kira-harness) runs the title unattended (scripted keys,
a save template, a run lock, frame capture, a results file) and turns a run log into
a baseline table; see its README.

## What is different from upstream

Upstream pull requests merged here, each as a `--no-ff` merge so its author stays
in the history:

| PR | Author | What it changes |
|---|---|---|
| [#47](https://github.com/avatarmanz/VIctory-7900XTX/pull/47) | gomeaw | Dynamic descriptor tables from coalesced free ranges |
| [#48](https://github.com/avatarmanz/VIctory-7900XTX/pull/48) | gomeaw | Dynamic descriptor ranges reclaimed at GPU completion |
| [#24](https://github.com/avatarmanz/VIctory-7900XTX/pull/24) | gomeaw | Unrelated buffer slots skipped in each spread heap scan |
| [#23](https://github.com/avatarmanz/VIctory-7900XTX/pull/23) | gomeaw | Structured buffer reads stay raw on heaps without descriptor twins |
| [#78](https://github.com/avatarmanz/VIctory-7900XTX/pull/78) | feanorsun | `play.ps1` fails on a missing executable |
| [#42](https://github.com/avatarmanz/VIctory-7900XTX/pull/42) | gomeaw | Render and depth descriptor scratch private to each recording thread |
| [#66](https://github.com/avatarmanz/VIctory-7900XTX/pull/66) | Mumogg | wave64 builder programs count threads on 32-lane hosts |
| [#18](https://github.com/avatarmanz/VIctory-7900XTX/pull/18) | gomeaw | Unique compute thread IDs on tiled wave32 GPUs |
| [#10](https://github.com/avatarmanz/VIctory-7900XTX/pull/10) | gomeaw | Wide indirect dispatches split on 32-lane GPUs |
| [#4](https://github.com/avatarmanz/VIctory-7900XTX/pull/4) | gomeaw | LDS flag regions run on 32-lane GPUs |
| [#58](https://github.com/avatarmanz/VIctory-7900XTX/pull/58) | battledogegames-design | Direct-heap root-signature flags from shader features |
| [#17](https://github.com/avatarmanz/VIctory-7900XTX/pull/17) | UwUCammie | A frame is counted after DXGI accepts the present |
| [#69](https://github.com/avatarmanz/VIctory-7900XTX/pull/69) | Adika713 | Memory category log (`VICTORY_MEMORY_CATEGORIES=1`, off by default), ported as `28f166b` |
| [#77](https://github.com/avatarmanz/VIctory-7900XTX/pull/77) | Adika713 | Idle window budget (`VICTORY_WINDOW_BUDGET_MB`, off by default; on this card it keeps copies rather than capping them, see findings) |

Changes of this branch:

- **On by default**
  - A stand-in pad in slot 0 shows the scripted keys when no controller is attached
    (`a738c22`).
  - The dynamic descriptor region is sized by where the title's heap ends on NVIDIA,
    so no dynamic table is refused (`bbcdb0a`).
  - `play.ps1` gives textures 97 % of the card's room on NVIDIA (`9e2763d`).
- **Off by default, for measuring**
  - `VICTORY_VRAM_LEDGER=1`: the card's memory by class.
  - `VICTORY_BUDGET_LOG=1`, `VICTORY_BUDGET_RESERVE_MB`: the DXGI budget over time,
    and a reservation test.
  - `VICTORY_POOL_SPARE`: how many empty texture blocks are kept.
  - `VICTORY_DROP_HOST_COPY=1`: let a texture's host copy go once its upload ran.
  - `VICTORY_LOOKUP_CACHE=1`: a thread remembers what its asks for a buffer's host copy
    found (upstream fxceless/victory-gta6 #1237). It works — 78.7 % of the asks answered
    from the asking thread's own memory on the RTX 3080 — but the frame time and the CPU
    time to prepare a submission both went up, not down; the numbers are in
    [docs/findings.md](docs/findings.md).
  - `-SeriesS` in `play.ps1`.

Measured on the RTX 3080 and **not** taken, with the numbers, in
[docs/findings.md](docs/findings.md): upstream PR #72 (VRAM eviction, frame time
×4 here), the Marvisak eviction water marks (branch `experiment/evict`), a DXGI
memory reservation, a smaller empty-block cap, and a window budget that is always on
(branch `experiment/winbudget`).

Tests on this branch: **953 passed, 0 failed, 45 ignored** (`cargo test --workspace`).

## What is next

From a comparison of the NVIDIA forks around (none has RTX 3080 10 GB frame times):

1. The buffer host-copy lookup cache (`VICTORY_LOOKUP_CACHE`, fxceless/victory-fork
   PR #1237), aimed at the GPU idle time.
2. Returning dynamic descriptor slots when a flight lands (TaynanGT/Vice-Tay).
3. Dropping the largest mip levels of title textures (`VICTORY_TEXTURE_DROP_MIPS`,
   soldsawn/victory-nvidia-8gb), to bring the card under its budget.

Each goes in behind a switch and is A/B-tested on this card before it becomes a
default.

These changes were made with AI assistance. GPL-3.0-or-later, as upstream.

---

*The rest of this file is upstream's README (avatarmanz/VIctory-7900XTX), unchanged.*

# VIctory on an RX 7900 XTX

A fork of [VIctory](https://github.com/Marvisak/VIctory), a compatibility layer
that runs an Xbox Series title natively on Windows from files the user supplies.
This one is about **speed on AMD RDNA 3**: the world at 30 frames a second on
one PC, without giving up the picture. It is not there yet.

**This repository contains no game files, code or assets.** You need your own
copy of the game. It is not affiliated with or endorsed by the game's developer
or publisher.

## Where it stands (2026-11-25)

Tested on one machine only: Windows 11, Intel i9-12900K, 64 GB RAM, Radeon
RX 7900 XTX, 1440p, the Series X profile.

| | |
|---|---|
| Menus, videos, loading screens | 30 fps |
| Prologue, indoors | 50-75 ms a frame (13-20 fps) |
| First mission with the boat | 46-53 ms (19-22 fps) |
| Street chase with many cars and people | 100-165 ms (6-10 fps), single frames far longer |
| Outdoors on foot, the camp | 60-90 ms |
| Flying | 42-57 ms |
| Longest session so far | 41 minutes, no crash |
| Memory | 40-46 GB of private memory: **64 GB of RAM recommended** |

It started at 280 ms a frame in the same scenes two days earlier.

What is known to be wrong:

- Trees, plants and far buildings flicker outdoors in some places.
- Rooms with little direct light are too dark without `-RayTracing`.
- Textures of what just came into view appear late while the title streams.
- The first run with a new driver or a new build stutters while the driver makes
  pipelines (`victory warm` makes them ahead).
- Recording a frame in the world makes the title's own watchdog end it.

## How to run it

You need Windows 10/11 x64, a CPU with AVX2, a Direct3D 12 GPU with shader
model 6.6 and mesh shaders, Rust (the toolchain is pinned), the MSVC build
tools, and your own dump of the title.

```powershell
git clone https://github.com/avatarmanz/VIctory-7900XTX
cd VIctory-7900XTX
copy victory.example.toml victory.toml      # then set your paths, outside this folder
cargo build --locked --profile diag -p victory --features diagnostics
scripts\play.ps1 -Exe <path of your copy's executable>
```

`scripts\play.ps1 -Safe` leaves out the newest, faster ways; try it first when
something is wrong. `-RayTracing` turns the title's ray-traced indirect light on.
On an NVIDIA card (vendor `0x10DE`) it also gives the textures picked by index more
of the card (`VICTORY_TEXTURE_ROOM_PERCENT=97`) where it is AMD's default `90`; AMD is
left as it was.

Before the first run, ahead of time (both can be stopped and go on later):

```powershell
target\diag\victory.exe shaders <the shader archives>   # every shader translated, minutes
target\diag\victory.exe warm --used                     # pipelines earlier runs drew with, for a new driver or build
```

Commands, debugging switches and upstream's own description:
[docs/README-fxceless.md](docs/README-fxceless.md). Every `VICTORY_...` switch is
described in a comment where it is read.

## What is different here

In short; the reasons and the measurements are in [docs/findings.md](docs/findings.md).

- **List calls are written down, not carried out, on the title's threads**
  (`VICTORY_THIN`): eight threads of ours translate them.
- **Submissions are prepared by a thread of ours and joined**
  (`VICTORY_ASYNC_SUBMIT`, `VICTORY_JOIN_PARTS`), with what can be spread over
  threads spread: refreshes, compares (AVX2), descriptor records, landings.
- **What shaders wrote comes back beside the write guards**, by the dwords that
  changed, on a thread of its own (`VICTORY_RELAY`, `VICTORY_LAND`).
- **Buffer fills that need bytes still on the card are done on the card**
  (`VICTORY_CARD_STEPS`) instead of waiting for it.
- **The title's writes are caught more cheaply**: one view opened at a fault,
  blocks that rest, places in the title's code that look before they write.
- **Textures go up on a copy queue of their own** and a slot shows one only after
  its upload ran, which also ended a device loss that came every 15 minutes or so.
- **Boats float**: textures that shaders write and the title's CPU reads go back
  to title memory (from fxceless and Geckomacabre, on by default here).
- **Frame record and replay** with per-pass times and shader variants compared
  turn by turn ([docs/replay.md](docs/replay.md)).

## Credits

This is a tree of other people's work with more on top. The history is kept, and
commits taken from elsewhere name the commit and its author.

- **[VIctory](https://github.com/Marvisak/VIctory)** by Marvisak and its
  contributors: the loader, the runtime services, the Direct3D 12 back end and
  the shader recompiler.
- **[fxceless/victory-fork](https://github.com/fxceless/victory-fork)**: the fork
  this one started from, and the people whose pull requests it carries.
- **[DexNom/VIctory](https://github.com/DexNom/VIctory)**: ray tracing fixes,
  cube gradients, sparse textures.
- **[Belobug/VIctory-Belobug-AMD](https://github.com/Belobug/VIctory-Belobug-AMD)**:
  the ambient light idea, pipeline workers, and work by romainhedouin.
- **[FQY55kai/ZJOU-VICTORY](https://github.com/FQY55kai/ZJOU-VICTORY)**.
- **[myokex/victory-amd](https://github.com/myokex/victory-amd)**: the guard over
  every view of a page (with Spexivus, joroyt and tightfall), and Joshua Odom's
  reads into title memory.
- **Geckomacabre** and **cxy0072019-sketch**: the texture read-back.
- **[XCL](https://github.com/ivall/xcl)** (GPL-2.0-only) was read for how the same
  title behaves under another layer; no code of it is here.
- This fork's changes were made with [Claude Code](https://claude.com/claude-code).

## License

GPL-3.0-or-later, as VIctory. See [LICENSE](LICENSE); the one file that is not
covered is named in [docs/asset-policy.md](docs/asset-policy.md).

ZETTROX
