//! Per-device IO thread: owns the HidDevice, parses input frames, applies the
//! profile, emits mapped state, and is the single writer of output reports.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use hidapi::HidDevice;

use super::hide;
use super::ids::{Model, Transport};
use super::mapping::{apply_profile, derive_digital_bits, lightbar_for};
use super::state::{OutputState, ParsedState, ProfileSpec, TriggerEffect};
use super::types::{ControllerEvent, ControllerDeviceInfo};
use super::virtualpad::{self, VirtualPad};
use super::{ds4, dual_sense, Emitter};

const READ_TIMEOUT_MS: i32 = 20;
const HEARTBEAT_MS: u64 = 500;
const MOVE_EMIT_MIN_MS: u64 = 8;
const OUTPUT_KEEPALIVE_MS: u64 = 4000;
const IDENTIFY_MS: u64 = 1600;

pub enum SessionCmd {
    SetLightbar {
        r: u8,
        g: u8,
        b: u8,
        flash_on: u8,
        flash_off: u8,
    },
    SetRumble {
        light: u8,
        heavy: u8,
    },
    SetMicLed(u8),
    SetPlayerLeds(u8),
    SetTrigger {
        left: bool,
        effect: Option<TriggerEffect>,
    },
    Identify,
    SetVirtualOutput(bool),
    SetHidden(bool),
    Shutdown,
}

pub struct SessionHandle {
    pub info: ControllerDeviceInfo,
    pub model: Model,
    pub cmd: Sender<SessionCmd>,
    /// Mapped (profile-applied) state — what navigation consumes.
    pub latest: Arc<RwLock<ParsedState>>,
    /// Raw parsed state — what the mapping editor captures.
    pub raw_latest: Arc<RwLock<ParsedState>>,
    pub profile: Arc<RwLock<ProfileSpec>>,
    pub manual_rgb: Arc<RwLock<Option<([u8; 3], u8, u8)>>>,
    alive: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl SessionHandle {
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.cmd.send(SessionCmd::Shutdown);
        if let Some(join) = self.join.lock().unwrap().take() {
            let _ = join.join();
        }
    }
}

struct EmitGate {
    last_at: Instant,
    last_sig: StateSig,
}

#[derive(PartialEq)]
struct StateSig {
    pressed: u64,
    axes: [u8; 6],
    battery: u8,
    charging: bool,
    touch: [(u8, bool, u16, u16); 2],
}

fn sig(s: &ParsedState) -> StateSig {
    StateSig {
        pressed: s.pressed,
        axes: s.axes,
        battery: s.battery,
        charging: s.charging,
        touch: [
            (s.touch[0].id, s.touch[0].active, s.touch[0].x, s.touch[0].y),
            (s.touch[1].id, s.touch[1].active, s.touch[1].x, s.touch[1].y),
        ],
    }
}

pub fn spawn_session(
    device: HidDevice,
    info: ControllerDeviceInfo,
    model: Model,
    transport: Transport,
    profile: Arc<RwLock<ProfileSpec>>,
    emitter: Emitter,
) -> SessionHandle {
    let (cmd_tx, cmd_rx) = channel::<SessionCmd>();
    let latest = Arc::new(RwLock::new(ParsedState::default()));
    let raw_latest = Arc::new(RwLock::new(ParsedState::default()));
    let manual_rgb = Arc::new(RwLock::new(Option::None));
    let alive = Arc::new(AtomicBool::new(true));
    let stop = Arc::new(AtomicBool::new(false));

    let join = std::thread::spawn({
        let latest = Arc::clone(&latest);
        let raw_latest = Arc::clone(&raw_latest);
        let manual_rgb = Arc::clone(&manual_rgb);
        let profile = Arc::clone(&profile);
        let alive = Arc::clone(&alive);
        let stop = Arc::clone(&stop);
        let device_id = info.id.clone();
        let device_path = info.path.clone();
        move || {
            io_loop(
                device, model, transport, device_id, device_path, cmd_rx, latest,
                raw_latest, manual_rgb, profile, emitter, stop,
            );
            alive.store(false, Ordering::Relaxed);
        }
    });

    SessionHandle {
        info,
        model,
        cmd: cmd_tx,
        latest,
        raw_latest,
        profile,
        manual_rgb,
        alive,
        stop,
        join: Mutex::new(Some(join)),
    }
}

fn build_output(model: Model, transport: Transport, out: &OutputState) -> Vec<u8> {
    if model.is_ds5() {
        dual_sense::build_output(out, transport)
    } else {
        ds4::build_output(out, transport)
    }
}

fn parse_frame(
    model: Model,
    transport: Transport,
    buf: &[u8],
    state: &mut ParsedState,
) -> bool {
    if model.is_ds5() {
        dual_sense::parse_input(buf, transport, state)
    } else {
        ds4::parse_input(buf, transport, state)
    }
}

fn emit(emitter: &Emitter, ev: ControllerEvent) {
    super::emit_event(emitter, ev);
}

fn emit_status(
    emitter: &Emitter,
    device_id: &str,
    event_type: &str,
    status: &str,
    message: Option<String>,
) {
    emit(
        emitter,
        ControllerEvent {
            event_type: event_type.to_string(),
            device_id: Some(device_id.to_string()),
            devices: None,
            state: None,
            message: Some(match message {
                Some(detail) => format!("{status}: {detail}"),
                None => status.to_string(),
            }),
        },
    );
}

#[allow(clippy::too_many_arguments)]
fn io_loop(
    device: HidDevice,
    model: Model,
    transport: Transport,
    device_id: String,
    device_path: String,
    cmd_rx: Receiver<SessionCmd>,
    latest: Arc<RwLock<ParsedState>>,
    raw_latest: Arc<RwLock<ParsedState>>,
    manual_rgb: Arc<RwLock<Option<([u8; 3], u8, u8)>>>,
    profile: Arc<RwLock<ProfileSpec>>,
    emitter: Emitter,
    stop: Arc<AtomicBool>,
) {
    let _ = device.set_blocking_mode(false);

    // Surface real hidden state — the pad may already be hidden by an
    // external tool (e.g. manual HidHide client config) before we attach.
    if hide::is_hidden(&device_path) {
        emit_status(&emitter, &device_id, "hidden", "enabled", None);
    }

    let mut out = OutputState::default();
    let mut out_dirty = true;
    let mut last_write = Instant::now() - Duration::from_secs(10);
    let mut gate = EmitGate {
        last_at: Instant::now() - Duration::from_secs(10),
        last_sig: sig(&ParsedState::default()),
    };
    let mut identify_until: Option<Instant> = None;
    let mut virtual_pad: Option<Box<dyn VirtualPad>> = None;
    let mut hidden_pad: Option<hide::HiddenPad> = None;
    let mut mapped = ParsedState::default();
    let mut buf = [0u8; 512];
    let start = Instant::now();

    while !stop.load(Ordering::Relaxed) {
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                SessionCmd::SetLightbar {
                    r,
                    g,
                    b,
                    flash_on,
                    flash_off,
                } => {
                    *manual_rgb.write().unwrap() = Some(([r, g, b], flash_on, flash_off));
                    out_dirty = true;
                }
                SessionCmd::SetRumble { light, heavy } => {
                    out.rumble_light = light;
                    out.rumble_heavy = heavy;
                    out_dirty = true;
                }
                SessionCmd::SetMicLed(mode) => {
                    if model.has_mic_led() {
                        out.mic_led = mode;
                        out_dirty = true;
                    }
                }
                SessionCmd::SetPlayerLeds(mask) => {
                    if model.has_player_leds() {
                        out.player_leds = mask;
                        out_dirty = true;
                    }
                }
                SessionCmd::SetTrigger { left, effect } => {
                    if model.has_trigger_effects() {
                        if left {
                            out.trigger_left = effect;
                        } else {
                            out.trigger_right = effect;
                        }
                        out_dirty = true;
                    }
                }
                SessionCmd::Identify => {
                    identify_until = Some(Instant::now() + Duration::from_millis(IDENTIFY_MS));
                }
                SessionCmd::SetVirtualOutput(enabled) => {
                    if enabled && virtual_pad.is_none() {
                        match virtualpad::create_virtual_pad() {
                            Ok(pad) => {
                                virtual_pad = Some(pad);
                                emit_status(
                                    &emitter,
                                    &device_id,
                                    "virtualOutput",
                                    "enabled",
                                    None,
                                );
                            }
                            Err(err) => emit_status(
                                &emitter,
                                &device_id,
                                "virtualOutput",
                                "failed",
                                Some(err.to_string()),
                            ),
                        }
                    } else if !enabled && virtual_pad.is_some() {
                        virtual_pad = None;
                        emit_status(&emitter, &device_id, "virtualOutput", "disabled", None);
                    }
                }
                SessionCmd::SetHidden(enabled) => {
                    if enabled && hidden_pad.is_none() {
                        match hide::hide(&device_path) {
                            Ok(guard) => {
                                hidden_pad = Some(guard);
                                emit_status(&emitter, &device_id, "hidden", "enabled", None);
                            }
                            Err(err) => emit_status(
                                &emitter,
                                &device_id,
                                "hidden",
                                "failed",
                                Some(err.to_string()),
                            ),
                        }
                    } else if !enabled
                        && (hidden_pad.is_some() || hide::is_hidden(&device_path))
                    {
                        hidden_pad = None;
                        if hide::is_hidden(&device_path) {
                            let _ = hide::unhide(&device_path);
                        }
                        emit_status(&emitter, &device_id, "hidden", "disabled", None);
                    }
                }
                SessionCmd::Shutdown => {
                    stop.store(true, Ordering::Relaxed);
                }
            }
        }

        match device.read_timeout(&mut buf, READ_TIMEOUT_MS) {
            Ok(n) if n > 0 => {
                let mut raw = ParsedState::default();
                if parse_frame(model, transport, &buf[..n], &mut raw) {
                    derive_digital_bits(&mut raw);
                    *raw_latest.write().unwrap() = raw.clone();

                    let prof = profile.read().unwrap().clone();
                    mapped = apply_profile(&raw, &prof);
                    *latest.write().unwrap() = mapped.clone();

                    if let Some(pad) = virtual_pad.as_mut() {
                        if pad.send(&mapped).is_err() {
                            virtual_pad = None;
                            emit_status(
                                &emitter,
                                &device_id,
                                "virtualOutput",
                                "failed",
                                Some("virtual pad write failed".to_string()),
                            );
                        }
                    }

                    let now = Instant::now();
                    let new_sig = sig(&mapped);
                    let pressed_changed = new_sig.pressed != gate.last_sig.pressed;
                    let moved = new_sig != gate.last_sig;
                    let elapsed = now.duration_since(gate.last_at).as_millis() as u64;
                    if pressed_changed
                        || (moved && elapsed >= MOVE_EMIT_MIN_MS)
                        || elapsed >= HEARTBEAT_MS
                    {
                        gate.last_sig = new_sig;
                        gate.last_at = now;
                        emit(
                            &emitter,
                            ControllerEvent {
                                event_type: "state".to_string(),
                                device_id: Some(device_id.clone()),
                                devices: None,
                                state: Some(super::to_controller_state(&mapped, model)),
                                message: None,
                            },
                        );
                    }
                }
            }
            Ok(_) => {}
            Err(_) => {
                emit(
                    &emitter,
                    ControllerEvent {
                        event_type: "sessionClosed".to_string(),
                        device_id: Some(device_id.clone()),
                        devices: None,
                        state: None,
                        message: Some("device read failed".to_string()),
                    },
                );
                break;
            }
        }

        let identifying = identify_until.map_or(false, |until| Instant::now() < until);
        if identify_until.is_some() && !identifying {
            identify_until = None;
        }

        let (rgb, flash_on, flash_off) = if identifying {
            ([255u8, 255, 255], 30u8, 30u8)
        } else if let Some((rgb, fon, foff)) = *manual_rgb.read().unwrap() {
            (rgb, fon, foff)
        } else {
            let prof = profile.read().unwrap();
            lightbar_for(
                &prof,
                mapped.battery,
                mapped.charging,
                start.elapsed().as_millis() as u64,
            )
        };
        if out.rgb != rgb || out.flash_on != flash_on || out.flash_off != flash_off {
            out.rgb = rgb;
            out.flash_on = flash_on;
            out.flash_off = flash_off;
            out_dirty = true;
        }

        let rumble_active = out.rumble_light > 0 || out.rumble_heavy > 0;
        let keepalive =
            rumble_active && last_write.elapsed() > Duration::from_millis(OUTPUT_KEEPALIVE_MS);
        if out_dirty || keepalive {
            let report = build_output(model, transport, &out);
            if device.write(&report).is_ok() {
                last_write = Instant::now();
                out_dirty = false;
            }
        }
    }

    let mut silence = OutputState::default();
    silence.rgb = out.rgb;
    let _ = device.write(&build_output(model, transport, &silence));
}
