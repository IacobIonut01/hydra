//! Native DualShock 4 / DualSense (Edge) support — HID enumeration, input
//! parsing, profile remap, and output reports (lightbar/rumble/LEDs).
//! See docs/ds4-hid-notes.md for the ported protocol tables.

mod controls;
mod crc32;
mod ds4;
mod dual_sense;
mod hide;
mod ids;
mod mapping;
mod session;
mod state;
mod types;
mod virtualpad;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use hidapi::{BusType, DeviceInfo, HidApi};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use controls::{get, ALL_CONTROLS};
use ids::{Model, Transport, SONY_VID};
use session::{spawn_session, SessionCmd, SessionHandle};
use state::{ParsedState, ProfileSpec, TriggerEffect};
use types::{
    ControllerDeviceInfo, ControllerEvent, ControllerState, StickState, TouchPoint, Vector3,
};

pub type EventTsfn = ThreadsafeFunction<ControllerEvent, (), ControllerEvent, Status, false>;
pub type Emitter = Arc<Mutex<Option<EventTsfn>>>;

fn emit_event(emitter: &Emitter, ev: ControllerEvent) {
    if let Some(tsfn) = emitter.lock().unwrap().as_ref() {
        let _ = tsfn.call(ev, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

struct Runtime {
    hid: Mutex<Option<HidApi>>,
    hid_error: Mutex<Option<String>>,
    sessions: RwLock<HashMap<String, Arc<SessionHandle>>>,
    emitter: Emitter,
    monitor_started: AtomicBool,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

fn runtime() -> &'static Runtime {
    RUNTIME.get_or_init(|| Runtime {
        hid: Mutex::new(None),
        hid_error: Mutex::new(None),
        sessions: RwLock::new(HashMap::new()),
        emitter: Arc::new(Mutex::new(None)),
        monitor_started: AtomicBool::new(false),
    })
}

fn hid_api() -> napi::Result<std::sync::MutexGuard<'static, Option<HidApi>>> {
    let mut guard = runtime().hid.lock().unwrap();
    if guard.is_none() {
        match HidApi::new() {
            Ok(api) => {
                *guard = Some(api);
                *runtime().hid_error.lock().unwrap() = None;
            }
            Err(e) => {
                *runtime().hid_error.lock().unwrap() = Some(e.to_string());
                return Err(Error::from_reason(format!("hidapi init failed: {e}")));
            }
        }
    }
    Ok(guard)
}

fn touch_max(model: Model) -> (f64, f64) {
    if model.is_ds5() {
        (1920.0, 1080.0)
    } else {
        (1920.0, 943.0)
    }
}

fn to_controller_state(s: &ParsedState, model: Model) -> ControllerState {
    let pressed = ALL_CONTROLS
        .iter()
        .filter(|&&c| get(s.pressed, c))
        .map(|c| c.name().to_string())
        .collect();

    let norm = |v: u8| ((v as f64 - 128.0) / 128.0).clamp(-1.0, 1.0);
    let (tx_max, ty_max) = touch_max(model);
    let touch = s
        .touch
        .iter()
        .filter(|t| t.active)
        .map(|t| TouchPoint {
            id: t.id as u32,
            active: t.active,
            x: (t.x as f64 / tx_max).clamp(0.0, 1.0),
            y: (t.y as f64 / ty_max).clamp(0.0, 1.0),
        })
        .collect();

    ControllerState {
        pressed,
        left_stick: StickState {
            x: norm(s.axes[0]),
            y: -norm(s.axes[1]),
        },
        right_stick: StickState {
            x: norm(s.axes[2]),
            y: -norm(s.axes[3]),
        },
        l2: s.axes[4] as f64 / 255.0,
        r2: s.axes[5] as f64 / 255.0,
        gyro: Vector3 {
            x: s.gyro[0] as f64,
            y: s.gyro[1] as f64,
            z: s.gyro[2] as f64,
        },
        accel: Vector3 {
            x: s.accel[0] as f64,
            y: s.accel[1] as f64,
            z: s.accel[2] as f64,
        },
        touch,
        battery: s.battery as f64,
        charging: s.charging,
        frame: s.frame as u32,
    }
}

fn detect_transport(info: &DeviceInfo) -> Transport {
    if matches!(info.bus_type(), BusType::Bluetooth) {
        return Transport::Bluetooth;
    }
    let path = info.path().to_string_lossy().to_lowercase();
    if path.contains("bluetooth") || path.contains("bthenum") || path.contains("_bt") {
        return Transport::Bluetooth;
    }
    Transport::Usb
}

/// Pick the gamepad HID interface among several same-PID interfaces
/// (DualSense USB exposes audio + gamepad nodes).
fn pick_interface<'a>(candidates: &[&'a DeviceInfo]) -> Option<&'a DeviceInfo> {
    let mut sorted: Vec<&DeviceInfo> = candidates.to_vec();
    sorted.sort_by_key(|d| d.interface_number());
    sorted
        .iter()
        .copied()
        .find(|d| d.usage_page() == 0x01 && d.usage() == 0x05)
        .or_else(|| sorted.first().copied())
}

fn enumerate() -> Vec<(
    String,
    Model,
    Transport,
    ControllerDeviceInfo,
    DeviceInfoOwned,
)> {
    let mut result = Vec::new();
    let Ok(guard) = hid_api() else {
        return result;
    };
    let Some(api) = guard.as_ref() else {
        return result;
    };

    // Group candidates by (vid, pid, serial-or-path) so multi-interface
    // devices (DualSense USB) collapse to one entry.
    let mut groups: HashMap<(u16, u16, String), Vec<&DeviceInfo>> = HashMap::new();
    for dev in api.device_list() {
        if dev.vendor_id() != SONY_VID || Model::from_pid(dev.product_id()).is_none() {
            continue;
        }
        let key = (
            dev.vendor_id(),
            dev.product_id(),
            dev.serial_number()
                .map(str::to_string)
                .unwrap_or_else(|| dev.path().to_string_lossy().to_string()),
        );
        groups.entry(key).or_default().push(dev);
    }

    for ((vid, pid, serial), mut candidates) in groups {
        let Some(dev) = pick_interface(&candidates) else {
            continue;
        };
        let model = Model::from_pid(pid).unwrap();
        let transport = detect_transport(dev);
        candidates.clear();
        let path = dev.path().to_string_lossy().to_string();
        let id = format!("{vid:04x}:{pid:04x}:{serial}");
        let name = dev
            .product_string()
            .map(str::to_string)
            .unwrap_or_else(|| model.kind().to_string());
        result.push((
            id.clone(),
            model,
            transport,
            ControllerDeviceInfo {
                id,
                path,
                vid: vid as u32,
                pid: pid as u32,
                model: model.kind().to_string(),
                name,
                connection: transport.as_str().to_string(),
                serial: if serial.is_empty() {
                    None
                } else {
                    Some(serial)
                },
                interface_number: dev.interface_number(),
                active: false,
                has_player_leds: model.has_player_leds(),
                has_mic_led: model.has_mic_led(),
                has_trigger_effects: model.has_trigger_effects(),
            },
            DeviceInfoOwned {
                path: dev.path().to_string_lossy().to_string(),
            },
        ));
    }

    result
}

struct DeviceInfoOwned {
    path: String,
}

fn devices_changed_event(rt: &Runtime) -> ControllerEvent {
    let sessions = rt.sessions.read().unwrap();
    let devices: Vec<ControllerDeviceInfo> = enumerate()
        .into_iter()
        .map(|(id, _, _, mut info, _)| {
            info.active = sessions.contains_key(&id);
            info
        })
        .collect();
    ControllerEvent {
        event_type: "devicesChanged".to_string(),
        device_id: None,
        devices: Some(devices),
        state: None,
        message: None,
    }
}

fn prune_dead_sessions(rt: &Runtime) {
    let mut sessions = rt.sessions.write().unwrap();
    let dead: Vec<String> = sessions
        .iter()
        .filter(|(_, s)| !s.is_alive())
        .map(|(id, _)| id.clone())
        .collect();
    for id in dead {
        sessions.remove(&id);
    }
}

fn start_monitor() {
    let rt = runtime();
    if rt.monitor_started.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut seen: Vec<String> = Vec::new();
        loop {
            std::thread::sleep(Duration::from_millis(1200));
            prune_dead_sessions(rt);

            let current: Vec<String> = enumerate().into_iter().map(|(id, ..)| id).collect();
            if current != seen {
                seen = current;
                let emitter = Arc::clone(&rt.emitter);
                emit_event(&emitter, devices_changed_event(rt));
            }
        }
    });
}

fn find_device(id: &str) -> Option<(Model, Transport, ControllerDeviceInfo, DeviceInfoOwned)> {
    enumerate()
        .into_iter()
        .find(|(dev_id, ..)| dev_id == id)
        .map(|(_, model, transport, info, owned)| (model, transport, info, owned))
}

#[napi]
pub fn controller_list() -> Vec<ControllerDeviceInfo> {
    let rt = runtime();
    prune_dead_sessions(rt);
    let sessions = rt.sessions.read().unwrap();
    enumerate()
        .into_iter()
        .map(|(id, _, _, mut info, _)| {
            info.active = sessions.contains_key(&id);
            info
        })
        .collect()
}

#[napi]
pub fn controller_start(id: String) -> napi::Result<bool> {
    let rt = runtime();
    prune_dead_sessions(rt);
    if rt.sessions.read().unwrap().contains_key(&id) {
        return Ok(true);
    }

    let Some((model, transport, info, owned)) = find_device(&id) else {
        return Ok(false);
    };

    let guard = hid_api()?;
    let api = guard
        .as_ref()
        .ok_or_else(|| Error::from_reason("hidapi not initialized"))?;
    let path = std::ffi::CString::new(owned.path.clone())
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let device = api
        .open_path(&path)
        .map_err(|e| Error::from_reason(format!("open {} failed: {e}", owned.path)))?;
    drop(guard);

    let handle = Arc::new(spawn_session(
        device,
        info,
        model,
        transport,
        Arc::new(RwLock::new(ProfileSpec::default())),
        Arc::clone(&rt.emitter),
    ));
    rt.sessions.write().unwrap().insert(id, handle);
    Ok(true)
}

#[napi]
pub fn controller_stop(id: String) -> bool {
    let rt = runtime();
    if let Some(handle) = rt.sessions.write().unwrap().remove(&id) {
        handle.shutdown();
        return true;
    }
    false
}

fn with_session<T>(id: &str, f: impl FnOnce(&SessionHandle) -> T) -> Option<T> {
    let rt = runtime();
    let sessions = rt.sessions.read().unwrap();
    sessions.get(id).map(|h| f(h.as_ref()))
}

#[napi]
pub fn controller_set_lightbar(
    id: String,
    r: u8,
    g: u8,
    b: u8,
    flash_on: u8,
    flash_off: u8,
) -> bool {
    with_session(&id, |s| {
        let _ = s.cmd.send(SessionCmd::SetLightbar {
            r,
            g,
            b,
            flash_on,
            flash_off,
        });
        *s.manual_rgb.write().unwrap() = Some(([r, g, b], flash_on, flash_off));
    })
    .is_some()
}

#[napi]
pub fn controller_set_rumble(id: String, light: u8, heavy: u8) -> bool {
    with_session(&id, |s| {
        let _ = s.cmd.send(SessionCmd::SetRumble { light, heavy });
    })
    .is_some()
}

#[napi]
pub fn controller_set_mic_led(id: String, mode: u8) -> bool {
    with_session(&id, |s| {
        let _ = s.cmd.send(SessionCmd::SetMicLed(mode));
    })
    .is_some()
}

#[napi]
pub fn controller_set_player_leds(id: String, mask: u8) -> bool {
    with_session(&id, |s| {
        let _ = s.cmd.send(SessionCmd::SetPlayerLeds(mask));
    })
    .is_some()
}

#[napi]
pub fn controller_set_trigger_effect(id: String, left: bool, mode: u8, params: Vec<u8>) -> bool {
    with_session(&id, |s| {
        let mut p = [0u8; 10];
        for (i, v) in params.iter().take(10).enumerate() {
            p[i] = *v;
        }
        let effect = if mode == 0 {
            None
        } else {
            Some(TriggerEffect { mode, params: p })
        };
        let _ = s.cmd.send(SessionCmd::SetTrigger { left, effect });
    })
    .is_some()
}

#[napi]
pub fn controller_identify(id: String) -> bool {
    with_session(&id, |s| {
        let _ = s.cmd.send(SessionCmd::Identify);
    })
    .is_some()
}

#[napi]
pub fn controller_set_profile(id: String, profile_json: String) -> bool {
    let Ok(profile) = serde_json::from_str::<ProfileSpec>(&profile_json) else {
        return false;
    };
    with_session(&id, |s| {
        *s.profile.write().unwrap() = profile;
        *s.manual_rgb.write().unwrap() = None;
    })
    .is_some()
}

#[napi]
pub fn controller_read_raw(id: String) -> Option<ControllerState> {
    with_session(&id, |s| {
        let raw = s.raw_latest.read().unwrap().clone();
        to_controller_state(&raw, s.model)
    })
}

/// Enable/disable a virtual X360 pad fed by this session's remapped state.
/// Emits a `virtualOutput` event ("enabled" | "disabled" | "failed: <err>").
#[napi]
pub fn controller_set_virtual_output(id: String, enabled: bool) -> bool {
    with_session(&id, |s| {
        let _ = s.cmd.send(SessionCmd::SetVirtualOutput(enabled));
    })
    .is_some()
}

/// Where games could see a remapped pad. "uinput-available" /
/// "uinput-blocked" on Linux, "vigem-available" / "vigem-unavailable" on
/// Windows (ViGEmBus runtime), "unavailable" elsewhere.
#[napi]
pub fn controller_virtual_output_support() -> String {
    match virtualpad::probe_support() {
        "supported" => {
            #[cfg(target_os = "linux")]
            return "uinput-available".to_string();
            #[cfg(target_os = "windows")]
            return "vigem-available".to_string();
            #[cfg(not(any(target_os = "linux", target_os = "windows")))]
            return "unavailable".to_string();
        }
        "driver-missing" => "vigem-unavailable".to_string(),
        _ => {
            #[cfg(target_os = "linux")]
            return "uinput-blocked".to_string();
            #[cfg(not(target_os = "linux"))]
            return "unavailable".to_string();
        }
    }
}

/// Hide/show the physical pad so only Hydra (and its virtual pad) see it.
/// Emits a `hidden` event ("enabled" | "disabled" | "failed: <err>").
#[napi]
pub fn controller_set_hidden(id: String, enabled: bool) -> bool {
    with_session(&id, |s| {
        let _ = s.cmd.send(SessionCmd::SetHidden(enabled));
    })
    .is_some()
}

/// How the physical pad can be hidden. "hidhide-available" /
/// "hidhide-unavailable" on Windows (HidHide driver), "evdev-grab" on Linux
/// (EVIOCGRAB; may still fail at runtime without uinput group access),
/// "unavailable" elsewhere.
#[napi]
pub fn controller_hiding_support() -> String {
    hide::probe_support().to_string()
}

/// Last hidapi init failure, if any — lets the service tell "no pads
/// present" apart from "HID backend broken" for diagnostics.
#[napi]
pub fn controller_backend_error() -> Option<String> {
    runtime().hid_error.lock().unwrap().clone()
}

#[napi]
pub fn controller_on_event(
    #[napi(ts_arg_type = "(event: ControllerEvent) => void")] callback: Function<
        '_,
        ControllerEvent,
        (),
    >,
) -> napi::Result<()> {
    let tsfn: EventTsfn = callback
        .build_threadsafe_function::<ControllerEvent>()
        .build()?;
    *runtime().emitter.lock().unwrap() = Some(tsfn);
    start_monitor();
    Ok(())
}
