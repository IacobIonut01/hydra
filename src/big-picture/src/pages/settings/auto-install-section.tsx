import "./auto-install-section.scss";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";

import {
  Button,
  Checkbox,
  FocusItem,
  HorizontalFocusGroup,
  VerticalFocusGroup,
} from "../../components";
import { useUserPreferences } from "../../hooks";
import type { FocusOverrideTarget, FocusOverrides } from "../../services";
import {
  AUTO_INSTALL_ITEM_FOCUS_IDS,
  AUTO_INSTALL_SECTION_REGION_ID,
  getLastDownloadsBehaviorItemFocusId,
} from "./settings-navigation";
import { SettingsSection } from "./settings-section";
import type { UserPreferences } from "@types";

interface AutoInstallSectionProps {
  className?: string;
  lastItemDownTarget?: FocusOverrideTarget;
}

interface AutoInstallForm {
  autoInstallRepacks: boolean;
  autoInstallInteractive: boolean;
  launchAfterInstall: boolean;
  deleteInstallerFilesAfterInstall: boolean;
  pauseSeedingWhileInstalling: boolean;
  installPath: string;
}

interface AutoInstallItem {
  id: string;
  focusId: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const DEFAULT_FORM: AutoInstallForm = {
  autoInstallRepacks: true,
  autoInstallInteractive: true,
  launchAfterInstall: true,
  deleteInstallerFilesAfterInstall: false,
  pauseSeedingWhileInstalling: false,
  installPath: "",
};

const buildForm = (preferences: UserPreferences | null): AutoInstallForm =>
  preferences
    ? {
        autoInstallRepacks: preferences.autoInstallRepacks ?? true,
        autoInstallInteractive: preferences.autoInstallInteractive ?? true,
        launchAfterInstall: preferences.launchAfterInstall ?? true,
        deleteInstallerFilesAfterInstall:
          preferences.deleteInstallerFilesAfterInstall ?? false,
        pauseSeedingWhileInstalling:
          preferences.pauseSeedingWhileInstalling ?? false,
        installPath: preferences.installPath ?? "",
      }
    : DEFAULT_FORM;

export function AutoInstallSection({
  className,
  lastItemDownTarget,
}: Readonly<AutoInstallSectionProps>) {
  const userPreferences = useUserPreferences();
  const [form, setForm] = useState<AutoInstallForm>(() =>
    buildForm(userPreferences)
  );

  useEffect(() => {
    if (!userPreferences) return;

    setForm(buildForm(userPreferences));
  }, [userPreferences]);

  const isWindows = globalThis.window.electron.platform === "win32";
  const isLinux = globalThis.window.electron.platform === "linux";
  const lastBehaviorFocusId = getLastDownloadsBehaviorItemFocusId(
    isWindows || isLinux
  );

  const updateUserPreferences = useCallback(
    async (values: Partial<AutoInstallForm>) => {
      setForm((currentForm) => ({ ...currentForm, ...values }));

      await globalThis.window.electron.updateUserPreferences(values);
    },
    []
  );

  const handleChooseInstallPath = async () => {
    const result = await globalThis.window.electron.showOpenDialog({
      defaultPath: form.installPath || undefined,
      properties: ["openDirectory"],
    });
    const selectedPath = result.filePaths[0];

    if (result.canceled || !selectedPath) return;

    await updateUserPreferences({ installPath: selectedPath });
  };

  const handleResetInstallPath = async () => {
    await updateUserPreferences({ installPath: "" });
  };

  const checkboxItems = useMemo<AutoInstallItem[]>(() => {
    const items: AutoInstallItem[] = [
      {
        id: "auto-install-repacks",
        focusId: AUTO_INSTALL_ITEM_FOCUS_IDS.autoInstallRepacks,
        label: "Install games automatically",
        checked: form.autoInstallRepacks,
        onChange: (checked: boolean) =>
          void updateUserPreferences({ autoInstallRepacks: checked }),
      },
    ];

    if (!form.autoInstallRepacks) return items;

    items.push(
      {
        id: "auto-install-interactive",
        focusId: AUTO_INSTALL_ITEM_FOCUS_IDS.autoInstallInteractive,
        label: "Show installer when silent install isn't possible",
        checked: form.autoInstallInteractive,
        onChange: (checked: boolean) =>
          void updateUserPreferences({ autoInstallInteractive: checked }),
      },
      {
        id: "auto-install-launch-after",
        focusId: AUTO_INSTALL_ITEM_FOCUS_IDS.launchAfterInstall,
        label: "Launch game after install",
        checked: form.launchAfterInstall,
        onChange: (checked: boolean) =>
          void updateUserPreferences({ launchAfterInstall: checked }),
      },
      {
        id: "auto-install-delete-installer-files",
        focusId: AUTO_INSTALL_ITEM_FOCUS_IDS.deleteInstallerFilesAfterInstall,
        label: "Delete installer files after install",
        checked: form.deleteInstallerFilesAfterInstall,
        onChange: (checked: boolean) =>
          void updateUserPreferences({
            deleteInstallerFilesAfterInstall: checked,
          }),
      },
      {
        id: "auto-install-pause-seeding",
        focusId: AUTO_INSTALL_ITEM_FOCUS_IDS.pauseSeedingWhileInstalling,
        label: "Pause seeding while installing",
        checked: form.pauseSeedingWhileInstalling,
        onChange: (checked: boolean) =>
          void updateUserPreferences({ pauseSeedingWhileInstalling: checked }),
      }
    );

    return items;
  }, [form, updateUserPreferences]);

  const focusChain = useMemo(() => {
    const ids = checkboxItems.map((item) => item.focusId);

    if (form.autoInstallRepacks) {
      ids.splice(1, 0, AUTO_INSTALL_ITEM_FOCUS_IDS.installDirectory);
    }

    return ids;
  }, [checkboxItems, form.autoInstallRepacks]);

  const navigationOverridesByFocusId = useMemo<
    Record<string, FocusOverrides>
  >(() => {
    return Object.fromEntries(
      focusChain.map((focusId, index) => {
        const previousFocusId = focusChain[index - 1];
        const nextFocusId = focusChain[index + 1];

        return [
          focusId,
          {
            up: previousFocusId
              ? {
                  type: "item",
                  itemId: previousFocusId,
                }
              : {
                  type: "item",
                  itemId: lastBehaviorFocusId,
                },
            down: nextFocusId
              ? {
                  type: "item",
                  itemId: nextFocusId,
                }
              : lastItemDownTarget
                ? lastItemDownTarget
                : undefined,
          } satisfies FocusOverrides,
        ];
      })
    );
  }, [focusChain, lastBehaviorFocusId, lastItemDownTarget]);

  const installDirectoryNavigationOverrides = useMemo<FocusOverrides>(
    () => ({
      ...navigationOverridesByFocusId[
        AUTO_INSTALL_ITEM_FOCUS_IDS.installDirectory
      ],
      left: { type: "block" },
      right: form.installPath
        ? {
            type: "item",
            itemId: AUTO_INSTALL_ITEM_FOCUS_IDS.installDirectoryReset,
          }
        : { type: "block" },
    }),
    [navigationOverridesByFocusId, form.installPath]
  );

  return (
    <SettingsSection
      title="Auto Install"
      description="Automatically run game installers once downloads finish extracting."
      className={className}
    >
      <VerticalFocusGroup regionId={AUTO_INSTALL_SECTION_REGION_ID} asChild>
        <div className="auto-install-section__content">
          <Checkbox
            id={checkboxItems[0].id}
            label={checkboxItems[0].label}
            checked={checkboxItems[0].checked}
            focusId={checkboxItems[0].focusId}
            navigationOverrides={
              navigationOverridesByFocusId[checkboxItems[0].focusId]
            }
            block
            onChange={checkboxItems[0].onChange}
          />

          {form.autoInstallRepacks && (
            <>
              <div className="auto-install-section__directory">
                <span className="auto-install-section__directory-label">
                  Install directory
                </span>
                <HorizontalFocusGroup
                  className="auto-install-section__directory-path-group"
                  asChild
                >
                  <div>
                    <FocusItem
                      id={AUTO_INSTALL_ITEM_FOCUS_IDS.installDirectory}
                      actions={{
                        primary: () => void handleChooseInstallPath(),
                      }}
                      navigationOverrides={installDirectoryNavigationOverrides}
                      asChild
                    >
                      <button
                        type="button"
                        className="auto-install-section__directory-path"
                        title={form.installPath || undefined}
                        onClick={() => void handleChooseInstallPath()}
                      >
                        {form.installPath || "Default"}
                      </button>
                    </FocusItem>

                    {form.installPath && (
                      <Button
                        variant="secondary"
                        size="icon"
                        focusId={
                          AUTO_INSTALL_ITEM_FOCUS_IDS.installDirectoryReset
                        }
                        aria-label="Reset install directory"
                        title="Reset install directory"
                        icon={<ArrowCounterClockwiseIcon size={18} />}
                        focusNavigationOverrides={{
                          ...installDirectoryNavigationOverrides,
                          left: {
                            type: "item",
                            itemId:
                              AUTO_INSTALL_ITEM_FOCUS_IDS.installDirectory,
                          },
                          right: { type: "block" },
                        }}
                        onClick={() => void handleResetInstallPath()}
                      >
                        {""}
                      </Button>
                    )}
                  </div>
                </HorizontalFocusGroup>
              </div>

              {checkboxItems.slice(1).map((item) => (
                <Checkbox
                  key={item.id}
                  id={item.id}
                  label={item.label}
                  checked={item.checked}
                  focusId={item.focusId}
                  navigationOverrides={
                    navigationOverridesByFocusId[item.focusId]
                  }
                  block
                  onChange={item.onChange}
                />
              ))}
            </>
          )}
        </div>
      </VerticalFocusGroup>
    </SettingsSection>
  );
}
