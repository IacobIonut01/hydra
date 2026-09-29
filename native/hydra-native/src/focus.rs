//! Editable-field focus detection for the in-game keyboard auto-summon.
//!
//! Windows: UI Automation reports the focused element's control type —
//! Edit/Document means a text field holds focus. Hydra's own windows are
//! excluded by process id so the overlay never summons itself. Linux has no
//! portable equivalent (AT-SPI would need a D-Bus session), so it reports
//! "not focused" and the controller chord remains the only summon path.

#[cfg(target_os = "windows")]
pub fn is_text_input_focused() -> bool {
    use std::mem::size_of;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, UIA_DocumentControlTypeId, UIA_EditControlTypeId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
    };

    unsafe {
        let foreground = GetForegroundWindow();
        if foreground == HWND::default() {
            return false;
        }

        let mut foreground_pid = 0u32;
        let thread_id = GetWindowThreadProcessId(foreground, Some(&mut foreground_pid));
        if foreground_pid == 0 || foreground_pid == GetCurrentProcessId() {
            return false;
        }

        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = (|| {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL).ok()?;

            // The focused HWND is a better element target than the raw window:
            // launchers and in-game browsers park focus on a child control.
            let mut info = GUITHREADINFO {
                cbSize: size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            let element = if GetGUIThreadInfo(thread_id, &mut info).is_ok()
                && info.hwndFocus != HWND::default()
            {
                automation
                    .ElementFromHandle(info.hwndFocus)
                    .or_else(|_| automation.GetFocusedElement())
                    .ok()?
            } else {
                automation.GetFocusedElement().ok()?
            };

            if element.CurrentProcessId().ok()? as u32 == GetCurrentProcessId() {
                return Some(false);
            }

            let control_type = element.CurrentControlType().ok()?;
            Some(control_type == UIA_EditControlTypeId || control_type == UIA_DocumentControlTypeId)
        })();

        if initialized {
            CoUninitialize();
        }

        result.unwrap_or(false)
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_text_input_focused() -> bool {
    false
}

/// Brings the top-level window owned by one of `executable_names` to the
/// foreground. Used by the "Return to game" action — the game record only
/// stores executable paths, so matching is done on the process image name.
///
/// Windows: Toolhelp snapshot resolves the image names to pids, then
/// EnumWindows finds their visible top-level windows (skipping owned and
/// tool windows) and SetForegroundWindow is attempted through the
/// AttachThreadInput dance so it isn't swallowed by the foreground lock.
///
/// Linux: /proc exe links resolve pids, then _NET_CLIENT_LIST is walked for
/// a window whose _NET_WM_PID matches and an _NET_ACTIVE_WINDOW client
/// message asks the WM to raise it (EWMH-compliant WMs only).
#[cfg(target_os = "windows")]
pub fn focus_game_window(executable_names: &[String]) -> Result<bool, String> {
    use std::collections::HashSet;
    use std::mem::size_of;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindow, GetWindowLongW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow,
        GWL_EXSTYLE, GW_OWNER, SW_RESTORE, WS_EX_TOOLWINDOW,
    };

    let wanted: HashSet<String> = executable_names
        .iter()
        .map(|name| name.to_lowercase())
        .collect();

    let pids = unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
            .map_err(|error| format!("failed to snapshot processes: {}", error.message()))?;

        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        let mut pids = Vec::new();
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&unit| unit == 0)
                    .unwrap_or(entry.szExeFile.len());
                let image_name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                if wanted.contains(&image_name.to_lowercase()) {
                    pids.push(entry.th32ProcessID);
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        pids
    };

    if pids.is_empty() {
        return Ok(false);
    }

    struct EnumContext {
        pids: Vec<u32>,
        hwnds: Vec<HWND>,
    }

    unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let context = &mut *(lparam.0 as *mut EnumContext);
        if IsWindowVisible(hwnd).as_bool() {
            let mut process_id = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
            if context.pids.contains(&process_id) {
                let unowned = GetWindow(hwnd, GW_OWNER).unwrap_or_default().0.is_null();
                let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
                if unowned && ex_style & WS_EX_TOOLWINDOW.0 == 0 {
                    context.hwnds.push(hwnd);
                }
            }
        }
        BOOL(1)
    }

    unsafe {
        let mut context = EnumContext {
            pids,
            hwnds: Vec::new(),
        };
        EnumWindows(
            Some(enum_window_proc),
            LPARAM(&mut context as *mut EnumContext as isize),
        )
        .map_err(|error| format!("failed to enumerate windows: {}", error.message()))?;

        let Some(&window) = context.hwnds.first() else {
            return Ok(false);
        };

        if IsIconic(window).as_bool() {
            let _ = ShowWindow(window, SW_RESTORE);
        }

        // SetForegroundWindow is refused unless this thread can act like the
        // foreground one — attach input queues first so the call lands.
        let foreground_thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let current_thread = GetCurrentThreadId();
        if foreground_thread != 0 && foreground_thread != current_thread {
            let _ = AttachThreadInput(current_thread, foreground_thread, true);
            let _ = BringWindowToTop(window);
            SetForegroundWindow(window);
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        } else {
            SetForegroundWindow(window);
        }

        Ok(true)
    }
}

#[cfg(target_os = "linux")]
pub fn focus_game_window(executable_names: &[String]) -> Result<bool, String> {
    use std::collections::HashSet;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ClientMessageEvent, ConnectionExt, EventMask};
    use x11rb::rust_connection::RustConnection;

    let wanted: HashSet<String> = executable_names
        .iter()
        .map(|name| name.to_lowercase())
        .collect();

    let mut pids = HashSet::new();
    let entries =
        std::fs::read_dir("/proc").map_err(|error| format!("failed to read /proc: {}", error))?;
    for entry in entries.flatten() {
        let Ok(process_id) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(target) = std::fs::read_link(entry.path().join("exe")) else {
            continue;
        };
        let Some(image) = target.file_name().map(|name| name.to_string_lossy()) else {
            continue;
        };
        if wanted.contains(&image.to_lowercase()) {
            pids.insert(process_id);
        }
    }
    if pids.is_empty() {
        return Ok(false);
    }

    let (connection, screen_index) = RustConnection::connect(None)
        .map_err(|error| format!("failed to connect to X11: {}", error))?;
    let Some(root) = connection.setup().roots.get(screen_index).map(|s| s.root) else {
        return Err("no X11 root window".to_string());
    };

    let atom = |name: &[u8]| -> Option<u32> {
        connection
            .intern_atom(false, name)
            .ok()?
            .reply()
            .ok()
            .map(|reply| reply.atom)
    };
    let (Some(client_list_atom), Some(pid_atom), Some(active_atom)) = (
        atom(b"_NET_CLIENT_LIST"),
        atom(b"_NET_WM_PID"),
        atom(b"_NET_ACTIVE_WINDOW"),
    ) else {
        return Err("window manager does not support EWMH".to_string());
    };

    let windows: Vec<u32> = connection
        .get_property(false, root, client_list_atom, AtomEnum::WINDOW, 0, u32::MAX)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .and_then(|reply| reply.value32().map(|values| values.collect()))
        .unwrap_or_default();

    for window in windows {
        let matches = connection
            .get_property(false, window, pid_atom, AtomEnum::CARDINAL, 0, 1)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .and_then(|reply| reply.value32().and_then(|mut v| v.next()))
            .map(|pid| pids.contains(&pid))
            .unwrap_or(false);
        if !matches {
            continue;
        }

        let _ = connection.map_window(window);
        let message = ClientMessageEvent::new(
            32,
            window,
            active_atom,
            [2u32, x11rb::CURRENT_TIME, 0, 0, 0],
        );
        let _ = connection.send_event(
            false,
            root,
            EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT,
            message,
        );
        let _ = connection.flush();
        return Ok(true);
    }

    Ok(false)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn focus_game_window(_executable_names: &[String]) -> Result<bool, String> {
    Ok(false)
}
