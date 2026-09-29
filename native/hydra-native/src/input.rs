//! OS-level input injection for the in-game virtual keyboard.
//!
//! Text goes through `SendInput`/`KEYEVENTF_UNICODE` on Windows and XTest on
//! Linux so characters land in whichever window holds OS focus — the keyboard
//! overlay itself is `focusable: false`. Wayland has no XTest equivalent and
//! is unsupported for now.

#[cfg(target_os = "windows")]
fn key_input(vk: u16, flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS) -> windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, VIRTUAL_KEY,
    };

    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(target_os = "windows")]
fn flush_inputs(
    inputs: &[windows::Win32::UI::Input::KeyboardAndMouse::INPUT],
) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::SendInput;

    if inputs.is_empty() {
        return Ok(());
    }

    let sent = unsafe { SendInput(inputs, std::mem::size_of_val(&inputs[0]) as i32) };
    if sent as usize != inputs.len() {
        return Err(format!(
            "SendInput injected {sent} of {} events",
            inputs.len()
        ));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn is_extended_virtual_key(vk: u16) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2d | 0x2e | 0x5b | 0x5c | 0x6f | 0xa2 | 0xa3)
}

#[cfg(target_os = "windows")]
pub fn send_text_input(text: &str) -> Result<bool, String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VIRTUAL_KEY,
    };

    let mut inputs: Vec<INPUT> = Vec::with_capacity(text.encode_utf16().count() * 2);
    for unit in text.encode_utf16() {
        for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: unit,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
    }

    flush_inputs(&inputs)?;
    Ok(true)
}

#[cfg(target_os = "windows")]
pub fn send_virtual_key_chord(virtual_keys: &[u32]) -> Result<bool, String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    };

    let mut inputs = Vec::with_capacity(virtual_keys.len() * 2);
    for &vk in virtual_keys {
        let vk = vk as u16;
        let mut flags = KEYBD_EVENT_FLAGS(0);
        if is_extended_virtual_key(vk) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        inputs.push(key_input(vk, flags));
    }
    for &vk in virtual_keys.iter().rev() {
        let vk = vk as u16;
        let mut flags = KEYEVENTF_KEYUP;
        if is_extended_virtual_key(vk) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        inputs.push(key_input(vk, flags));
    }

    flush_inputs(&inputs)?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Linux (X11 XTest). Wayland compositors reject XTest on XWayland in many
// setups — failures surface as Err and are logged by the caller.
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod linux {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::ConnectionExt;
    use x11rb::protocol::xtest::ConnectionExt as XTestConnectionExt;
    use x11rb::rust_connection::RustConnection;
    use x11rb::wrapper::ConnectionExt as WrapperConnectionExt;

    const KEY_PRESS: u8 = 2;
    const KEY_RELEASE: u8 = 3;

    fn vk_to_keysym(vk: u32) -> Option<u32> {
        Some(match vk {
            0x08 => 0xff08, // XK_BackSpace
            0x09 => 0xff09, // XK_Tab
            0x0d => 0xff0d, // XK_Return
            0x10 => 0xffe1, // XK_Shift_L
            0x11 => 0xffe3, // XK_Control_L
            0x12 => 0xffe9, // XK_Alt_L
            0x1b => 0xff1b, // XK_Escape
            0x20 => 0x0020, // XK_space
            0x21 => 0xff55, // XK_Page_Up
            0x22 => 0xff56, // XK_Page_Down
            0x23 => 0xff57, // XK_End
            0x24 => 0xff50, // XK_Home
            0x25 => 0xff51, // XK_Left
            0x26 => 0xff52, // XK_Up
            0x27 => 0xff53, // XK_Right
            0x28 => 0xff54, // XK_Down
            0x2d => 0xff63, // XK_Insert
            0x2e => 0xffff, // XK_Delete
            vk @ 0x30..=0x39 => vk,          // digits: VK == keysym
            vk @ 0x41..=0x5a => vk + 0x20,   // letters: VK_A..Z -> a..z keysyms
            _ => return None,
        })
    }

    fn char_to_keysym(character: char) -> u32 {
        let codepoint = character as u32;
        if codepoint <= 0xff {
            codepoint
        } else {
            // XKB Unicode keysym convention: 0x01000000 + codepoint.
            0x0100_0000 + codepoint
        }
    }

    struct X11Keyboard {
        connection: RustConnection,
        root: u32,
    }

    impl X11Keyboard {
        fn connect() -> Result<Self, String> {
            let (connection, screen_index) = RustConnection::connect(None)
                .map_err(|error| format!("failed to connect to X server: {error}"))?;
            let root = connection
                .setup()
                .roots
                .get(screen_index)
                .map(|screen| screen.root)
                .ok_or_else(|| "X server returned no screens".to_string())?;

            Ok(Self { connection, root })
        }

        fn keyboard_mapping(&self) -> Result<(u8, Vec<u32>, usize), String> {
            let setup = self.connection.setup();
            let first = setup.min_keycode;
            let count = setup.max_keycode - first + 1;
            let reply = self
                .connection
                .get_keyboard_mapping(first, count)
                .map_err(|error| format!("GetKeyboardMapping failed: {error}"))?
                .reply()
                .map_err(|error| format!("GetKeyboardMapping reply failed: {error}"))?;

            Ok((
                first,
                reply.keysyms,
                reply.keysyms_per_keycode as usize,
            ))
        }

        fn keysym_to_keycode(&self, keysym: u32) -> Result<Option<u8>, String> {
            let (first, keysyms, per_keycode) = self.keyboard_mapping()?;

            for (index, row) in keysyms.chunks(per_keycode.max(1)).enumerate() {
                if row.contains(&keysym) {
                    return Ok(Some(first + index as u8));
                }
            }

            Ok(None)
        }

        fn spare_keycode(&self) -> Result<Option<u8>, String> {
            let (first, keysyms, per_keycode) = self.keyboard_mapping()?;

            for (index, row) in keysyms.chunks(per_keycode.max(1)).enumerate() {
                if row.iter().all(|&keysym| keysym == 0) {
                    return Ok(Some(first + index as u8));
                }
            }

            Ok(None)
        }

        fn fake_key(&self, keycode: u8, press: bool) -> Result<(), String> {
            self.connection
                .xtest_fake_input(
                    if press { KEY_PRESS } else { KEY_RELEASE },
                    keycode,
                    0,
                    self.root,
                    0,
                    0,
                    0,
                )
                .map_err(|error| format!("XTestFakeInput failed: {error}"))?;
            self.connection
                .flush()
                .map_err(|error| format!("X11 flush failed: {error}"))?;

            Ok(())
        }

        /// Press+release a keysym. Unmapped keysyms are temporarily bound to a
        /// spare keycode (the xdotool trick) so arbitrary Unicode text works.
        fn tap_keysym(&self, keysym: u32) -> Result<(), String> {
            if let Some(keycode) = self.keysym_to_keycode(keysym)? {
                self.fake_key(keycode, true)?;
                return self.fake_key(keycode, false);
            }

            let Some(spare) = self.spare_keycode()? else {
                return Err(format!("no spare keycode for keysym {keysym:#x}"));
            };

            self.connection
                .change_keyboard_mapping(1, spare, 1, &[keysym])
                .map_err(|error| format!("ChangeKeyboardMapping failed: {error}"))?;
            self.connection
                .sync()
                .map_err(|error| format!("X11 sync failed: {error}"))?;

            let result = self
                .fake_key(spare, true)
                .and_then(|_| self.fake_key(spare, false));

            let _ = self
                .connection
                .change_keyboard_mapping(1, spare, 1, &[0])
                .and_then(|_| self.connection.flush());

            result
        }

        /// Hold/release a keysym. Unmapped keysyms are silently skipped —
        /// modifiers always map to real keycodes.
        fn set_keysym(&self, keysym: u32, press: bool) -> Result<(), String> {
            let Some(keycode) = self.keysym_to_keycode(keysym)? else {
                return Err(format!("keysym {keysym:#x} has no keycode"));
            };

            self.fake_key(keycode, press)
        }
    }

    pub fn send_text_input(text: &str) -> Result<bool, String> {
        if text.is_empty() {
            return Ok(true);
        }

        let keyboard = X11Keyboard::connect()?;
        for character in text.chars() {
            keyboard.tap_keysym(char_to_keysym(character))?;
        }

        Ok(true)
    }

    pub fn send_virtual_key_chord(virtual_keys: &[u32]) -> Result<bool, String> {
        if virtual_keys.is_empty() {
            return Ok(true);
        }

        let keyboard = X11Keyboard::connect()?;
        for &vk in virtual_keys {
            let keysym =
                vk_to_keysym(vk).ok_or_else(|| format!("unsupported virtual key {vk:#x}"))?;
            keyboard.set_keysym(keysym, true)?;
        }
        for &vk in virtual_keys.iter().rev() {
            let keysym = vk_to_keysym(vk).expect("validated above");
            let _ = keyboard.set_keysym(keysym, false);
        }

        Ok(true)
    }
}

#[cfg(target_os = "linux")]
pub fn send_text_input(text: &str) -> Result<bool, String> {
    linux::send_text_input(text)
}

#[cfg(target_os = "linux")]
pub fn send_virtual_key_chord(virtual_keys: &[u32]) -> Result<bool, String> {
    linux::send_virtual_key_chord(virtual_keys)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn send_text_input(_text: &str) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn send_virtual_key_chord(_virtual_keys: &[u32]) -> Result<bool, String> {
    Ok(false)
}
