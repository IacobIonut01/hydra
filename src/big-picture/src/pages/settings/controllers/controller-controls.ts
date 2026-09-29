import type {
  ControllerDeviceInfo,
  ControllerProfile,
  LightbarMode,
} from "@types";
import { EDGE_EXTRA_CONTROL_IDS, MAPPABLE_CONTROL_IDS } from "@shared";

export {
  DEADZONE_OPTIONS,
  FLASH_AT_OPTIONS,
  LIGHTBAR_SWATCHES,
  MIC_LED_OPTIONS,
  PLAYER_LED_MAX,
  REMAP_DEFAULT_VALUE,
  REMAP_OUTPUT_IDS,
  REMAP_UNBOUND_VALUE,
} from "@shared";
import { TRIGGER_EFFECT_PRESETS as SHARED_TRIGGER_PRESETS } from "@shared";

export const CONTROL_LABEL_KEYS: Record<string, string> = {
  cross: "settings_controllers_control_cross",
  circle: "settings_controllers_control_circle",
  square: "settings_controllers_control_square",
  triangle: "settings_controllers_control_triangle",
  dpadUp: "settings_controllers_control_dpad_up",
  dpadDown: "settings_controllers_control_dpad_down",
  dpadLeft: "settings_controllers_control_dpad_left",
  dpadRight: "settings_controllers_control_dpad_right",
  l1: "settings_controllers_control_l1",
  r1: "settings_controllers_control_r1",
  l2: "settings_controllers_control_l2",
  r2: "settings_controllers_control_r2",
  l3: "settings_controllers_control_l3",
  r3: "settings_controllers_control_r3",
  share: "settings_controllers_control_share",
  options: "settings_controllers_control_options",
  ps: "settings_controllers_control_ps",
  touchClick: "settings_controllers_control_touch_click",
  mute: "settings_controllers_control_mute",
  fnL: "settings_controllers_control_fn_left",
  fnR: "settings_controllers_control_fn_right",
  paddleLeft: "settings_controllers_control_paddle_left",
  paddleRight: "settings_controllers_control_paddle_right",
};

export const LIGHTBAR_MODE_OPTIONS: ReadonlyArray<{
  value: LightbarMode;
  labelKey: string;
}> = [
  { value: "static", labelKey: "settings_controllers_lightbar_mode_static" },
  { value: "rainbow", labelKey: "settings_controllers_lightbar_mode_rainbow" },
  { value: "battery", labelKey: "settings_controllers_lightbar_mode_battery" },
];

export const TRIGGER_EFFECT_PRESETS: ReadonlyArray<{
  value: string;
  labelKey: string;
  mode: number;
  params: number[];
}> = SHARED_TRIGGER_PRESETS.map((preset) => ({
  ...preset,
  labelKey: `settings_controllers_trigger_${preset.value}`,
}));

/** Physical controls shown in the remap editor, in display order. */
export const MAPPABLE_CONTROLS: ReadonlyArray<{
  id: string;
  labelKey: string;
}> = MAPPABLE_CONTROL_IDS.map((id) => ({
  id,
  labelKey: CONTROL_LABEL_KEYS[id],
}));

export const EDGE_EXTRA_CONTROLS: ReadonlyArray<{
  id: string;
  labelKey: string;
}> = EDGE_EXTRA_CONTROL_IDS.map((id) => ({
  id,
  labelKey: CONTROL_LABEL_KEYS[id],
}));

export function modelLabel(device: ControllerDeviceInfo): string {
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
}

export function defaultProfileFor(
  profile: ControllerProfile
): Omit<ControllerProfile, "id" | "builtin"> {
  return {
    name: profile.name,
    lightbar: { ...profile.lightbar },
    playerLedCount: profile.playerLedCount,
    micLed: profile.micLed,
    stickDeadzone: profile.stickDeadzone,
    swapSticks: profile.swapSticks,
    remap: { ...profile.remap },
  };
}
