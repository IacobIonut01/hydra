import type {
  NativeControllerDeviceInfo,
  NativeControllerState,
} from "../native-addon";
import type {
  ControllerDeviceInfo,
  ControllerDeviceKind,
  ControllerState,
} from "@types";

export const normalizeDevice = (
  d: NativeControllerDeviceInfo
): ControllerDeviceInfo => ({
  id: d.id,
  path: d.path,
  vid: d.vid,
  pid: d.pid,
  model: d.model as ControllerDeviceKind,
  name: d.name,
  connection: d.connection === "bt" ? "bt" : "usb",
  serial: d.serial ?? null,
  interfaceNumber: d.interface_number,
  active: d.active,
  virtualOutput: false,
  hidden: false,
  hasPlayerLeds: d.has_player_leds,
  hasMicLed: d.has_mic_led,
  hasTriggerEffects: d.has_trigger_effects,
});

export const normalizeState = (
  s: NativeControllerState | null
): ControllerState | null => {
  if (!s) return null;
  return {
    pressed: s.pressed,
    leftStick: s.left_stick,
    rightStick: s.right_stick,
    l2: s.l2,
    r2: s.r2,
    gyro: s.gyro,
    accel: s.accel,
    touch: s.touch,
    battery: s.battery,
    charging: s.charging,
    frame: s.frame,
  };
};
