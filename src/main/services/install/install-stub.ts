import path from "node:path";

import { downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import { Downloader } from "@shared";
import type { Download, Game } from "@types";

import { logger } from "../logger";
import { WindowManager } from "../window-manager";

/**
 * Development stub for the auto-install pipeline, enabled with
 * `HYDRA_STUB_INSTALL=1`. Seeds three library rows + download rows so the
 * Big Picture / downloads UIs exercise the install states without touching a
 * real repack:
 *   1. an in-flight install (bytes-written ticker drives progress events),
 *   2. a failed install (needs-attention / retry state),
 *   3. a completed download not yet installed (Install button state).
 */
export const installStubEnabled = process.env.HYDRA_STUB_INSTALL === "1";

const STUB_SHOP = "custom" as const;
const GB = 1024 * 1024 * 1024;

const baseGame = (objectId: string, title: string): Game => ({
  title,
  iconUrl: null,
  libraryHeroImageUrl: null,
  logoImageUrl: null,
  playTimeInMilliseconds: 0,
  lastTimePlayed: null,
  addedToLibraryAt: new Date(),
  objectId,
  shop: STUB_SHOP,
  remoteId: null,
  isDeleted: false,
  installerSizeInBytes: 42 * GB,
});

const baseDownload = (
  objectId: string,
  overrides: Partial<Download>
): Download => ({
  shop: STUB_SHOP,
  objectId,
  uri: "magnet:?xt=urn:btih:stub",
  folderName: `${objectId}-repack`,
  downloadPath: path.join(process.env.TMPDIR ?? "/tmp", "hydra-stub"),
  progress: 1,
  downloader: Downloader.Torrent,
  bytesDownloaded: 42 * GB,
  fileSize: 42 * GB,
  shouldSeed: false,
  status: "complete",
  queued: false,
  timestamp: Date.now(),
  extracting: false,
  automaticallyExtract: true,
  automaticallyDeleteArchiveFiles: false,
  automaticallyInstall: true,
  installPath: path.join(process.env.TMPDIR ?? "/tmp", "hydra-stub", "install"),
  ...overrides,
});

interface StubRow {
  objectId: string;
  title: string;
  download: Partial<Download>;
}

const STUB_ROWS: StubRow[] = [
  {
    objectId: "hydra-stub-installing",
    title: "[Stub] Elden Ring Deluxe (DODI)",
    download: {
      installing: true,
      installStartedAt: Date.now() - 30_000,
      downloadSourceName: "DODI Repacks",
      repackTitle: "Elden.Ring.Deluxe.Edition.v1.10-DODI",
    },
  },
  {
    objectId: "hydra-stub-failed",
    title: "[Stub] Cyberpunk 2077 (FitGirl)",
    download: {
      installing: false,
      installFailure: { reason: "needs-interaction" },
      downloadSourceName: "FitGirl Repacks",
      repackTitle: "Cyberpunk.2077.v2.1-FitGirl",
    },
  },
  {
    objectId: "hydra-stub-ready",
    title: "[Stub] Horizon Zero Dawn (SteamRip)",
    download: {
      installing: false,
      installFailure: null,
      status: "seeding",
      downloadSourceName: "SteamRip",
      repackTitle: "Horizon.Zero.Dawn.Complete.Edition-SteamRip",
    },
  },
];

const PROGRESS_TICK_MS = 2_500;
const BYTES_PER_TICK = 250 * 1024 * 1024;

let progressTimer: NodeJS.Timeout | null = null;
let stubBytesWritten = 3 * GB;

const startProgressDriver = (objectId: string) => {
  if (progressTimer) return;

  progressTimer = setInterval(() => {
    void (async () => {
      const key = levelKeys.game(STUB_SHOP, objectId);
      const download = await downloadsSublevel.get(key).catch(() => null);
      if (!download?.installing) {
        if (progressTimer) {
          clearInterval(progressTimer);
          progressTimer = null;
        }
        return;
      }

      stubBytesWritten += BYTES_PER_TICK;
      WindowManager.sendToAppWindows(
        "on-install-progress",
        STUB_SHOP,
        objectId,
        stubBytesWritten
      );
    })();
  }, PROGRESS_TICK_MS);
  progressTimer.unref();
};

export const seedInstallStubs = async (): Promise<void> => {
  if (!installStubEnabled) return;

  for (const row of STUB_ROWS) {
    const key = levelKeys.game(STUB_SHOP, row.objectId);

    const existingGame = await gamesSublevel.get(key).catch(() => null);
    if (!existingGame) {
      await gamesSublevel
        .put(key, baseGame(row.objectId, row.title))
        .catch((error) =>
          logger.warn("[install-stub] failed to seed game", error)
        );
    }

    const existingDownload = await downloadsSublevel.get(key).catch(() => null);
    if (!existingDownload) {
      await downloadsSublevel
        .put(key, baseDownload(row.objectId, row.download))
        .catch((error) =>
          logger.warn("[install-stub] failed to seed download", error)
        );
    } else if (row.objectId === "hydra-stub-installing") {
      // A previous stub run may have been cancelled; re-mark installing so
      // the state is exercised on every stub launch.
      await downloadsSublevel
        .put(key, { ...existingDownload, ...row.download })
        .catch(() => undefined);
    }
  }

  WindowManager.sendDownloadsUpdated();
  startProgressDriver("hydra-stub-installing");
  logger.info(
    "[install-stub] seeded stub library/downloads rows (HYDRA_STUB_INSTALL=1)"
  );
};
