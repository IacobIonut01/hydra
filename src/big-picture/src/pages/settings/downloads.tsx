import "./downloads.scss";

import { AutoInstallSection } from "./auto-install-section";
import { DownloadsBehaviorSection } from "./downloads-behavior-section";
import { DownloadsSourcesSection } from "./downloads-sources-section";
import {
  AUTO_INSTALL_SECTION_REGION_ID,
  DOWNLOADS_SOURCES_ACTIONS_REGION_ID,
} from "./settings-navigation";

interface SettingsSectionProps {
  className?: string;
}

export function DownloadsSettingsSection({
  className,
}: Readonly<SettingsSectionProps>) {
  const supportsAutoInstall = globalThis.window.electron.platform !== "darwin";

  const sourcesRegionDownTarget = {
    type: "region" as const,
    regionId: DOWNLOADS_SOURCES_ACTIONS_REGION_ID,
    entryDirection: "down" as const,
    preferRememberedFocus: false,
  };

  return (
    <div
      className={
        className
          ? `downloads-settings-section ${className}`
          : "downloads-settings-section"
      }
    >
      <DownloadsBehaviorSection
        lastItemDownTarget={
          supportsAutoInstall
            ? {
                type: "region",
                regionId: AUTO_INSTALL_SECTION_REGION_ID,
                entryDirection: "down",
                preferRememberedFocus: false,
              }
            : sourcesRegionDownTarget
        }
      />
      {supportsAutoInstall && (
        <AutoInstallSection lastItemDownTarget={sourcesRegionDownTarget} />
      )}
      <DownloadsSourcesSection />
    </div>
  );
}
