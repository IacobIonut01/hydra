import { logger } from "../logger";
import type {
  NativeControllerDeviceInfo,
  NativeControllerEvent,
  NativeControllerState,
} from "../native-addon";

/**
 * Development stub for the controller native addon, enabled with
 * `HYDRA_STUB_CONTROLLERS=1`. Fakes a USB DualShock 4 and a Bluetooth
 * DualSense Edge so the settings UIs can be exercised on a machine with no
 * PlayStation hardware attached. All write operations are logged, state
 * frames animate sticks/buttons/battery, and the virtual-output and hiding
 * probes always report available so the toggles render.
 */
export const controllerStubEnabled = process.env.HYDRA_STUB_CONTROLLERS === "1";

const DS4_ID = "stub-ds4-usb";
const DS5_ID = "stub-ds5edge-bt";

const stubDevices: NativeControllerDeviceInfo[] = [
  {
    id: DS4_ID,
    path: "stub://ds4-usb",
    vid: 0x054c,
    pid: 0x09cc,
    model: "ds4",
    name: "DualShock 4 (stub)",
    connection: "usb",
    serial: "STUB-DS4",
    interface_number: 3,
    active: false,
    has_player_leds: false,
    has_mic_led: false,
    has_trigger_effects: false,
  },
  {
    id: DS5_ID,
    path: "stub://ds5edge-bt",
    vid: 0x054c,
    pid: 0x0df2,
    model: "dualsense-edge",
    name: "DualSense Edge (stub)",
    connection: "bt",
    serial: "STUB-DS5",
    interface_number: 0,
    active: false,
    has_player_leds: true,
    has_mic_led: true,
    has_trigger_effects: true,
  },
];

const activeSessions = new Set<string>();
const virtualOutput = new Set<string>();
const hiddenPads = new Set<string>();
const eventCallbacks = new Set<(event: NativeControllerEvent) => void>();

let frame = 0;
let ticker: NodeJS.Timeout | null = null;
let devicesChangedTimer: NodeJS.Timeout | null = null;

const BUTTON_SEQUENCE: string[][] = [
  [],
  ["cross"],
  ["dpadUp", "l1"],
  ["circle"],
  ["l2", "l2Full"],
  ["triangle"],
  ["dpadRight", "r1"],
  ["square", "r2", "r2Full"],
  ["options"],
  [],
];

const makeState = (deviceId: string): NativeControllerState => {
  const phase = frame / 20;
  const seq =
    BUTTON_SEQUENCE[
      (Math.floor(frame / 30) + (deviceId === DS5_ID ? 3 : 0)) %
        BUTTON_SEQUENCE.length
    ];

  return {
    pressed: [...seq],
    left_stick: {
      x: Math.sin(phase) * (deviceId === DS4_ID ? 0.6 : 0.3),
      y: Math.cos(phase) * (deviceId === DS4_ID ? 0.6 : 0.3),
    },
    right_stick: {
      x: Math.cos(phase / 2) * 0.2,
      y: Math.sin(phase / 2) * 0.2,
    },
    l2: seq.includes("l2Full") ? 1 : 0,
    r2: seq.includes("r2Full") ? 1 : 0,
    gyro: { x: 0, y: 0, z: 0 },
    accel: { x: 0, y: 0, z: -1 },
    touch: [],
    battery: deviceId === DS4_ID ? 72 : 55,
    charging: deviceId === DS5_ID,
    frame,
  };
};

const emit = (event: NativeControllerEvent) => {
  for (const cb of eventCallbacks) {
    try {
      cb(event);
    } catch (error) {
      logger.error("[controller-stub] event callback failed", error);
    }
  }
};

const startTicker = () => {
  if (ticker) return;
  ticker = setInterval(() => {
    frame += 1;
    for (const id of activeSessions) {
      emit({
        event_type: "state",
        device_id: id,
        devices: null,
        state: makeState(id),
        message: null,
      });
    }
  }, 50);
  ticker.unref();
};

const logWrite = (call: string, args: unknown[]) => {
  logger.info(`[controller-stub] ${call}(${args.join(", ")})`);
};

const deviceFor = (id: string) =>
  stubDevices.find((device) => device.id === id);

export const controllerStub = {
  list(): NativeControllerDeviceInfo[] {
    return stubDevices;
  },

  start(id: string): boolean {
    const device = deviceFor(id);
    if (!device) return false;
    device.active = true;
    activeSessions.add(id);
    startTicker();
    return true;
  },

  stop(id: string): boolean {
    const device = deviceFor(id);
    if (!device) return false;
    device.active = false;
    activeSessions.delete(id);
    virtualOutput.delete(id);
    hiddenPads.delete(id);
    return true;
  },

  setLightbar(
    id: string,
    r: number,
    g: number,
    b: number,
    flashOn: number,
    flashOff: number
  ): boolean {
    logWrite("setLightbar", [id, r, g, b, flashOn, flashOff]);
    return activeSessions.has(id);
  },

  setRumble(id: string, light: number, heavy: number): boolean {
    logWrite("setRumble", [id, light, heavy]);
    return activeSessions.has(id);
  },

  setMicLed(id: string, mode: number): boolean {
    logWrite("setMicLed", [id, mode]);
    return activeSessions.has(id);
  },

  setPlayerLeds(id: string, mask: number): boolean {
    logWrite("setPlayerLeds", [id, mask]);
    return activeSessions.has(id);
  },

  setTriggerEffect(
    id: string,
    left: boolean,
    mode: number,
    params: number[]
  ): boolean {
    logWrite("setTriggerEffect", [id, left, mode, params.join("/")]);
    return activeSessions.has(id);
  },

  identify(id: string): boolean {
    logWrite("identify", [id]);
    return activeSessions.has(id);
  },

  setProfile(id: string, profileJson: string): boolean {
    logWrite("setProfile", [id, profileJson]);
    return activeSessions.has(id);
  },

  readRaw(id: string): NativeControllerState | null {
    if (!activeSessions.has(id)) return null;
    return makeState(id);
  },

  setVirtualOutput(id: string, enabled: boolean): boolean {
    if (!activeSessions.has(id)) return false;
    if (enabled) {
      virtualOutput.add(id);
    } else {
      virtualOutput.delete(id);
    }
    setImmediate(() =>
      emit({
        event_type: "virtualOutput",
        device_id: id,
        devices: null,
        state: null,
        message: enabled ? "enabled" : "disabled",
      })
    );
    return true;
  },

  virtualOutputSupport(): string {
    return "vigem-available";
  },

  setHidden(id: string, enabled: boolean): boolean {
    if (!activeSessions.has(id)) return false;
    if (enabled) {
      hiddenPads.add(id);
    } else {
      hiddenPads.delete(id);
    }
    setImmediate(() =>
      emit({
        event_type: "hidden",
        device_id: id,
        devices: null,
        state: null,
        message: enabled ? "enabled" : "disabled",
      })
    );
    return true;
  },

  hidingSupport(): string {
    return "hidhide-available";
  },

  onEvent(callback: (event: NativeControllerEvent) => void): boolean {
    eventCallbacks.add(callback);
    devicesChangedTimer?.unref();
    devicesChangedTimer = setTimeout(() => {
      emit({
        event_type: "devicesChanged",
        device_id: null,
        devices: stubDevices,
        state: null,
        message: null,
      });
    }, 300);
    devicesChangedTimer.unref();
    return true;
  },
};
