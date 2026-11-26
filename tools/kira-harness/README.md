# kira-harness

Unattended runs of the title under VIctory, and what the log of such a run says.

`scripts/play.ps1` sets the switches and starts `victory run`. What it does not do is
everything around that: take a lock, check the executable, keep the title's own folder
untouched, stop at a deadline with the whole process tree, keep the log when the run is
killed, copy in a save folder that has already been through the title's first setup, and
turn the log into numbers a later run can be compared with. That is all this is.

Nothing here decides anything about the title; it runs it and reads what it prints.

## Setup

    cp tools/kira-harness/kira-harness.example.json tools/kira-harness/kira-harness.local.json

Fill in `victory` (a build made with the `diagnostics` feature — the scripted keys and the
frame capture live behind it), `exe` (the title's own executable) and `gameDir` (its
folder). `work` is where runs, links, logs and copied save data go; keep it off the system
drive. `kira-harness.local.json` is ignored by git.

If you want the run to skip the title's first setup, point `dataTemplate` at a save folder
that has already been through it. The folder is copied in fresh for every run and is never
written to. It is not part of the repository.

## One run

    node tools/kira-harness/run-one.mjs --id first --commit <hash>

    run          first  wall 214 s  exit 0  (stopped once the world was in the log)
    world        reached  frames 52  worst 4503.7 ms  median 576.9 ms
    …

It writes `<work>/runs/<id>/result.json`, `summary.txt`, `run.log` and a few frames.
The exit code is 0 when the run went as asked, whether or not the title reached its world;
`result.json` holds both facts.

## What the log means

| Question | Where the answer comes from |
|---|---|
| Is the title in the world? | a frame line under 5 frames a second (`crates/victory-gpu/src/host.rs`) |
| How slow is it there? | the same line's `ms/frame` |
| Are draws being dropped? | `dropped N without a host pipeline (M being made)` is temporary, `and N indirect` is not |
| Did it survive? | `device removed`, `0x887a0005`, TDR, a panic |

`draws/frame` is reported and never decides the world: a scene that draws ten times a
frame is slow, not missing. No verdict here comes from looking at a frame — the saved
pictures are evidence to look at later, not an input.

## The keys

`VICTORY_KEYS` is read inside the process
(`crates/victory-hle/src/modules/gameinput.rs`), so presses need no window in front and
type into nothing else. The list is `<seconds>:<key>`, each key held for 0.2 s, and a key
is a letter, a digit, or Enter, Esc, Tab, Back, Up, Down, Left, Right.

`keys` in the settings is that list, written out. Two presses of one key closer together
than the hold time are dropped rather than joined into one long press.

## Tests

    node --test "tools/kira-harness/test/*.test.mjs"

## Checking it before publishing

    node tools/kira-harness/check-public.mjs

It greps what git tracks for paths, private names, credentials and the title's own file
names. `--all` widens it to the whole repository.
