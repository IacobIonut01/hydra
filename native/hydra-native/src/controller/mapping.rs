//! Remap engine: derives digital bits from axes, applies the profile's
//! remap/deadzone/swap, and computes the per-frame lightbar color.

use super::controls::{get, set, Ds4Control, ALL_CONTROLS};
use super::state::{LightbarMode, ParsedState, ProfileSpec};

const STICK_DIR_THRESHOLD: i32 = 50; // ~0.4 of the 0..255 range past center
const TRIGGER_FULL_PULL: u8 = 235;

/// Add derived bits to `pressed`: stick directions + trigger full pulls.
/// Runs on the raw state before remap so direction bits are mappable inputs.
pub fn derive_digital_bits(state: &mut ParsedState) {
    let [lx, ly, rx, ry, l2, r2] = state.axes;
    let mut p = state.pressed;

    let lx_d = lx as i32 - 128;
    let ly_d = ly as i32 - 128;
    let rx_d = rx as i32 - 128;
    let ry_d = ry as i32 - 128;

    set(&mut p, Ds4Control::LxRight, lx_d > STICK_DIR_THRESHOLD);
    set(&mut p, Ds4Control::LxLeft, lx_d < -STICK_DIR_THRESHOLD);
    set(&mut p, Ds4Control::LxDown, ly_d > STICK_DIR_THRESHOLD);
    set(&mut p, Ds4Control::LxUp, ly_d < -STICK_DIR_THRESHOLD);
    set(&mut p, Ds4Control::RxRight, rx_d > STICK_DIR_THRESHOLD);
    set(&mut p, Ds4Control::RxLeft, rx_d < -STICK_DIR_THRESHOLD);
    set(&mut p, Ds4Control::RxDown, ry_d > STICK_DIR_THRESHOLD);
    set(&mut p, Ds4Control::RxUp, ry_d < -STICK_DIR_THRESHOLD);

    set(&mut p, Ds4Control::L2Full, l2 >= TRIGGER_FULL_PULL);
    set(&mut p, Ds4Control::R2Full, r2 >= TRIGGER_FULL_PULL);

    state.pressed = p;
}

/// Radial deadzone rescale on a -1..1 axis pair.
fn apply_deadzone(x: f32, y: f32, dz: f32) -> (f32, f32) {
    let mag = (x * x + y * y).sqrt();
    if mag <= dz || dz <= 0.0 {
        return (0.0, 0.0);
    }
    let scaled = ((mag - dz) / (1.0 - dz)).min(1.0) / mag;
    (x * scaled, y * scaled)
}

fn axis_to_norm(v: u8) -> f32 {
    (v as f32 - 128.0) / 128.0
}

fn norm_to_axis(v: f32) -> u8 {
    (v * 128.0 + 128.0).round().clamp(0.0, 255.0) as u8
}

/// Apply profile remap to a parsed (post-derive) state.
/// Unmapped controls pass through; `unbound` drops the input.
pub fn apply_profile(raw: &ParsedState, profile: &ProfileSpec) -> ParsedState {
    let mut mapped = raw.clone();

    if !profile.remap.is_empty() {
        let mut pressed = 0u64;
        for control in ALL_CONTROLS {
            if !get(raw.pressed, control) {
                continue;
            }
            let target = profile
                .remap
                .get(control.name())
                .map(String::as_str)
                .unwrap_or(control.name());
            if target == "unbound" {
                continue;
            }
            if let Some(target_control) = Ds4Control::from_name(target) {
                set(&mut pressed, target_control, true);
            }
        }
        mapped.pressed = pressed;
    }

    if profile.swap_sticks {
        mapped.axes.swap(0, 2);
        mapped.axes.swap(1, 3);
    }

    let dz = profile.stick_deadzone.clamp(0.0, 0.5);
    if dz > 0.0 {
        let (lx, ly) = apply_deadzone(
            axis_to_norm(mapped.axes[0]),
            axis_to_norm(mapped.axes[1]),
            dz,
        );
        let (rx, ry) = apply_deadzone(
            axis_to_norm(mapped.axes[2]),
            axis_to_norm(mapped.axes[3]),
            dz,
        );
        mapped.axes[0] = norm_to_axis(lx);
        mapped.axes[1] = norm_to_axis(ly);
        mapped.axes[2] = norm_to_axis(rx);
        mapped.axes[3] = norm_to_axis(ry);
    }

    mapped
}

fn hsv_to_rgb(h: f32, s: f32, v: f32) -> [u8; 3] {
    let i = (h * 6.0).floor() as i32;
    let f = h * 6.0 - i as f32;
    let p = v * (1.0 - s);
    let q = v * (1.0 - f * s);
    let t = v * (1.0 - (1.0 - f) * s);
    let (r, g, b) = match i.rem_euclid(6) {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    };
    [
        (r * 255.0).round() as u8,
        (g * 255.0).round() as u8,
        (b * 255.0).round() as u8,
    ]
}

/// Current lightbar color + flash duty cycle for a frame.
/// `tick` is a millisecond counter driving rainbow hue and flash-at blink.
pub fn lightbar_for(
    profile: &ProfileSpec,
    battery: u8,
    charging: bool,
    tick: u64,
) -> ([u8; 3], u8, u8) {
    let spec = &profile.lightbar;
    let rgb = match spec.mode {
        LightbarMode::Static => [spec.r, spec.g, spec.b],
        LightbarMode::Rainbow => {
            let hue = ((tick / 20) % 360) as f32 / 360.0;
            hsv_to_rgb(hue, 1.0, 1.0)
        }
        LightbarMode::Battery => {
            let t = (battery as f32 / 100.0).clamp(0.0, 1.0);
            let (r, g) = if t < 0.5 {
                (1.0, t * 2.0)
            } else {
                ((1.0 - t) * 2.0, 1.0)
            };
            [(r * 255.0).round() as u8, (g * 255.0).round() as u8, 0]
        }
    };

    let low = spec.flash_at > 0 && battery <= spec.flash_at && !charging;
    let (flash_on, flash_off) = if low { (40, 40) } else { (0, 0) };
    (rgb, flash_on, flash_off)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::controller::controls::get;
    use std::collections::HashMap;

    fn state_with(controls: &[Ds4Control]) -> ParsedState {
        let mut s = ParsedState::default();
        for &c in controls {
            set(&mut s.pressed, c, true);
        }
        s
    }

    #[test]
    fn derive_sets_direction_bits() {
        let mut s = ParsedState::default();
        s.axes = [255, 128, 0, 128, 0, 255];
        derive_digital_bits(&mut s);
        assert!(get(s.pressed, Ds4Control::LxRight));
        assert!(get(s.pressed, Ds4Control::RxLeft));
        assert!(get(s.pressed, Ds4Control::R2Full));
        assert!(!get(s.pressed, Ds4Control::L2Full));
    }

    #[test]
    fn remap_moves_button_and_drops_unbound() {
        let mut profile = ProfileSpec::default();
        profile.remap = HashMap::from([
            ("cross".to_string(), "triangle".to_string()),
            ("share".to_string(), "unbound".to_string()),
        ]);
        let raw = state_with(&[Ds4Control::Cross, Ds4Control::Share, Ds4Control::L1]);
        let mapped = apply_profile(&raw, &profile);
        assert!(get(mapped.pressed, Ds4Control::Triangle));
        assert!(!get(mapped.pressed, Ds4Control::Cross));
        assert!(!get(mapped.pressed, Ds4Control::Share));
        assert!(get(mapped.pressed, Ds4Control::L1)); // unmapped passes through
    }

    #[test]
    fn deadzone_zeroes_center_and_rescales() {
        let mut profile = ProfileSpec::default();
        profile.stick_deadzone = 0.2;
        let mut raw = ParsedState::default();
        raw.axes = [135, 128, 255, 128, 0, 0];
        let mapped = apply_profile(&raw, &profile);
        assert_eq!(mapped.axes[0], 128); // inside dz -> centered
        assert_eq!(mapped.axes[2], 255); // outside dz -> still max
    }

    #[test]
    fn swap_sticks_exchanges_axes() {
        let mut profile = ProfileSpec::default();
        profile.swap_sticks = true;
        let mut raw = ParsedState::default();
        raw.axes = [10, 20, 30, 40, 0, 0];
        let mapped = apply_profile(&raw, &profile);
        assert_eq!(&mapped.axes[..4], &[30, 40, 10, 20]);
    }

    #[test]
    fn rainbow_cycles_and_battery_lerps() {
        let mut profile = ProfileSpec::default();
        profile.lightbar.mode = LightbarMode::Rainbow;
        let (a, _, _) = lightbar_for(&profile, 50, false, 0);
        let (b, _, _) = lightbar_for(&profile, 50, false, 2400); // ~1/3 hue cycle
        assert_ne!(a, b);

        profile.lightbar.mode = LightbarMode::Battery;
        let (low, _, _) = lightbar_for(&profile, 0, false, 0);
        let (full, _, _) = lightbar_for(&profile, 100, false, 0);
        assert!(low[0] > 200 && low[1] < 10); // red
        assert!(full[1] > 200 && full[0] < 10); // green
    }

    #[test]
    fn flash_at_blinks_only_below_threshold() {
        let mut profile = ProfileSpec::default();
        profile.lightbar.flash_at = 25;
        let (_, on, off) = lightbar_for(&profile, 20, false, 0);
        assert!(on > 0 && off > 0);
        let (_, on, off) = lightbar_for(&profile, 20, true, 0);
        assert_eq!((on, off), (0, 0)); // charging suppresses
        let (_, on, off) = lightbar_for(&profile, 80, false, 0);
        assert_eq!((on, off), (0, 0));
    }
}
