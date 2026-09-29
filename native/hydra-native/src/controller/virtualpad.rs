//! Virtual Xbox 360 pad output — publishes the *remapped* `ParsedState` to a
//! virtual X360 controller that games can read (Linux `uinput`, Windows
//! ViGEmBus via `vigemclient.dll` loaded at runtime). Unsupported platforms
//! return an error at creation and `probe_support` reports them upfront.

use super::state::ParsedState;
#[cfg(any(target_os = "linux", target_os = "windows", test))]
use super::controls::{self, Ds4Control};

pub trait VirtualPad: Send {
    fn send(&mut self, state: &ParsedState) -> std::io::Result<()>;
}

/// XUSB report (XInput `XUSB_REPORT`) — shared serialization target for every
/// backend. Buttons follow the `XUSB_GAMEPAD_*` bitfield.
#[cfg(any(target_os = "linux", target_os = "windows", test))]
#[derive(Debug, Default, Clone, Copy)]
#[cfg_attr(windows, repr(C))]
pub struct XusbReport {
    pub buttons: u16,
    pub left_trigger: u8,
    pub right_trigger: u8,
    pub left_x: i16,
    pub left_y: i16,
    pub right_x: i16,
    pub right_y: i16,
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
mod xusb {
    pub const DPAD_UP: u16 = 0x0001;
    pub const DPAD_DOWN: u16 = 0x0002;
    pub const DPAD_LEFT: u16 = 0x0004;
    pub const DPAD_RIGHT: u16 = 0x0008;
    pub const START: u16 = 0x0010;
    pub const BACK: u16 = 0x0020;
    pub const LEFT_THUMB: u16 = 0x0040;
    pub const RIGHT_THUMB: u16 = 0x0080;
    pub const LEFT_SHOULDER: u16 = 0x0100;
    pub const RIGHT_SHOULDER: u16 = 0x0200;
    pub const GUIDE: u16 = 0x0400;
    pub const A: u16 = 0x1000;
    pub const B: u16 = 0x2000;
    pub const X: u16 = 0x4000;
    pub const Y: u16 = 0x8000;
}

/// u8 axis → signed i16, full -32768..=32767 range; `invert` flips sign for
/// XInput Y conventions (HID raw is +down, XInput is +up).
#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn stick_to_i16(axis: u8, invert: bool) -> i16 {
    let v = axis as i32 * 257 - 32768;
    let v = if invert { -v } else { v };
    v.clamp(-32768, 32767) as i16
}

/// Canonical state → X360 report. Stick Y is negated: our axis convention is
/// +up, XInput's is +up too — but stored axes are +down (HID raw), so flip.
#[cfg(any(target_os = "linux", target_os = "windows", test))]
pub fn to_xusb(s: &ParsedState) -> XusbReport {
    let p = s.pressed;
    let mut r = XusbReport::default();
    r.buttons |= if controls::get(p, Ds4Control::DpadUp) { xusb::DPAD_UP } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::DpadDown) { xusb::DPAD_DOWN } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::DpadLeft) { xusb::DPAD_LEFT } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::DpadRight) { xusb::DPAD_RIGHT } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::Options) { xusb::START } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::Share) { xusb::BACK } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::L3) { xusb::LEFT_THUMB } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::R3) { xusb::RIGHT_THUMB } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::L1) { xusb::LEFT_SHOULDER } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::R1) { xusb::RIGHT_SHOULDER } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::Ps) { xusb::GUIDE } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::Cross) { xusb::A } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::Circle) { xusb::B } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::Square) { xusb::X } else { 0 };
    r.buttons |= if controls::get(p, Ds4Control::Triangle) { xusb::Y } else { 0 };
    // Axes: [lx, ly, rx, ry, l2, r2]
    r.left_x = stick_to_i16(s.axes[0], false);
    r.left_y = stick_to_i16(s.axes[1], true);
    r.right_x = stick_to_i16(s.axes[2], false);
    r.right_y = stick_to_i16(s.axes[3], true);
    r.left_trigger = s.axes[4];
    r.right_trigger = s.axes[5];
    r
}

pub fn create_virtual_pad() -> std::io::Result<Box<dyn VirtualPad>> {
    platform::create()
}

/// What the UI should render for the virtual-output toggle.
/// `supported` — backend present & writable; `driver-missing` — ViGEmBus not
/// installed (Windows); `unsupported` — no backend for this OS.
pub fn probe_support() -> &'static str {
    platform::probe()
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{to_xusb, VirtualPad, XusbReport};
    use crate::controller::state::ParsedState;
    use evdev::uinput::VirtualDevice;
    use evdev::{
        AbsInfo, AbsoluteAxisCode, AttributeSet, BusType, EventType, InputEvent, InputId, KeyCode,
        UinputAbsSetup,
    };
    use std::io;

    const KEYS: [KeyCode; 15] = [
        KeyCode::BTN_SOUTH,
        KeyCode::BTN_EAST,
        KeyCode::BTN_NORTH,
        KeyCode::BTN_WEST,
        KeyCode::BTN_TL,
        KeyCode::BTN_TR,
        KeyCode::BTN_TL2,
        KeyCode::BTN_TR2,
        KeyCode::BTN_SELECT,
        KeyCode::BTN_START,
        KeyCode::BTN_MODE,
        KeyCode::BTN_THUMBL,
        KeyCode::BTN_THUMBR,
        KeyCode::BTN_DPAD_UP,
        KeyCode::BTN_DPAD_DOWN,
    ];
    const DPAD_LR: [KeyCode; 2] = [KeyCode::BTN_DPAD_LEFT, KeyCode::BTN_DPAD_RIGHT];

    fn key_bits() -> AttributeSet<KeyCode> {
        let mut set = AttributeSet::<KeyCode>::new();
        for k in KEYS.iter().chain(DPAD_LR.iter()) {
            set.insert(*k);
        }
        set
    }

    fn stick_axis(code: AbsoluteAxisCode) -> UinputAbsSetup {
        UinputAbsSetup::new(code, AbsInfo::new(0, -32768, 32767, 16, 256, 0))
    }

    fn trigger_axis(code: AbsoluteAxisCode) -> UinputAbsSetup {
        UinputAbsSetup::new(code, AbsInfo::new(0, 0, 255, 0, 0, 0))
    }

    pub struct LinuxPad {
        dev: VirtualDevice,
        last: XusbReport,
    }

    pub fn create() -> io::Result<Box<dyn VirtualPad>> {
        let dev = VirtualDevice::builder()?
            .name("Hydra Virtual Xbox 360 Controller")
            .input_id(InputId::new(BusType::BUS_VIRTUAL, 0x045e, 0x028e, 0x0110))
            .with_keys(&key_bits())?
            .with_absolute_axis(&stick_axis(AbsoluteAxisCode::ABS_X))?
            .with_absolute_axis(&stick_axis(AbsoluteAxisCode::ABS_Y))?
            .with_absolute_axis(&stick_axis(AbsoluteAxisCode::ABS_RX))?
            .with_absolute_axis(&stick_axis(AbsoluteAxisCode::ABS_RY))?
            .with_absolute_axis(&trigger_axis(AbsoluteAxisCode::ABS_Z))?
            .with_absolute_axis(&trigger_axis(AbsoluteAxisCode::ABS_RZ))?
            .build()?;
        Ok(Box::new(LinuxPad {
            dev,
            last: XusbReport::default(),
        }))
    }

    impl LinuxPad {
        fn push_key(events: &mut Vec<InputEvent>, code: KeyCode, before: u16, after: u16, bit: u16) {
            if (before ^ after) & bit != 0 {
                events.push(InputEvent::new(
                    EventType::KEY.0,
                    code.0,
                    if after & bit != 0 { 1 } else { 0 },
                ));
            }
        }

        fn push_axis(
            events: &mut Vec<InputEvent>,
            code: AbsoluteAxisCode,
            before: i32,
            after: i32,
        ) {
            if before != after {
                events.push(InputEvent::new(EventType::ABSOLUTE.0, code.0, after));
            }
        }
    }

    impl VirtualPad for LinuxPad {
        fn send(&mut self, state: &ParsedState) -> io::Result<()> {
            let next = to_xusb(state);
            let prev = self.last;
            let mut events: Vec<InputEvent> = Vec::with_capacity(24);

            let mapping: [(KeyCode, u16); 17] = [
                (KeyCode::BTN_SOUTH, super::xusb::A),
                (KeyCode::BTN_EAST, super::xusb::B),
                (KeyCode::BTN_NORTH, super::xusb::Y),
                (KeyCode::BTN_WEST, super::xusb::X),
                (KeyCode::BTN_TL, super::xusb::LEFT_SHOULDER),
                (KeyCode::BTN_TR, super::xusb::RIGHT_SHOULDER),
                (KeyCode::BTN_SELECT, super::xusb::BACK),
                (KeyCode::BTN_START, super::xusb::START),
                (KeyCode::BTN_MODE, super::xusb::GUIDE),
                (KeyCode::BTN_THUMBL, super::xusb::LEFT_THUMB),
                (KeyCode::BTN_THUMBR, super::xusb::RIGHT_THUMB),
                (KeyCode::BTN_DPAD_UP, super::xusb::DPAD_UP),
                (KeyCode::BTN_DPAD_DOWN, super::xusb::DPAD_DOWN),
                (KeyCode::BTN_DPAD_LEFT, super::xusb::DPAD_LEFT),
                (KeyCode::BTN_DPAD_RIGHT, super::xusb::DPAD_RIGHT),
                (KeyCode::BTN_TL2, 0),
                (KeyCode::BTN_TR2, 0),
            ];
            for (code, bit) in mapping {
                if bit != 0 {
                    Self::push_key(&mut events, code, prev.buttons, next.buttons, bit);
                }
            }
            Self::push_key(
                &mut events,
                KeyCode::BTN_TL2,
                prev.left_trigger as u16 >> 4,
                next.left_trigger as u16 >> 4,
                0xF,
            );
            Self::push_key(
                &mut events,
                KeyCode::BTN_TR2,
                prev.right_trigger as u16 >> 4,
                next.right_trigger as u16 >> 4,
                0xF,
            );

            Self::push_axis(&mut events, AbsoluteAxisCode::ABS_X, prev.left_x as i32, next.left_x as i32);
            Self::push_axis(&mut events, AbsoluteAxisCode::ABS_Y, prev.left_y as i32, next.left_y as i32);
            Self::push_axis(&mut events, AbsoluteAxisCode::ABS_RX, prev.right_x as i32, next.right_x as i32);
            Self::push_axis(&mut events, AbsoluteAxisCode::ABS_RY, prev.right_y as i32, next.right_y as i32);
            Self::push_axis(&mut events, AbsoluteAxisCode::ABS_Z, prev.left_trigger as i32, next.left_trigger as i32);
            Self::push_axis(&mut events, AbsoluteAxisCode::ABS_RZ, prev.right_trigger as i32, next.right_trigger as i32);

            if events.is_empty() {
                return Ok(());
            }
            self.last = next;
            self.dev.emit(&events)
        }
    }

    pub fn probe() -> &'static str {
        if std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/uinput")
            .is_ok()
        {
            "supported"
        } else {
            "unsupported"
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{to_xusb, VirtualPad, XusbReport};
    use crate::controller::state::ParsedState;
    use libloading::{Library, Symbol};
    use std::ffi::c_void;
    use std::io;

    type VigemClient = c_void;
    type VigemTarget = c_void;

    type VigemAlloc = unsafe extern "C" fn() -> *mut VigemClient;
    type VigemConnect = unsafe extern "C" fn(*mut VigemClient) -> i32;
    type VigemTargetX360Alloc = unsafe extern "C" fn() -> *mut VigemTarget;
    type VigemTargetAdd = unsafe extern "C" fn(*mut VigemClient, *mut VigemTarget) -> i32;
    type VigemTargetRemove = unsafe extern "C" fn(*mut VigemClient, *mut VigemTarget);
    type VigemTargetFree = unsafe extern "C" fn(*mut VigemTarget);
    type VigemTargetX360Update =
        unsafe extern "C" fn(*mut VigemClient, *mut VigemTarget, XusbReport);
    type VigemDisconnect = unsafe extern "C" fn(*mut VigemClient);
    type VigemFree = unsafe extern "C" fn(*mut VigemClient);

    pub struct VigemPad {
        lib: Library,
        client: *mut VigemClient,
        target: *mut VigemTarget,
    }
    // Raw vigem pointers are only touched from the session's IO thread.
    unsafe impl Send for VigemPad {}

    pub fn create() -> io::Result<Box<dyn VirtualPad>> {
        unsafe {
            let lib = Library::new("vigemclient.dll").map_err(io::Error::other)?;
            let alloc: Symbol<VigemAlloc> = lib.get(b"vigem_alloc").map_err(io::Error::other)?;
            let connect: Symbol<VigemConnect> =
                lib.get(b"vigem_connect").map_err(io::Error::other)?;
            let x360_alloc: Symbol<VigemTargetX360Alloc> = lib
                .get(b"vigem_target_x360_alloc")
                .map_err(io::Error::other)?;
            let add: Symbol<VigemTargetAdd> =
                lib.get(b"vigem_target_add").map_err(io::Error::other)?;

            let client = alloc();
            if client.is_null() {
                return Err(io::Error::other("vigem_alloc returned null"));
            }
            if connect(client) != 0 {
                return Err(io::Error::other("vigem_connect failed"));
            }
            let target = x360_alloc();
            if target.is_null() || add(client, target) != 0 {
                return Err(io::Error::other("vigem_target_add failed"));
            }
            Ok(Box::new(VigemPad {
                lib,
                client,
                target,
            }))
        }
    }

    impl VirtualPad for VigemPad {
        fn send(&mut self, state: &ParsedState) -> io::Result<()> {
            unsafe {
                let update: Symbol<VigemTargetX360Update> = self
                    .lib
                    .get(b"vigem_target_x360_update")
                    .map_err(io::Error::other)?;
                update(self.client, self.target, to_xusb(state));
            }
            Ok(())
        }
    }

    impl Drop for VigemPad {
        fn drop(&mut self) {
            unsafe {
                if let Ok(remove) = self.lib.get::<VigemTargetRemove>(b"vigem_target_remove") {
                    remove(self.client, self.target);
                }
                if let Ok(free) = self.lib.get::<VigemTargetFree>(b"vigem_target_free") {
                    free(self.target);
                }
                if let Ok(disconnect) = self.lib.get::<VigemDisconnect>(b"vigem_disconnect") {
                    disconnect(self.client);
                }
                if let Ok(free) = self.lib.get::<VigemFree>(b"vigem_free") {
                    free(self.client);
                }
            }
        }
    }

    pub fn probe() -> &'static str {
        match unsafe { Library::new("vigemclient.dll") } {
            Ok(_) => "supported",
            Err(_) => "driver-missing",
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod platform {
    use super::VirtualPad;
    use std::io;

    pub fn create() -> io::Result<Box<dyn VirtualPad>> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "virtual controller output is not supported on this platform",
        ))
    }

    pub fn probe() -> &'static str {
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> ParsedState {
        ParsedState::default()
    }

    #[test]
    fn maps_face_buttons_to_xusb_bits() {
        let mut s = state();
        controls::set(&mut s.pressed, Ds4Control::Cross, true);
        controls::set(&mut s.pressed, Ds4Control::Triangle, true);
        controls::set(&mut s.pressed, Ds4Control::Ps, true);
        let r = to_xusb(&s);
        assert_eq!(r.buttons & (xusb::A | xusb::Y | xusb::GUIDE), xusb::A | xusb::Y | xusb::GUIDE);
        assert_eq!(r.buttons & xusb::B, 0);
    }

    #[test]
    fn flips_stick_y_for_xinput() {
        let mut s = state();
        s.axes[0] = 255; // lx right
        s.axes[1] = 0; // ly up (HID raw)
        s.axes[4] = 200;
        let r = to_xusb(&s);
        assert!(r.left_x > 0);
        assert!(r.left_y > 0, "up should be positive in XInput");
        assert_eq!(r.left_trigger, 200);
    }

    #[test]
    fn dpad_maps_to_dpad_bits() {
        let mut s = state();
        controls::set(&mut s.pressed, Ds4Control::DpadLeft, true);
        let r = to_xusb(&s);
        assert_eq!(r.buttons & xusb::DPAD_LEFT, xusb::DPAD_LEFT);
    }
}
