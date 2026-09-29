import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

import { app } from "electron";
import type { ProcessPayload } from "./download/types";
import type {
  BuildLocalGameSnapshotPipelineInput,
  BuildSnapshotAggregateHashInput,
  DeleteLocalSaveTarget,
  DeleteLocalSaveTargetsResult,
  GameSaveRules,
  GetSaveRulesForGameInput,
  NativeLocalGameSnapshotPipelineResult,
  ReplaceRestoreTarget,
  ReplaceRestoreTargetsResult,
  ResolveRestoreTargetsInput,
  ResolveRestoreTargetsResult,
  ShouldSkipRestoreFileInput,
  VerifyDownloadedRestoreFileResult,
  CheckCloudSaveCustomPathOverlapInput,
  CheckCloudSaveCustomPathOverlapResult,
  HydraAudioDevice,
} from "@types";

import type { AudioDeviceDefaults } from "./audio-device-manager-utils";
import { logger } from "./logger";
import { controllerStub, controllerStubEnabled } from "./controller/stub";

type NativeProcessProfileImageResponse = {
  imagePath?: string;
  image_path?: string;
  mimeType?: string;
  mime_type?: string;
};

type NativeProcessSizedImageResponse = NativeProcessProfileImageResponse & {
  isAnimated?: boolean;
  is_animated?: boolean;
};

type NativeDisplayBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type NativeAudioDeviceDefaults = {
  consoleId: string | null;
  multimediaId: string | null;
};

type NativeActiveWindowResponse = {
  windowId?: string;
  window_id?: string;
  processId?: number;
  process_id?: number;
};

export type NativeControllerDeviceInfo = {
  id: string;
  path: string;
  vid: number;
  pid: number;
  model: string;
  name: string;
  connection: string;
  serial: string | null;
  interface_number: number;
  active: boolean;
  has_player_leds: boolean;
  has_mic_led: boolean;
  has_trigger_effects: boolean;
};

export type NativeControllerState = {
  pressed: string[];
  left_stick: { x: number; y: number };
  right_stick: { x: number; y: number };
  l2: number;
  r2: number;
  gyro: { x: number; y: number; z: number };
  accel: { x: number; y: number; z: number };
  touch: { id: number; active: boolean; x: number; y: number }[];
  battery: number;
  charging: boolean;
  frame: number;
};

export type NativeControllerEvent = {
  event_type: string;
  device_id: string | null;
  devices: NativeControllerDeviceInfo[] | null;
  state: NativeControllerState | null;
  message: string | null;
};

type HydraNativeModule = {
  torrentInitialize: (port: number) => Promise<void>;
  torrentRequest: (method: string, paramsJson: string) => Promise<string>;
  torrentShutdown: () => Promise<void>;
  processProfileImage: (
    imagePath: string,
    targetExtension?: string
  ) => NativeProcessProfileImageResponse;
  processImage: (
    imagePath: string,
    outputPathBase: string,
    width: number,
    height: number,
    preserveAnimation: boolean
  ) => Promise<NativeProcessSizedImageResponse>;
  listProcesses: () => ProcessPayload[];
  setPrimaryDisplayByBounds?: (bounds: NativeDisplayBounds) => boolean;
  getDisplaySourceNameByBounds?: (bounds: NativeDisplayBounds) => string | null;
  getPrimaryDisplaySourceName?: () => string | null;
  setPrimaryDisplayBySourceName?: (sourceName: string) => boolean;
  listAudioRenderDevices?: () => HydraAudioDevice[];
  getDefaultAudioRenderDeviceId?: () => string | null;
  setDefaultAudioRenderDeviceId?: (id: string) => boolean;
  getDefaultAudioRenderDeviceIds?: () => NativeAudioDeviceDefaults;
  setDefaultAudioRenderDeviceIds?: (
    defaults: NativeAudioDeviceDefaults
  ) => boolean;
  getLinuxActiveWindow: () => NativeActiveWindowResponse | null;
  isProcessElevated?: () => boolean;
  relaunchElevated?: (exePath: string) => boolean;
  sendTextInput?: (text: string) => boolean;
  sendVirtualKeyChord?: (virtualKeys: number[]) => boolean;
  isTextInputFocused?: () => boolean;
  focusGameWindow?: (executableNames: string[]) => boolean;
  buildLocalGameSnapshotPipeline: (
    input: BuildLocalGameSnapshotPipelineInput
  ) => Promise<NativeLocalGameSnapshotPipelineResult>;
  getSaveRulesForGame: (
    input: GetSaveRulesForGameInput
  ) => Promise<GameSaveRules>;
  buildSnapshotAggregateHash: (
    input: BuildSnapshotAggregateHashInput
  ) => string;
  checkCloudSaveCustomPathOverlap: (
    input: CheckCloudSaveCustomPathOverlapInput
  ) => CheckCloudSaveCustomPathOverlapResult;
  uploadLocalSaveBlob: (
    absolutePath: string,
    uploadUrl: string,
    contentLength: string,
    checksumSha256: string
  ) => Promise<void>;
  resolveRestoreTargets: (
    input: ResolveRestoreTargetsInput
  ) => Promise<ResolveRestoreTargetsResult>;
  downloadRestoreBlobToTemp: (
    snapshotId: string,
    hash: string,
    expectedSizeBytes: number,
    downloadUrl: string,
    tempRoot: string
  ) => Promise<string>;
  verifyDownloadedRestoreFile: (
    tempPath: string,
    expectedHash: string
  ) => Promise<VerifyDownloadedRestoreFileResult>;
  shouldSkipRestoreFile: (
    localPath: string,
    expectedHash: string
  ) => Promise<boolean>;
  replaceRestoreTargets: (
    files: ReplaceRestoreTarget[]
  ) => Promise<ReplaceRestoreTargetsResult>;
  deleteLocalSaveTargets: (
    files: DeleteLocalSaveTarget[],
    cleanupRootPaths?: string[]
  ) => Promise<DeleteLocalSaveTargetsResult>;
  cleanupRestoreTempSnapshot: (
    snapshotId: string,
    tempRoot: string
  ) => Promise<void>;
  controllerList?: () => NativeControllerDeviceInfo[];
  controllerBackendError?: () => string | null;
  controllerStart?: (id: string) => boolean;
  controllerStop?: (id: string) => boolean;
  controllerSetLightbar?: (
    id: string,
    r: number,
    g: number,
    b: number,
    flashOn: number,
    flashOff: number
  ) => boolean;
  controllerSetRumble?: (id: string, light: number, heavy: number) => boolean;
  controllerSetMicLed?: (id: string, mode: number) => boolean;
  controllerSetPlayerLeds?: (id: string, mask: number) => boolean;
  controllerSetTriggerEffect?: (
    id: string,
    left: boolean,
    mode: number,
    params: number[]
  ) => boolean;
  controllerIdentify?: (id: string) => boolean;
  controllerSetProfile?: (id: string, profileJson: string) => boolean;
  controllerReadRaw?: (id: string) => NativeControllerState | null;
  controllerSetVirtualOutput?: (id: string, enabled: boolean) => boolean;
  controllerVirtualOutputSupport?: () => string;
  controllerSetHidden?: (id: string, enabled: boolean) => boolean;
  controllerHidingSupport?: () => string;
  controllerOnEvent?: (
    callback: (event: NativeControllerEvent) => void
  ) => void;
};

export type SystemProcessMap = {
  processMap: Record<string, string[]>;
  winePrefixMap: Record<string, string>;
  linuxProcesses: Array<{
    name: string;
    cwd: string;
    exe: string;
    pid: number;
    appImagePath: string | null;
    steamCompatDataPath: string | null;
  }>;
};

// Runs in the worker thread (CJS context).
// "list"  → posts back the raw ProcessPayload array (used by close-game, launch-game)
// "map"   → posts back compact pre-built maps (used by the main loop's watchProcesses)
const WORKER_CODE = `
const { workerData, parentPort } = require('worker_threads');
const path = require('path');
if (process.platform === 'linux' && workerData.addonDir) {
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? workerData.addonDir + ':' + process.env.LD_LIBRARY_PATH
    : workerData.addonDir;
}
const addon = require(workerData.addonPath);
const platform = process.platform;

function buildMaps(processes) {
  const processMap = Object.create(null);
  const winePrefixMap = Object.create(null);
  const linuxProcesses = [];

  for (const proc of processes) {
    const key = proc.name && proc.name.toLowerCase();
    const value = platform === 'win32'
      ? proc.exe
      : path.join(proc.cwd || '', proc.name || '');

    if (!key || !value) continue;

    const steamCompatDataPath = proc.environ && proc.environ.STEAM_COMPAT_DATA_PATH;
    if (steamCompatDataPath) winePrefixMap[value] = steamCompatDataPath;

    if (platform === 'linux') {
      const appImagePath = proc.environ && proc.environ.APPIMAGE;
      linuxProcesses.push({
        name: key,
        cwd: (proc.cwd || '').toLowerCase(),
        exe: (proc.exe || '').toLowerCase(),
        pid: proc.pid,
        appImagePath: appImagePath ? appImagePath.toLowerCase() : null,
        steamCompatDataPath: steamCompatDataPath ? steamCompatDataPath.toLowerCase() : null,
      });
    }

    if (!processMap[key]) processMap[key] = [];
    processMap[key].push(value);
  }

  return { processMap, winePrefixMap, linuxProcesses };
}

parentPort.on('message', (type) => {
  try {
    const processes = addon.listProcesses();
    if (type === 'map') {
      parentPort.postMessage({ type: 'map', result: buildMaps(processes) });
    } else {
      parentPort.postMessage({ type: 'list', result: processes });
    }
  } catch (_) {
    if (type === 'map') {
      parentPort.postMessage({ type: 'map', result: null });
    } else {
      parentPort.postMessage({ type: 'list', result: [] });
    }
  }
});
`;

type PendingResolver =
  | { type: "list"; resolve: (p: ProcessPayload[]) => void }
  | { type: "map"; resolve: (m: SystemProcessMap | null) => void };

export class NativeAddon {
  public static torrentInitialize(port: number) {
    return this.load().torrentInitialize(port);
  }

  public static torrentRequest(method: string, paramsJson: string) {
    return this.load().torrentRequest(method, paramsJson);
  }

  public static torrentShutdown() {
    // Quitting an app which never used torrenting must not load the addon.
    return this.nativeModule?.torrentShutdown() ?? Promise.resolve();
  }
  private static nativeModule: HydraNativeModule | null = null;
  private static worker: Worker | null = null;
  private static pendingResolvers: PendingResolver[] = [];

  private static resolveAddonPath() {
    if (app.isPackaged) {
      return path.join(
        process.resourcesPath,
        "hydra-native",
        "hydra-native.node"
      );
    }

    return path.join(app.getAppPath(), "hydra-native", "hydra-native.node");
  }

  private static load() {
    if (this.nativeModule) return this.nativeModule;

    const addonPath = this.resolveAddonPath();
    const addonDir = path.dirname(addonPath);

    if (!fs.existsSync(addonPath)) {
      throw new Error(`Hydra native addon not found at ${addonPath}`);
    }

    if (process.platform === "linux") {
      process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
        ? `${addonDir}:${process.env.LD_LIBRARY_PATH}`
        : addonDir;
    }

    const require = createRequire(import.meta.url);
    const nativeModule = require(addonPath) as HydraNativeModule;

    this.nativeModule = nativeModule;

    return nativeModule;
  }

  private static getWorker(): Worker {
    if (this.worker) return this.worker;

    const addonPath = this.resolveAddonPath();
    const addonDir = path.dirname(addonPath);

    if (!fs.existsSync(addonPath)) {
      throw new Error(`Hydra native addon not found at ${addonPath}`);
    }

    this.worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { addonPath, addonDir },
    });

    this.worker.on("message", ({ result }) => {
      const pending = this.pendingResolvers.shift();
      if (!pending) return;
      if (pending.type === "list") {
        (pending.resolve as (p: ProcessPayload[]) => void)(
          (result as ProcessPayload[]).filter(
            (p): p is ProcessPayload =>
              typeof p?.pid === "number" &&
              typeof p?.name === "string" &&
              p.name.length > 0
          )
        );
      } else {
        (pending.resolve as (m: SystemProcessMap | null) => void)(
          result as SystemProcessMap | null
        );
      }
    });

    this.worker.on("error", (error) => {
      logger.error("Process list worker error", error);
      this.drainResolvers();
    });

    this.worker.on("exit", (code) => {
      if (code !== 0)
        logger.error(`Process list worker exited with code ${code}`);
      this.worker = null;
      this.drainResolvers();
    });

    return this.worker;
  }

  public static processProfileImage(
    imagePath: string,
    targetExtension = "webp"
  ) {
    try {
      const response = this.load().processProfileImage(
        imagePath,
        targetExtension
      );

      const normalizedImagePath = response.imagePath ?? response.image_path;
      const normalizedMimeType = response.mimeType ?? response.mime_type;

      if (!normalizedImagePath || !normalizedMimeType) {
        throw new Error("Hydra native addon returned an invalid payload");
      }

      return {
        imagePath: normalizedImagePath,
        mimeType: normalizedMimeType,
      };
    } catch (error) {
      logger.error("Failed to process profile image via native addon", error);
      throw error;
    }
  }

  public static async processImage(
    imagePath: string,
    outputPathBase: string,
    width: number,
    height: number,
    preserveAnimation: boolean
  ) {
    try {
      const response = await this.load().processImage(
        imagePath,
        outputPathBase,
        width,
        height,
        preserveAnimation
      );

      const normalizedImagePath = response.imagePath ?? response.image_path;
      const normalizedMimeType = response.mimeType ?? response.mime_type;
      const normalizedIsAnimated =
        response.isAnimated ?? response.is_animated ?? false;

      if (!normalizedImagePath || !normalizedMimeType) {
        throw new Error("Hydra native addon returned an invalid payload");
      }

      return {
        imagePath: normalizedImagePath,
        mimeType: normalizedMimeType,
        isAnimated: normalizedIsAnimated,
      };
    } catch (error) {
      logger.error("Failed to process friend image via native addon", error);
      throw error;
    }
  }

  private static drainResolvers() {
    const drained = this.pendingResolvers.splice(0);
    for (const pending of drained) {
      if (pending.type === "list") pending.resolve([]);
      else pending.resolve(null);
    }
  }

  public static listProcesses(): Promise<ProcessPayload[]> {
    return new Promise((resolve) => {
      try {
        const worker = this.getWorker();
        this.pendingResolvers.push({ type: "list", resolve });
        worker.postMessage("list");
      } catch {
        resolve([]);
      }
    });
  }

  public static isProcessElevated(): boolean {
    try {
      return this.load().isProcessElevated?.() ?? false;
    } catch (error) {
      logger.error("Failed to check process elevation", error);
      return false;
    }
  }

  public static relaunchElevated(exePath: string): boolean {
    try {
      return this.load().relaunchElevated?.(exePath) ?? false;
    } catch (error) {
      logger.error("Failed to relaunch elevated", error);
      return false;
    }
  }

  public static sendTextInput(text: string): boolean {
    try {
      return this.load().sendTextInput?.(text) ?? false;
    } catch (error) {
      logger.error("Failed to send text input", error);
      return false;
    }
  }

  public static sendVirtualKeyChord(virtualKeys: number[]): boolean {
    try {
      return this.load().sendVirtualKeyChord?.(virtualKeys) ?? false;
    } catch (error) {
      logger.error("Failed to send virtual key chord", error);
      return false;
    }
  }

  public static isTextInputFocused(): boolean {
    try {
      return this.load().isTextInputFocused?.() ?? false;
    } catch (error) {
      logger.error("Failed to check text input focus", error);
      return false;
    }
  }

  public static focusGameWindow(executableNames: string[]): boolean {
    try {
      return this.load().focusGameWindow?.(executableNames) ?? false;
    } catch (error) {
      logger.error("Failed to focus game window", error);
      return false;
    }
  }

  public static getLinuxActiveWindow() {
    if (process.platform !== "linux") return null;

    try {
      const response = this.load().getLinuxActiveWindow();
      if (!response) return null;

      const windowId = response.windowId ?? response.window_id;
      if (!windowId) return null;

      return {
        windowId,
        processId: response.processId ?? response.process_id ?? null,
      };
    } catch (error) {
      logger.error("Failed to identify active Linux window", error);
      return null;
    }
  }

  public static getSystemProcessMap(): Promise<SystemProcessMap | null> {
    return new Promise((resolve) => {
      try {
        const worker = this.getWorker();
        this.pendingResolvers.push({ type: "map", resolve });
        worker.postMessage("map");
      } catch {
        resolve(null);
      }
    });
  }

  public static setPrimaryDisplayByBounds(
    bounds: NativeDisplayBounds
  ): boolean {
    try {
      return this.load().setPrimaryDisplayByBounds?.(bounds) ?? false;
    } catch (error) {
      logger.error("Failed to set primary display via native addon", error);
      return false;
    }
  }

  public static getDisplaySourceNameByBounds(
    bounds: NativeDisplayBounds
  ): string | null {
    try {
      return this.load().getDisplaySourceNameByBounds?.(bounds) ?? null;
    } catch (error) {
      logger.error("Failed to get display source name via native addon", error);
      return null;
    }
  }

  public static getPrimaryDisplaySourceName(): string | null {
    try {
      return this.load().getPrimaryDisplaySourceName?.() ?? null;
    } catch (error) {
      logger.error("Failed to get primary display source name", error);
      return null;
    }
  }

  public static setPrimaryDisplayBySourceName(sourceName: string): boolean {
    try {
      return this.load().setPrimaryDisplayBySourceName?.(sourceName) ?? false;
    } catch (error) {
      logger.error("Failed to set primary display by source name", error);
      return false;
    }
  }

  public static listAudioRenderDevices(): HydraAudioDevice[] {
    try {
      return this.load().listAudioRenderDevices?.() ?? [];
    } catch (error) {
      logger.error("Failed to list audio render devices", error);
      return [];
    }
  }

  public static getDefaultAudioRenderDeviceId(): string | null {
    try {
      return this.load().getDefaultAudioRenderDeviceId?.() ?? null;
    } catch (error) {
      logger.error("Failed to get default audio render device", error);
      return null;
    }
  }

  public static setDefaultAudioRenderDeviceId(id: string): boolean {
    try {
      return this.load().setDefaultAudioRenderDeviceId?.(id) ?? false;
    } catch (error) {
      logger.error("Failed to set default audio render device", error);
      return false;
    }
  }

  public static getDefaultAudioRenderDeviceIds(): AudioDeviceDefaults {
    try {
      const defaults = this.load().getDefaultAudioRenderDeviceIds?.();
      return {
        consoleId: defaults?.consoleId ?? null,
        multimediaId: defaults?.multimediaId ?? null,
      };
    } catch (error) {
      logger.error("Failed to get default audio render devices", error);
      return { consoleId: null, multimediaId: null };
    }
  }

  public static setDefaultAudioRenderDeviceIds(
    defaults: AudioDeviceDefaults
  ): boolean {
    try {
      return this.load().setDefaultAudioRenderDeviceIds?.(defaults) ?? false;
    } catch (error) {
      logger.error("Failed to restore default audio render devices", error);
      return false;
    }
  }

  public static buildLocalGameSnapshotPipeline(
    input: BuildLocalGameSnapshotPipelineInput
  ) {
    return this.load().buildLocalGameSnapshotPipeline(input);
  }

  public static getSaveRulesForGame(input: GetSaveRulesForGameInput) {
    return this.load().getSaveRulesForGame(input);
  }

  public static checkCloudSaveCustomPathOverlap(
    input: CheckCloudSaveCustomPathOverlapInput
  ) {
    return this.load().checkCloudSaveCustomPathOverlap(input);
  }

  public static buildSnapshotAggregateHash(
    input: BuildSnapshotAggregateHashInput
  ) {
    return this.load().buildSnapshotAggregateHash(input);
  }

  public static uploadLocalSaveBlob(
    absolutePath: string,
    uploadUrl: string,
    contentLength: string,
    checksumSha256: string
  ) {
    return this.load().uploadLocalSaveBlob(
      absolutePath,
      uploadUrl,
      contentLength,
      checksumSha256
    );
  }

  public static resolveRestoreTargets(input: ResolveRestoreTargetsInput) {
    return this.load().resolveRestoreTargets(input);
  }

  public static downloadRestoreBlobToTemp(
    snapshotId: string,
    hash: string,
    expectedSizeBytes: number,
    downloadUrl: string,
    tempRoot: string
  ) {
    return this.load().downloadRestoreBlobToTemp(
      snapshotId,
      hash,
      expectedSizeBytes,
      downloadUrl,
      tempRoot
    );
  }

  public static verifyDownloadedRestoreFile(
    tempPath: string,
    expectedHash: string
  ) {
    return this.load().verifyDownloadedRestoreFile(tempPath, expectedHash);
  }

  public static shouldSkipRestoreFile(input: ShouldSkipRestoreFileInput) {
    return this.load().shouldSkipRestoreFile(
      input.localPath,
      input.expectedHash
    );
  }

  public static replaceRestoreTargets(files: ReplaceRestoreTarget[]) {
    return this.load().replaceRestoreTargets(files);
  }

  public static deleteLocalSaveTargets(
    files: DeleteLocalSaveTarget[],
    cleanupRootPaths?: string[]
  ) {
    return this.load().deleteLocalSaveTargets(files, cleanupRootPaths);
  }

  public static cleanupRestoreTempSnapshot(
    snapshotId: string,
    tempRoot: string
  ) {
    return this.load().cleanupRestoreTempSnapshot(snapshotId, tempRoot);
  }

  private static useControllerStub() {
    return controllerStubEnabled;
  }

  private static controllerExportsWarned = false;

  private static hasControllerExports(): boolean {
    const mod = this.load();
    const missing =
      typeof mod.controllerList !== "function" ||
      typeof mod.controllerOnEvent !== "function";
    if (missing && !this.controllerExportsWarned) {
      this.controllerExportsWarned = true;
      logger.error(
        "Native addon has no controller exports — the .node binary predates the controller module or is for the wrong platform; controller detection is disabled"
      );
    }
    return !missing;
  }

  public static controllerList(): NativeControllerDeviceInfo[] {
    if (this.useControllerStub()) return controllerStub.list();
    try {
      if (!this.hasControllerExports()) return [];
      const devices = this.load().controllerList?.() ?? [];
      const backendError = this.load().controllerBackendError?.();
      if (backendError && !this.controllerExportsWarned) {
        this.controllerExportsWarned = true;
        logger.error(`Controller HID backend failed: ${backendError}`);
      }
      return devices;
    } catch (error) {
      logger.error("Failed to list controllers via native addon", error);
      return [];
    }
  }

  public static controllerStart(id: string): boolean {
    if (this.useControllerStub()) return controllerStub.start(id);
    try {
      return this.load().controllerStart?.(id) ?? false;
    } catch (error) {
      logger.error("Failed to start controller session", error);
      return false;
    }
  }

  public static controllerStop(id: string): boolean {
    if (this.useControllerStub()) return controllerStub.stop(id);
    try {
      return this.load().controllerStop?.(id) ?? false;
    } catch (error) {
      logger.error("Failed to stop controller session", error);
      return false;
    }
  }

  public static controllerSetLightbar(
    id: string,
    r: number,
    g: number,
    b: number,
    flashOn = 0,
    flashOff = 0
  ): boolean {
    if (this.useControllerStub()) {
      return controllerStub.setLightbar(id, r, g, b, flashOn, flashOff);
    }
    try {
      return (
        this.load().controllerSetLightbar?.(id, r, g, b, flashOn, flashOff) ??
        false
      );
    } catch (error) {
      logger.error("Failed to set controller lightbar", error);
      return false;
    }
  }

  public static controllerSetRumble(
    id: string,
    light: number,
    heavy: number
  ): boolean {
    if (this.useControllerStub()) {
      return controllerStub.setRumble(id, light, heavy);
    }
    try {
      return this.load().controllerSetRumble?.(id, light, heavy) ?? false;
    } catch (error) {
      logger.error("Failed to set controller rumble", error);
      return false;
    }
  }

  public static controllerSetMicLed(id: string, mode: number): boolean {
    if (this.useControllerStub()) return controllerStub.setMicLed(id, mode);
    try {
      return this.load().controllerSetMicLed?.(id, mode) ?? false;
    } catch (error) {
      logger.error("Failed to set controller mic LED", error);
      return false;
    }
  }

  public static controllerSetPlayerLeds(id: string, mask: number): boolean {
    if (this.useControllerStub()) {
      return controllerStub.setPlayerLeds(id, mask);
    }
    try {
      return this.load().controllerSetPlayerLeds?.(id, mask) ?? false;
    } catch (error) {
      logger.error("Failed to set controller player LEDs", error);
      return false;
    }
  }

  public static controllerSetTriggerEffect(
    id: string,
    left: boolean,
    mode: number,
    params: number[]
  ): boolean {
    if (this.useControllerStub()) {
      return controllerStub.setTriggerEffect(id, left, mode, params);
    }
    try {
      return (
        this.load().controllerSetTriggerEffect?.(id, left, mode, params) ??
        false
      );
    } catch (error) {
      logger.error("Failed to set controller trigger effect", error);
      return false;
    }
  }

  public static controllerIdentify(id: string): boolean {
    if (this.useControllerStub()) return controllerStub.identify(id);
    try {
      return this.load().controllerIdentify?.(id) ?? false;
    } catch (error) {
      logger.error("Failed to identify controller", error);
      return false;
    }
  }

  public static controllerSetProfile(id: string, profileJson: string): boolean {
    if (this.useControllerStub()) {
      return controllerStub.setProfile(id, profileJson);
    }
    try {
      return this.load().controllerSetProfile?.(id, profileJson) ?? false;
    } catch (error) {
      logger.error("Failed to set controller profile", error);
      return false;
    }
  }

  public static controllerReadRaw(id: string): NativeControllerState | null {
    if (this.useControllerStub()) return controllerStub.readRaw(id);
    try {
      return this.load().controllerReadRaw?.(id) ?? null;
    } catch (error) {
      logger.error("Failed to read raw controller state", error);
      return null;
    }
  }

  public static controllerSetVirtualOutput(
    id: string,
    enabled: boolean
  ): boolean {
    if (this.useControllerStub()) {
      return controllerStub.setVirtualOutput(id, enabled);
    }
    try {
      return this.load().controllerSetVirtualOutput?.(id, enabled) ?? false;
    } catch (error) {
      logger.error("Failed to set controller virtual output", error);
      return false;
    }
  }

  public static controllerVirtualOutputSupport(): string {
    if (this.useControllerStub()) return controllerStub.virtualOutputSupport();
    try {
      return this.load().controllerVirtualOutputSupport?.() ?? "unavailable";
    } catch (error) {
      logger.error("Failed to probe virtual output support", error);
      return "unavailable";
    }
  }

  public static controllerSetHidden(id: string, enabled: boolean): boolean {
    if (this.useControllerStub()) {
      return controllerStub.setHidden(id, enabled);
    }
    try {
      return this.load().controllerSetHidden?.(id, enabled) ?? false;
    } catch (error) {
      logger.error("Failed to set controller hidden state", error);
      return false;
    }
  }

  public static controllerHidingSupport(): string {
    if (this.useControllerStub()) return controllerStub.hidingSupport();
    try {
      return this.load().controllerHidingSupport?.() ?? "unavailable";
    } catch (error) {
      logger.error("Failed to probe hiding support", error);
      return "unavailable";
    }
  }

  public static controllerOnEvent(
    callback: (event: NativeControllerEvent) => void
  ): boolean {
    if (this.useControllerStub()) return controllerStub.onEvent(callback);
    try {
      if (!this.hasControllerExports()) return false;
      this.load().controllerOnEvent?.(callback);
      return true;
    } catch (error) {
      logger.error("Failed to subscribe to controller events", error);
      return false;
    }
  }
}
