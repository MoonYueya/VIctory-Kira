//! Where a frame's wall clock goes, thread by thread: `VICTORY_CPUPROF=<from>,<to>,<ms>,<file>`.
//!
//! A frame's time is not one thread's: the title prepares it on its own threads,
//! our layer copies, records and submits on others, and the card is waited for
//! on the one that holds the submission lock. The frame lines say how much of a
//! frame was spent preparing, copying back and standing for the card, but not
//! which thread spent the rest, and not where.
//!
//! This walks every thread of the process every `ms` between two times
//! (seconds, like `VICTORY_STACKS`) and asks the system for two things:
//! how much processor time it has used so far (`GetThreadTimes`, user plus
//! kernel) and which way it is going (a sample of its stack, as the profile
//! writes them). Between two walks the difference of the processor times is
//! what that thread ran, so the busy time of a thread over the stretch adds up
//! to the process's own: no frame is called anybody's, nothing is estimated.
//!
//! The file: `span <seconds> <ms>` for the stretch, `cpu <ms> <user ms> <kernel ms>`
//! from the process's counters, then one `thread <id> <ms> <samples> <name> <start>`
//! per thread, and `stack <thread> <count> <frame>;<frame>;...` for the ways it was
//! found (innermost first). Our own addresses are named from the symbols beside
//! the program when it has them (`victory.pdb`, a `diag` build); the title's
//! keep `module+rva`, which is all there is for an image with no symbols.
//!
//! Nothing here changes what the title or the layer does: the walks read
//! counters, and a thread is suspended only while its stack is copied.

use std::collections::HashMap;
use std::io::Write;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, GetThreadTimes, OpenThread, THREAD_GET_CONTEXT,
    THREAD_QUERY_INFORMATION, THREAD_SUSPEND_RESUME,
};

use crate::crash::locate;
use crate::stacks::{frames_of, name_of, other_threads, start_of};

/// Names for addresses in our own program, from the symbols beside it.
///
/// Loaded the first time a name is asked for, never at start: a run without
/// `VICTORY_CPUPROF` never opens the library. Nothing is fetched: only the
/// program's own symbols are read, and a program without them falls back to
/// `module+rva`, which is what the profile wrote before this existed.
struct Symbols {
    /// `SymFromAddr` and `SymGetLineFromAddr64`, as the library declares them.
    from_address: unsafe extern "system" fn(*mut std::ffi::c_void, u64, *mut u64, *mut u8) -> i32,
    line_of: unsafe extern "system" fn(*mut std::ffi::c_void, u64, *mut u32, *mut u8) -> i32,
    process: *mut std::ffi::c_void,
}

impl Symbols {
    fn load() -> Option<Symbols> {
        use windows_sys::Win32::System::LibraryLoader::{
            GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExA,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        type Initialize = unsafe extern "system" fn(*mut std::ffi::c_void, *const u16, i32) -> i32;
        type Options = unsafe extern "system" fn(u32) -> u32;
        // SAFETY: the system's own library and functions, by their names and
        // signatures.
        unsafe {
            let module = LoadLibraryExA(
                c"dbghelp.dll".as_ptr().cast(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_SYSTEM32,
            );
            if module.is_null() {
                return None;
            }
            let options: Options =
                std::mem::transmute(GetProcAddress(module, c"SymSetOptions".as_ptr().cast())?);
            let initialize: Initialize =
                std::mem::transmute(GetProcAddress(module, c"SymInitializeW".as_ptr().cast())?);
            let from_address =
                std::mem::transmute::<
                    unsafe extern "system" fn() -> isize,
                    unsafe extern "system" fn(*mut std::ffi::c_void, u64, *mut u64, *mut u8) -> i32,
                >(GetProcAddress(module, c"SymFromAddr".as_ptr().cast())?);
            let line_of = std::mem::transmute::<
                unsafe extern "system" fn() -> isize,
                unsafe extern "system" fn(*mut std::ffi::c_void, u64, *mut u32, *mut u8) -> i32,
            >(GetProcAddress(
                module,
                c"SymGetLineFromAddr64".as_ptr().cast(),
            )?);
            let process = GetCurrentProcess();
            // Undecorated names, loaded when asked for, no dialogs
            // (SYMOPT_UNDNAME | SYMOPT_DEFERRED_LOADS | SYMOPT_FAIL_CRITICAL_ERRORS).
            options(0x2 | 0x4 | 0x100);
            // The symbols lie beside the program, which names them by their
            // file alone.
            let beside = std::env::current_exe()
                .ok()
                .and_then(|p| Some(p.parent()?.to_path_buf()))
                .unwrap_or_default();
            let beside: Vec<u16> = std::os::windows::ffi::OsStrExt::encode_wide(beside.as_os_str())
                .chain([0])
                .collect();
            initialize(process, beside.as_ptr(), 1);
            Some(Symbols {
                from_address,
                line_of,
                process,
            })
        }
    }

    /// The function at `address`, and where in its source.
    fn name(&self, address: usize) -> Option<(String, Option<String>)> {
        // `SYMBOL_INFO`: 88 bytes, the name's first character at 84.
        const NAME: usize = 84;
        const ROOM: usize = 512;
        let mut info = [0u64; (NAME + ROOM) / 8 + 1];
        let at = info.as_mut_ptr().cast::<u8>();
        let mut off = 0u64;
        // SAFETY: a buffer of the structure's size and the name's, its size
        // fields set as asked.
        let function = unsafe {
            at.cast::<u32>().write(88);
            at.add(80).cast::<u32>().write(ROOM as u32);
            if (self.from_address)(self.process, address as u64, &mut off, at) == 0 {
                return None;
            }
            std::ffi::CStr::from_ptr(at.add(NAME).cast())
                .to_string_lossy()
                .into_owned()
        };
        // `IMAGEHLP_LINE64`: 40 bytes, the line at 16 and the file's pointer at
        // 24.
        let mut line = [0u64; 5];
        let at = line.as_mut_ptr().cast::<u8>();
        let mut displacement = 0u32;
        // SAFETY: as above, for the line's own structure.
        let where_ = unsafe {
            at.cast::<u32>().write(40);
            if (self.line_of)(self.process, address as u64, &mut displacement, at) == 0 {
                None
            } else {
                let name = at.add(24).cast::<*const u16>().read();
                let number = at.add(16).cast::<u32>().read();
                if name.is_null() {
                    None
                } else {
                    let len = (0..).take_while(|&i| *name.add(i) != 0).count();
                    let path = String::from_utf16_lossy(std::slice::from_raw_parts(name, len));
                    let file = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
                    Some(format!("{file}:{number}"))
                }
            }
        };
        Some((function, where_))
    }
}

impl Symbols {
    /// No symbols at all (the library would not load): every address keeps the
    /// module and its place in it.
    fn none() -> Symbols {
        unsafe extern "system" fn nothing(
            _: *mut std::ffi::c_void,
            _: u64,
            _: *mut u64,
            _: *mut u8,
        ) -> i32 {
            0
        }
        unsafe extern "system" fn no_line(
            _: *mut std::ffi::c_void,
            _: u64,
            _: *mut u32,
            _: *mut u8,
        ) -> i32 {
            0
        }
        Symbols {
            from_address: nothing,
            line_of: no_line,
            process: std::ptr::null_mut(),
        }
    }

    /// `address` as `function (file:line)`, or nothing where no symbol covers
    /// it: the title's own code has none, and keeps its module and place.
    fn of(&self, address: usize) -> Option<String> {
        let (function, where_) = self.name(address)?;
        Some(match where_ {
            Some(where_) => format!("{function} ({where_})"),
            None => function,
        })
    }
}

/// What `VICTORY_CPUPROF` says: from, to, every, the file. Read whole or not
/// at all, as `VICTORY_PROFILE` is.
fn asked(list: &str) -> Option<(Duration, Duration, Duration, String)> {
    let mut parts = list.splitn(4, ',');
    let mut seconds = || parts.next()?.trim().parse::<f64>().ok();
    let (from, to, ms) = (seconds()?, seconds()?, seconds()?);
    let of = |s: f64| Duration::try_from_secs_f64(s).ok();
    let file = parts.next()?.trim().to_string();
    Some((of(from)?, of(to)?, of(ms / 1000.0)?, file))
        .filter(|(a, b, ms, f)| a < b && !ms.is_zero() && !f.is_empty())
}

/// A `FILETIME` as 100 ns units.
fn ticks(t: &FILETIME) -> u64 {
    u64::from(t.dwHighDateTime) << 32 | u64::from(t.dwLowDateTime)
}

/// The processor time of a thread (user, kernel), in 100 ns units.
fn thread_cpu(thread: HANDLE) -> Option<(u64, u64)> {
    let mut created = empty_filetime();
    let mut exited = empty_filetime();
    let mut kernel = empty_filetime();
    let mut user = empty_filetime();
    // SAFETY: an open thread and four valid out pointers.
    let ok = unsafe { GetThreadTimes(thread, &mut created, &mut exited, &mut kernel, &mut user) };
    (ok != 0).then(|| (ticks(&user), ticks(&kernel)))
}

/// A `FILETIME` of no time at all, for a call to fill.
fn empty_filetime() -> FILETIME {
    FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    }
}

/// The processor time of the whole process (user, kernel), in 100 ns units.
fn process_cpu() -> (u64, u64) {
    let mut created = empty_filetime();
    let mut exited = empty_filetime();
    let mut kernel = empty_filetime();
    let mut user = empty_filetime();
    // SAFETY: our own process and four valid out pointers.
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        (0, 0)
    } else {
        (ticks(&user), ticks(&kernel))
    }
}

/// A thread the walk opened, and what it was at the walk before.
struct Seen {
    handle: HANDLE,
    name: String,
    start: String,
    /// Its processor time (user plus kernel) at the walk before.
    was: u64,
    /// How much it ran since, 100 ns.
    ran: u64,
}

/// One walk's answer: what each thread ran since the walk before, and how
/// each was found.
struct Walk {
    /// By thread: what it ran since the last walk, and a sample of its stack.
    threads: HashMap<u32, (u64, Vec<u64>)>,
}

fn walk(seen: &mut HashMap<u32, Seen>) -> Walk {
    // Threads that went away are let go: their handles are closed and their
    // time is already counted in the total.
    let live: Vec<u32> = other_threads();
    seen.retain(|id, s| {
        let keep = live.contains(id);
        if !keep {
            // SAFETY: opened by this walk.
            unsafe { CloseHandle(s.handle) };
        }
        keep
    });
    let mut out = HashMap::new();
    for id in live {
        let s = seen.entry(id).or_insert_with(|| {
            // SAFETY: opens a thread of our own process; kept for the walk's
            // life so the id stays its own.
            let handle = unsafe {
                OpenThread(
                    THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION,
                    0,
                    id,
                )
            };
            let (name, start) = if handle.is_null() {
                (String::new(), String::new())
            } else {
                // Both read only its description and its first instruction.
                (name_of(handle), locate(start_of(handle)))
            };
            let was = thread_cpu(handle).map(|(u, k)| u + k).unwrap_or(0);
            Seen {
                handle,
                name,
                start,
                was,
                ran: 0,
            }
        });
        if s.handle.is_null() {
            continue;
        }
        let now = thread_cpu(s.handle).map(|(u, k)| u + k).unwrap_or(s.was);
        s.ran = now.saturating_sub(s.was);
        s.was = now;
        // WHERE it is going, not just how much: a sample of its stack, the
        // same way `VICTORY_PROFILE` takes one.
        let (frames, _) = frames_of(s.handle);
        out.insert(id, (s.ran, frames));
    }
    Walk { threads: out }
}

/// Starts the walk if `VICTORY_CPUPROF` says so. `phase` is asked at each
/// walk, so a stack can be told apart by what the frame was at.
pub fn cpuprof_on_schedule(phase: fn() -> u32) {
    let Ok(list) = std::env::var("VICTORY_CPUPROF") else {
        return;
    };
    let start = Instant::now();
    let all: Vec<_> = list.split(';').filter_map(asked).collect();
    std::thread::spawn(move || {
        for one in all {
            cpuprof(one, start, phase);
        }
    });
}

fn cpuprof(
    (from, to, every, file): (Duration, Duration, Duration, String),
    start: Instant,
    phase: fn() -> u32,
) {
    std::thread::sleep(from.saturating_sub(start.elapsed()));
    eprintln!("VIctory: the CPU profile begins");
    let begin = Instant::now();
    let mut seen: HashMap<u32, Seen> = HashMap::new();
    // By thread: (ms ran, samples, stacks by phase).
    let mut ran: HashMap<u32, u64> = HashMap::new();
    let mut samples: HashMap<u32, u64> = HashMap::new();
    let mut stacks: HashMap<(u32, u32, Vec<u64>), u64> = HashMap::new();
    let mut rounds = 0u64;
    let mut first_walk = true;
    while start.elapsed() < to {
        let round = Instant::now();
        let w = walk(&mut seen);
        // The first walk of all measures against the process's start, which is
        // not the stretch being measured: it is only a base.
        if !first_walk {
            for (id, (took, frames)) in &w.threads {
                *ran.entry(*id).or_default() += *took;
                *samples.entry(*id).or_default() += 1;
                if !frames.is_empty() {
                    *stacks.entry((*id, phase(), frames.clone())).or_default() += 1;
                }
            }
        }
        first_walk = false;
        rounds += 1;
        std::thread::sleep(every.saturating_sub(round.elapsed()));
    }
    let (user, kernel) = process_cpu();
    let took = begin.elapsed().as_secs_f64();
    let all = Finished {
        seconds: took,
        user,
        kernel,
        seen: &seen,
        ran: &ran,
        samples: &samples,
        stacks: &stacks,
        rounds,
    };
    if let Err(e) = write(&file, &all) {
        eprintln!("VIctory: the CPU profile was not written: {e}");
    } else {
        eprintln!("VIctory: the CPU profile is in {file}");
    }
}

/// Everything one stretch has to say, as `write` takes it.
struct Finished<'a> {
    seconds: f64,
    /// The process's processor time (user, kernel), 100 ns, since its start.
    user: u64,
    kernel: u64,
    seen: &'a HashMap<u32, Seen>,
    /// By thread: what it ran over the stretch, 100 ns.
    ran: &'a HashMap<u32, u64>,
    samples: &'a HashMap<u32, u64>,
    stacks: &'a HashMap<(u32, u32, Vec<u64>), u64>,
    rounds: u64,
}

fn write(file: &str, all: &Finished) -> std::io::Result<()> {
    let Finished {
        seconds,
        user,
        kernel,
        seen,
        ran,
        samples,
        stacks,
        rounds,
    } = all;
    let mut out = std::io::BufWriter::new(std::fs::File::create(file)?);
    writeln!(out, "rounds {rounds}")?;
    writeln!(out, "span {seconds:.3} {:.1}", seconds * 1000.0)?;
    // The process's own counters, for the stretch and since the start: what
    // the threads below add up to is the first line's business.
    writeln!(
        out,
        "cpu {:.1} {:.1} {:.1}",
        (*user + *kernel) as f64 / 1e4,
        *user as f64 / 1e4,
        *kernel as f64 / 1e4
    )?;
    let mut order: Vec<(&u32, &u64)> = ran.iter().collect();
    order.sort_unstable_by(|a, b| b.1.cmp(a.1));
    for (id, took) in &order {
        let s = (*seen).get(id);
        writeln!(
            out,
            "thread {id} {:.1} {} {} {}",
            **took as f64 / 1e4,
            samples.get(id).copied().unwrap_or(0),
            s.map(|s| s.name.as_str()).unwrap_or(""),
            s.map(|s| s.start.as_str()).unwrap_or("")
        )?;
    }
    // The symbols are opened only if there is a stack to name: a run that
    // samples nothing never touches the library.
    let mut symbols: Option<Symbols> = None;
    let mut cache: HashMap<u64, String> = HashMap::new();
    let mut stacks: Vec<_> = stacks.iter().collect();
    stacks.sort_unstable_by(|a, b| b.1.cmp(a.1));
    for ((id, phase, frames), n) in stacks {
        write!(out, "stack {id} {phase} {n} ")?;
        for f in frames {
            let name = cache
                .entry(*f)
                .or_insert_with(|| {
                    let symbols =
                        symbols.get_or_insert_with(|| Symbols::load().unwrap_or(Symbols::none()));
                    symbols
                        .of(*f as usize)
                        .unwrap_or_else(|| locate(*f as usize))
                })
                .clone();
            write!(out, "{name};")?;
        }
        writeln!(out)?;
    }
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_asked_is_read_whole_or_not_at_all() {
        assert_eq!(
            asked("420, 840.5,25,F:\\a b,c.txt"),
            Some((
                Duration::from_secs(420),
                Duration::from_millis(840_500),
                Duration::from_millis(25),
                "F:\\a b,c.txt".to_string()
            ))
        );
        assert_eq!(asked("420,840,25"), None);
        assert_eq!(asked("840,420,25,x"), None);
        assert_eq!(asked("a,840,25,x"), None);
        assert_eq!(asked("420,840,0,x"), None);
        assert_eq!(asked("-1,840,25,x"), None);
    }
}
