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
        // With submissions sent to the card and not waited for
        // (`crate::host::late`) the signal may be behind them: they are
        // settled, which sets it.
        #[cfg(windows)]
        if crate::host::late() {
            drop(waiters);
            crate::queue::before_sync();
            crate::host::settle_for_fence();
            if fence.value.load(Ordering::Acquire) >= value {
                return S_OK;
            }
            tracing::warn!(value, "blocking fence wait not implemented");
            return E_NOTIMPL;
        }
        // shortcut: a null event means "block until reached"; nothing can
        // reach it while no GPU work runs, so fail instead of hanging.
        tracing::warn!(value, "blocking fence wait not implemented");
        return E_NOTIMPL;
    }
    waiters.push((value, event as usize));
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
}
