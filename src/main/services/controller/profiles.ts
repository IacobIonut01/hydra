import { randomUUID } from "node:crypto";

import { controllerProfilesSublevel } from "@main/level";
import type { ControllerProfile, ControllerProfilePayload } from "@types";

export const BUILTIN_CONTROLLER_PROFILES: ControllerProfile[] = [
  {
    id: "default",
    name: "Default",
    builtin: true,
    lightbar: { mode: "static", r: 0, g: 0, b: 255, flashAt: 0 },
    playerLedCount: 0,
    micLed: 0,
    stickDeadzone: 0,
    swapSticks: false,
    remap: {},
  },
  {
    id: "fps",
    name: "FPS",
    builtin: true,
    lightbar: { mode: "static", r: 255, g: 0, b: 0, flashAt: 20 },
    playerLedCount: 0,
    micLed: 0,
    stickDeadzone: 0.08,
    swapSticks: false,
    remap: {},
  },
  {
    id: "battery-indicator",
    name: "Battery Indicator",
    builtin: true,
    lightbar: { mode: "battery", r: 0, g: 0, b: 0, flashAt: 15 },
    playerLedCount: 0,
    micLed: 0,
    stickDeadzone: 0,
    swapSticks: false,
    remap: {},
  },
];

const builtinIds = new Set(BUILTIN_CONTROLLER_PROFILES.map((p) => p.id));

export const toProfilePayload = (
  profile: ControllerProfile
): ControllerProfilePayload => ({
  name: profile.name,
  lightbar: profile.lightbar,
  playerLedCount: profile.playerLedCount,
  micLed: profile.micLed,
  stickDeadzone: profile.stickDeadzone,
  swapSticks: profile.swapSticks,
  remap: profile.remap,
});

export const listControllerProfiles = async (): Promise<
  ControllerProfile[]
> => {
  const stored = await controllerProfilesSublevel.values().all();
  const customs = stored.filter((p) => !builtinIds.has(p.id));
  return [...BUILTIN_CONTROLLER_PROFILES, ...customs];
};

export const getControllerProfile = async (
  id: string
): Promise<ControllerProfile | null> => {
  const builtin = BUILTIN_CONTROLLER_PROFILES.find((p) => p.id === id);
  if (builtin) return builtin;

  try {
    return (await controllerProfilesSublevel.get(id)) ?? null;
  } catch {
    return null;
  }
};

export const saveControllerProfile = async (
  profile: Omit<ControllerProfile, "id" | "builtin"> & { id?: string }
): Promise<ControllerProfile> => {
  const existing = profile.id ? await getControllerProfile(profile.id) : null;
  const id =
    profile.id && !builtinIds.has(profile.id) ? profile.id : randomUUID();

  const stored: ControllerProfile = {
    ...existing,
    ...profile,
    id,
    builtin: false,
  };

  await controllerProfilesSublevel.put(id, stored);
  return stored;
};

export const deleteControllerProfile = async (id: string): Promise<boolean> => {
  if (builtinIds.has(id)) return false;
  await controllerProfilesSublevel.del(id);
  return true;
};
