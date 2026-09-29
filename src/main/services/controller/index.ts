import { db, levelKeys } from "@main/level";
import { WindowManager } from "../window-manager";
import type {
  ControllerDeviceInfo,
  ControllerProfile,
  ControllerState,
  HidingSupport,
  UserPreferences,
  VirtualOutputSupport,
} from "@types";

import { logger } from "../logger";
import {
  NativeAddon,
  type NativeControllerDeviceInfo,
  type NativeControllerEvent,
} from "../native-addon";
import { normalizeDevice, normalizeState } from "./normalize";
import {
  deleteControllerProfile,
  getControllerProfile,
  listControllerProfiles,
  saveControllerProfile,
  toProfilePayload,
} from "./profiles";

const PLAYER_LED_MASKS = [0x00, 0x04, 0x0a, 0x0e, 0x1b, 0x1f];
const CAPTURE_INTERVAL_MS = 25;

export class ControllerService {
  private static initialized = false;
  private static enabled = true;
  private static devices = new Map<string, ControllerDeviceInfo>();
  private static assignments: Record<string, string> = {};
  private static virtualOutput: Record<string, boolean> = {};
  private static hidden: Record<string, boolean> = {};
  private static profileCache = new Map<string, ControllerProfile>();
  private static captureTimers = new Map<
    string,
    { timer: NodeJS.Timeout; lastFrame: number }
  >();

  public static async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const prefs = await db
      .get<string, UserPreferences | null>(levelKeys.userPreferences, {
        valueEncoding: "json",
      })
      .catch(() => null);

    this.enabled = prefs?.controllerEnabled !== false;
    this.assignments = { ...(prefs?.controllerAssignments ?? {}) };
    this.virtualOutput = { ...(prefs?.controllerVirtualOutput ?? {}) };
    this.hidden = { ...(prefs?.controllerHidden ?? {}) };

    if (!this.subscribeToNativeEvents()) {
      this.enabled = false;
      return;
    }

    if (this.enabled) {
      this.refreshDevices(NativeAddon.controllerList());
    }
  }

  private static subscribeToNativeEvents(): boolean {
    return NativeAddon.controllerOnEvent((event) => {
      try {
        this.onNativeEvent(event);
      } catch (error) {
        logger.error("Controller event handler failed", error);
      }
    });
  }

  private static onNativeEvent(event: NativeControllerEvent) {
    switch (event.event_type) {
      case "devicesChanged":
        if (this.enabled) this.refreshDevices(event.devices ?? []);
        break;
      case "state":
        if (event.device_id && event.state) {
          WindowManager.sendToAppWindows("on-controller-state", {
            deviceId: event.device_id,
            state: normalizeState(event.state),
          });
        }
        break;
      case "sessionClosed":
        if (event.device_id) {
          const device = this.devices.get(event.device_id);
          if (device) {
            this.devices.set(event.device_id, { ...device, active: false });
            this.broadcastDevices();
          }
        }
        break;
      case "virtualOutput":
        if (event.device_id) {
          const device = this.devices.get(event.device_id);
          const status = event.message ?? "";
          if (device && !status.startsWith("enabled")) {
            if (status.startsWith("failed")) {
              logger.warn(
                `Virtual output failed for ${event.device_id}: ${status}`
              );
              this.virtualOutput[event.device_id] = false;
              void this.persistAssignments();
            }
            this.devices.set(event.device_id, {
              ...device,
              virtualOutput: false,
            });
            this.broadcastDevices();
          } else if (device) {
            this.devices.set(event.device_id, {
              ...device,
              virtualOutput: true,
            });
            this.broadcastDevices();
          }
        }
        break;
      case "hidden":
        if (event.device_id) {
          const device = this.devices.get(event.device_id);
          const status = event.message ?? "";
          if (device && !status.startsWith("enabled")) {
            if (status.startsWith("failed")) {
              logger.warn(`Hiding failed for ${event.device_id}: ${status}`);
              this.hidden[event.device_id] = false;
              void this.persistAssignments();
            }
            this.devices.set(event.device_id, {
              ...device,
              hidden: false,
            });
            this.broadcastDevices();
          } else if (device) {
            this.devices.set(event.device_id, {
              ...device,
              hidden: true,
            });
            this.broadcastDevices();
          }
        }
        break;
      case "error":
        logger.warn(
          `Controller error${event.device_id ? ` (${event.device_id})` : ""}: ${event.message ?? "unknown"}`
        );
        break;
    }
  }

  private static refreshDevices(nativeDevices: NativeControllerDeviceInfo[]) {
    const previousIds = new Set(this.devices.keys());
    const next = new Map<string, ControllerDeviceInfo>();

    for (const nativeDevice of nativeDevices) {
      const device = normalizeDevice(nativeDevice);
      const previous = this.devices.get(device.id);
      next.set(device.id, {
        ...device,
        active: previous?.active ?? device.active,
        virtualOutput: previous?.virtualOutput ?? false,
        hidden: previous?.hidden ?? false,
      });
    }

    this.devices = next;

    for (const device of next.values()) {
      if (!previousIds.has(device.id)) {
        void this.startSession(device.id);
      }
    }

    for (const id of previousIds) {
      if (!next.has(id)) this.endCapture(id);
    }

    this.broadcastDevices();
  }

  private static broadcastDevices() {
    WindowManager.sendToAppWindows(
      "on-controller-devices-changed",
      this.listDevices()
    );
  }

  private static async startSession(deviceId: string) {
    const device = this.devices.get(deviceId);
    if (!device || device.active) return;

    if (!NativeAddon.controllerStart(deviceId)) {
      logger.warn(`Failed to start controller session for ${deviceId}`);
      return;
    }

    this.devices.set(deviceId, { ...device, active: true });
    await this.applyAssignedProfile(deviceId);
    if (this.virtualOutput[deviceId]) {
      NativeAddon.controllerSetVirtualOutput(deviceId, true);
    }
    if (this.hidden[deviceId]) {
      NativeAddon.controllerSetHidden(deviceId, true);
    }
    this.broadcastDevices();
  }

  private static async loadProfile(
    id: string
  ): Promise<ControllerProfile | null> {
    const cached = this.profileCache.get(id);
    if (cached) return cached;
    const profile = await getControllerProfile(id);
    if (profile) this.profileCache.set(id, profile);
    return profile;
  }

  private static async applyAssignedProfile(deviceId: string) {
    const profileId = this.assignments[deviceId] ?? "default";
    const profile =
      (await this.loadProfile(profileId)) ??
      (await this.loadProfile("default"));
    if (!profile) return;

    NativeAddon.controllerSetProfile(
      deviceId,
      JSON.stringify(toProfilePayload(profile))
    );

    const device = this.devices.get(deviceId);
    if (device?.hasPlayerLeds && profile.playerLedCount > 0) {
      NativeAddon.controllerSetPlayerLeds(
        deviceId,
        PLAYER_LED_MASKS[
          Math.min(profile.playerLedCount, PLAYER_LED_MASKS.length - 1)
        ]
      );
    }
    if (device?.hasMicLed) {
      NativeAddon.controllerSetMicLed(deviceId, profile.micLed);
    }
  }

  private static async persistAssignments() {
    const prefs = await db
      .get<string, UserPreferences | null>(levelKeys.userPreferences, {
        valueEncoding: "json",
      })
      .catch(() => null);

    const updated: UserPreferences = {
      ...prefs,
      controllerEnabled: this.enabled,
      controllerAssignments: this.assignments,
      controllerVirtualOutput: this.virtualOutput,
      controllerHidden: this.hidden,
    } as UserPreferences;

    await db.put<string, UserPreferences>(levelKeys.userPreferences, updated, {
      valueEncoding: "json",
    });

    WindowManager.sendToAppWindows("on-user-preferences-updated", updated);
  }

  private static endCapture(deviceId: string) {
    const session = this.captureTimers.get(deviceId);
    if (session) {
      clearInterval(session.timer);
      this.captureTimers.delete(deviceId);
    }
  }

  // ── public API used by IPC handlers ───────────────────────────────────────

  public static listDevices(): ControllerDeviceInfo[] {
    return [...this.devices.values()];
  }

  public static listProfiles(): Promise<ControllerProfile[]> {
    return listControllerProfiles();
  }

  public static async saveProfile(
    profile: Parameters<typeof saveControllerProfile>[0]
  ): Promise<ControllerProfile> {
    const saved = await saveControllerProfile(profile);
    this.profileCache.set(saved.id, saved);
    for (const [deviceId, profileId] of Object.entries(this.assignments)) {
      if (profileId === saved.id) void this.applyAssignedProfile(deviceId);
    }
    return saved;
  }

  public static async deleteProfile(id: string): Promise<boolean> {
    const deleted = await deleteControllerProfile(id);
    if (!deleted) return false;
    this.profileCache.delete(id);

    let changed = false;
    for (const [deviceId, profileId] of Object.entries(this.assignments)) {
      if (profileId === id) {
        this.assignments[deviceId] = "default";
        void this.applyAssignedProfile(deviceId);
        changed = true;
      }
    }
    if (changed) await this.persistAssignments();
    return true;
  }

  public static async assignProfile(
    deviceId: string,
    profileId: string | null
  ): Promise<boolean> {
    if (profileId === null) {
      delete this.assignments[deviceId];
    } else {
      if (!(await this.loadProfile(profileId))) return false;
      this.assignments[deviceId] = profileId;
    }
    await this.persistAssignments();
    await this.applyAssignedProfile(deviceId);
    return true;
  }

  public static setLightbar(
    deviceId: string,
    r: number,
    g: number,
    b: number,
    flashOn = 0,
    flashOff = 0
  ): boolean {
    return NativeAddon.controllerSetLightbar(
      deviceId,
      r,
      g,
      b,
      flashOn,
      flashOff
    );
  }

  public static previewRumble(
    deviceId: string,
    light: number,
    heavy: number,
    durationMs = 300
  ): boolean {
    if (!NativeAddon.controllerSetRumble(deviceId, light, heavy)) return false;
    setTimeout(
      () => NativeAddon.controllerSetRumble(deviceId, 0, 0),
      durationMs
    );
    return true;
  }

  public static setPlayerLedCount(deviceId: string, count: number): boolean {
    const mask =
      PLAYER_LED_MASKS[Math.min(count, PLAYER_LED_MASKS.length - 1)] ?? 0;
    return NativeAddon.controllerSetPlayerLeds(deviceId, mask);
  }

  public static setMicLed(deviceId: string, mode: number): boolean {
    return NativeAddon.controllerSetMicLed(deviceId, mode);
  }

  public static setTriggerEffect(
    deviceId: string,
    side: "left" | "right",
    mode: number,
    params: number[]
  ): boolean {
    return NativeAddon.controllerSetTriggerEffect(
      deviceId,
      side === "left",
      mode,
      params
    );
  }

  public static identify(deviceId: string): boolean {
    return NativeAddon.controllerIdentify(deviceId);
  }

  public static getVirtualOutputSupport(): VirtualOutputSupport {
    return NativeAddon.controllerVirtualOutputSupport() as VirtualOutputSupport;
  }

  public static async setVirtualOutput(
    deviceId: string,
    enabled: boolean
  ): Promise<boolean> {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    if (enabled && this.getVirtualOutputSupport() === "unavailable") {
      return false;
    }

    this.virtualOutput[deviceId] = enabled;
    this.devices.set(deviceId, { ...device, virtualOutput: enabled });
    await this.persistAssignments();
    this.broadcastDevices();

    if (device.active) {
      NativeAddon.controllerSetVirtualOutput(deviceId, enabled);
    }
    return true;
  }

  public static getHidingSupport(): HidingSupport {
    return NativeAddon.controllerHidingSupport() as HidingSupport;
  }

  /// Full service restart — tears down sessions (releasing any hid hides /
  /// virtual pads), re-enumerates, and reapplies saved per-device prefs so
  /// externally configured state (HidHide client, driver installs) surfaces.
  public static async restart(): Promise<void> {
    if (!this.enabled) {
      this.refreshDevices(NativeAddon.controllerList());
      return;
    }
    await this.setEnabled(false);
    await this.setEnabled(true);
  }

  public static async setHidden(
    deviceId: string,
    enabled: boolean
  ): Promise<boolean> {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    if (enabled) {
      const support = this.getHidingSupport();
      if (support === "unavailable" || support === "hidhide-unavailable") {
        return false;
      }
    }

    this.hidden[deviceId] = enabled;
    this.devices.set(deviceId, { ...device, hidden: enabled });
    await this.persistAssignments();
    this.broadcastDevices();

    if (device.active) {
      NativeAddon.controllerSetHidden(deviceId, enabled);
    }
    return true;
  }

  public static async setEnabled(enabled: boolean): Promise<void> {
    if (this.enabled === enabled) return;
    this.enabled = enabled;

    if (!enabled) {
      for (const [id, device] of this.devices) {
        this.endCapture(id);
        if (device.active) NativeAddon.controllerStop(id);
        this.devices.set(id, {
          ...device,
          active: false,
          virtualOutput: false,
          hidden: false,
        });
      }
    } else {
      this.refreshDevices(NativeAddon.controllerList());
    }

    await this.persistAssignments();
    this.broadcastDevices();
  }

  public static beginCapture(deviceId: string): boolean {
    if (this.captureTimers.has(deviceId)) return true;

    let lastFrame = -1;
    const timer = setInterval(() => {
      const raw = NativeAddon.controllerReadRaw(deviceId);
      if (!raw || raw.frame === lastFrame) return;
      lastFrame = raw.frame;
      const state: ControllerState | null = normalizeState(raw);
      WindowManager.sendToAppWindows("on-controller-capture", {
        deviceId,
        state,
      });
    }, CAPTURE_INTERVAL_MS);

    this.captureTimers.set(deviceId, { timer, lastFrame });
    return true;
  }

  public static endControllerCapture(deviceId: string): void {
    this.endCapture(deviceId);
  }
}
