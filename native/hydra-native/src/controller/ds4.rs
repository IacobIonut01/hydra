//! DualShock 4 report parsing/building. Offsets verified against DS4Windows
//! DS4Device.cs; see docs/ds4-hid-notes.md.

use super::controls::{dpad_bits, set, Ds4Control};
use super::crc32;
use super::ids::Transport;
use super::state::{OutputState, ParsedState, TouchRaw};

pub const USB_INPUT_ID: u8 = 0x01;
pub const BT_INPUT_ID: u8 = 0x11;
pub const USB_OUTPUT_ID: u8 = 0x05;
pub const BT_OUTPUT_ID_78: u8 = 0x11;
pub const BT_OUTPUT_ID_334: u8 = 0x15;
pub const USB_OUTPUT_LEN: usize = 32;
pub const BT_OUTPUT_LEN_78: usize = 78;
pub const BT_OUTPUT_LEN_334: usize = 334;

const DS4_BATTERY_MAX: f32 = 8.0;
const DS4_BATTERY_MAX_CHARGING: f32 = 11.0;

/// BT 0x11 reports carry a 2-byte header before the USB-shaped payload —
/// DS4Windows copies btInputReport[2..] into its parse buffer, which is the
/// same transform as this offset.
fn offset(transport: Transport) -> usize {
    match transport {
        Transport::Usb => 0,
        Transport::Bluetooth => 2,
    }
}

/// 4-byte touch packet: b0 = id(0..6) + !active(7), b1 = x lo,
/// b2 = x hi 4 | y lo 4, b3 = y hi.
fn touch_at(report: &[u8], base: usize) -> TouchRaw {
    let b = &report[base..base + 4];
    TouchRaw {
        id: b[0] & 0x7F,
        active: b[0] & 0x80 == 0,
        x: b[1] as u16 | (((b[2] & 0x0F) as u16) << 8),
        y: ((b[2] & 0xF0) as u16 >> 4) | ((b[3] as u16) << 4),
    }
}

/// nibble * 100 / max; max is 11 while charging (cable), 8 on battery.
fn ds4_battery(raw: u8) -> (u8, bool) {
    let charging = raw & 0x10 != 0;
    let max = if charging {
        DS4_BATTERY_MAX_CHARGING
    } else {
        DS4_BATTERY_MAX
    };
    let level = ((raw & 0x0F) as f32 * 100.0 / max).clamp(0.0, 100.0);
    (level as u8, charging)
}

/// Parse a DS4 input report into `state`. Returns false if the report id or
/// length doesn't match the transport.
pub fn parse_input(report: &[u8], transport: Transport, state: &mut ParsedState) -> bool {
    match transport {
        Transport::Usb => {
            if report.len() < 64 || report[0] != USB_INPUT_ID {
                return false;
            }
        }
        Transport::Bluetooth => {
            if report.len() < 78 || report[0] != BT_INPUT_ID {
                return false;
            }
            state.crc_failed = !crc32::bt_input_crc_valid(report);
        }
    }

    let o = offset(transport);
    let r = report;

    state.axes = [r[o + 1], r[o + 2], r[o + 3], r[o + 4], r[o + 8], r[o + 9]];

    let mut pressed = dpad_bits(r[o + 5]);
    let face = r[o + 5];
    set(&mut pressed, Ds4Control::Square, face & 0x10 != 0);
    set(&mut pressed, Ds4Control::Cross, face & 0x20 != 0);
    set(&mut pressed, Ds4Control::Circle, face & 0x40 != 0);
    set(&mut pressed, Ds4Control::Triangle, face & 0x80 != 0);

    let shoulders = r[o + 6];
    set(&mut pressed, Ds4Control::L1, shoulders & 0x01 != 0);
    set(&mut pressed, Ds4Control::R1, shoulders & 0x02 != 0);
    set(&mut pressed, Ds4Control::L2, shoulders & 0x04 != 0);
    set(&mut pressed, Ds4Control::R2, shoulders & 0x08 != 0);
    set(&mut pressed, Ds4Control::Share, shoulders & 0x10 != 0);
    set(&mut pressed, Ds4Control::Options, shoulders & 0x20 != 0);
    set(&mut pressed, Ds4Control::L3, shoulders & 0x40 != 0);
    set(&mut pressed, Ds4Control::R3, shoulders & 0x80 != 0);

    let misc = r[o + 7];
    set(&mut pressed, Ds4Control::Ps, misc & 0x01 != 0);
    set(&mut pressed, Ds4Control::TouchClick, misc & 0x02 != 0);
    state.frame = misc >> 2;

    let le_i16 = |i: usize| i16::from_le_bytes([r[o + i], r[o + i + 1]]);
    state.gyro = [le_i16(13), le_i16(15), le_i16(17)];
    state.accel = [le_i16(19), le_i16(21), le_i16(23)];

    let (battery, charging) = ds4_battery(r[o + 30]);
    state.battery = battery;
    state.charging = charging;

    state.touch = [touch_at(r, o + 35), touch_at(r, o + 39)];
    state.pressed = pressed;
    true
}

pub fn build_usb_output(out: &OutputState) -> [u8; USB_OUTPUT_LEN] {
    let mut r = [0u8; USB_OUTPUT_LEN];
    r[0] = USB_OUTPUT_ID;
    r[1] = 0x07; // rumble + lightbar + flash features
    r[2] = 0x04;
    r[4] = out.rumble_light;
    r[5] = out.rumble_heavy;
    r[6] = out.rgb[0];
    r[7] = out.rgb[1];
    r[8] = out.rgb[2];
    r[9] = out.flash_on;
    r[10] = out.flash_off;
    r
}

/// BT output — both the 78-byte 0x11 and 334-byte 0x15 forms exist in the
/// wild; layout is identical, CRC sits at len-4 over head 0xA2 + [0..len-5].
pub fn build_bt_output(out: &OutputState, poll_rate: u8, long_form: bool) -> Vec<u8> {
    let len = if long_form {
        BT_OUTPUT_LEN_334
    } else {
        BT_OUTPUT_LEN_78
    };
    let mut r = vec![0u8; len];
    r[0] = if long_form {
        BT_OUTPUT_ID_334
    } else {
        BT_OUTPUT_ID_78
    };
    r[1] = 0xC0 | (poll_rate & 0x0F);
    r[3] = 0x07;
    r[4] = 0x04;
    r[6] = out.rumble_light;
    r[7] = out.rumble_heavy;
    r[8] = out.rgb[0];
    r[9] = out.rgb[1];
    r[10] = out.rgb[2];
    r[11] = out.flash_on;
    r[12] = out.flash_off;

    let crc = crc32::crc32_with_head(crc32::BT_OUTPUT_HEAD, &r[..len - 4]);
    r[len - 4..].copy_from_slice(&crc.to_le_bytes());
    r
}

pub fn build_output(out: &OutputState, transport: Transport) -> Vec<u8> {
    match transport {
        Transport::Usb => build_usb_output(out).to_vec(),
        Transport::Bluetooth => build_bt_output(out, 0, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::controller::controls::{get, Ds4Control::*};

    fn usb_report() -> [u8; 64] {
        let mut r = [0u8; 64];
        r[0] = USB_INPUT_ID;
        r[1] = 128;
        r[2] = 128;
        r[3] = 20;
        r[4] = 200;
        r[5] = 0x28; // dpad neutral + Cross
        r[6] = 0x25; // L1 + L2 + Options
        r[8] = 0xFF;
        r[30] = 0x19; // charging + nibble 9
        r[35] = 0x00; // touch1 active, id 0
        r[36] = 0x00;
        r[37] = 0x01; // x = 0x100
        r[38] = 0x40; // y = 0x400
        r[39] = 0x80; // touch2 inactive
        r
    }

    #[test]
    fn parses_usb_state() {
        let r = usb_report();
        let mut s = ParsedState::default();
        assert!(parse_input(&r, Transport::Usb, &mut s));
        assert_eq!(s.axes, [128, 128, 20, 200, 0xFF, 0]);
        assert!(get(s.pressed, Cross));
        assert!(get(s.pressed, L1));
        assert!(get(s.pressed, Options));
        assert!(!get(s.pressed, Triangle));
        assert!(!get(s.pressed, DpadUp));
        assert_eq!(s.battery, 81); // nibble 9 * 100 / 11 (charging divisor)
        assert!(s.charging);
        assert!(s.touch[0].active);
        assert_eq!(s.touch[0].x, 0x100);
        assert_eq!(s.touch[0].y, 0x400);
        assert!(!s.touch[1].active);
    }

    #[test]
    fn battery_divisor_switches_on_charging() {
        // nibble 8: on battery -> 100%, while charging -> 72%
        assert_eq!(ds4_battery(0x08).0, 100);
        assert_eq!(ds4_battery(0x18).0, 72);
    }

    #[test]
    fn dpad_hat_directions() {
        assert_eq!(dpad_bits(8), 0);
        assert_eq!(dpad_bits(0), Ds4Control::DpadUp.bit());
        assert_eq!(
            dpad_bits(1),
            Ds4Control::DpadUp.bit() | Ds4Control::DpadRight.bit()
        );
    }

    #[test]
    fn usb_output_layout() {
        let mut out = OutputState::default();
        out.rgb = [1, 2, 3];
        out.rumble_light = 9;
        out.rumble_heavy = 10;
        let r = build_usb_output(&out);
        assert_eq!(r[0], USB_OUTPUT_ID);
        assert_eq!(r[1], 0x07);
        assert_eq!(r[2], 0x04);
        assert_eq!(&r[6..9], &[1, 2, 3]);
        assert_eq!(r[4], 9);
        assert_eq!(r[5], 10);
    }

    #[test]
    fn bt_output_has_valid_crc_both_lengths() {
        let out = OutputState::default();
        for long_form in [false, true] {
            let r = build_bt_output(&out, 4, long_form);
            let len = r.len();
            assert_eq!(r[0], if long_form { 0x15 } else { 0x11 });
            assert_eq!(r[1], 0xC4);
            let expected =
                crc32::crc32_with_head(crc32::BT_OUTPUT_HEAD, &r[..len - 4]);
            let stored = u32::from_le_bytes([
                r[len - 4],
                r[len - 3],
                r[len - 2],
                r[len - 1],
            ]);
            assert_eq!(expected, stored);
        }
    }

    #[test]
    fn rejects_wrong_report_id() {
        let mut r = usb_report();
        r[0] = 0x31;
        let mut s = ParsedState::default();
        assert!(!parse_input(&r, Transport::Usb, &mut s));
    }

    #[test]
    fn parses_bt_payload_with_shift() {
        let mut r = [0u8; 78];
        r[0] = BT_INPUT_ID;
        r[3] = 128; // LX at o+1
        r[7] = 0x28; // face byte at o+5
        let mut s = ParsedState::default();
        assert!(parse_input(&r, Transport::Bluetooth, &mut s));
        assert_eq!(s.axes[0], 128);
        assert!(get(s.pressed, Cross));
        assert!(s.crc_failed); // no CRC written — tolerated
    }
}
