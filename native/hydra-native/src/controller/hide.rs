//! Exclusive access ("hide physical pad") so only Hydra sees the real
//! controller while a virtual output pad is fed by remapped state.
//!
//! - Windows: the HidHide filter driver (`\\.\HidHide` control device).
//!   Hiding = self DOS-exe path in the driver whitelist + pad instance path
//!   in the blacklist + driver active. Prefers the *session* blacklist
//!   (IOCTL 2056/2057, self-clearing on process exit) and falls back to the
//!   persistent blacklist on drivers too old to expose it.
//! - Linux: EVIOCGRAB on every evdev node the HID device exposes; an
//!   exclusive grab makes other readers (incl. SDL/evdev enumerators) see
//!   the node as busy.
//! - Other platforms: probe reports `unavailable`.

use std::io;

/// Probe vocabulary consumed by the TS side (`HidingSupport` type).
pub fn probe_support() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        win::probe()
    }
    #[cfg(target_os = "linux")]
    {
        "evdev-grab"
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        "unavailable"
    }
}

/// Held while the pad stays hidden; dropping restores visibility.
pub enum HiddenPad {
    #[cfg(target_os = "windows")]
    Win(win::Guard),
    #[cfg(target_os = "linux")]
    Lin(Vec<std::fs::File>),
}

/// Whether the pad is currently hidden — true when we hid it OR when an
/// external tool (e.g. the HidHide client) blacklisted it. Used to surface
/// real exclusive-access state instead of only tracking our own guards.
/// Session-blacklist entries live per-process inside the driver and are not
/// externally observable; the persistent blacklist is.
pub fn is_hidden(device_path: &str) -> bool {
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let _ = device_path;
    #[cfg(target_os = "windows")]
    {
        win::is_hidden(device_path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Removes externally-configured hiding (persistent blacklist entry) so a
/// user turning the toggle off actually un-hides the pad. No-op when nothing
/// is hidden or the platform has no persistent hide state.
pub fn unhide(device_path: &str) -> io::Result<()> {
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let _ = device_path;
    #[cfg(target_os = "windows")]
    {
        win::unhide(device_path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(())
    }
}

pub fn hide(device_path: &str) -> io::Result<HiddenPad> {
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let _ = device_path;
    #[cfg(target_os = "windows")]
    {
        return win::Guard::enable(device_path).map(HiddenPad::Win);
    }
    #[cfg(target_os = "linux")]
    {
        return lin::grab_all(device_path).map(HiddenPad::Lin);
    }
    #[allow(unreachable_code)]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "controller hiding unsupported on this platform",
    ))
}

#[cfg(target_os = "windows")]
mod win {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::os::windows::io::AsRawHandle;

    // HidHide control-device IOCTLs (Functions 2048–2057, METHOD_BUFFERED).
    const IOCTL_GET_WHITELIST: u32 = 0x8001_6000;
    const IOCTL_SET_WHITELIST: u32 = 0x8001_6004;
    const IOCTL_GET_BLACKLIST: u32 = 0x8001_6008;
    const IOCTL_SET_BLACKLIST: u32 = 0x8001_600C;
    const IOCTL_GET_ACTIVE: u32 = 0x8001_6010;
    const IOCTL_SET_ACTIVE: u32 = 0x8001_6014;
    const IOCTL_ADD_SESSION_BLACKLIST: u32 = 0x8001_6020;
    const IOCTL_CLR_SESSION_BLACKLIST: u32 = 0x8001_6024;

    fn open_control() -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(r"\\.\HidHide")
    }

    fn dev_ioctl(
        file: &File,
        code: u32,
        in_buf: Option<&[u8]>,
        out_buf: Option<&mut [u8]>,
    ) -> io::Result<u32> {
        use windows_sys::Win32::System::IO::DeviceIoControl;
        let out_len = out_buf.as_ref().map_or(0, |b| b.len() as u32);
        let out_ptr = match out_buf {
            Some(b) => b.as_mut_ptr() as *mut core::ffi::c_void,
            None => std::ptr::null_mut(),
        };
        let mut returned = 0u32;
        let ok = unsafe {
            DeviceIoControl(
                file.as_raw_handle() as _,
                code,
                in_buf.map_or(std::ptr::null(), |b| b.as_ptr() as *const _),
                in_buf.map_or(0, |b| b.len() as u32),
                out_ptr,
                out_len,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(returned)
        }
    }

    /// REG_MULTI_SZ helpers — consecutive UTF-16 strings, double-NUL tail.
    fn multi_sz_encode(items: &[String]) -> Vec<u8> {
        let mut w: Vec<u16> = Vec::new();
        for s in items {
            w.extend(s.encode_utf16());
            w.push(0);
        }
        w.push(0);
        w.iter().flat_map(|c| c.to_le_bytes()).collect()
    }

    fn multi_sz_decode(buf: &[u16]) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = String::new();
        for &c in buf {
            if c == 0 {
                if cur.is_empty() {
                    break;
                }
                out.push(std::mem::take(&mut cur));
            } else {
                cur.push(char::from_u32(c as u32).unwrap_or('\u{FFFD}'));
            }
        }
        out
    }

    fn get_list(file: &File, code: u32) -> io::Result<Vec<String>> {
        let needed = dev_ioctl(file, code, None, None)? as usize;
        let mut buf = vec![0u16; needed / 2 + 2];
        let byte_len = buf.len() * 2;
        let byte_slice =
            unsafe { std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, byte_len) };
        dev_ioctl(file, code, None, Some(byte_slice))?;
        Ok(multi_sz_decode(&buf))
    }

    fn set_list(file: &File, code: u32, items: &[String]) -> io::Result<()> {
        dev_ioctl(file, code, Some(&multi_sz_encode(items)), None).map(|_| ())
    }

    fn get_active(file: &File) -> io::Result<bool> {
        let mut b = [0u8; 1];
        dev_ioctl(file, IOCTL_GET_ACTIVE, None, Some(&mut b))?;
        Ok(b[0] != 0)
    }

    fn set_active(file: &File, active: bool) -> io::Result<()> {
        dev_ioctl(file, IOCTL_SET_ACTIVE, Some(&[active as u8]), None).map(|_| ())
    }

    fn self_dos_path() -> io::Result<String> {
        Ok(format!(r"\??\{}", std::env::current_exe()?.display()))
    }

    fn ensure_whitelisted(file: &File) -> io::Result<()> {
        let me = self_dos_path()?;
        let mut list = get_list(file, IOCTL_GET_WHITELIST)?;
        if !list.iter().any(|s| s.eq_ignore_ascii_case(&me)) {
            list.push(me);
            set_list(file, IOCTL_SET_WHITELIST, &list)?;
        }
        Ok(())
    }

    fn ensure_active(file: &File) -> io::Result<bool> {
        if get_active(file)? {
            return Ok(false);
        }
        set_active(file, true)?;
        Ok(true)
    }

    /// `\\?\HID#VID_054C&PID_09CC&IG_00#9&1a2b&0&0000#{4d1e55b2-...}`
    /// → `HID\VID_054C&PID_09CC&IG_00\9&1A2B&0&0000`
    fn instance_path(device_path: &str) -> Option<String> {
        let s = device_path
            .strip_prefix(r"\\?\")
            .or_else(|| device_path.strip_prefix(r"\\.\"))?;
        let s = s.split("#{").next()?;
        if s.len() < 4 || !s[..4].eq_ignore_ascii_case("hid#") {
            return None;
        }
        Some(s.replace('#', r"\").to_ascii_uppercase())
    }

    enum Kind {
        Session,
        Persistent { instance: String },
    }

    pub struct Guard {
        kind: Kind,
        activated: bool,
    }

    impl Guard {
        pub fn enable(device_path: &str) -> io::Result<Self> {
            let instance = instance_path(device_path).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "not a HID device path")
            })?;
            let file = open_control().map_err(|e| {
                io::Error::new(e.kind(), format!("HidHide control device: {e}"))
            })?;
            ensure_whitelisted(&file)?;
            // Session blacklist (self-clearing) first; older drivers reject
            // the unknown IOCTL and fall through to the persistent list.
            if dev_ioctl(
                &file,
                IOCTL_ADD_SESSION_BLACKLIST,
                Some(&multi_sz_encode(std::slice::from_ref(&instance))),
                None,
            )
            .is_ok()
            {
                let activated = ensure_active(&file)?;
                return Ok(Self {
                    kind: Kind::Session,
                    activated,
                });
            }
            let mut list = get_list(&file, IOCTL_GET_BLACKLIST)?;
            if !list.iter().any(|s| s.eq_ignore_ascii_case(&instance)) {
                list.push(instance.clone());
                set_list(&file, IOCTL_SET_BLACKLIST, &list)?;
            }
            let activated = ensure_active(&file)?;
            Ok(Self {
                kind: Kind::Persistent { instance },
                activated,
            })
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            let Ok(file) = open_control() else {
                return;
            };
            match &self.kind {
                Kind::Session => {
                    let _ = dev_ioctl(&file, IOCTL_CLR_SESSION_BLACKLIST, None, None);
                }
                Kind::Persistent { instance } => {
                    if let Ok(mut list) = get_list(&file, IOCTL_GET_BLACKLIST) {
                        list.retain(|s| !s.eq_ignore_ascii_case(instance));
                        let _ = set_list(&file, IOCTL_SET_BLACKLIST, &list);
                    }
                }
            }
            if self.activated {
                let _ = set_active(&file, false);
            }
        }
    }

    pub fn probe() -> &'static str {
        match open_control() {
            Ok(_) => "hidhide-available",
            Err(e) if e.kind() == io::ErrorKind::NotFound => "hidhide-unavailable",
            Err(_) => "hidhide-available",
        }
    }

    /// Active + instance in the persistent blacklist = externally hidden.
    pub fn is_hidden(device_path: &str) -> bool {
        let Some(instance) = instance_path(device_path) else {
            return false;
        };
        let Ok(file) = open_control() else {
            return false;
        };
        let active = get_active(&file).unwrap_or(false);
        let listed = get_list(&file, IOCTL_GET_BLACKLIST)
            .map(|list| list.iter().any(|s| s.eq_ignore_ascii_case(&instance)))
            .unwrap_or(false);
        active && listed
    }

    /// Removes the instance from the persistent blacklist (leaves whitelist
    /// and the active flag alone — other clients may rely on them).
    pub fn unhide(device_path: &str) -> io::Result<()> {
        let Some(instance) = instance_path(device_path) else {
            return Ok(());
        };
        let file = open_control()?;
        let mut list = get_list(&file, IOCTL_GET_BLACKLIST)?;
        let before = list.len();
        list.retain(|s| !s.eq_ignore_ascii_case(&instance));
        if list.len() != before {
            set_list(&file, IOCTL_SET_BLACKLIST, &list)?;
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod lin {
    use super::*;
    use std::fs::{self, File};
    use std::os::unix::io::AsRawFd;
    use std::path::Path;

    const EVIOCGRAB: libc::c_ulong = 0x4004_4590;

    /// Grabs every evdev node belonging to the pad's HID device. Keeping the
    /// `File`s in the guard holds the grabs; closing them releases.
    pub fn grab_all(device_path: &str) -> io::Result<Vec<File>> {
        let name = device_path
            .rsplit('/')
            .next()
            .filter(|s| s.starts_with("hidraw"))
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a hidraw path"))?;
        let dev_dir = fs::canonicalize(format!("/sys/class/hidraw/{name}/device"))?;
        let mut files = Vec::new();
        let mut first_err: Option<io::Error> = None;
        for input_ent in fs::read_dir(dev_dir.join("input"))? {
            let input_dir = input_ent?.path();
            if !input_dir.is_dir() {
                continue;
            }
            for ev in fs::read_dir(&input_dir)? {
                let ev = ev?.path();
                let node = Path::new("/dev/input").join(ev.file_name().unwrap_or_default());
                match File::open(&node) {
                    Ok(f) => {
                        if unsafe { libc::ioctl(f.as_raw_fd(), EVIOCGRAB, 1) } == 0 {
                            files.push(f);
                        }
                    }
                    Err(e) => {
                        if first_err.is_none() {
                            first_err = Some(e);
                        }
                    }
                }
            }
        }
        if files.is_empty() {
            Err(first_err.unwrap_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "no evdev nodes for device")
            }))
        } else {
            Ok(files)
        }
    }
}
