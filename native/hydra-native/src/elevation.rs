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
    use windows::core::w;
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
            Err(error)
                if error.code()
                    == windows::Win32::Foundation::HRESULT::from_win32(
                        ERROR_CANCELLED.0 as i32,
                    ) =>
            {
                Ok(false)
            }
            Err(error) => Err(error.message()),
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn relaunch_elevated(_exe_path: &str) -> Result<bool, String> {
    Err("relaunch_elevated is only supported on Windows".to_string())
}
