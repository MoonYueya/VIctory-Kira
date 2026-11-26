//! Fences: a 64-bit value and the events waiting for it. Nothing runs on a
//! GPU yet, so only signals (the title's, later our queues') move one.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

use std::ffi::c_void;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::object::{self, E_NOTIMPL, FENCE, HRESULT, Iid, Object, S_OK, Table, This, guid};
use crate::resource::PAGEABLE_IIDS;

pub(crate) const FENCE_IIDS: [Iid; 5] = [
    guid(
        0x0a753dcf,
        0xc4d8,
        0x4b91,
        [0xad, 0xf6, 0xbe, 0x5a, 0x60, 0xd9, 0x5a, 0x76],
    ),
    // ID3D12Fence1.
    guid(
        0x433685fe,
        0xe22b,
        0x4ca0,
        [0xa8, 0xdb, 0xb5, 0xb4, 0xf4, 0xdd, 0x0e, 0x4a],
    ),
    PAGEABLE_IIDS[0],
    PAGEABLE_IIDS[1],
    PAGEABLE_IIDS[2],
];

#[repr(C)]
struct Fence {
    object: Object,
    /// Titles also read it straight from memory, at the fence's GPU
    /// address.
    value: AtomicU64,
    flags: u32,
    /// Events to set once the value reaches theirs (handles as integers).
    waiters: Mutex<Vec<(u64, usize)>>,
}

fn fence<'a>(this: This) -> &'a Fence {
    // SAFETY: called from fence methods only.
    unsafe { &*this.cast::<Fence>() }
}

pub(crate) extern "system" fn create(
    _: This,
    initial: u64,
    flags: u32,
    iid: *const Iid,
    out: *mut This,
) -> HRESULT {
    tracing::debug!(initial, flags, "fence");
    let fence = Box::new(Fence {
        object: Object::new(&FUNCTIONS),
        value: AtomicU64::new(initial),
        flags,
        waiters: Mutex::new(Vec::new()),
    });
    object::hand_out(FENCE, fence, iid, &FENCE_IIDS, out)
}

fn set_event(event: usize) {
    #[cfg(windows)]
    // SAFETY: the title passed an event handle.
    unsafe {
        windows_sys::Win32::System::Threading::SetEvent(event as *mut c_void)
    };
    #[cfg(not(windows))]
    let _ = event;
}

/// Blocking fence waits that are woken when the value moves
/// (`VICTORY_FENCE_WAKE=1`; off by default, and off leaves every call answered
/// exactly as it was before this switch existed, `E_NOTIMPL` included).
///
/// A null event in `SetEventOnCompletion` asks for "block until the value is
/// reached": there is nothing to signal, so the thread has to sleep on the
/// value itself. `WaitOnAddress` does that, and `WakeByAddressAll` on the same
/// word — the fence's `value`, which is also the address `GetGpuAddress` hands
/// the title — wakes it the moment a signal, a queue's bottom-of-pipe write or
/// a settle moves the value.
///
/// The wait is bounded: 250 ms in all, in slices of at most 10 ms, and the word
/// is read again after each slice. A value reached during a slice ends the wait
/// at once; a value not reached by the end of it is answered as the call always
/// was (`E_NOTIMPL`), so a title that treats a failure as "poll instead" ends
/// up where it started rather than hanging.
///
/// This waits for the value only. It does not make the value move: what moves
/// it is a signal, a bottom-of-pipe write, or a settle (`crate::host::late`).
#[cfg(windows)]
pub(crate) mod wake {
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicU64, Ordering::Acquire};
    use std::time::{Duration, Instant};

    /// Whether blocking waits sleep and are woken (`VICTORY_FENCE_WAKE=1`; off
    /// by default).
    pub(crate) fn on() -> bool {
        static ON: OnceLock<bool> = OnceLock::new();
        *ON.get_or_init(|| std::env::var_os("VICTORY_FENCE_WAKE").is_some_and(|v| v == "1"))
    }

    /// How long a blocking wait waits before it is answered as it always was.
    pub(crate) const MOST: Duration = Duration::from_millis(250);

    /// The longest single sleep, so the word is looked at again soon after it
    /// moves and a waker that arrives between the read and the sleep is not
    /// missed for long.
    pub(crate) const SLICE: u32 = 10;

    /// Sleeps until `value` is reached or [`MOST`] has passed: whether it was
    /// reached.
    pub(crate) fn until(word: &AtomicU64, value: u64) -> bool {
        let deadline = Instant::now() + MOST;
        loop {
            let seen = word.load(Acquire);
            if seen >= value {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let ms = (deadline - now).as_millis().min(u128::from(SLICE)) as u32;
            // SAFETY: `word` is a live atomic the title reads at the fence's GPU
            // address; `seen` is the value the wait is given up for.
            unsafe {
                windows_sys::Win32::System::Threading::WaitOnAddress(
                    (&raw const *word).cast(),
                    (&raw const seen).cast(),
                    size_of::<u64>(),
                    ms.max(1),
                );
            }
        }
    }

    /// Wakes every thread waiting on `word`.
    ///
    /// # Safety
    /// `word` must be a live atomic, and stay where it is while it is waited on.
    pub(crate) unsafe fn wake_all(word: &AtomicU64) {
        // SAFETY: the caller says the word is live, which is what the address
        // taken here has to be.
        unsafe {
            windows_sys::Win32::System::Threading::WakeByAddressAll((&raw const *word).cast());
        }
    }
}

/// The wait a null event asks for: sleeps on a fence's value until it is
/// reached or [`wake::MOST`] has passed. `woken` says whether it sleeps at all
/// (`VICTORY_FENCE_WAKE=1`); off, it answers "not reached" without waiting,
/// which is what the call did before the switch.
///
/// The caller must not hold the fence's waiters while this sleeps: what wakes
/// it is `set`, which takes them.
fn blocking_wait(word: &AtomicU64, value: u64, woken: bool) -> bool {
    #[cfg(windows)]
    if woken {
        return wake::until(word, value);
    }
    let _ = (word, value);
    false
}

extern "system" fn query(this: This, iid: *const Iid, out: *mut This) -> HRESULT {
    object::answer(
        FENCE,
        iid,
        object::is(iid, &FENCE_IIDS).then_some(this),
        out,
    )
}
extern "system" fn release(this: This) -> u32 {
    object::release_boxed::<Fence>(this)
}
pub(crate) extern "system" fn completed(this: This) -> u64 {
    fence(this).value.load(Ordering::Acquire)
}
/// The title's `GetCompletedValue`.
extern "system" fn completed_called(this: This) -> u64 {
    let value = completed(this);
    #[cfg(all(windows, feature = "diagnostics"))]
    crate::timeline::polled(this as usize, value);
    value
}
extern "system" fn set_event_on_completion(this: This, value: u64, event: *mut c_void) -> HRESULT {
    let fence = fence(this);
    let mut waiters = fence.waiters.lock().unwrap_or_else(|e| e.into_inner());
    if fence.value.load(Ordering::Acquire) >= value {
        if !event.is_null() {
            set_event(event as usize);
        }
        return S_OK;
    }
    #[cfg(all(windows, feature = "diagnostics"))]
    crate::timeline::told("an event asked for", this as usize, value);
    if event.is_null() {
        #[cfg(windows)]
        {
            // With submissions sent to the card and not waited for
            // (`crate::host::late`) the signal may be behind them: they are
            // settled, which sets it.
            if crate::host::late() {
                drop(waiters);
                crate::queue::before_sync();
                crate::host::settle_for_fence();
                if fence.value.load(Ordering::Acquire) >= value {
                    return S_OK;
                }
                // Not reached yet: with the wake on this thread waits for the
                // value here instead of taking the call back (`VICTORY_FENCE_WAKE=1`).
                if blocking_wait(&fence.value, value, wake::on()) {
                    return S_OK;
                }
                tracing::warn!(value, "blocking fence wait not implemented");
                return E_NOTIMPL;
            }
            // Nothing of ours settles the flights here, but another thread of
            // the title's (or one of ours) may still move the value: with the
            // wake on the lock is let go and this thread waits for it. Off, the
            // call is answered exactly as it was.
            if wake::on() {
                drop(waiters);
                if blocking_wait(&fence.value, value, true) {
                    return S_OK;
                }
                tracing::warn!(value, "blocking fence wait timed out");
                return E_NOTIMPL;
            }
        }
        // shortcut: a null event means "block until reached"; nothing can
        // reach it while no GPU work runs, so fail instead of hanging.
        tracing::warn!(value, "blocking fence wait not implemented");
        return E_NOTIMPL;
    }
    waiters.push((value, event as usize));
    // The value may have moved between the look above and the push (nothing
    // holds memory writes): an event that arrived then would never be set.
    // (Belobug's fence.rs re-checks here for the same reason.) This costs a
    // load and changes nothing when the value has not moved.
    if fence.value.load(Ordering::Acquire) >= value {
        let reached = waiters.iter().position(|&(wanted, _)| wanted == value);
        if let Some(at) = reached {
            let (_, event) = waiters.remove(at);
            set_event(event);
        }
    }
    S_OK
}
/// Diagnostics: the value the title waits on, seen from our side of it
/// (`VICTORY_FENCE_LAG=1`; off by default, and only in diagnostics builds).
///
/// The title waits for a fence by reading the value in memory: `monitorx` on
/// it, `mwaitx`, then the value again, with `Sleep(0)` on the passes that
/// find it unmoved (its `+0x4fb0ad0`; the read at `+0x4fb0c03` is 57.6% of
/// that thread's running samples in run cpuprof-ctl-b). Nothing of ours sees
/// those reads: they are in the title's own code. What this measures is the
/// other side of them, how often the value moves and how long a move is held
/// after the card has finished the work it stands for. A thread that keeps a
/// processor busy for 536 ms a frame is waiting for one of those two numbers,
/// and which one it is is what this says.
#[cfg(all(windows, feature = "diagnostics"))]
pub(crate) mod lag {
    use std::sync::atomic::{AtomicU64, Ordering::Acquire, Ordering::Release};
    use std::sync::{Mutex, OnceLock};

    /// Whether the meter runs (`VICTORY_FENCE_LAG=1`; off by default).
    pub(crate) fn on() -> bool {
        static ON: OnceLock<bool> = OnceLock::new();
        *ON.get_or_init(|| std::env::var_os("VICTORY_FENCE_LAG").is_some_and(|v| v == "1"))
    }

    /// Microseconds since the first look, for the stamps below.
    fn micros() -> u64 {
        static START: OnceLock<std::time::Instant> = OnceLock::new();
        START.get_or_init(std::time::Instant::now).elapsed().as_micros() as u64
    }

    /// When the card was last seen to have finished the flights in the air
    /// ([`card_done`]), and the one last counted against a move.
    static CARD_DONE: AtomicU64 = AtomicU64::new(0);
    static COUNTED: AtomicU64 = AtomicU64::new(0);

    /// The card has finished the flights in the air: what a signal behind
    /// them has to wait for (`crate::host::late`).
    pub(crate) fn card_done() {
        if !on() {
            return;
        }
        CARD_DONE.store(micros().max(1), Release);
    }

    /// The bands a hold falls in, in microseconds: under 1 ms, 4, 16, 50,
    /// 100, and anything longer.
    pub(crate) const BANDS: [u64; 5] = [1_000, 4_000, 16_000, 50_000, 100_000];

    /// Which band `us` falls in: an index into [`BANDS`], or `BANDS.len()`
    /// for the last, open one.
    pub(crate) fn band_of(us: u64) -> usize {
        BANDS.iter().position(|&edge| us < edge).unwrap_or(BANDS.len())
    }

    /// Moves seen, and the holds counted by band.
    #[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
    pub(crate) struct Seen {
        pub(crate) moves: u64,
        pub(crate) held: [u64; 6],
        pub(crate) longest: u64,
    }

    impl Seen {
        /// The holds, band by band: `<1ms 3, <4ms 1, ... >=100ms 2`.
        pub(crate) fn held_text(&self) -> String {
            let names = ["<1ms", "<4ms", "<16ms", "<50ms", "<100ms", ">=100ms"];
            names
                .iter()
                .zip(self.held)
                .filter(|(_, n)| *n > 0)
                .map(|(name, n)| format!("{name} {n}"))
                .collect::<Vec<_>>()
                .join(", ")
        }
    }

    static SEEN: Mutex<Seen> = Mutex::new(Seen {
        moves: 0,
        held: [0; 6],
        longest: 0,
    });
    static LAST_LINE: Mutex<Option<std::time::Instant>> = Mutex::new(None);

    /// The fence moved to `value`: counted, and held against the card's last
    /// completion if there is one newer than the one already counted.
    pub(crate) fn moved(value: u64) {
        if !on() {
            return;
        }
        let done = CARD_DONE.load(Acquire);
        let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        seen.moves += 1;
        if done != 0 && done > COUNTED.load(Acquire) {
            COUNTED.store(done, Release);
            let hold = micros().saturating_sub(done);
            seen.held[band_of(hold)] += 1;
            seen.longest = seen.longest.max(hold);
        }
        drop(seen);
        line(value);
    }

    /// Once every five seconds: what the meter has seen.
    fn line(value: u64) {
        let Ok(mut last) = LAST_LINE.try_lock() else {
            return;
        };
        let since = *last.get_or_insert_with(std::time::Instant::now);
        let seconds = since.elapsed().as_secs_f64();
        if seconds < 5.0 {
            return;
        }
        *last = Some(std::time::Instant::now());
        drop(last);
        let taken = {
            let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *seen)
        };
        let held = taken.held_text();
        tracing::info!(
            last = value,
            "fence values the title waits on, seen from our side (VICTORY_FENCE_LAG=1): moved {:.1} times a second; a move held after the card had finished the work it stands for: {}; the longest of those {:.1} ms",
            taken.moves as f64 / seconds,
            if held.is_empty() { "never".to_owned() } else { held },
            taken.longest as f64 / 1000.0,
        );
    }
}

/// Moves the fence to `value` and sets the events that waited for it.
pub(crate) fn set(this: This, value: u64) {
    let fence = fence(this);
    #[cfg(all(windows, feature = "diagnostics"))]
    {
        crate::timeline::told("a fence set", this as usize, value);
        lag::moved(value);
    }
    let mut waiters = fence.waiters.lock().unwrap_or_else(|e| e.into_inner());
    fence.value.store(value, Ordering::Release);
    waiters.retain(|&(wanted, event)| {
        let reached = wanted <= value;
        if reached {
            set_event(event);
        }
        !reached
    });
    drop(waiters);
    #[cfg(windows)]
    if wake::on() {
        // A title thread blocked on this value without an event
        // (`WakeOnAddress`, `VICTORY_FENCE_WAKE=1`): what it waits for has
        // moved.
        // SAFETY: the fence is alive (a wait on it holds a reference), and its
        // value does not move while it is.
        unsafe { wake::wake_all(&fence.value) };
    }
}
pub(crate) extern "system" fn signal(this: This, value: u64) -> HRESULT {
    let _called = crate::timeline::span("a fence set");
    set(this, value);
    // A queue may have waited for it: what it held runs now.
    #[cfg(windows)]
    crate::queue::release_held(false);
    S_OK
}

extern "system" fn creation_flags(this: This) -> u32 {
    fence(this).flags
}
/// Where the value lives (GPU addresses are CPU addresses).
extern "system" fn gpu_address(this: This) -> u64 {
    (&raw const fence(this).value) as u64
}

/// IUnknown 3, object 4, device child 1, fence 3, fence 1 (2, a console
/// one among them).
static FUNCTIONS: Table<24> = {
    let mut f = object::d3d12_object(object::missing_table::<FENCE, 24>());
    f[0] = query as *const ();
    f[2] = release as *const ();
    f[7] = object::parent_device as *const (); // 0x38
    f[8] = completed_called as *const (); // 0x40
    f[9] = set_event_on_completion as *const (); // 0x48
    f[10] = signal as *const (); // 0x50
    f[11] = creation_flags as *const (); // 0x58
    f[12] = gpu_address as *const (); // 0x60
    Table(f)
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object::slot;

    #[cfg(windows)]
    #[test]
    fn signals_set_waiting_events() {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

        let mut f = std::ptr::null();
        assert_eq!(create(std::ptr::null(), 1, 0, &FENCE_IIDS[0], &mut f), S_OK);
        assert_eq!(slot::<extern "system" fn(This) -> u64>(f, 0x40)(f), 1);
        // SAFETY: plain auto-reset event.
        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        assert!(!event.is_null());
        let wait = slot::<extern "system" fn(This, u64, *mut c_void) -> HRESULT>(f, 0x48);
        let signal = slot::<extern "system" fn(This, u64) -> HRESULT>(f, 0x50);
        assert_eq!(wait(f, 5, event), S_OK);
        // SAFETY: a valid event.
        assert_ne!(unsafe { WaitForSingleObject(event, 0) }, WAIT_OBJECT_0);
        assert_eq!(signal(f, 5), S_OK);
        // SAFETY: as above.
        assert_eq!(unsafe { WaitForSingleObject(event, 0) }, WAIT_OBJECT_0);
        assert_eq!(wait(f, 5, event), S_OK, "already reached");
        // SAFETY: as above.
        assert_eq!(unsafe { WaitForSingleObject(event, 0) }, WAIT_OBJECT_0);
        assert_eq!(wait(f, 9, std::ptr::null_mut()), E_NOTIMPL);
        // The title reads the value at the fence's address.
        let at = slot::<extern "system" fn(This) -> u64>(f, 0x60)(f);
        // SAFETY: the fence's value.
        assert_eq!(unsafe { *(at as *const u64) }, 5);
        // SAFETY: ours.
        unsafe { CloseHandle(event) };
        assert_eq!(slot::<extern "system" fn(This) -> u32>(f, 0x10)(f), 0);
    }

    /// What the meter counts: the bands a hold falls in, and the text it
    /// says them with. (The meter itself only runs with `VICTORY_FENCE_LAG=1`
    /// and a diagnostics build; here is what it computes.)
    #[cfg(all(windows, feature = "diagnostics"))]
    #[test]
    fn a_hold_is_counted_in_the_band_it_falls_in() {
        use lag::{BANDS, Seen, band_of};
        assert_eq!(band_of(0), 0);
        assert_eq!(band_of(999), 0);
        assert_eq!(band_of(1_000), 1);
        assert_eq!(band_of(3_999), 1);
        assert_eq!(band_of(4_000), 2);
        assert_eq!(band_of(15_999), 2);
        assert_eq!(band_of(16_000), 3);
        assert_eq!(band_of(49_999), 3);
        assert_eq!(band_of(50_000), 4);
        assert_eq!(band_of(99_999), 4);
        assert_eq!(band_of(100_000), BANDS.len());
        assert_eq!(band_of(u64::MAX), BANDS.len());
        // Six bands: the five edges and the open one past them.
        let mut seen = Seen::default();
        seen.moves = 7;
        for us in [0, 1_500, 5_000, 20_000, 60_000, 500_000] {
            seen.held[band_of(us)] += 1;
            seen.longest = seen.longest.max(us);
        }
        assert_eq!(seen.held, [1, 1, 1, 1, 1, 1]);
        assert_eq!(seen.longest, 500_000);
        assert_eq!(seen.held_text(), "<1ms 1, <4ms 1, <16ms 1, <50ms 1, <100ms 1, >=100ms 1");
        assert_eq!(Seen::default().held_text(), "", "nothing held, nothing said");
    }

    /// The meter is off unless it is asked for: the fence's own path is the
    /// same with it off as with it on, and nothing is counted.
    #[cfg(all(windows, feature = "diagnostics"))]
    #[test]
    fn the_meter_is_off_by_default() {
        // SAFETY: plain process environment, set before the meter is first
        // asked (nothing else in this test binary asks it).
        unsafe { std::env::remove_var("VICTORY_FENCE_LAG") };
        assert!(!lag::on(), "the meter runs only when asked for");
    }

    #[test]
    fn fence1_interface_is_created_and_queried() {
        const FENCE1_IID: Iid = guid(
            0x433685fe,
            0xe22b,
            0x4ca0,
            [0xa8, 0xdb, 0xb5, 0xb4, 0xf4, 0xdd, 0x0e, 0x4a],
        );
        type Query = extern "system" fn(This, *const Iid, *mut This) -> HRESULT;
        type Flags = extern "system" fn(This) -> u32;
        type Release = extern "system" fn(This) -> u32;

        // Direct creation as ID3D12Fence1, and GetCreationFlags at slot 0x58.
        let mut f1 = std::ptr::null();
        assert_eq!(create(std::ptr::null(), 3, 0x5, &FENCE1_IID, &mut f1), S_OK);
        assert!(!f1.is_null());
        assert_eq!(slot::<Flags>(f1, 0x58)(f1), 0x5);
        assert_eq!(slot::<Release>(f1, 0x10)(f1), 0);

        // QueryInterface from ID3D12Fence to ID3D12Fence1 returns the same object.
        let mut f = std::ptr::null();
        assert_eq!(
            create(std::ptr::null(), 0, 0x2, &FENCE_IIDS[0], &mut f),
            S_OK
        );
        let mut queried = std::ptr::null();
        assert_eq!(slot::<Query>(f, 0x00)(f, &FENCE1_IID, &mut queried), S_OK);
        assert_eq!(queried, f);
        assert_eq!(slot::<Flags>(queried, 0x58)(queried), 0x2);
        assert_eq!(slot::<Release>(queried, 0x10)(queried), 1);
        assert_eq!(slot::<Release>(f, 0x10)(f), 0);
    }

    /// A null event with the wake off is answered exactly as it was before the
    /// switch: `E_NOTIMPL`, and nothing waits.
    #[cfg(windows)]
    #[test]
    fn a_blocking_wait_is_refused_with_the_wake_off() {
        // SAFETY: plain process environment, set before the switch is first
        // asked.
        unsafe { std::env::remove_var("VICTORY_FENCE_WAKE") };
        assert!(!wake::on(), "the wake runs only when asked for");

        let mut f = std::ptr::null();
        assert_eq!(create(std::ptr::null(), 1, 0, &FENCE_IIDS[0], &mut f), S_OK);
        let wait = slot::<extern "system" fn(This, u64, *mut c_void) -> HRESULT>(f, 0x48);
        let signal = slot::<extern "system" fn(This, u64) -> HRESULT>(f, 0x50);
        // Off: the call comes straight back, as it always did.
        assert_eq!(wait(f, 9, std::ptr::null_mut()), E_NOTIMPL);
        // The refusal leaves the value where it was.
        assert_eq!(slot::<extern "system" fn(This) -> u64>(f, 0x40)(f), 1);
        assert_eq!(signal(f, 4), S_OK);
        // Reached: S_OK with the wake off too, as before.
        assert_eq!(wait(f, 4, std::ptr::null_mut()), S_OK);
        assert_eq!(slot::<extern "system" fn(This) -> u32>(f, 0x10)(f), 0);
    }

    /// A value already reached is answered at once, without sleeping for it.
    #[cfg(windows)]
    #[test]
    fn a_value_already_reached_is_not_waited_for() {
        let word = AtomicU64::new(7);
        let started = std::time::Instant::now();
        assert!(wake::until(&word, 7), "reached: the wait ends at once");
        assert!(wake::until(&word, 3), "past it: reached all the same");
        assert!(
            started.elapsed() < wake::MOST,
            "a value already reached must not sleep for the whole wait"
        );
    }

    /// A wait on a value that is moved from another thread ends when it is
    /// moved, and not at the end of the wait.
    #[cfg(windows)]
    #[test]
    fn a_wait_is_woken_when_the_value_arrives() {
        use std::sync::Arc;

        let word = Arc::new(AtomicU64::new(0));
        let mover = {
            let word = Arc::clone(&word);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                word.store(5, Ordering::Release);
                // SAFETY: the word is alive until the join below.
                unsafe { wake::wake_all(&word) };
            })
        };
        let started = std::time::Instant::now();
        assert!(wake::until(&word, 5), "the value arrived");
        let waited = started.elapsed();
        mover.join().expect("the mover finishes");
        assert!(
            waited < wake::MOST,
            "woken by the move, not by the end of the wait ({waited:?})"
        );
    }

    /// A value that never arrives ends the wait at its bound, and says it did
    /// not arrive.
    #[cfg(windows)]
    #[test]
    fn a_wait_that_is_never_reached_ends_at_its_bound() {
        let word = AtomicU64::new(1);
        let started = std::time::Instant::now();
        assert!(!wake::until(&word, 2), "it never arrived");
        let waited = started.elapsed();
        assert!(
            waited >= wake::MOST,
            "the wait runs to its bound ({waited:?})"
        );
        assert!(
            waited < wake::MOST * 3,
            "and does not run far past it ({waited:?})"
        );
    }

    /// The switch is what decides: never asked for here, so off.
    #[cfg(windows)]
    #[test]
    fn the_wake_is_off_unless_asked_for() {
        // SAFETY: plain process environment, as above.
        unsafe { std::env::remove_var("VICTORY_FENCE_WAKE") };
        assert!(!wake::on(), "off unless asked for");
    }

    /// A null event with the wake on sleeps until the value is moved, and says
    /// the call was answered by the wait.
    #[cfg(windows)]
    #[test]
    fn a_blocking_wait_is_answered_when_the_value_arrives() {
        let mut f = std::ptr::null();
        assert_eq!(create(std::ptr::null(), 0, 0, &FENCE_IIDS[0], &mut f), S_OK);
        let wait = slot::<extern "system" fn(This, u64, *mut c_void) -> HRESULT>(f, 0x48);
        // Another thread moves the value to 5 while the wait sleeps on it.
        let mover = {
            let f = f as usize;
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let this = f as This;
                let moved = fence(this);
                moved.value.store(5, Ordering::Release);
                // SAFETY: the fence is alive until the wait below returns.
                unsafe { wake::wake_all(&moved.value) };
            })
        };
        let started = std::time::Instant::now();
        // The seam with the wake on: this is the branch the switch takes.
        let reached = blocking_wait(
            // SAFETY: the fence made above, alive until it is released below.
            unsafe { &(*f.cast::<Fence>()).value },
            5,
            true,
        );
        let waited = started.elapsed();
        mover.join().expect("the mover finishes");
        assert!(reached, "the wait says the value arrived");
        assert!(
            waited < wake::MOST,
            "woken by the move, not by the end of the wait ({waited:?})"
        );
        assert_eq!(wait(f, 5, std::ptr::null_mut()), S_OK, "and the call agrees");
        assert_eq!(slot::<extern "system" fn(This) -> u32>(f, 0x10)(f), 0);
    }

    /// The seam with the wake off does not sleep: it answers "not reached" at
    /// once, which is the behaviour the call had before the switch.
    #[cfg(windows)]
    #[test]
    fn a_blocking_wait_with_the_wake_off_does_not_sleep() {
        let word = AtomicU64::new(1);
        let started = std::time::Instant::now();
        assert!(!blocking_wait(&word, 2, false), "not reached, and not waited for");
        assert!(
            started.elapsed() < wake::MOST,
            "the switch off means no sleep at all"
        );
    }

    /// A value that moved between the look and the push still sets the event:
    /// the window Belobug's fence.rs re-checks for.
    #[cfg(windows)]
    #[test]
    fn an_event_is_set_when_the_value_moved_after_it_was_asked_for() {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

        let mut f = std::ptr::null();
        assert_eq!(create(std::ptr::null(), 0, 0, &FENCE_IIDS[0], &mut f), S_OK);
        // SAFETY: plain auto-reset event.
        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        assert!(!event.is_null());
        let wait = slot::<extern "system" fn(This, u64, *mut c_void) -> HRESULT>(f, 0x48);
        let signal = slot::<extern "system" fn(This, u64) -> HRESULT>(f, 0x50);

        // Asked for before the value moves: registered, not set yet.
        assert_eq!(wait(f, 5, event), S_OK);
        // SAFETY: a valid event.
        assert_eq!(unsafe { WaitForSingleObject(event, 0) }, WAIT_TIMEOUT);
        // It moves: the event is set.
        assert_eq!(signal(f, 5), S_OK);
        // SAFETY: as above.
        assert_eq!(unsafe { WaitForSingleObject(event, 0) }, WAIT_OBJECT_0);

        // SAFETY: ours.
        unsafe { CloseHandle(event) };
        assert_eq!(slot::<extern "system" fn(This) -> u32>(f, 0x10)(f), 0);
    }
}
