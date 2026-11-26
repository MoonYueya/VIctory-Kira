//! A ledger of the card's memory by what holds it (`VICTORY_VRAM_LEDGER=1`,
//! diagnostics builds; off by default).
//!
//! ## What is counted, and what is not
//!
//! This layer holds card memory in two very different ways, and the ledger
//! keeps them apart because only one of them can be moved:
//!
//! - **The title's resources.** The title makes textures, heaps and buffers
//!   through the device we hand it. Buffers and heaps are simulated in this
//!   process's own memory (`resource.rs` `Memory`), so they cost the card
//!   nothing. Textures are real: their host copy is a D3D12 texture in the
//!   card's DEFAULT heap (`resource.rs` `host_texture_as`, `pool::texture`,
//!   `tiles`). Those bytes are the layer's to place, and its texture budget
//!   (`resource::room`) is the rule that admits them.
//! - **The layer's own buffers.** Buffers this crate makes for itself: the
//!   two sides of title-memory copies, windows, unordered-access scratch,
//!   the staging blocks, GPU-upload buffers. Every one of them has a switch
//!   that keeps it in system memory or makes it smaller (`SWITCHES`).
//!
//! Upload (`D3D12_HEAP_TYPE_UPLOAD`) and read-back memory are in the PC's
//! memory, not the card's, and are counted apart so the sum stays honest.
//!
//! ## Why the parts will not add up to the number the system gives
//!
//! `DXGI_QUERY_VIDEO_MEMORY_INFO.CurrentUsage` for the local segment counts
//! everything this process has resident on the card, including what the
//! driver allocates on its own account (command allocators, pipeline
//! objects, the pipeline library's mapped file, descriptor heaps, query
//! heaps, reserved-but-unmapped tiles). None of that passes through a call
//! this crate can see, so the ledger prints the difference as *unaccounted*
//! rather than pretending to explain it.
//!
//! ## Reading a line
//!
//! Every number is *live*: what is held at the moment of the line, not what
//! was made since the start. `MB` is 2^20 bytes, as everywhere else in the
//! memory lines.
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use windows::Win32::Graphics::Direct3D12::*;
use windows::core::{GUID, HRESULT, IUnknown, Interface};

/// What a bank of the ledger holds: bytes, and how many things.
#[derive(Clone, Copy, Default)]
pub(crate) struct Held {
    pub(crate) bytes: u64,
    pub(crate) count: u64,
}

/// One class of card memory: what is alive of it now.
struct Bank {
    bytes: AtomicU64,
    count: AtomicU64,
}

impl Bank {
    const fn new() -> Bank {
        Bank {
            bytes: AtomicU64::new(0),
            count: AtomicU64::new(0),
        }
    }

    fn add(&self, bytes: u64) {
        self.bytes.fetch_add(bytes, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
    }

    fn take(&self, bytes: u64) {
        self.bytes.fetch_sub(bytes, Ordering::Relaxed);
        self.count.fetch_sub(1, Ordering::Relaxed);
    }

    fn held(&self) -> Held {
        Held {
            bytes: self.bytes.load(Ordering::Relaxed),
            count: self.count.load(Ordering::Relaxed),
        }
    }
}

/// The classes the layer makes itself, in the order the line prints them.
/// Each is memory this crate asked the card for, so each answers to a switch
/// that can keep it in the PC's memory instead (`SWITCHES`).
pub(crate) mod class {
    /// The card's side of a title buffer's copy: shaders read vertices,
    /// indices and constants without crossing the bus (`shadow::card_for`).
    pub(crate) const BUFFER_COPY: usize = 0;
    /// The card's side of a window (title memory outside the title's own
    /// buffers), same reason (`shadow::window_card_for`).
    pub(crate) const WINDOW_COPY: usize = 1;
    /// A window in card memory the CPU maps, one buffer instead of two
    /// sides (`shadow::window_mapped_for`, `D3D12_HEAP_TYPE_GPU_UPLOAD`).
    pub(crate) const WINDOW_MAPPED: usize = 2;
    /// A buffer shaders write (unordered access): the scratch of the
    /// indirect passes, the ambient stand-in, the bytes put between copies
    /// (`Host::uav_buffer`).
    pub(crate) const UAV: usize = 3;
    /// Memory the CPU maps that the card reads: the staging of texture
    /// uploads and the write-back buffers that stand in for card memory the
    /// CPU must reach. These are the PC's memory (an upload heap is a
    /// system-memory heap), so they are counted apart from the card's.
    pub(crate) const STAGING: usize = 4;
    pub(crate) const CLASSES: usize = 5;
}

static BANKS: [Bank; class::CLASSES] = [const { Bank::new() }; class::CLASSES];

/// Whether the ledger is kept (`VICTORY_VRAM_LEDGER=1`; off by default).
pub(crate) fn on() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| crate::switch::on("VICTORY_VRAM_LEDGER"))
}

/// Counts `resource` under `class` from now until it goes.
///
/// A local guard cannot do this: the caller keeps the resource for as long
/// as the title or a list names it, so the count has to end with the COM
/// object itself. The way is the one `book` uses: a small object of this
/// module's own, held in the resource's private data, whose release is the
/// last reference going.
pub(crate) fn note(resource: &ID3D12Resource, class: usize, bytes: u64) {
    if !on() || bytes == 0 {
        return;
    }
    BANKS[class].add(bytes);
    let Ok(object) = resource.cast::<ID3D12Object>() else {
        return;
    };
    const KEY: GUID = GUID::from_u128(0x8a1f3c14_2b95_4d70_9e33_77c2d1f40a5e);
    // SAFETY: a COM object of ours with one reference, which this drops; the
    // resource takes its own.
    unsafe {
        let notice = Box::into_raw(Box::new(Notice {
            methods: &NOTICE.0,
            references: AtomicU32::new(1),
            class,
            bytes,
        }));
        let notice = IUnknown::from_raw(notice.cast());
        if object.SetPrivateDataInterface(&KEY, &notice).is_err() {
            // Nothing will tell us: take the count back rather than lie.
            std::mem::forget(notice);
            BANKS[class].take(bytes);
        }
    }
}

/// The last reference to a counted resource going.
#[repr(C)]
struct Notice {
    methods: &'static [*const (); 3],
    references: AtomicU32,
    class: usize,
    bytes: u64,
}

struct Methods([*const (); 3]);
// SAFETY: function addresses only.
unsafe impl Sync for Methods {}
static NOTICE: Methods = Methods([
    query as *const (),
    add_ref as *const (),
    release as *const (),
]);

unsafe extern "system" fn query(
    this: *mut core::ffi::c_void,
    iid: *const GUID,
    out: *mut *mut core::ffi::c_void,
) -> HRESULT {
    // SAFETY: COM's arguments.
    unsafe {
        if out.is_null() {
            return HRESULT(0x8000_4003_u32 as i32);
        }
        if iid.as_ref().is_some_and(|iid| *iid == IUnknown::IID) {
            add_ref(this);
            *out = this;
            return HRESULT(0);
        }
        *out = std::ptr::null_mut();
    }
    HRESULT(0x8000_4002_u32 as i32)
}

unsafe extern "system" fn add_ref(this: *mut core::ffi::c_void) -> u32 {
    // SAFETY: one of ours, alive while a reference to it is.
    unsafe {
        (*this.cast::<Notice>())
            .references
            .fetch_add(1, Ordering::Relaxed)
            + 1
    }
}

unsafe extern "system" fn release(this: *mut core::ffi::c_void) -> u32 {
    // SAFETY: as above; the last reference frees the box it was made as and
    // takes the bytes out of their bank.
    unsafe {
        let left = (*this.cast::<Notice>())
            .references
            .fetch_sub(1, Ordering::AcqRel)
            - 1;
        if left == 0 {
            let gone = Box::from_raw(this.cast::<Notice>());
            BANKS[gone.class].take(gone.bytes);
        }
        left
    }
}

/// What one class holds now.
pub(crate) fn held(class: usize) -> Held {
    BANKS[class].held()
}

/// Every class, in the line's order.
pub(crate) fn all() -> [Held; class::CLASSES] {
    std::array::from_fn(held)
}
/// A switch that moves a part of the card's memory elsewhere or makes it
/// smaller, and what it moves. `default` is what `scripts/play.ps1` leaves
/// it at on an NVIDIA card.
pub(crate) struct Switch {
    pub(crate) var: &'static str,
    pub(crate) default: &'static str,
    pub(crate) moves: &'static str,
}

/// Every switch the ledger's classes answer to.
pub(crate) const SWITCHES: &[Switch] = &[
    Switch {
        var: "VICTORY_CARD_BUFFERS",
        default: "1",
        moves: "0 keeps every title buffer's copy in the PC's memory (card sides of title buffers)",
    },
    Switch {
        var: "VICTORY_CARD_BUFFERS_MIN_KB",
        default: "from the budget: 16 MiB under a 12 GiB one",
        moves: "smallest title buffer whose copy goes to the card (shadow::card_limits); a larger value moves that whole class off the card",
    },
    Switch {
        var: "VICTORY_CARD_ALL",
        default: "0",
        moves: "a card side for every title buffer's copy, however small",
    },
    Switch {
        var: "VICTORY_CARD_WINDOWS_MB",
        default: "0",
        moves: "cap on the card's sides of windows (shadow::window_card_most); 0 keeps windows in the PC's memory",
    },
    Switch {
        var: "VICTORY_WINDOWS_BAR_MB",
        default: "0",
        moves: "windows in card memory the CPU maps, one buffer instead of two sides (shadow::window_mapped_most)",
    },
    Switch {
        var: "VICTORY_TEXTURE_BUDGET_MB",
        default: "from the budget, with a 2 GiB floor",
        moves: "bytes of host copies of textures the title fills (resource::room)",
    },
    Switch {
        var: "VICTORY_TEXTURE_ROOM_PERCENT",
        default: "97 on NVIDIA, 90 elsewhere",
        moves: "share of the card's budget those copies may fill (resource::room_percent)",
    },
    Switch {
        var: "VICTORY_CARD_ROOM_FOR_TARGETS_MB",
        default: "3072",
        moves: "room the texture queue keeps free for render targets not made yet (resource::targets_room_kept); 0 keeps none",
    },
    Switch {
        var: "VICTORY_LEVELS_ON_DEMAND",
        default: "1 in diagnostics builds",
        moves: "large textures to reserved ones given tiles level by level (tiles); 0 gives every level memory at once",
    },
    Switch {
        var: "VICTORY_TEXTURE_POOL",
        default: "1",
        moves: "textures cut from 64 MiB blocks instead of committed one by one (pool)",
    },
    Switch {
        var: "VICTORY_POOL_SPARE",
        default: "the card's room alone (64 blocks below 85 %, else 2)",
        moves: "the most 64 MiB blocks of texture memory the pool keeps empty, whatever the card's room says",
    },
];
/// The ledger's line: what the card holds by class, and how the sum relates
/// to the number the system gives (`DXGI_QUERY_VIDEO_MEMORY_INFO`).
///
/// Every number is live: what is held at the moment of the line, in MiB (2^20
/// bytes, as everywhere else in the memory lines).
#[cfg(feature = "diagnostics")]
pub(crate) fn line() -> String {
    let mb = |v: u64| v as f64 / (1 << 20) as f64;
    let own = all();
    // The title's textures: host copies this crate made in the card's DEFAULT
    // heap. `HOST_TEXTURES` counts them all, `KINDS[1]` the ones the title
    // fills (the rest are render targets and unordered-access textures the
    // host itself writes), and the tiles are the memory given level by level
    // to reserved ones (`tiles`).
    let host = [
        crate::resource::HOST_TEXTURES[0].load(Ordering::Relaxed),
        crate::resource::HOST_TEXTURES[1].load(Ordering::Relaxed),
    ];
    let kinds = [
        crate::resource::KINDS[0].load(Ordering::Relaxed),
        crate::resource::KINDS[1].load(Ordering::Relaxed),
    ];
    let tiled = crate::tiles::given_total();
    let filled = kinds[1] + tiled;
    let targets = host[1].saturating_sub(kinds[1]);
    // Blocks of texture memory. A texture cut from a block (`pool::texture`)
    // has no bytes of its own: `HOST_TEXTURES` counts it as none, and its
    // pieces are already inside the block. Counting both would count the
    // same card memory twice, so the block's spare part is what stands on
    // its own here, and the pieces are folded into the textures above.
    let (in_blocks, block_count) = crate::pool::held_pieces();
    let counts = crate::pool::block_counts();
    let block_bytes = block_count << 26;
    let block_spare = block_bytes.saturating_sub(in_blocks);
    let card = crate::host::host()
        .and_then(|h| h.video_memory())
        .unwrap_or_default();
    let (budget, used) = (card[0], card[1]);
    // A placed texture has no card memory of its own: its piece is inside a
    // block. So the textures' own bytes are what they are outside the blocks,
    // and the blocks are counted whole (`texture_card`).
    let named = filled.saturating_sub(in_blocks)
        + targets
        + block_bytes
        + own[class::BUFFER_COPY].bytes
        + own[class::WINDOW_COPY].bytes
        + own[class::WINDOW_MAPPED].bytes
        + own[class::UAV].bytes;
    let unaccounted = used.saturating_sub(named);
    let row = |name: &str, bytes: u64, count: u64| format!("{name} {:.0} MB/{count}", mb(bytes));
    let parts = [
        row("in use, as the system counts it", used, host[0]),
        row("budget", budget, 0),
        row("title textures the title fills", filled, kinds[0]),
        row("  of them given level by level", tiled, 0),
        row(
            "render targets and unordered-access textures",
            targets,
            host[0].saturating_sub(kinds[0]),
        ),
        row("pieces taken from the blocks (of the textures above)", in_blocks, 0),
        row("blocks of texture memory, whole", block_bytes, block_count),
        row("  of them empty and kept", block_spare, 0),
        format!("blocks made in all {}, let go {}", counts[0], counts[1]),
        // The row above counts the bytes of blocks no piece holds; this one
        // counts the blocks with nothing in them at all, which is what the
        // pool may let go: the rest of the former is holes inside blocks.
        format!("blocks there now {}, of them wholly empty {}", counts[2], counts[3]),
        row(
            "card sides of title buffers",
            own[class::BUFFER_COPY].bytes,
            own[class::BUFFER_COPY].count,
        ),
        row(
            "card sides of windows",
            own[class::WINDOW_COPY].bytes,
            own[class::WINDOW_COPY].count,
        ),
        row(
            "card memory the CPU maps",
            own[class::WINDOW_MAPPED].bytes,
            own[class::WINDOW_MAPPED].count,
        ),
        row(
            "unordered-access and scratch buffers",
            own[class::UAV].bytes,
            own[class::UAV].count,
        ),
        row("accounted", named, 0),
        row("unaccounted", unaccounted, 0),
        format!(
            "the PC's memory the CPU maps {:.0} MB/{}",
            mb(own[class::STAGING].bytes),
            own[class::STAGING].count
        ),
        format!(
            "of the budget, {:.0} % used",
            if budget == 0 {
                0.0
            } else {
                used as f64 * 100.0 / budget as f64
            }
        ),
    ];
    format!(
        "vram ledger (VICTORY_VRAM_LEDGER=1), live, MB/things: {}",
        parts.join("; ")
    )
}

/// Logs the switches once, each with what it moves: the ledger's own answer
/// to "what could take this off the card", in the same log as the numbers.
pub(crate) fn log_switches() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        for s in SWITCHES {
            tracing::info!(
                "vram switch, {} (default {}): moves {}",
                s.var,
                s.default,
                s.moves
            );
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;

    /// A switch the ledger names is one this crate reads somewhere.
    #[test]
    fn the_switch_table_is_complete() {
        for (i, switch) in SWITCHES.iter().enumerate() {
            assert!(
                switch.var.starts_with("VICTORY_"),
                "{} is not a switch",
                switch.var
            );
            assert!(
                !switch.moves.is_empty(),
                "{} says nothing it moves",
                switch.var
            );
            assert!(!switch.default.is_empty(), "{} says no default", switch.var);
            for other in &SWITCHES[i + 1..] {
                assert_ne!(switch.var, other.var, "{} is listed twice", switch.var);
            }
        }
    }

    /// The classes are distinct and every one of them has a bank.
    #[test]
    fn every_class_is_its_own_bank() {
        let classes = [
            class::BUFFER_COPY,
            class::WINDOW_COPY,
            class::WINDOW_MAPPED,
            class::UAV,
            class::STAGING,
        ];
        assert_eq!(classes.len(), class::CLASSES);
        for (i, a) in classes.iter().enumerate() {
            for b in &classes[i + 1..] {
                assert_ne!(a, b);
            }
        }
        assert_eq!(all().len(), class::CLASSES);
    }

    /// A bank takes back exactly what it was given (on one of its own: the
    /// ledger's banks are shared with every other test in this process).
    #[test]
    fn a_bank_gives_back_what_it_took() {
        let bank = Bank::new();
        bank.add(3 << 20);
        bank.add(1 << 20);
        assert_eq!(bank.held().bytes, 4 << 20);
        assert_eq!(bank.held().count, 2);
        // One take per hold, with the bytes it was added with.
        bank.take(3 << 20);
        bank.take(1 << 20);
        assert_eq!(bank.held().bytes, 0);
        assert_eq!(bank.held().count, 0);
    }
}