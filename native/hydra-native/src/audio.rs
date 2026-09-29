//! Per-process audio session mute. Repack installers (Inno [Code] sections)
//! play music while silently installing — there is no flag to disable it —
//! so we mute the installer's own audio session instead of the whole system.
//! The session is created lazily by the installer, so callers poll until
//! `true` is returned or give up after a bounded window.

#[cfg(target_os = "windows")]
pub fn mute_audio_by_process_name(process_name: &str, muted: bool) -> Result<bool, String> {
    use windows::core::{Interface, BOOL};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::{
        eMultimedia, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        ISimpleAudioVolume, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    // Toolhelp gives the exe basename and parent pid for every process
    // without opening process handles — enough to match the installer
    // and any differently-named child it delegated to.
    let (matching_pids, processes): (Vec<u32>, Vec<(u32, u32)>) = unsafe {
        let mut pids = Vec::new();
        let mut processes = Vec::new();
        if let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut entry = PROCESSENTRY32W::default();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

            let mut has_entry = Process32FirstW(snapshot, &mut entry).is_ok();
            while has_entry {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if name.eq_ignore_ascii_case(process_name) {
                    pids.push(entry.th32ProcessID);
                }
                processes.push((entry.th32ProcessID, entry.th32ParentProcessID));
                has_entry = Process32NextW(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
        }
        (pids, processes)
    };

    // Fold in descendants of every matched pid (Inno elevated respawns keep
    // the basename, but a repack wrapper may delegate to a named child).
    let mut target_pids = matching_pids.clone();
    let mut frontier = matching_pids;
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for (pid, parent) in &processes {
            if frontier.contains(parent) && !target_pids.contains(pid) {
                target_pids.push(*pid);
                next.push(*pid);
            }
        }
        frontier = next;
    }

    if target_pids.is_empty() {
        return Ok(false);
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.message())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .map_err(|e| e.message())?;
        let session_manager: IAudioSessionManager2 =
            device.Activate(CLSCTX_ALL, None).map_err(|e| e.message())?;
        let sessions = session_manager
            .GetSessionEnumerator()
            .map_err(|e| e.message())?;
        let count = sessions.GetCount().map_err(|e| e.message())?;

        let mut muted_any = false;
        for index in 0..count {
            let Ok(control) = sessions.GetSession(index) else {
                continue;
            };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let Ok(pid) = control2.GetProcessId() else {
                continue;
            };
            if !target_pids.contains(&pid) {
                continue;
            }
            if let Ok(volume) = control.cast::<ISimpleAudioVolume>() {
                if volume.SetMute(BOOL(muted as i32), std::ptr::null()).is_ok() {
                    muted_any = true;
                }
            }
        }

        Ok(muted_any)
    }
}

#[cfg(not(target_os = "windows"))]
pub fn mute_audio_by_process_name(_process_name: &str, _muted: bool) -> Result<bool, String> {
    Ok(false)
}
