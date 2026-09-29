import "./controllers.scss";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GameControllerIcon } from "@phosphor-icons/react";

import {
  Button,
  Checkbox,
  EmptyState,
  VerticalFocusGroup,
} from "../../../components";
import { useUserPreferences } from "../../../hooks";
import type {
  ControllerDeviceInfo,
  ControllerProfile,
  HidingSupport,
  VirtualOutputSupport,
} from "@types";

import { ControllerDeviceCard } from "./controller-device-card";
import { SettingsSection } from "../settings-section";
import {
  CONTROLLERS_ITEM_FOCUS_IDS,
  CONTROLLERS_SECTION_REGION_ID,
} from "../settings-navigation";

interface ControllersSettingsSectionProps {
  className?: string;
}

export function ControllersSettingsSection({
  className,
}: Readonly<ControllersSettingsSectionProps>) {
  const { t } = useTranslation("big_picture");
  const userPreferences = useUserPreferences();
  const electron = globalThis.window.electron;

  const [devices, setDevices] = useState<ControllerDeviceInfo[]>([]);
  const [profiles, setProfiles] = useState<ControllerProfile[]>([]);
  const [virtualOutputSupport, setVirtualOutputSupport] =
    useState<VirtualOutputSupport>("unavailable");
  const [hidingSupport, setHidingSupport] =
    useState<HidingSupport>("unavailable");

  const enabled = userPreferences?.controllerEnabled !== false;
  const assignments = useMemo(
    () => userPreferences?.controllerAssignments ?? {},
    [userPreferences]
  );

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

    const unsubscribeDevices = electron.onControllerDevicesChanged(setDevices);

    return () => {
      unsubscribeDevices();
    };
  }, [electron, reloadProfiles]);

  const virtualOutputHint = useMemo(() => {
    switch (virtualOutputSupport) {
      case "vigem-available":
        return t("settings_controllers_virtual_output_vigem");
      case "uinput-available":
        return t("settings_controllers_virtual_output_uinput");
      case "uinput-blocked":
        return t("settings_controllers_virtual_output_uinput_blocked");
      case "vigem-unavailable":
        return t("settings_controllers_virtual_output_vigem_unavailable");
      default:
        return null;
    }
  }, [t, virtualOutputSupport]);

  const hidingHint = useMemo(() => {
    switch (hidingSupport) {
      case "hidhide-unavailable":
        return t("settings_controllers_hiding_hidhide_unavailable");
      case "evdev-grab":
        return t("settings_controllers_hiding_evdev");
      default:
        return null;
    }
  }, [t, hidingSupport]);

  return (
    <div className={className}>
      <SettingsSection
        title={t("settings_controllers_section_title")}
        description={t("settings_controllers_section_description")}
      >
        <VerticalFocusGroup regionId={CONTROLLERS_SECTION_REGION_ID} asChild>
          <div className="controllers-section__content">
            <Checkbox
              id="controllers-enabled"
              label={t("settings_controllers_enable")}
              checked={enabled}
              focusId={CONTROLLERS_ITEM_FOCUS_IDS.enabled}
              block
              onChange={(checked) => {
                void electron.setControllerEnabled(checked);
              }}
            />
            <Button
              variant="secondary"
              focusId={CONTROLLERS_ITEM_FOCUS_IDS.restart}
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
              {t("settings_controllers_restart_service")}
            </Button>
            {virtualOutputHint ? (
              <p className="controllers-section__hint">{virtualOutputHint}</p>
            ) : null}
            {hidingHint ? (
              <p className="controllers-section__hint">{hidingHint}</p>
            ) : null}
          </div>
        </VerticalFocusGroup>
      </SettingsSection>

      {enabled && devices.length === 0 ? (
        <SettingsSection
          title={t("settings_controllers_devices_title")}
          description={t("settings_controllers_devices_description")}
        >
          <EmptyState
            icon={<GameControllerIcon size={32} weight="bold" />}
            title={t("settings_controllers_empty_title")}
            description={t("settings_controllers_empty_description")}
          />
        </SettingsSection>
      ) : null}

      {enabled
        ? devices.map((device) => (
            <ControllerDeviceCard
              key={device.id}
              device={device}
              profiles={profiles}
              assignedProfileId={assignments[device.id] ?? null}
              virtualOutputSupport={virtualOutputSupport}
              hidingSupport={hidingSupport}
              onProfilesChanged={reloadProfiles}
            />
          ))
        : null}
    </div>
  );
}
