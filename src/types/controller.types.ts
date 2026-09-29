export type ControllerDeviceKind = "ds4" | "dualsense" | "dualsense-edge";

export type ControllerConnection = "usb" | "bt";

export interface ControllerDeviceInfo {
  id: string;
  path: string;
  vid: number;
  pid: number;
  model: ControllerDeviceKind;
  name: string;
  connection: ControllerConnection;
  serial: string | null;
  interfaceNumber: number;
  active: boolean;
  /** Whether a virtual X360 pad is mirroring this device's remapped state. */
  virtualOutput: boolean;
  /** Whether the physical pad is hidden from other apps (exclusive access). */
  hidden: boolean;
  hasPlayerLeds: boolean;
  hasMicLed: boolean;
  hasTriggerEffects: boolean;
}

export interface ControllerStickState {
  x: number;
  y: number;
}

export interface ControllerVector3 {
  x: number;
  y: number;
  z: number;
}

export interface ControllerTouchPoint {
  id: number;
  active: boolean;
  x: number;
  y: number;
}

export interface ControllerState {
  /** Canonical control ids currently held ("cross", "dpadUp", "l2Full", …). */
  pressed: string[];
  leftStick: ControllerStickState;
  rightStick: ControllerStickState;
  l2: number;
  r2: number;
  gyro: ControllerVector3;
  accel: ControllerVector3;
  touch: ControllerTouchPoint[];
  battery: number;
  charging: boolean;
  frame: number;
}

export type ControllerEventType =
  | "devicesChanged"
  | "state"
  | "error"
  | "sessionClosed"
  | "virtualOutput"
  | "hidden";

export interface ControllerEvent {
  type: ControllerEventType;
  deviceId: string | null;
  devices: ControllerDeviceInfo[] | null;
  /** Mapped (profile-applied) state; present on "state" events. */
  state: ControllerState | null;
  message: string | null;
}

export type LightbarMode = "static" | "rainbow" | "battery";

export interface ControllerLightbarSpec {
  mode: LightbarMode;
  r: number;
  g: number;
  b: number;
  flashAt: number;
}

export interface ControllerProfile {
  id: string;
  name: string;
  builtin: boolean;
  lightbar: ControllerLightbarSpec;
  playerLedCount: number;
  micLed: number;
  stickDeadzone: number;
  swapSticks: boolean;
  /** controlId -> controlId | "unbound"; missing entries pass through. */
  remap: Record<string, string>;
}

/** Subset of ControllerProfile serialized to the native addon. */
export type ControllerProfilePayload = Omit<
  ControllerProfile,
  "id" | "builtin"
>;

export type VirtualOutputSupport =
  | "uinput-available"
  | "uinput-blocked"
  | "vigem-unavailable"
  | "vigem-available"
  | "unavailable";

export type HidingSupport =
  | "hidhide-available"
  | "hidhide-unavailable"
  | "evdev-grab"
  | "unavailable";

export type ControllerCaptureKind = "raw";

export interface ControllerCaptureFrame {
  deviceId: string;
  state: ControllerState;
}
