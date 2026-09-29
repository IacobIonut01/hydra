//! DualSense / DualSense Edge report parsing/building. Offsets verified
//! against DS4Windows InputDevices/DualSenseDevice.cs; docs/ds4-hid-notes.md.

use super::controls::{dpad_bits, set, Ds4Control};
use super::crc32;
use super::ids::Transport;
use super::state::{OutputState, ParsedState, TouchRaw, TriggerEffect};

pub const USB_INPUT_ID: u8 = 0x01;
pub const BT_INPUT_ID: u8 = 0x31;
pub const USB_OUTPUT_ID: u8 = 0x02;
pub const BT_OUTPUT_ID: u8 = 0x31;
pub const BT_OUTPUT_DATA_ID: u8 = 0x02;
pub const USB_OUTPUT_LEN: usize = 48;
pub const BT_OUTPUT_LEN: usize = 78;

const DS5_BATTERY_MAX: f32 = 8.0;

/// Both input and output payloads shift +1 on BT vs USB.
fn offset(transport: Transport) -> usize {
    match transport {
        Transport::Usb => 0,
        Transport::Bluetooth => 1,
    }
}

fn touch_at(report: &[u8], base: usize) -> TouchRaw {
    let b = &report[base..base + 4];
    TouchRaw {
        id: b[0] & 0x7F,
        active: b[0] & 0x80 == 0,
        x: b[1] as u16 | (((b[2] & 0x0F) as u16) << 8),
        y: ((b[2] & 0xF0) as u16 >> 4) | ((b[3] as u16) << 4),
    }
}

/// [53]: bit5 = full -> 100, else nibble * 100 / 8. [54]: bit3 = charging.
fn ds5_battery(level_byte: u8, status_byte: u8) -> (u8, bool) {
    let charging = status_byte & 0x08 != 0;
    let level = if level_byte & 0x20 != 0 {
        100
    } else {
        ((level_byte & 0x0F) as f32 * 100.0 / DS5_BATTERY_MAX).clamp(0.0, 100.0) as u8
    };
    (level, charging)
}

/// Parse a DualSense input report into `state`. Returns false on id/len
/// mismatch.
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

    state.axes = [
        r[o + 1],
        r[o + 2],
        r[o + 3],
        r[o + 4],
        r[o + 5], // DS5 puts analog L2 right after the sticks
        r[o + 6],
    ];

    let mut pressed = dpad_bits(r[o + 8]);
    let face = r[o + 8];
    set(&mut pressed, Ds4Control::Square, face & 0x10 != 0);
    set(&mut pressed, Ds4Control::Cross, face & 0x20 != 0);
    set(&mut pressed, Ds4Control::Circle, face & 0x40 != 0);
    set(&mut pressed, Ds4Control::Triangle, face & 0x80 != 0);

    let shoulders = r[o + 9];
    set(&mut pressed, Ds4Control::L1, shoulders & 0x01 != 0);
    set(&mut pressed, Ds4Control::R1, shoulders & 0x02 != 0);
    set(&mut pressed, Ds4Control::L2, shoulders & 0x04 != 0);
    set(&mut pressed, Ds4Control::R2, shoulders & 0x08 != 0);
    set(&mut pressed, Ds4Control::Share, shoulders & 0x10 != 0);
    set(&mut pressed, Ds4Control::Options, shoulders & 0x20 != 0);
    set(&mut pressed, Ds4Control::L3, shoulders & 0x40 != 0);
    set(&mut pressed, Ds4Control::R3, shoulders & 0x80 != 0);

    let misc = r[o + 10];
    set(&mut pressed, Ds4Control::Ps, misc & 0x01 != 0);
    set(&mut pressed, Ds4Control::TouchClick, misc & 0x02 != 0);
    set(&mut pressed, Ds4Control::Mute, misc & 0x04 != 0);
    set(&mut pressed, Ds4Control::FnL, misc & 0x10 != 0);
    set(&mut pressed, Ds4Control::FnR, misc & 0x20 != 0);
    set(&mut pressed, Ds4Control::PaddleLeft, misc & 0x40 != 0);
    set(&mut pressed, Ds4Control::PaddleRight, misc & 0x80 != 0);
    state.frame = r[o + 7];

    let le_i16 = |i: usize| i16::from_le_bytes([r[o + i], r[o + i + 1]]);
    state.gyro = [le_i16(16), le_i16(18), le_i16(20)];
    state.accel = [le_i16(22), le_i16(24), le_i16(26)];

    let (battery, charging) = ds5_battery(r[o + 53], r[o + 54]);
    state.battery = battery;
    state.charging = charging;

    state.touch = [touch_at(r, o + 33), touch_at(r, o + 37)];
    state.pressed = pressed;
    true
}

/// Write an 11-byte trigger-effect block at `start`.
fn write_trigger_block(r: &mut [u8], start: usize, effect: Option<TriggerEffect>) {
    if let Some(e) = effect {
        r[start] = e.mode;
        for (i, &p) in e.params.iter().enumerate() {
            r[start + 1 + i] = p;
        }
    }
}

fn fill_report(r: &mut [u8], o: usize, out: &OutputState) {
    // valid-flag 0: rumble motors + trigger motors enabled
    r[1 + o] = 0x0F;
    // valid-flag 1: mic LED | lightbar strips | player LEDs | motor power
    r[2 + o] = 0x55;
    r[3 + o] = out.rumble_light;
    r[4 + o] = out.rumble_heavy;
    r[9 + o] = out.mic_led;

    write_trigger_block(r, 11 + o, out.trigger_right);
    write_trigger_block(r, 22 + o, out.trigger_left);

    // Player-LED section: brightness-enabled mode, no boot pulse/fade.
    r[39 + o] = 0x01;
    r[43 + o] = 0x00; // high brightness
    r[44 + o] = out.player_leds & 0x3F;

    r[45 + o] = out.rgb[0];
    r[46 + o] = out.rgb[1];
    r[47 + o] = out.rgb[2];
}

pub fn build_usb_output(out: &OutputState) -> [u8; USB_OUTPUT_LEN] {
    let mut r = [0u8; USB_OUTPUT_LEN];
    r[0] = USB_OUTPUT_ID;
    fill_report(&mut r, 0, out);
    r
}

pub fn build_bt_output(out: &OutputState) -> [u8; BT_OUTPUT_LEN] {
    let mut r = [0u8; BT_OUTPUT_LEN];
    r[0] = BT_OUTPUT_ID;
    r[1] = BT_OUTPUT_DATA_ID;
    fill_report(&mut r, 1, out);
    crc32::seal_bt_output(&mut r);
    r
}

pub fn build_output(out: &OutputState, transport: Transport) -> Vec<u8> {
    match transport {
        Transport::Usb => build_usb_output(out).to_vec(),
        Transport::Bluetooth => build_bt_output(out).to_vec(),
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
        r[3] = 64;
        r[4] = 192;
        r[5] = 0xFF; // L2 analog
        r[6] = 0x10; // R2 analog
        r[7] = 42;
        r[8] = 0x28; // dpad neutral + Cross
        r[9] = 0x21; // L1 + Options
        r[10] = 0x01 | 0x40; // PS + left paddle
        r[33] = 0x03; // touch1 active id 3
        r[34] = 0xFF;
        r[35] = 0x0F; // x = 0xFFF
        r[36] = 0x80; // y = 0x800
        r[37] = 0x80; // touch2 inactive
        r[53] = 0x05; // battery nibble 5
        r[54] = 0x08; // charging
        r
    }

    #[test]
    fn parses_usb_state() {
        let r = usb_report();
        let mut s = ParsedState::default();
        assert!(parse_input(&r, Transport::Usb, &mut s));
        assert_eq!(s.axes, [128, 128, 64, 192, 0xFF, 0x10]);
        assert!(get(s.pressed, Cross));
        assert!(get(s.pressed, L1));
        assert!(get(s.pressed, Options));
        assert!(get(s.pressed, Ps));
        assert!(get(s.pressed, PaddleLeft));
        assert!(!get(s.pressed, PaddleRight));
        assert!(!get(s.pressed, Mute));
        assert_eq!(s.battery, 62); // 5 * 100 / 8
        assert!(s.charging);
        assert_eq!(s.frame, 42);
        assert!(s.touch[0].active);
        assert_eq!(s.touch[0].id, 3);
        assert_eq!(s.touch[0].x, 0xFFF);
        assert_eq!(s.touch[0].y, 0x800);
    }

    #[test]
    fn battery_full_flag_wins() {
        assert_eq!(ds5_battery(0x20, 0x00), (100, false));
        assert_eq!(ds5_battery(0x05, 0x08), (62, true));
    }

    #[test]
    fn usb_output_layout() {
        let mut out = OutputState::default();
        out.rgb = [7, 8, 9];
        out.mic_led = 2;
        out.player_leds = 0x1F;
        out.trigger_right = Some(TriggerEffect {
            mode: 0x02,
            params: [10, 200, 0, 0, 0, 0, 0, 0, 30, 0],
        });
        let r = build_usb_output(&out);
        assert_eq!(r[0], USB_OUTPUT_ID);
        assert_eq!(r[1], 0x0F);
        assert_eq!(r[2], 0x55);
        assert_eq!(r[9], 2);
        assert_eq!(r[11], 0x02); // R2 mode
        assert_eq!(r[12], 10); // start
        assert_eq!(r[13], 200); // effectForce
        assert_eq!(r[20], 30); // actuationFreq
        assert_eq!(r[44], 0x1F); // player mask
        assert_eq!(&r[45..48], &[7, 8, 9]);
    }

    #[test]
    fn bt_output_shifted_and_sealed() {
        let mut out = OutputState::default();
        out.rgb = [7, 8, 9];
        let r = build_bt_output(&out);
        assert_eq!(r[0], BT_OUTPUT_ID);
        assert_eq!(r[1], BT_OUTPUT_DATA_ID);
        assert_eq!(r[2], 0x0F);
        assert_eq!(&r[46..49], &[7, 8, 9]);
        let expected = crc32::crc32_with_head(crc32::BT_OUTPUT_HEAD, &r[..74]);
        let stored = u32::from_le_bytes([r[74], r[75], r[76], r[77]]);
        assert_eq!(expected, stored);
    }

    #[test]
    fn parses_bt_payload_with_shift() {
        let mut r = [0u8; 78];
        r[0] = BT_INPUT_ID;
        r[2] = 128; // LX at o+1
        r[9] = 0x28; // face byte at o+8
        r[54] = 0x25; // battery level at o+53 -> full flag + nibble 5
        let mut s = ParsedState::default();
        assert!(parse_input(&r, Transport::Bluetooth, &mut s));
        assert_eq!(s.axes[0], 128);
        assert!(get(s.pressed, Cross));
        assert_eq!(s.battery, 100); // 0x20 full flag
        assert!(s.crc_failed);
    }
}
