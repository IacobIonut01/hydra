import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Button,
  CheckboxField,
  SelectField,
  TextField,
} from "@renderer/components";
import { settingsContext } from "@renderer/context";
import { useAppSelector } from "@renderer/hooks";
import type { NetworkInterface, UserPreferences } from "@types";
import { SettingsGlobalTrackers } from "./settings-global-trackers";

import "./settings-general.scss";

const formatLimitInputValue = (
  value: number,
  useMegabytes: boolean
): string => {
  const unitValue = useMegabytes ? value / (1024 * 1024) : (value * 8) / 1e6;
  return Number.isInteger(unitValue)
    ? `${unitValue}`
    : `${Number(unitValue.toFixed(2))}`;
};

const buildForm = (preferences: UserPreferences | null) => ({
  seedAfterDownloadComplete: preferences?.seedAfterDownloadComplete ?? false,
  showDownloadSpeedInMegabytes:
    preferences?.showDownloadSpeedInMegabytes ?? false,
  extractFilesByDefault: preferences?.extractFilesByDefault ?? true,
  createStartMenuShortcut: preferences?.createStartMenuShortcut ?? true,
  maxDownloadSpeedMegabytes:
    typeof preferences?.maxDownloadSpeedBytesPerSecond === "number" &&
    preferences.maxDownloadSpeedBytesPerSecond > 0
      ? formatLimitInputValue(
          preferences.maxDownloadSpeedBytesPerSecond,
          preferences.showDownloadSpeedInMegabytes ?? false
        )
      : "",
  deleteArchiveFilesAfterExtractionByDefault:
    preferences?.deleteArchiveFilesAfterExtractionByDefault ?? false,
  torrentNetworkInterface: preferences?.torrentNetworkInterface ?? "",
  autoInstallRepacks: preferences?.autoInstallRepacks ?? true,
  autoInstallInteractive: preferences?.autoInstallInteractive ?? true,
  launchAfterInstall: preferences?.launchAfterInstall ?? true,
  deleteInstallerFilesAfterInstall:
    preferences?.deleteInstallerFilesAfterInstall ?? false,
  pauseSeedingWhileInstalling:
    preferences?.pauseSeedingWhileInstalling ?? false,
  installPath: preferences?.installPath ?? "",
});

export function SettingsContextDownloads() {
  const { t } = useTranslation("settings");
  const { updateUserPreferences } = useContext(settingsContext);

  const userPreferences = useAppSelector(
    (state) => state.userPreferences.value
  );

  const parseLimitInputToBytesPerSecond = (
    value: string,
    useMegabytes: boolean
  ): number | null | undefined => {
    const trimmed = value.trim();

    if (!trimmed) return null;

    const parsed = Number.parseFloat(trimmed);
    if (Number.isNaN(parsed)) return undefined;
    if (parsed <= 0) return null;

    return useMegabytes
      ? Math.floor(parsed * 1024 * 1024)
      : Math.floor((parsed * 1e6) / 8);
  };

  const [form, setForm] = useState(() => buildForm(userPreferences));

  const [networkInterfaces, setNetworkInterfaces] = useState<
    NetworkInterface[]
  >([]);

  useEffect(() => {
    globalThis.electron
      .getNetworkInterfaces()
      .then(setNetworkInterfaces)
      .catch(() => setNetworkInterfaces([]));
  }, []);

  useEffect(() => {
    if (!userPreferences) return;

    setForm(buildForm(userPreferences));
  }, [userPreferences]);

  const networkInterfaceOptions = useMemo(() => {
    const options = [
      { key: "default", value: "", label: t("network_interface_default") },
      ...networkInterfaces.map((networkInterface) => {
        const ipv4 = networkInterface.addresses.find(
          (address) => !address.includes(":")
        );

        return {
          key: networkInterface.name,
          value: networkInterface.name,
          label: ipv4
            ? `${networkInterface.name} (${ipv4})`
            : networkInterface.name,
        };
      }),
    ];

    const selected = form.torrentNetworkInterface;
    if (selected && !options.some((option) => option.value === selected)) {
      options.push({
        key: selected,
        value: selected,
        label: `${selected} (${t("network_interface_unavailable")})`,
      });
    }

    return options;
  }, [networkInterfaces, form.torrentNetworkInterface, t]);

  const handleChange = (values: Partial<typeof form>) => {
    setForm((prev) => ({ ...prev, ...values }));
    updateUserPreferences(values);
  };

  const handleMaxDownloadSpeedBlur = () => {
    const parsedBytesPerSecond = parseLimitInputToBytesPerSecond(
      form.maxDownloadSpeedMegabytes,
      form.showDownloadSpeedInMegabytes
    );

    if (parsedBytesPerSecond === undefined) {
      setForm((prev) => ({ ...prev, maxDownloadSpeedMegabytes: "" }));
      updateUserPreferences({ maxDownloadSpeedBytesPerSecond: null });
      return;
    }

    if (parsedBytesPerSecond === null) {
      setForm((prev) => ({ ...prev, maxDownloadSpeedMegabytes: "" }));
      updateUserPreferences({ maxDownloadSpeedBytesPerSecond: null });
      return;
    }

    const nextLimitValue = formatLimitInputValue(
      parsedBytesPerSecond,
      form.showDownloadSpeedInMegabytes
    );
    setForm((prev) => ({ ...prev, maxDownloadSpeedMegabytes: nextLimitValue }));
    updateUserPreferences({
      maxDownloadSpeedBytesPerSecond: parsedBytesPerSecond,
    });
  };

  const handleChooseInstallPath = async () => {
    const { filePaths } = await globalThis.electron.showOpenDialog({
      defaultPath: form.installPath || undefined,
      properties: ["openDirectory"],
    });

    const path = filePaths?.[0];
    if (!path) return;

    handleChange({ installPath: path });
  };

  const handleSpeedUnitChange = () => {
    const nextUseMegabytes = !form.showDownloadSpeedInMegabytes;
    const parsedBytesPerSecond = parseLimitInputToBytesPerSecond(
      form.maxDownloadSpeedMegabytes,
      form.showDownloadSpeedInMegabytes
    );

    const nextLimitInput =
      typeof parsedBytesPerSecond === "number" && parsedBytesPerSecond > 0
        ? formatLimitInputValue(parsedBytesPerSecond, nextUseMegabytes)
        : "";

    setForm((prev) => ({
      ...prev,
      showDownloadSpeedInMegabytes: nextUseMegabytes,
      maxDownloadSpeedMegabytes: nextLimitInput,
    }));

    updateUserPreferences({
      showDownloadSpeedInMegabytes: nextUseMegabytes,
    });
  };

  return (
    <div className="settings-context-panel">
      <div className="settings-context-panel__group">
        <h3>{t("download_behavior")}</h3>

        <TextField
          type="number"
          min="0"
          step="0.1"
          label={t("max_download_speed", {
            unit: form.showDownloadSpeedInMegabytes ? "MB/s" : "Mbps",
          })}
          hint={t("max_download_speed_hint", {
            unit: form.showDownloadSpeedInMegabytes
              ? t("max_download_speed_unit_megabytes")
              : t("max_download_speed_unit_megabits"),
          })}
          value={form.maxDownloadSpeedMegabytes}
          onChange={(event) => {
            setForm((prev) => ({
              ...prev,
              maxDownloadSpeedMegabytes: event.target.value,
            }));
          }}
          onBlur={handleMaxDownloadSpeedBlur}
          placeholder={t("max_download_speed_unlimited")}
        />

        <div className="settings-general__network-interface">
          <SelectField
            label={t("network_interface")}
            value={form.torrentNetworkInterface}
            onChange={(event) =>
              handleChange({ torrentNetworkInterface: event.target.value })
            }
            options={networkInterfaceOptions}
          />
          <small className="settings-general__network-interface-hint">
            {t("network_interface_hint")}
          </small>
        </div>

        <CheckboxField
          label={t("seed_after_download_complete")}
          checked={form.seedAfterDownloadComplete}
          onChange={() =>
            handleChange({
              seedAfterDownloadComplete: !form.seedAfterDownloadComplete,
            })
          }
        />

        <CheckboxField
          label={t("extract_files_by_default")}
          checked={form.extractFilesByDefault}
          onChange={() =>
            handleChange({
              extractFilesByDefault: !form.extractFilesByDefault,
            })
          }
        />

        <CheckboxField
          label={t("show_download_speed_in_megabytes")}
          checked={form.showDownloadSpeedInMegabytes}
          onChange={handleSpeedUnitChange}
        />

        <CheckboxField
          label={t("delete_archive_files_after_extraction")}
          checked={form.deleteArchiveFilesAfterExtractionByDefault}
          onChange={() =>
            handleChange({
              deleteArchiveFilesAfterExtractionByDefault:
                !form.deleteArchiveFilesAfterExtractionByDefault,
            })
          }
        />

        {(window.electron.platform === "win32" ||
          window.electron.platform === "linux") && (
          <CheckboxField
            label={t("create_shortcuts_on_download")}
            checked={form.createStartMenuShortcut}
            onChange={() =>
              handleChange({
                createStartMenuShortcut: !form.createStartMenuShortcut,
              })
            }
          />
        )}
      </div>

      {globalThis.electron.platform !== "darwin" && (
        <div className="settings-context-panel__group">
          <h3>{t("auto_install")}</h3>

          <CheckboxField
            label={t("auto_install_repacks")}
            checked={form.autoInstallRepacks}
            onChange={() =>
              handleChange({ autoInstallRepacks: !form.autoInstallRepacks })
            }
          />

          {form.autoInstallRepacks && (
            <>
              <TextField
                label={t("auto_install_path")}
                hint={t("auto_install_path_hint")}
                value={form.installPath}
                readOnly
                disabled
                rightContent={
                  <Button theme="outline" onClick={handleChooseInstallPath}>
                    {t("browse")}
                  </Button>
                }
              />

              <CheckboxField
                label={t("auto_install_interactive")}
                checked={form.autoInstallInteractive}
                onChange={() =>
                  handleChange({
                    autoInstallInteractive: !form.autoInstallInteractive,
                  })
                }
              />

              <CheckboxField
                label={t("launch_after_install")}
                checked={form.launchAfterInstall}
                onChange={() =>
                  handleChange({
                    launchAfterInstall: !form.launchAfterInstall,
                  })
                }
              />

              <CheckboxField
                label={t("delete_installer_files_after_install")}
                checked={form.deleteInstallerFilesAfterInstall}
                onChange={() =>
                  handleChange({
                    deleteInstallerFilesAfterInstall:
                      !form.deleteInstallerFilesAfterInstall,
                  })
                }
              />

              <CheckboxField
                label={t("pause_seeding_while_installing")}
                checked={form.pauseSeedingWhileInstalling}
                onChange={() =>
                  handleChange({
                    pauseSeedingWhileInstalling:
                      !form.pauseSeedingWhileInstalling,
                  })
                }
              />
            </>
          )}
        </div>
      )}

      <div className="settings-context-panel__group">
        <h3>{t("global_trackers")}</h3>
        <SettingsGlobalTrackers />
      </div>
    </div>
  );
}
