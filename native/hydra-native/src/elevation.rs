#[cfg(target_os = "windows")]
pub fn is_process_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }

        let mut elevation = TOKEN_ELEVATION::default();
        let mut return_length = 0u32;
        let result = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut std::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut return_length,
        );
        let _ = CloseHandle(token);

        result.is_ok() && elevation.TokenIsElevated != 0
    }
}

#[cfg(target_os = "linux")]
pub fn is_process_elevated() -> bool {
    unsafe { libc::geteuid() == 0 }
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn is_process_elevated() -> bool {
    false
}

#[cfg(target_os = "windows")]
pub fn relaunch_elevated(exe_path: &str) -> Result<bool, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{w, HRESULT};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW};

    let wide_path: Vec<u16> = std::ffi::OsStr::new(exe_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        hwnd: HWND::default(),
        lpVerb: w!("runas"),
        lpFile: windows::core::PCWSTR(wide_path.as_ptr()),
        nShow: 1,
        ..Default::default()
    };

    unsafe {
        match ShellExecuteExW(&mut info) {
            Ok(()) => Ok(true),
            Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => Ok(false),
            Err(error) => Err(error.message()),
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn relaunch_elevated(_exe_path: &str) -> Result<bool, String> {
    Err("relaunch_elevated is only supported on Windows".to_string())
}

// HANDLE is a raw pointer and therefore !Send, so the map keeps the
// handle value as usize instead. The handle must be kept -- a
// non-elevated caller cannot OpenProcess a handle to a high-integrity
// child to wait on it later.
#[cfg(target_os = "windows")]
fn elevated_handles() -> &'static std::sync::Mutex<std::collections::HashMap<u32, usize>> {
    static HANDLES: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u32, usize>>> =
        std::sync::OnceLock::new();
    HANDLES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Elevates a target exe through ShellExecuteEx(runas) and returns its
/// PID. Unlike powershell-based launches there is no wildcard parsing,
/// no argument re-quoting, and no console-window involvement -- the
/// child gets the raw argument string verbatim, exactly like .NET
/// ProcessStartInfo(Verb=runas) produces.
#[cfg(target_os = "windows")]
pub fn spawn_elevated(exe_path: &str, args: &str, cwd: Option<&str>) -> Result<u32, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{w, HRESULT, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, HWND};
    use windows::Win32::System::Threading::GetProcessId;
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};

    let to_wide = |value: &str| -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let wide_path = to_wide(exe_path);
    let wide_args = to_wide(args);
    let wide_cwd = cwd.map(to_wide);

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        hwnd: HWND::default(),
        lpVerb: w!("runas"),
        lpFile: PCWSTR(wide_path.as_ptr()),
        lpParameters: PCWSTR(wide_args.as_ptr()),
        lpDirectory: match &wide_cwd {
            Some(dir) => PCWSTR(dir.as_ptr()),
            None => PCWSTR::null(),
        },
        nShow: 1,
        ..Default::default()
    };

    unsafe {
        match ShellExecuteExW(&mut info) {
            Ok(()) => {
                let process = info.hProcess;
                if process.0.is_null() {
                    return Err("ShellExecuteEx returned no process handle".to_string());
                }
                let pid = GetProcessId(process);
                if pid == 0 {
                    let _ = CloseHandle(process);
                    return Err("could not read elevated process id".to_string());
                }
                let mut handles = elevated_handles()
                    .lock()
                    .map_err(|_| "elevated handle map poisoned".to_string())?;
                handles.insert(pid, process.0 as usize);
                Ok(pid)
            }
            Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => {
                Err("elevation denied by user".to_string())
            }
            Err(error) => Err(error.message()),
        }
    }
}

#[cfg(target_os = "windows")]
pub fn wait_elevated_exit(pid: u32) -> Result<i32, String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};

    let process = {
        let raw = {
            let mut handles = elevated_handles()
                .lock()
                .map_err(|_| "elevated handle map poisoned".to_string())?;
            handles
                .remove(&pid)
                .ok_or_else(|| format!("no elevated process tracked for pid {pid}"))?
        };
        HANDLE(raw as *mut core::ffi::c_void)
    };

    unsafe {
        WaitForSingleObject(process, u32::MAX);
        let mut code = 0u32;
        let result = if GetExitCodeProcess(process, &mut code).is_ok() {
            Ok(code as i32)
        } else {
            Err("GetExitCodeProcess failed".to_string())
        };
        let _ = CloseHandle(process);
        result
    }
}

#[cfg(not(target_os = "windows"))]
pub fn spawn_elevated(_exe_path: &str, _args: &str, _cwd: Option<&str>) -> Result<u32, String> {
    Err("spawn_elevated is only supported on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn wait_elevated_exit(_pid: u32) -> Result<i32, String> {
    Err("wait_elevated_exit is only supported on Windows".to_string())
}
