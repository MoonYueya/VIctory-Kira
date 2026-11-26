//! Offline check of the host compute pipelines a run could not make.
//!
//! On a host whose waves have 32 lanes some console wave64 compute programs
//! get no host pipeline: the translated DXIL asks for `WaveSize(64)`, which
//! the driver rejects with `E_INVALIDARG` (0x80070057). The debug layer says
//! it in words: "Shader wants wave lane count of 64 but maximum wave lane
//! count for device is 32". This module makes those pipelines here, off the
//! title, so the reason can be read without starting a game.
//!
//! The containers are the user's own (rule #1): the test reads them from a
//! folder named by `VICTORY_SHADER_AUDIT_CACHE`, holding one `*.cdxil` per
//! container (`victory translate --list` writes them with
//! `VICTORY_DUMP_MATCH=<dir>;<hash>...`). No game bytes are stored in the
//! repository, and the test skips when the variable is unset or the folder
//! is empty.
//!
//! The containers go through the run's own steps (`shader` for the shared
//! container, then `HostPipeline::new`), so what this reports is what the
//! title would get. `VICTORY_SHADER_AUDIT_EXPECT=all` turns the report into
//! a check: every audited shader must then get its pipeline.

#![cfg(all(windows, test))]

use std::sync::Arc;

use super::*;

/// `VICTORY_SHADER_AUDIT_CACHE`: the folder of `*.cdxil` containers.
fn containers() -> Option<Vec<(String, Vec<u8>)>> {
    let dir = std::env::var_os("VICTORY_SHADER_AUDIT_CACHE")?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).ok()? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "cdxil") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        // The hash a run's log names the container by: its BLAKE3, 16 digits.
        out.push((blake3::hash(&bytes).to_hex()[..16].to_owned(), bytes));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Some(out)
}

/// Each container in the audit folder gets a host compute pipeline, as a run
/// would make it. The ones that cannot are listed with the console thread
/// group that stopped them, which is what says whether a 32-lane form exists
/// at all. Skips without a card or without `VICTORY_SHADER_AUDIT_CACHE`.
#[test]
fn the_audited_compute_shaders_report_their_host_pipelines() {
    let Some(containers) = containers() else {
        eprintln!("VICTORY_SHADER_AUDIT_CACHE unset: skipping the shader audit");
        return;
    };
    if containers.is_empty() {
        eprintln!("no *.cdxil in the audit folder: skipping the shader audit");
        return;
    }
    // As a run does first: the card decides the form of some programs
    // (`host`, `set_host_max_wave`).
    if crate::host::host().is_none() {
        eprintln!("no host device: skipping the shader audit");
        return;
    }
    let mut made = Vec::new();
    let mut refused = Vec::new();
    for (hash, bytes) in &containers {
        // The shared container a title's pipeline carries, then its host
        // pipeline: the run's own two steps.
        let shader: Arc<Shader> = shader("compute", bytes);
        debug_assert_eq!(&shader.hash, hash);
        let threads = shader.programs().and_then(|programs| {
            let cs = programs.first()?;
            match cs.io {
                victory_shader::native::StageIo::Cs(ref cs) => Some(cs.threads),
                _ => None,
            }
        });
        match super::host::HostPipeline::new(&[shader], None) {
            Some(_) => made.push(hash.clone()),
            None => refused.push((hash.clone(), threads)),
        }
    }
    eprintln!(
        "shader audit: {} of {} get a host pipeline; made {made:?}",
        made.len(),
        containers.len()
    );
    for (hash, threads) in &refused {
        eprintln!("shader audit: {hash} gets none (console thread group {threads:?})");
    }
    // Only when asked: the report is the point here, since whether a 32-lane
    // form exists depends on the program (a group of several console waves
    // cannot take the wave-wide form at all).
    if std::env::var_os("VICTORY_SHADER_AUDIT_EXPECT").is_some_and(|v| v == "all") {
        assert!(
            refused.is_empty(),
            "{} of {} audited compute shaders get no host pipeline: {:?}",
            refused.len(),
            containers.len(),
            refused.iter().map(|(h, _)| h).collect::<Vec<_>>()
        );
    }
}
