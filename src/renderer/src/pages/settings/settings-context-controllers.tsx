import "./settings-controllers.scss";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { WarningIcon } from "@phosphor-icons/react";

import { Button, CheckboxField, SelectField } from "@renderer/components";
import { useAppSelector } from "@renderer/hooks";
import type {
  ControllerDeviceInfo,
  ControllerProfile,
  ControllerState,
  LightbarMode,
  HidingSupport,
  VirtualOutputSupport,
} from "@types";
import {
  DEADZONE_OPTIONS,
  FLASH_AT_OPTIONS,
  LIGHTBAR_SWATCHES,
  MIC_LED_OPTIONS,
  PLAYER_LED_MAX,
  REMAP_DEFAULT_VALUE,
  REMAP_OUTPUT_IDS,
  REMAP_UNBOUND_VALUE,
  TRIGGER_EFFECT_PRESETS,
} from "@shared";

import { ControllerRemapDiagram } from "./controller-remap-diagram";

const CONTROL_LABEL_KEYS: Record<string, string> = {
  cross: "controllers_control_cross",
  circle: "controllers_control_circle",
  square: "controllers_control_square",
  triangle: "controllers_control_triangle",
  dpadUp: "controllers_control_dpad_up",
  dpadDown: "controllers_control_dpad_down",
  dpadLeft: "controllers_control_dpad_left",
  dpadRight: "controllers_control_dpad_right",
  l1: "controllers_control_l1",
  r1: "controllers_control_r1",
  l2: "controllers_control_l2",
  r2: "controllers_control_r2",
  l3: "controllers_control_l3",
  r3: "controllers_control_r3",
  share: "controllers_control_share",
  options: "controllers_control_options",
  ps: "controllers_control_ps",
  touchClick: "controllers_control_touch_click",
  mute: "controllers_control_mute",
  fnL: "controllers_control_fn_left",
  fnR: "controllers_control_fn_right",
  paddleLeft: "controllers_control_paddle_left",
  paddleRight: "controllers_control_paddle_right",
};

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

function modelLabel(device: ControllerDeviceInfo): string {
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

function profilePayload(
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

interface DeviceEditorProps {
  device: ControllerDeviceInfo;
  profiles: ControllerProfile[];
  assignedProfileId: string | null;
  virtualOutputAvailable: boolean;
  hidingSupport: HidingSupport;
  onProfilesChanged: () => void;
}

function ControllerDeviceEditor({
  device,
  profiles,
  assignedProfileId,
  virtualOutputAvailable,
  hidingSupport,
  onProfilesChanged,
}: Readonly<DeviceEditorProps>) {
  const { t } = useTranslation("settings");
  const electron = globalThis.window.electron;
  const hidingAvailable =
    hidingSupport === "hidhide-available" || hidingSupport === "evdev-grab";

  const [liveState, setLiveState] = useState<ControllerState | null>(null);

  useEffect(() => {
    return electron.onControllerState((payload) => {
      if (payload.deviceId === device.id && payload.state) {
        setLiveState(payload.state);
      }
    });
  }, [device.id, electron]);

  const profile = useMemo(
    () =>
      profiles.find((candidate) => candidate.id === assignedProfileId) ??
      profiles.find((candidate) => candidate.id === "default") ??
      null,
    [assignedProfileId, profiles]
  );

  const isDualSense =
    device.model === "dualsense" || device.model === "dualsense-edge";

  const mutateProfile = useCallback(
    async (patch: Partial<Omit<ControllerProfile, "id" | "builtin">>) => {
      if (!profile) return;

      if (profile.builtin) {
        const saved = await electron.saveControllerProfile({
          ...profilePayload(profile),
          ...patch,
          name: `${profile.name} ${t("controllers_profile_copy_suffix")}`,
        });
        await electron.assignControllerProfile(device.id, saved.id);
      } else {
        await electron.saveControllerProfile({
          ...profilePayload(profile),
          ...patch,
          id: profile.id,
        });
      }

      onProfilesChanged();
    },
    [device.id, electron, onProfilesChanged, profile, t]
  );

  const applyLightbar = useCallback(
    (r: number, g: number, b: number) => {
      const flashAt = profile?.lightbar.flashAt ?? 0;
      electron.setControllerLightbar(device.id, r, g, b, flashAt, flashAt);
      void mutateProfile({
        lightbar: { mode: "static", r, g, b, flashAt },
      });
    },
    [device.id, electron, mutateProfile, profile?.lightbar.flashAt]
  );

  const profileOptions = useMemo(
    () =>
      profiles.map((candidate) => ({
        key: candidate.id,
        value: candidate.id,
        label: candidate.builtin
          ? `${candidate.name} (${t("controllers_profile_builtin")})`
          : candidate.name,
      })),
    [profiles, t]
  );

  const lightbarModeOptions = useMemo(
    () =>
      (["static", "rainbow", "battery"] as LightbarMode[]).map((mode) => ({
        key: mode,
        value: mode,
        label: t(`controllers_lightbar_mode_${mode}`),
      })),
    [t]
  );

  const flashAtOptions = useMemo(
    () =>
      FLASH_AT_OPTIONS.map((percent) => ({
        key: String(percent),
        value: String(percent),
        label:
          percent === 0
            ? t("controllers_flash_at_off")
            : t("controllers_flash_at_percent", { percent }),
      })),
    [t]
  );

  const deadzoneOptions = useMemo(
    () =>
      DEADZONE_OPTIONS.map((value) => ({
        key: String(value),
        value: String(value),
        label: t("controllers_deadzone_percent", {
          percent: Math.round(value * 100),
        }),
      })),
    [t]
  );

  const micLedOptions = useMemo(
    () =>
      MIC_LED_OPTIONS.map((mode) => ({
        key: String(mode),
        value: String(mode),
        label: t(
          mode === 0
            ? "controllers_mic_led_off"
            : mode === 1
              ? "controllers_mic_led_on"
              : "controllers_mic_led_pulse"
        ),
      })),
    [t]
  );

  const playerLedOptions = useMemo(
    () =>
      Array.from({ length: PLAYER_LED_MAX + 1 }, (_unused, count) => ({
        key: String(count),
        value: String(count),
        label:
          count === 0
            ? t("controllers_player_leds_off")
            : t("controllers_player_leds_count", { count }),
      })),
    [t]
  );

  const triggerEffectOptions = useMemo(
    () =>
      TRIGGER_EFFECT_PRESETS.map((preset) => ({
        key: preset.value,
        value: preset.value,
        label: t(`controllers_trigger_${preset.value}`),
      })),
    [t]
  );

  const remapOptions = useMemo(
    () => [
      {
        key: REMAP_DEFAULT_VALUE,
        value: REMAP_DEFAULT_VALUE,
        label: t("controllers_remap_default"),
      },
      ...REMAP_OUTPUT_IDS.map((id) => ({
        key: id,
        value: id,
        label: t(CONTROL_LABEL_KEYS[id]),
      })),
      {
        key: REMAP_UNBOUND_VALUE,
        value: REMAP_UNBOUND_VALUE,
        label: t("controllers_remap_unbound"),
      },
    ],
    [t]
  );

  const lightbarMode = profile?.lightbar.mode ?? "static";
  const batteryLabel = !liveState
    ? t("controllers_battery_unknown")
    : liveState.charging
      ? t("controllers_battery_charging", {
          percent: Math.round(liveState.battery),
        })
      : t("controllers_battery_percent", {
          percent: Math.round(liveState.battery),
        });
  const connectionLabel =
    device.connection === "bt"
      ? t("controllers_connection_bt")
      : t("controllers_connection_usb");

  return (
    <div className="settings-controllers__device">
      <div className="settings-controllers__device-header">
        <h4>{device.name}</h4>
        <span className="settings-controllers__device-meta">
          {modelLabel(device)} · {connectionLabel} · {batteryLabel}
        </span>
      </div>

      <SelectField
        label={t("controllers_profile")}
        value={profile?.id ?? ""}
        options={profileOptions}
        onChange={(event) => {
          void electron
            .assignControllerProfile(device.id, event.target.value)
            .then(onProfilesChanged);
        }}
      />

      <div className="settings-controllers__button-row">
        <Button
          theme="outline"
          onClick={() => electron.identifyController(device.id)}
        >
          {t("controllers_identify")}
        </Button>
        <Button
          theme="outline"
          onClick={() =>
            electron.previewControllerRumble(device.id, 255, 255, 400)
          }
        >
          {t("controllers_test_rumble")}
        </Button>
      </div>

      <SelectField
        label={t("controllers_lightbar_mode")}
        value={lightbarMode}
        options={lightbarModeOptions}
        onChange={(event) => {
          void mutateProfile({
            lightbar: {
              ...(profile?.lightbar ?? { r: 0, g: 0, b: 255, flashAt: 0 }),
              mode: event.target.value as LightbarMode,
            },
          });
        }}
      />

      {lightbarMode === "static" ? (
        <div className="settings-controllers__color-row">
          <div className="settings-controllers__swatches">
            {LIGHTBAR_SWATCHES.map((swatch) => {
              const isSelected =
                profile?.lightbar.mode === "static" &&
                profile.lightbar.r === swatch.r &&
                profile.lightbar.g === swatch.g &&
                profile.lightbar.b === swatch.b;

              return (
                <button
                  key={swatch.key}
                  type="button"
                  className="settings-controllers__swatch"
                  data-selected={isSelected || undefined}
                  title={t(`controllers_swatch_${swatch.key}`)}
                  style={{
                    background: `rgb(${swatch.r} ${swatch.g} ${swatch.b})`,
                  }}
                  onClick={() => applyLightbar(swatch.r, swatch.g, swatch.b)}
                />
              );
            })}
          </div>
          <input
            type="color"
            className="settings-controllers__color-input"
            aria-label={t("controllers_custom_color")}
            value={toHex(
              profile?.lightbar.r ?? 0,
              profile?.lightbar.g ?? 0,
              profile?.lightbar.b ?? 255
            )}
            onChange={(event) => {
              const value = parseInt(event.target.value.slice(1), 16);
              applyLightbar(value >> 16, (value >> 8) & 0xff, value & 0xff);
            }}
          />
        </div>
      ) : null}

      <SelectField
        label={t("controllers_flash_at")}
        value={String(profile?.lightbar.flashAt ?? 0)}
        options={flashAtOptions}
        onChange={(event) => {
          void mutateProfile({
            lightbar: {
              ...(profile?.lightbar ?? {
                mode: "static",
                r: 0,
                g: 0,
                b: 255,
              }),
              flashAt: Number(event.target.value),
            },
          });
        }}
      />

      {isDualSense ? (
        <>
          <SelectField
            label={t("controllers_player_leds")}
            value={String(profile?.playerLedCount ?? 0)}
            options={playerLedOptions}
            onChange={(event) => {
              void mutateProfile({
                playerLedCount: Number(event.target.value),
              });
            }}
          />

          <SelectField
            label={t("controllers_mic_led")}
            value={String(profile?.micLed ?? 0)}
            options={micLedOptions}
            onChange={(event) => {
              void mutateProfile({ micLed: Number(event.target.value) });
            }}
          />

          <SelectField
            label={t("controllers_trigger_effect")}
            value="off"
            options={triggerEffectOptions}
            onChange={(event) => {
              const preset = TRIGGER_EFFECT_PRESETS.find(
                (candidate) => candidate.value === event.target.value
              );
              if (!preset) return;
              for (const side of ["left", "right"] as const) {
                electron.setControllerTriggerEffect(
                  device.id,
                  side,
                  preset.mode,
                  preset.params
                );
              }
            }}
          />
        </>
      ) : null}

      <SelectField
        label={t("controllers_deadzone")}
        value={String(profile?.stickDeadzone ?? 0)}
        options={deadzoneOptions}
        onChange={(event) => {
          void mutateProfile({ stickDeadzone: Number(event.target.value) });
        }}
      />

      <CheckboxField
        label={t("controllers_swap_sticks")}
        checked={profile?.swapSticks ?? false}
        onChange={() => {
          void mutateProfile({ swapSticks: !(profile?.swapSticks ?? false) });
        }}
      />

      {hidingAvailable && !device.hidden ? (
        <div className="settings-controllers__warning" role="alert">
          <WarningIcon
            size={20}
            weight="bold"
            className="settings-controllers__warning-icon"
          />
          <div className="settings-controllers__warning-body">
            <p className="settings-controllers__warning-text">
              {t("controllers_exclusive_warning")}
            </p>
            <p className="settings-controllers__warning-fix">
              {t("controllers_exclusive_warning_fix")}
            </p>
            {hidingSupport === "hidhide-available" ? (
              <p className="settings-controllers__warning-fix">
                {t("controllers_exclusive_warning_hidhide")}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {virtualOutputAvailable ? (
        <CheckboxField
          label={t("controllers_virtual_output")}
          checked={device.virtualOutput}
          onChange={() => {
            void electron.setControllerVirtualOutput(
              device.id,
              !device.virtualOutput
            );
          }}
        />
      ) : null}

      {hidingAvailable ? (
        <CheckboxField
          label={t("controllers_hide_device")}
          checked={device.hidden}
          onChange={() => {
            void electron.setControllerHidden(device.id, !device.hidden);
          }}
        />
      ) : null}

      <div className="settings-controllers__mapping-header">
        <h4>{t("controllers_mapping_title")}</h4>
        <span className="settings-controllers__live-pressed">
          {t("controllers_pressed_label", {
            controls:
              (liveState?.pressed ?? [])
                .filter((control) => CONTROL_LABEL_KEYS[control])
                .map((control) => t(CONTROL_LABEL_KEYS[control]))
                .join(" + ") || t("controllers_pressed_none"),
          })}
        </span>
      </div>

      <ControllerRemapDiagram
        device={device}
        profile={profile}
        liveState={liveState}
        lightbarColor={
          profile?.lightbar.mode === "static"
            ? `rgb(${profile.lightbar.r} ${profile.lightbar.g} ${profile.lightbar.b})`
            : undefined
        }
        remapOptions={remapOptions}
        controlLabel={(controlId) => t(CONTROL_LABEL_KEYS[controlId])}
        remapAriaLabel={(control, target) =>
          t("controllers_remap_aria", { control, target })
        }
        onRemap={(controlId, value) => {
          const remap = { ...(profile?.remap ?? {}) };
          if (value === REMAP_DEFAULT_VALUE) {
            delete remap[controlId];
          } else {
            remap[controlId] = value;
          }
          void mutateProfile({ remap });
        }}
      />

      <div className="settings-controllers__button-row">
        <Button
          theme="outline"
          onClick={() => {
            if (!profile) return;
            void (async () => {
              const saved = await electron.saveControllerProfile({
                ...profilePayload(profile),
                name: `${profile.name} ${t("controllers_profile_copy_suffix")}`,
              });
              await electron.assignControllerProfile(device.id, saved.id);
              onProfilesChanged();
            })();
          }}
        >
          {t("controllers_save_as")}
        </Button>
        {profile && !profile.builtin ? (
          <Button
            theme="danger"
            onClick={() => {
              void electron
                .deleteControllerProfile(profile.id)
                .then(onProfilesChanged);
            }}
          >
            {t("controllers_delete_profile")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsContextControllers() {
  const { t } = useTranslation("settings");
  const electron = globalThis.window.electron;

  const userPreferences = useAppSelector(
    (state) => state.userPreferences.value
  );

  const [devices, setDevices] = useState<ControllerDeviceInfo[]>([]);
  const [profiles, setProfiles] = useState<ControllerProfile[]>([]);
  const [virtualOutputSupport, setVirtualOutputSupport] =
    useState<VirtualOutputSupport>("unavailable");
  const [hidingSupport, setHidingSupport] =
    useState<HidingSupport>("unavailable");

  const enabled = userPreferences?.controllerEnabled !== false;
  const assignments = userPreferences?.controllerAssignments ?? {};

  const reloadProfiles = useCallback(() => {
    void electron
      .getControllerProfiles()
      .then(setProfiles)
      .catch(() => undefined);
  }, [electron]);

  useEffect(() => {
    void electron
      .getControllers()
      .then(setDevices)
      .catch(() => undefined);
    reloadProfiles();
    void electron
      .getVirtualOutputSupport()
      .then(setVirtualOutputSupport)
      .catch(() => undefined);
    void electron
      .getHidingSupport()
      .then(setHidingSupport)
      .catch(() => undefined);

    return electron.onControllerDevicesChanged(setDevices);
  }, [electron, reloadProfiles]);

  const virtualOutputHint = useMemo(() => {
    switch (virtualOutputSupport) {
      case "vigem-available":
        return t("controllers_virtual_output_vigem");
      case "uinput-available":
        return t("controllers_virtual_output_uinput");
      case "uinput-blocked":
        return t("controllers_virtual_output_uinput_blocked");
      case "vigem-unavailable":
        return t("controllers_virtual_output_vigem_unavailable");
      default:
        return null;
    }
  }, [t, virtualOutputSupport]);

  const hidingHint = useMemo(() => {
    switch (hidingSupport) {
      case "hidhide-unavailable":
        return t("controllers_hiding_hidhide_unavailable");
      case "evdev-grab":
        return t("controllers_hiding_evdev");
      default:
        return null;
    }
  }, [t, hidingSupport]);

  return (
    <div className="settings-context-panel">
      <div className="settings-context-panel__group">
        <h3>{t("controllers_section_title")}</h3>

        <CheckboxField
          label={t("controllers_enable")}
          checked={enabled}
          onChange={() => electron.setControllerEnabled(!enabled)}
        />

        <Button
          theme="outline"
          onClick={() => {
            void electron.restartControllerService().then(() => {
              void electron
                .getVirtualOutputSupport()
                .then(setVirtualOutputSupport)
                .catch(() => undefined);
              void electron
                .getHidingSupport()
                .then(setHidingSupport)
                .catch(() => undefined);
            });
          }}
        >
          {t("controllers_restart_service")}
        </Button>

        {virtualOutputHint ? (
          <p className="settings-controllers__hint">{virtualOutputHint}</p>
        ) : null}

        {hidingHint ? (
          <p className="settings-controllers__hint">{hidingHint}</p>
        ) : null}
      </div>

      {enabled ? (
        <div className="settings-context-panel__group">
          <h3>{t("controllers_devices_title")}</h3>

          {devices.length === 0 ? (
            <p className="settings-controllers__empty">
              {t("controllers_empty_description")}
            </p>
          ) : (
            devices.map((device) => (
              <ControllerDeviceEditor
                key={device.id}
                device={device}
                profiles={profiles}
                assignedProfileId={assignments[device.id] ?? null}
                virtualOutputAvailable={
                  virtualOutputSupport === "uinput-available" ||
                  virtualOutputSupport === "vigem-available"
                }
                hidingSupport={hidingSupport}
                onProfilesChanged={reloadProfiles}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
