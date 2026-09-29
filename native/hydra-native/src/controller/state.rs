//! Internal device state: what the parsers produce, what the output builders
//! consume, and the profile model the session applies per frame.

use std::collections::HashMap;

use serde::Deserialize;

#[derive(Clone, Copy, Debug, Default)]
pub struct TouchRaw {
    pub id: u8,
    pub active: bool,
    /// Raw surface coordinates (DS4 max 1920x943, DS5 1920x1080).
    pub x: u16,
    pub y: u16,
}

#[derive(Clone, Debug, Default)]
pub struct ParsedState {
    /// Ds4Control bitmask — digital inputs + derived direction bits.
    pub pressed: u64,
    /// lx, ly, rx, ry, l2, r2 — raw 0..255.
    pub axes: [u8; 6],
    pub gyro: [i16; 3],
    pub accel: [i16; 3],
    pub touch: [TouchRaw; 2],
    /// 0..100
    pub battery: u8,
    pub charging: bool,
    pub frame: u8,
    /// Inbound CRC failed — tolerated but surfaced (clone pads send garbage).
    pub crc_failed: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct TriggerEffect {
    pub mode: u8,
    /// Up to 10 payload bytes after the mode byte (11-byte effect block).
    pub params: [u8; 10],
}

#[derive(Clone, Debug)]
pub struct OutputState {
    pub rumble_light: u8,
    pub rumble_heavy: u8,
    pub rgb: [u8; 3],
    /// Hardware blink duty cycle; 0 = steady.
    pub flash_on: u8,
    pub flash_off: u8,
    /// DS5: 0 off, 1 on, 2 pulse.
    pub mic_led: u8,
    /// DS5: 5-LED bitmask.
    pub player_leds: u8,
    pub trigger_right: Option<TriggerEffect>,
    pub trigger_left: Option<TriggerEffect>,
}

impl Default for OutputState {
    fn default() -> Self {
        Self {
            rumble_light: 0,
            rumble_heavy: 0,
            rgb: [0, 0, 255],
            flash_on: 0,
            flash_off: 0,
            mic_led: 0,
            player_leds: 0,
            trigger_right: None,
            trigger_left: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LightbarMode {
    #[default]
    Static,
    Rainbow,
    Battery,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LightbarSpec {
    pub mode: LightbarMode,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    /// Blink when battery at/below this percent; 0 disables.
    pub flash_at: u8,
}

impl Default for LightbarSpec {
    fn default() -> Self {
        Self {
            mode: LightbarMode::Static,
            r: 0,
            g: 0,
            b: 255,
            flash_at: 0,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileSpec {
    pub name: String,
    pub lightbar: LightbarSpec,
    pub player_led_count: u8,
    /// DS5: 0 off, 1 on, 2 pulse.
    pub mic_led: u8,
    /// Radial deadzone 0..0.5 applied to both sticks.
    pub stick_deadzone: f32,
    pub swap_sticks: bool,
    /// controlName -> outAction: control name or "unbound". Missing = identity.
    pub remap: HashMap<String, String>,
}

impl Default for ProfileSpec {
    fn default() -> Self {
        Self {
            name: "default".to_string(),
            lightbar: LightbarSpec::default(),
            player_led_count: 0,
            mic_led: 0,
            stick_deadzone: 0.0,
            swap_sticks: false,
            remap: HashMap::new(),
        }
    }
}
