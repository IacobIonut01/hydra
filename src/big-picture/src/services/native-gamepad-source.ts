import type { ControllerDeviceInfo, ControllerState } from "@types";

import { GamepadService } from "./gamepad.service";

/**
 * Bridges native HID controller sessions into the GamepadService.
 *
 * Chromium still exposes the physical DS4/DS5 through the Gamepad API while a
 * native session remaps it. To avoid double input we synthesize a standard
 * Gamepad per native device (fed with the *mapped* state pushed over IPC) and
 * tell the service to suppress the matching physical pads — matched by
 * Vendor/Product hex in the gamepad id or by the device-family name patterns.
 */

const NATIVE_GAMEPAD_INDEX_BASE = 1000;
const STANDARD_BUTTON_COUNT = 18;
const STANDARD_AXIS_COUNT = 4;

const BUTTON_INDEX_BY_CONTROL: Record<string, number> = {
  cross: 0,
  circle: 1,
  square: 2,
  triangle: 3,
  l1: 4,
  r1: 5,
  l2: 6,
  r2: 7,
  share: 8,
  options: 9,
  l3: 10,
  r3: 11,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  ps: 16,
  touchClick: 17,
};

const MODEL_NAME_PATTERNS: Record<string, RegExp> = {
  ds4: /dualshock|(?!.*dualsense).*wireless controller/i,
  dualsense: /dualsense(?!.*edge)/i,
  "dualsense-edge": /dualsense edge/i,
};

type MutableGamepadButton = {
  pressed: boolean;
  touched: boolean;
  value: number;
};

interface SyntheticGamepad {
  id: string;
  index: number;
  connected: boolean;
  timestamp: number;
  mapping: string;
  buttons: MutableGamepadButton[];
  axes: number[];
  vibrationActuator: null;
}

interface NativePad {
  deviceId: string;
  index: number;
  model: string;
  hardwareKey: string | null;
  gamepad: SyntheticGamepad;
}

const hex4 = (value: number) => value.toString(16).padStart(4, "0");

const hardwareKeyOf = (device: ControllerDeviceInfo) =>
  device.vid > 0 && device.pid > 0
    ? `${hex4(device.vid)}:${hex4(device.pid)}`
    : null;

const modelDisplayName = (device: ControllerDeviceInfo) => {
  switch (device.model) {
    case "ds4":
      return "DualShock 4";
    case "dualsense":
      return "DualSense";
    case "dualsense-edge":
      return "DualSense Edge";
    default:
      return device.name;
  }
};

export class NativeGamepadSource {
  private static instance: NativeGamepadSource;

  private attached = false;
  private unsubscribeState: (() => void) | null = null;
  private unsubscribeDevices: (() => void) | null = null;
  private readonly pads = new Map<string, NativePad>();
  private readonly freeIndexes: number[] = [];
  private indexCounter = 0;

  public static getInstance(): NativeGamepadSource {
    if (!NativeGamepadSource.instance) {
      NativeGamepadSource.instance = new NativeGamepadSource();
    }
    return NativeGamepadSource.instance;
  }

  public attach(): void {
    if (this.attached || typeof globalThis.window === "undefined") return;
    if (!globalThis.window.electron?.onControllerState) return;
    this.attached = true;

    const electron = globalThis.window.electron;

    this.unsubscribeState = electron.onControllerState((payload) => {
      if (payload?.deviceId && payload.state) {
        this.applyState(payload.deviceId, payload.state);
      }
    });

    this.unsubscribeDevices = electron.onControllerDevicesChanged(
      (devices) => {
        this.syncDevices(devices ?? []);
      }
    );

    void electron
      .getControllers()
      .then((devices) => this.syncDevices(devices ?? []))
      .catch(() => undefined);
  }

  public detach(): void {
    this.unsubscribeState?.();
    this.unsubscribeDevices?.();
    this.unsubscribeState = null;
    this.unsubscribeDevices = null;
    this.attached = false;

    const service = GamepadService.getInstance();
    for (const pad of this.pads.values()) {
      service.unregisterNativeGamepad(pad.index);
    }
    this.pads.clear();
    this.freeIndexes.length = 0;
    this.indexCounter = 0;
    service.setSuppressedHardwareKeys([]);
    service.setSuppressedNamePatterns([]);
  }

  private nextIndex(): number {
    return (
      this.freeIndexes.pop() ?? NATIVE_GAMEPAD_INDEX_BASE + this.indexCounter++
    );
  }

  private createGamepad(
    device: ControllerDeviceInfo,
    index: number
  ): SyntheticGamepad {
    const buttons: MutableGamepadButton[] = Array.from(
      { length: STANDARD_BUTTON_COUNT },
      () => ({ pressed: false, touched: false, value: 0 })
    );

    return {
      id: `${modelDisplayName(device)} (STANDARD GAMEPAD Vendor: ${hex4(
        device.vid
      )} Product: ${hex4(device.pid)}) HydraNative`,
      index,
      connected: true,
      timestamp: Date.now(),
      mapping: "standard",
      buttons,
      axes: new Array(STANDARD_AXIS_COUNT).fill(0),
      vibrationActuator: null,
    };
  }

  private syncDevices(devices: ControllerDeviceInfo[]): void {
    const service = GamepadService.getInstance();
    const seen = new Set<string>();

    for (const device of devices) {
      if (!device.active) continue;
      seen.add(device.id);

      if (!this.pads.has(device.id)) {
        const index = this.nextIndex();
        const pad: NativePad = {
          deviceId: device.id,
          index,
          model: device.model,
          hardwareKey: hardwareKeyOf(device),
          gamepad: this.createGamepad(device, index),
        };
        this.pads.set(device.id, pad);
        service.registerNativeGamepad(
          index,
          pad.gamepad as unknown as globalThis.Gamepad
        );
      }
    }

    for (const [deviceId, pad] of this.pads) {
      if (!seen.has(deviceId)) {
        service.unregisterNativeGamepad(pad.index);
        this.freeIndexes.push(pad.index);
        this.pads.delete(deviceId);
      }
    }

    const pads = [...this.pads.values()];
    service.setSuppressedHardwareKeys(
      pads.flatMap((pad) => (pad.hardwareKey ? [pad.hardwareKey] : []))
    );
    service.setSuppressedNamePatterns(
      pads.flatMap((pad) => {
        const pattern = MODEL_NAME_PATTERNS[pad.model];
        return pattern ? [pattern] : [];
      })
    );
  }

  private applyState(deviceId: string, state: ControllerState): void {
    const pad = this.pads.get(deviceId);
    if (!pad) return;

    const { gamepad } = pad;
    gamepad.timestamp = Date.now();

    for (const button of gamepad.buttons) {
      button.pressed = false;
      button.touched = false;
      button.value = 0;
    }

    for (const control of state.pressed) {
      const index = BUTTON_INDEX_BY_CONTROL[control];
      if (index === undefined) continue;
      const button = gamepad.buttons[index];
      button.pressed = true;
      button.touched = true;
      button.value = 1;
    }

    gamepad.buttons[6].value = state.l2;
    if (!gamepad.buttons[6].pressed) {
      gamepad.buttons[6].pressed = state.l2 > 0.5;
      gamepad.buttons[6].touched = gamepad.buttons[6].pressed;
    }
    gamepad.buttons[7].value = state.r2;
    if (!gamepad.buttons[7].pressed) {
      gamepad.buttons[7].pressed = state.r2 > 0.5;
      gamepad.buttons[7].touched = gamepad.buttons[7].pressed;
    }

    // Native stick Y is +up; standard gamepad axes use -up.
    gamepad.axes[0] = state.leftStick.x;
    gamepad.axes[1] = -state.leftStick.y;
    gamepad.axes[2] = state.rightStick.x;
    gamepad.axes[3] = -state.rightStick.y;
  }
}
