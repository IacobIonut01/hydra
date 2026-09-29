//! #[napi(object)] payloads crossing the JS boundary.
//! Field names stay snake_case to match the existing native surface
//! (NativeProcessPayload::parent_pid etc.).

use napi_derive::napi;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ControllerDeviceInfo {
    /// Stable-ish id: "{vid}:{pid}:{serial-or-path-hash}".
    pub id: String,
    pub path: String,
    pub vid: u32,
    pub pid: u32,
    /// "ds4" | "dualsense" | "dualsense-edge"
    pub model: String,
    pub name: String,
    /// "usb" | "bt"
    pub connection: String,
    pub serial: Option<String>,
    pub interface_number: i32,
    /// An IO session is currently running for this device.
    pub active: bool,
    pub has_player_leds: bool,
    pub has_mic_led: bool,
    pub has_trigger_effects: bool,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct StickState {
    /// Normalized -1.0..1.0, y is up-positive.
    pub x: f64,
    pub y: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct Vector3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct TouchPoint {
    pub id: u32,
    pub active: bool,
    /// Normalized 0..1 within the pad surface.
    pub x: f64,
    pub y: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ControllerState {
    /// Canonical control names currently held (see controls.rs Ds4Control::name).
    /// Includes derived bits: stick directions, trigger full-pulls.
    pub pressed: Vec<String>,
    pub left_stick: StickState,
    pub right_stick: StickState,
    /// 0..1
    pub l2: f64,
    /// 0..1
    pub r2: f64,
    /// Raw i16 sensor counts.
    pub gyro: Vector3,
    pub accel: Vector3,
    pub touch: Vec<TouchPoint>,
    /// 0..100
    pub battery: f64,
    pub charging: bool,
    pub frame: u32,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ControllerEvent {
    /// "devicesChanged" | "state" | "error" | "sessionClosed"
    pub event_type: String,
    /// Present on state/sessionClosed/error events.
    pub device_id: Option<String>,
    /// Present on devicesChanged.
    pub devices: Option<Vec<ControllerDeviceInfo>>,
    /// Present on state events (mapped state; raw state via controller_read_raw).
    pub state: Option<ControllerState>,
    /// Present on error events.
    pub message: Option<String>,
}
