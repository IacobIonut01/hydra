import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { WarningIcon } from "@phosphor-icons/react";

import {
  Button,
  Checkbox,
  DropdownSelect,
  FocusItem,
  GridFocusGroup,
  Input,
  VerticalFocusGroup,
  type DropdownSelectOption,
} from "../../../components";
import type { FocusOverrides, FocusOverrideTarget } from "../../../services";
import type {
  ControllerDeviceInfo,
  ControllerProfile,
  ControllerState,
  HidingSupport,
  VirtualOutputSupport,
} from "@types";

import {
  CONTROL_LABEL_KEYS,
  DEADZONE_OPTIONS,
  FLASH_AT_OPTIONS,
  LIGHTBAR_MODE_OPTIONS,
  LIGHTBAR_SWATCHES,
  MIC_LED_OPTIONS,
  PLAYER_LED_MAX,
  REMAP_DEFAULT_VALUE,
  REMAP_OUTPUT_IDS,
  REMAP_UNBOUND_VALUE,
  TRIGGER_EFFECT_PRESETS,
  defaultProfileFor,
  modelLabel,
} from "./controller-controls";
import { ControllerRemapDiagram } from "./controller-diagram";
import { SettingsSection } from "../settings-section";
import {
  getControllerDeviceRegionId,
  getControllerItemFocusId,
  getControllerSwatchFocusId,
} from "../settings-navigation";

type SequenceEntry =
  | { kind: "item"; focusId: string }
  | { kind: "region"; regionId: string };

const toTarget = (entry: SequenceEntry | undefined): FocusOverrideTarget => {
  if (!entry) return { type: "block" };
  if (entry.kind === "region") {
    return {
      type: "region",
      regionId: entry.regionId,
      entryDirection: "down",
    };
  }
  return { type: "item", itemId: entry.focusId };
};

const buildLinearOverrides = (sequence: SequenceEntry[]) => {
  const itemOverrides: Record<string, FocusOverrides> = {};
  const regionOverrides: Record<string, FocusOverrides> = {};

  sequence.forEach((entry, index) => {
    const overrides: FocusOverrides = {
      up: toTarget(sequence[index - 1]),
      down: toTarget(sequence[index + 1]),
    };

    if (entry.kind === "region") {
      regionOverrides[entry.regionId] = overrides;
    } else {
      itemOverrides[entry.focusId] = overrides;
    }
  });

  return { itemOverrides, regionOverrides };
};

interface ControllerDeviceCardProps {
  device: ControllerDeviceInfo;
  profiles: ControllerProfile[];
  assignedProfileId: string | null;
  virtualOutputSupport: VirtualOutputSupport;
  hidingSupport: HidingSupport;
  onProfilesChanged: () => void;
}

export function ControllerDeviceCard({
  device,
  profiles,
  assignedProfileId,
  virtualOutputSupport,
  hidingSupport,
  onProfilesChanged,
}: Readonly<ControllerDeviceCardProps>) {
  const { t } = useTranslation("big_picture");
  const electron = globalThis.window.electron;

  const [liveState, setLiveState] = useState<ControllerState | null>(null);
  const [hexDraft, setHexDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const unsubscribe = electron.onControllerState((payload) => {
      if (payload.deviceId === device.id && payload.state) {
        setLiveState(payload.state);
      }
    });

    return () => unsubscribe();
  }, [device.id, electron]);

  const profile = useMemo(() => {
    return (
      profiles.find((candidate) => candidate.id === assignedProfileId) ??
      profiles.find((candidate) => candidate.id === "default") ??
      null
    );
  }, [assignedProfileId, profiles]);

  const isDualSense =
    device.model === "dualsense" || device.model === "dualsense-edge";
  const virtualOutputAvailable =
    virtualOutputSupport === "uinput-available" ||
    virtualOutputSupport === "vigem-available";
  const hidingAvailable =
    hidingSupport === "hidhide-available" || hidingSupport === "evdev-grab";

  const regionId = getControllerDeviceRegionId(device.id);
  const swatchRegionId = `${regionId}-swatches`;
  const diagramRegionId = `${regionId}-diagram`;

  const profileOptions = useMemo<Array<DropdownSelectOption<string>>>(
    () =>
      profiles.map((candidate) => ({
        value: candidate.id,
        label: candidate.builtin
          ? `${candidate.name} (${t("settings_controllers_profile_builtin")})`
          : candidate.name,
      })),
    [profiles, t]
  );

  const lightbarModeOptions = useMemo<Array<DropdownSelectOption<string>>>(
    () =>
      LIGHTBAR_MODE_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      })),
    [t]
  );

  const flashAtOptions = useMemo<Array<DropdownSelectOption<string>>>(
    () =>
      FLASH_AT_OPTIONS.map((percent) => ({
        value: String(percent),
        label:
          percent === 0
            ? t("settings_controllers_flash_at_off")
            : t("settings_controllers_flash_at_percent", { percent }),
      })),
    [t]
  );

  const deadzoneOptions = useMemo<Array<DropdownSelectOption<string>>>(
    () =>
      DEADZONE_OPTIONS.map((value) => ({
        value: String(value),
        label: t("settings_controllers_deadzone_percent", {
          percent: Math.round(value * 100),
        }),
      })),
    [t]
  );

  const micLedOptions = useMemo<Array<DropdownSelectOption<string>>>(
    () =>
      MIC_LED_OPTIONS.map((mode) => ({
        value: String(mode),
        label: t(
          mode === 0
            ? "settings_controllers_mic_led_off"
            : mode === 1
              ? "settings_controllers_mic_led_on"
              : "settings_controllers_mic_led_pulse"
        ),
      })),
    [t]
  );

  const playerLedOptions = useMemo<Array<DropdownSelectOption<string>>>(
    () =>
      Array.from({ length: PLAYER_LED_MAX + 1 }, (_unused, count) => ({
        value: String(count),
        label:
          count === 0
            ? t("settings_controllers_player_leds_off")
            : t("settings_controllers_player_leds_count", { count }),
      })),
    [t]
  );

  const triggerEffectOptions = useMemo<Array<DropdownSelectOption<string>>>(
    () =>
      TRIGGER_EFFECT_PRESETS.map((preset) => ({
        value: preset.value,
        label: t(preset.labelKey),
      })),
    [t]
  );

  const remapOptions = useMemo<Array<DropdownSelectOption<string>>>(
    () => [
      {
        value: REMAP_DEFAULT_VALUE,
        label: t("settings_controllers_remap_default"),
      },
      ...REMAP_OUTPUT_IDS.map((id) => ({
        value: id,
        label: t(CONTROL_LABEL_KEYS[id]),
      })),
      {
        value: REMAP_UNBOUND_VALUE,
        label: t("settings_controllers_remap_unbound"),
      },
    ],
    [t]
  );

  const mutateProfile = useCallback(
    async (patch: Partial<Omit<ControllerProfile, "id" | "builtin">>) => {
      if (!profile) return;
      setSaving(true);

      try {
        if (profile.builtin) {
          const saved = await electron.saveControllerProfile({
            ...defaultProfileFor(profile),
            ...patch,
            name: `${profile.name} ${t("settings_controllers_profile_copy_suffix")}`,
          });
          await electron.assignControllerProfile(device.id, saved.id);
        } else {
          await electron.saveControllerProfile({
            ...defaultProfileFor(profile),
            ...patch,
            id: profile.id,
          });
        }

        onProfilesChanged();
      } finally {
        setSaving(false);
      }
    },
    [device.id, electron, onProfilesChanged, profile, t]
  );

  const applyLightbar = useCallback(
    async (r: number, g: number, b: number, flashAt?: number) => {
      const flash =
        flashAt !== undefined ? flashAt : (profile?.lightbar.flashAt ?? 0);
      electron.setControllerLightbar(device.id, r, g, b, flash, flash);
      await mutateProfile({
        lightbar: { mode: "static", r, g, b, flashAt: flash },
      });
    },
    [device.id, electron, mutateProfile, profile?.lightbar.flashAt]
  );

  const handleSwatchSelect = useCallback(
    (r: number, g: number, b: number) => {
      setHexDraft(
        `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
      );
      void applyLightbar(r, g, b);
    },
    [applyLightbar]
  );

  const handleHexChange = useCallback(
    (raw: string) => {
      const normalized = raw.startsWith("#") ? raw : `#${raw}`;
      setHexDraft(normalized);

      const match = /^#([0-9a-fA-F]{6})$/.exec(normalized);
      if (!match) return;

      const value = parseInt(match[1], 16);
      void applyLightbar(value >> 16, (value >> 8) & 0xff, value & 0xff);
    },
    [applyLightbar]
  );

  const batteryLabel = useMemo(() => {
    if (!liveState) return t("settings_controllers_battery_unknown");
    const percent = Math.round(liveState.battery);
    return liveState.charging
      ? t("settings_controllers_battery_charging", { percent })
      : t("settings_controllers_battery_percent", { percent });
  }, [liveState, t]);

  const connectionLabel =
    device.connection === "bt"
      ? t("settings_controllers_connection_bt")
      : t("settings_controllers_connection_usb");

  const sectionDescription = `${modelLabel(device)} · ${connectionLabel} · ${batteryLabel}`;

  const lightbarMode = profile?.lightbar.mode ?? "static";
  const isStaticLightbar = lightbarMode === "static";

  const sequence = useMemo<SequenceEntry[]>(() => {
    const entries: SequenceEntry[] = [
      { kind: "item", focusId: getControllerItemFocusId(device.id, "profile") },
      {
        kind: "item",
        focusId: getControllerItemFocusId(device.id, "identify"),
      },
      { kind: "item", focusId: getControllerItemFocusId(device.id, "rumble") },
      { kind: "item", focusId: getControllerItemFocusId(device.id, "mode") },
    ];

    if (isStaticLightbar) {
      entries.push({ kind: "region", regionId: swatchRegionId });
      entries.push({
        kind: "item",
        focusId: getControllerItemFocusId(device.id, "hex"),
      });
    }

    entries.push({
      kind: "item",
      focusId: getControllerItemFocusId(device.id, "flash-at"),
    });

    if (isDualSense) {
      entries.push(
        {
          kind: "item",
          focusId: getControllerItemFocusId(device.id, "player-leds"),
        },
        {
          kind: "item",
          focusId: getControllerItemFocusId(device.id, "mic-led"),
        },
        {
          kind: "item",
          focusId: getControllerItemFocusId(device.id, "trigger-effect"),
        }
      );
    }

    entries.push(
      {
        kind: "item",
        focusId: getControllerItemFocusId(device.id, "deadzone"),
      },
      {
        kind: "item",
        focusId: getControllerItemFocusId(device.id, "swap-sticks"),
      }
    );

    if (virtualOutputAvailable) {
      entries.push({
        kind: "item",
        focusId: getControllerItemFocusId(device.id, "virtual-output"),
      });
    }

    if (hidingAvailable) {
      entries.push({
        kind: "item",
        focusId: getControllerItemFocusId(device.id, "hide-device"),
      });
    }

    entries.push({ kind: "region", regionId: diagramRegionId });

    entries.push({
      kind: "item",
      focusId: getControllerItemFocusId(device.id, "save-as"),
    });
    if (profile && !profile.builtin) {
      entries.push({
        kind: "item",
        focusId: getControllerItemFocusId(device.id, "delete"),
      });
    }

    return entries;
  }, [
    device.id,
    diagramRegionId,
    isDualSense,
    isStaticLightbar,
    hidingAvailable,
    profile,
    swatchRegionId,
    virtualOutputAvailable,
  ]);

  const { itemOverrides, regionOverrides } = useMemo(
    () => buildLinearOverrides(sequence),
    [sequence]
  );

  const overrideFor = useCallback(
    (focusId: string): FocusOverrides | undefined => itemOverrides[focusId],
    [itemOverrides]
  );

  const identifyFocusId = getControllerItemFocusId(device.id, "identify");
  const rumbleFocusId = getControllerItemFocusId(device.id, "rumble");
  const saveAsFocusId = getControllerItemFocusId(device.id, "save-as");
  const deleteFocusId = getControllerItemFocusId(device.id, "delete");

  const livePressedLabel = useMemo(() => {
    const pressed = (liveState?.pressed ?? []).filter(
      (control) => CONTROL_LABEL_KEYS[control]
    );
    if (pressed.length === 0) return t("settings_controllers_pressed_none");
    return pressed.map((control) => t(CONTROL_LABEL_KEYS[control])).join(" + ");
  }, [liveState, t]);

  return (
    <SettingsSection
      title={device.name}
      description={sectionDescription}
      className="controller-device-card"
    >
      <VerticalFocusGroup regionId={regionId} asChild>
        <div className="controller-device-card__content">
          <DropdownSelect
            label={t("settings_controllers_profile")}
            value={profile?.id ?? ""}
            options={profileOptions}
            focusId={getControllerItemFocusId(device.id, "profile")}
            focusNavigationOverrides={overrideFor(
              getControllerItemFocusId(device.id, "profile")
            )}
            onValueChange={(profileId) => {
              void electron.assignControllerProfile(device.id, profileId);
              onProfilesChanged();
            }}
          />

          <div className="controller-device-card__button-row">
            <Button
              variant="secondary"
              focusId={identifyFocusId}
              focusNavigationOverrides={{
                ...overrideFor(identifyFocusId),
                right: { type: "item", itemId: rumbleFocusId },
              }}
              onClick={() => electron.identifyController(device.id)}
            >
              {t("settings_controllers_identify")}
            </Button>
            <Button
              variant="secondary"
              focusId={rumbleFocusId}
              focusNavigationOverrides={{
                ...overrideFor(rumbleFocusId),
                left: { type: "item", itemId: identifyFocusId },
              }}
              onClick={() =>
                electron.previewControllerRumble(device.id, 255, 255, 400)
              }
            >
              {t("settings_controllers_test_rumble")}
            </Button>
          </div>

          <DropdownSelect
            label={t("settings_controllers_lightbar_mode")}
            value={lightbarMode}
            options={lightbarModeOptions}
            focusId={getControllerItemFocusId(device.id, "mode")}
            focusNavigationOverrides={overrideFor(
              getControllerItemFocusId(device.id, "mode")
            )}
            onValueChange={(mode) => {
              void mutateProfile({
                lightbar: {
                  ...(profile?.lightbar ?? {
                    r: 0,
                    g: 0,
                    b: 255,
                    flashAt: 0,
                  }),
                  mode: mode as ControllerProfile["lightbar"]["mode"],
                },
              });
            }}
          />

          {isStaticLightbar ? (
            <>
              <GridFocusGroup
                regionId={swatchRegionId}
                navigationOverrides={regionOverrides[swatchRegionId]}
                className="controller-device-card__swatch-grid"
              >
                {LIGHTBAR_SWATCHES.map((swatch, index) => {
                  const swatchFocusId = getControllerSwatchFocusId(
                    device.id,
                    index
                  );
                  const isSelected =
                    profile?.lightbar.mode === "static" &&
                    profile.lightbar.r === swatch.r &&
                    profile.lightbar.g === swatch.g &&
                    profile.lightbar.b === swatch.b;

                  return (
                    <FocusItem key={swatch.key} id={swatchFocusId} asChild>
                      <button
                        type="button"
                        className="controller-device-card__swatch"
                        data-selected={isSelected || undefined}
                        aria-label={t(
                          `settings_controllers_swatch_${swatch.key}`
                        )}
                        style={
                          {
                            "--swatch-color": `rgb(${swatch.r} ${swatch.g} ${swatch.b})`,
                          } as React.CSSProperties
                        }
                        onClick={() =>
                          handleSwatchSelect(swatch.r, swatch.g, swatch.b)
                        }
                      />
                    </FocusItem>
                  );
                })}
              </GridFocusGroup>

              <Input
                label={t("settings_controllers_custom_color")}
                placeholder="#0080ff"
                value={hexDraft}
                focusId={getControllerItemFocusId(device.id, "hex")}
                focusNavigationOverrides={overrideFor(
                  getControllerItemFocusId(device.id, "hex")
                )}
                onChange={(event) => handleHexChange(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </>
          ) : null}

          <DropdownSelect
            label={t("settings_controllers_flash_at")}
            value={String(profile?.lightbar.flashAt ?? 0)}
            options={flashAtOptions}
            focusId={getControllerItemFocusId(device.id, "flash-at")}
            focusNavigationOverrides={overrideFor(
              getControllerItemFocusId(device.id, "flash-at")
            )}
            onValueChange={(value) => {
              const flashAt = Number(value);
              void mutateProfile({
                lightbar: {
                  ...(profile?.lightbar ?? {
                    mode: "static",
                    r: 0,
                    g: 0,
                    b: 255,
                  }),
                  flashAt,
                },
              });
            }}
          />

          {isDualSense ? (
            <>
              <DropdownSelect
                label={t("settings_controllers_player_leds")}
                value={String(profile?.playerLedCount ?? 0)}
                options={playerLedOptions}
                focusId={getControllerItemFocusId(device.id, "player-leds")}
                focusNavigationOverrides={overrideFor(
                  getControllerItemFocusId(device.id, "player-leds")
                )}
                onValueChange={(value) => {
                  const count = Number(value);
                  void mutateProfile({ playerLedCount: count });
                }}
              />

              <DropdownSelect
                label={t("settings_controllers_mic_led")}
                value={String(profile?.micLed ?? 0)}
                options={micLedOptions}
                focusId={getControllerItemFocusId(device.id, "mic-led")}
                focusNavigationOverrides={overrideFor(
                  getControllerItemFocusId(device.id, "mic-led")
                )}
                onValueChange={(value) => {
                  void mutateProfile({ micLed: Number(value) });
                }}
              />

              <DropdownSelect
                label={t("settings_controllers_trigger_effect")}
                value="off"
                options={triggerEffectOptions}
                focusId={getControllerItemFocusId(device.id, "trigger-effect")}
                focusNavigationOverrides={overrideFor(
                  getControllerItemFocusId(device.id, "trigger-effect")
                )}
                onValueChange={(value) => {
                  const preset = TRIGGER_EFFECT_PRESETS.find(
                    (candidate) => candidate.value === value
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

          <DropdownSelect
            label={t("settings_controllers_deadzone")}
            value={String(profile?.stickDeadzone ?? 0)}
            options={deadzoneOptions}
            focusId={getControllerItemFocusId(device.id, "deadzone")}
            focusNavigationOverrides={overrideFor(
              getControllerItemFocusId(device.id, "deadzone")
            )}
            onValueChange={(value) => {
              void mutateProfile({ stickDeadzone: Number(value) });
            }}
          />

          <Checkbox
            id={`controller-${device.id}-swap-sticks`}
            label={t("settings_controllers_swap_sticks")}
            checked={profile?.swapSticks ?? false}
            disabled={!profile}
            focusId={getControllerItemFocusId(device.id, "swap-sticks")}
            navigationOverrides={overrideFor(
              getControllerItemFocusId(device.id, "swap-sticks")
            )}
            block
            onChange={(checked) => {
              void mutateProfile({ swapSticks: checked });
            }}
          />

          {hidingAvailable && !device.hidden ? (
            <div
              className="controller-device-card__exclusive-warning"
              role="alert"
            >
              <WarningIcon
                size={20}
                weight="bold"
                className="controller-device-card__exclusive-warning-icon"
              />
              <div className="controller-device-card__exclusive-warning-body">
                <p className="controller-device-card__exclusive-warning-text">
                  {t("settings_controllers_exclusive_warning")}
                </p>
                <p className="controller-device-card__exclusive-warning-fix">
                  {t("settings_controllers_exclusive_warning_fix")}
                </p>
                {hidingSupport === "hidhide-available" ? (
                  <p className="controller-device-card__exclusive-warning-fix">
                    {t("settings_controllers_exclusive_warning_hidhide")}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {virtualOutputAvailable ? (
            <Checkbox
              id={`controller-${device.id}-virtual-output`}
              label={t("settings_controllers_virtual_output")}
              secondaryText={t("settings_controllers_virtual_output_secondary")}
              checked={device.virtualOutput}
              focusId={getControllerItemFocusId(device.id, "virtual-output")}
              navigationOverrides={overrideFor(
                getControllerItemFocusId(device.id, "virtual-output")
              )}
              block
              onChange={(checked) => {
                void electron.setControllerVirtualOutput(device.id, checked);
              }}
            />
          ) : null}

          {hidingAvailable ? (
            <Checkbox
              id={`controller-${device.id}-hide-device`}
              label={t("settings_controllers_hide_device")}
              secondaryText={t("settings_controllers_hide_device_secondary")}
              checked={device.hidden}
              focusId={getControllerItemFocusId(device.id, "hide-device")}
              navigationOverrides={overrideFor(
                getControllerItemFocusId(device.id, "hide-device")
              )}
              block
              onChange={(checked) => {
                void electron.setControllerHidden(device.id, checked);
              }}
            />
          ) : null}

          <div className="controller-device-card__mapping-header">
            <p className="controller-device-card__mapping-title">
              {t("settings_controllers_mapping_title")}
            </p>
            <p className="controller-device-card__mapping-live">
              {t("settings_controllers_pressed_label", {
                controls: livePressedLabel,
              })}
            </p>
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
            regionId={diagramRegionId}
            regionOverrides={regionOverrides[diagramRegionId]}
            remapOptions={remapOptions}
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

          <div className="controller-device-card__button-row">
            <Button
              variant="secondary"
              loading={saving}
              focusId={saveAsFocusId}
              focusNavigationOverrides={{
                ...overrideFor(saveAsFocusId),
                right:
                  profile && !profile.builtin
                    ? { type: "item", itemId: deleteFocusId }
                    : { type: "block" },
              }}
              onClick={() => {
                if (!profile) return;
                void (async () => {
                  const saved = await electron.saveControllerProfile({
                    ...defaultProfileFor(profile),
                    name: `${profile.name} ${t("settings_controllers_profile_copy_suffix")}`,
                  });
                  await electron.assignControllerProfile(device.id, saved.id);
                  onProfilesChanged();
                })();
              }}
            >
              {t("settings_controllers_save_as")}
            </Button>
            {profile && !profile.builtin ? (
              <Button
                variant="danger"
                focusId={deleteFocusId}
                focusNavigationOverrides={{
                  ...overrideFor(deleteFocusId),
                  left: { type: "item", itemId: saveAsFocusId },
                }}
                onClick={() => {
                  void electron
                    .deleteControllerProfile(profile.id)
                    .then(onProfilesChanged);
                }}
              >
                {t("settings_controllers_delete_profile")}
              </Button>
            ) : (
              <span className="controller-device-card__button-spacer" />
            )}
          </div>
        </div>
      </VerticalFocusGroup>
    </SettingsSection>
  );
}
