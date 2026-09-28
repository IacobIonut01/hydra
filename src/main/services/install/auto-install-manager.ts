import path from "node:path";
import fs from "node:fs";
import { execFile, type ChildProcess } from "node:child_process";

import { launchGame } from "@main/helpers/launch-game";
import { db, downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import { getDirectorySize } from "@main/events/helpers/get-directory-size";
import {
  DownloadManager,
  getDiskUsage,
  logger,
  Wine,
  WindowManager,
} from "@main/services";
import { getTrackedGamesRunning } from "@main/services/game-running-state";
import {
  publishInstallCompleteNotification,
  publishInstallFailedNotification,
} from "@main/services/notifications";
import {
  buildInnoSilentArgs,
  Downloader,
  resolveRepackInstallStrategy,
  sanitizeInstallDirName,
} from "@shared";
import type {
  Download,
  Game,
  GameShop,
  InstallFailure,
  UserPreferences,
} from "@types";

import { findInstallerInFolder } from "./installer-locator";
import { startInstallProgressMonitor } from "./install-progress-monitor";
import {
  executeGameInstaller,
  rescanAndBindExecutableAfterInstall,
  scheduleRescanPoll,
} from "./installer-runner";

// A silent Inno run that dies or reports success this fast without writing
// anything never installed -- the flags were rejected or the payload could
// not be read. That is the escalation signal, not a real install.
const SILENT_FAIL_THRESHOLD_MS = 60_000;
// Repacks decompress to roughly twice their compressed size; used only as a
// preflight estimate when no better number exists.
const INSTALLED_SIZE_ESTIMATE_FACTOR = 2;

interface QueuedInstall {
  shop: GameShop;
  objectId: string;
}

interface ActiveInstall {
  gameKey: string;
  child: ChildProcess | null;
  cancelling: boolean;
  stopProgressMonitor: (() => void) | null;
  attemptStartedAt: number;
  seedingWasPaused: boolean;
}

const installQueue: QueuedInstall[] = [];
let activeInstall: ActiveInstall | null = null;
let processingQueue = false;

const getUserPreferences = () =>
  db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);

export const enqueueGameInstall = async (
  shop: GameShop,
  objectId: string
): Promise<"queued" | "already-active" | "already-queued"> => {
  const gameKey = levelKeys.game(shop, objectId);

  if (activeInstall?.gameKey === gameKey) return "already-active";
  if (
    installQueue.some(
      (entry) => entry.shop === shop && entry.objectId === objectId
    )
  ) {
    return "already-queued";
  }

  installQueue.push({ shop, objectId });
  void processInstallQueue();
  return "queued";
};

/**
 * Pipeline hook: called after extraction + exe-binding finished without
 * finding an executable. Applies every opt-out gate (per-download override,
 * per-source exclusion, master pref, non-installable sources) so the caller
 * never has to know whether auto-install is enabled.
 */
export const maybeEnqueueInstallFromPipeline = async (
  shop: GameShop,
  objectId: string
): Promise<void> => {
  try {
    if (process.platform === "darwin") return;

    const gameKey = levelKeys.game(shop, objectId);
    const [download, game, userPreferences] = await Promise.all([
      downloadsSublevel.get(gameKey).catch(() => null),
      gamesSublevel.get(gameKey).catch(() => null),
      getUserPreferences(),
    ]);

    if (!download || !game || game.executablePath) return;
    if (download.progress < 1 || download.extracting) return;
    if (shop === "launchbox" || shop === "custom") return;

    const autoInstallEnabled =
      download.automaticallyInstall ??
      userPreferences?.autoInstallRepacks ??
      true;
    if (!autoInstallEnabled) return;

    if (
      download.downloadSourceId &&
      userPreferences?.autoInstallExcludedSourceIds?.includes(
        download.downloadSourceId
      )
    ) {
      return;
    }

    const strategy = resolveRepackInstallStrategy({
      downloadSourceName: download.downloadSourceName,
      repackTitle: download.repackTitle,
    });
    if (strategy === "preinstalled") return;

    await enqueueGameInstall(shop, objectId);
  } catch (error) {
    logger.error(
      `[AutoInstallManager] Failed to evaluate auto-install for ${shop}:${objectId}`,
      error
    );
  }
};

const killChildProcessTree = (child: ChildProcess) => {
  if (child.pid == null) return;

  if (process.platform === "win32") {
    // Inno setup.exe respawns the real installer as a child; /T takes the
    // whole tree down.
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], (error) => {
      if (error) {
        logger.warn("[AutoInstallManager] taskkill failed", error);
      }
    });
    return;
  }

  try {
    // detached:true made the child a process-group leader, so a negative
    // pid reaches umu-run and the wineserver tree below it.
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      logger.warn("[AutoInstallManager] Failed to kill installer", error);
    }
  }
};

export const cancelGameInstall = async (
  shop: GameShop,
  objectId: string
): Promise<boolean> => {
  const queuedIndex = installQueue.findIndex(
    (entry) => entry.shop === shop && entry.objectId === objectId
  );
  if (queuedIndex >= 0) {
    installQueue.splice(queuedIndex, 1);
    return true;
  }

  const gameKey = levelKeys.game(shop, objectId);
  if (activeInstall?.gameKey !== gameKey) return false;

  activeInstall.cancelling = true;
  if (activeInstall.child) {
    killChildProcessTree(activeInstall.child);
  }
  return true;
};

const toInstallerDirArg = (
  installDirPath: string,
  winePrefixPath: string | null
): string => {
  if (process.platform === "linux") {
    if (winePrefixPath) {
      const driveCPath = path.join(winePrefixPath, "drive_c");
      const relative = path.relative(driveCPath, installDirPath);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        return `C:\\${relative.split(path.sep).join("\\")}`;
      }
    }

    // Outside the prefix, Wine exposes the filesystem root as the Z: drive.
    return `Z:\\${installDirPath.split(path.sep).filter(Boolean).join("\\")}`;
  }

  return installDirPath;
};

const resolveInstallRoot = (
  download: Download,
  game: Game,
  objectId: string,
  userPreferences: UserPreferences | null
): string | null => {
  const overrideRoot = download.installPath ?? userPreferences?.installPath;
  if (overrideRoot) return overrideRoot;

  if (process.platform === "win32") {
    const driveRoot = path.parse(download.downloadPath).root;
    return path.join(driveRoot, "Games");
  }

  if (process.platform === "linux") {
    const winePrefixPath = Wine.getEffectivePrefixPath(
      game.winePrefixPath,
      objectId
    );
    return winePrefixPath
      ? path.join(winePrefixPath, "drive_c", "Games")
      : null;
  }

  return null;
};

const directoryIsEmptyOrMissing = (dirPath: string) => {
  try {
    return !fs.existsSync(dirPath) || fs.readdirSync(dirPath).length === 0;
  } catch {
    return true;
  }
};

const runInstall = async (queued: QueuedInstall): Promise<void> => {
  const { shop, objectId } = queued;
  const gameKey = levelKeys.game(shop, objectId);

  const download = await downloadsSublevel.get(gameKey).catch(() => null);
  const game = await gamesSublevel.get(gameKey).catch(() => null);

  const finishInstall = async (params: {
    failure?: InstallFailure | null;
    installedPath?: string | null;
  }) => {
    const latestDownload = await downloadsSublevel
      .get(gameKey)
      .catch(() => null);
    if (latestDownload) {
      await downloadsSublevel.put(gameKey, {
        ...latestDownload,
        installing: false,
        installFailure: params.failure ?? null,
        installedPath: params.installedPath ?? latestDownload.installedPath,
      });
      WindowManager.sendDownloadsUpdated();
    }

    if (params.failure) {
      WindowManager.sendToAppWindows(
        "on-install-failed",
        shop,
        objectId,
        params.failure
      );
      if (game) {
        await publishInstallFailedNotification(game, params.failure).catch(
          (error) =>
            logger.error(
              "[AutoInstallManager] Failed to publish install failed notification",
              error
            )
        );
      }
    } else {
      WindowManager.sendToAppWindows(
        "on-install-complete",
        shop,
        objectId,
        params.installedPath ?? null
      );
      if (game) {
        await publishInstallCompleteNotification(game).catch((error) =>
          logger.error(
            "[AutoInstallManager] Failed to publish install complete notification",
            error
          )
        );
      }
    }

    if (activeInstall?.seedingWasPaused) {
      const downloadToSeed = await downloadsSublevel
        .get(gameKey)
        .catch(() => null);
      if (downloadToSeed) {
        await DownloadManager.resumeSeeding(downloadToSeed).catch((error) =>
          logger.error(
            "[AutoInstallManager] Failed to resume seeding after install",
            error
          )
        );
      }
    }

    activeInstall?.stopProgressMonitor?.();
    activeInstall = null;
  };

  if (!download || !game || game.executablePath || !download.folderName) {
    return;
  }

  if (process.platform === "darwin") {
    await finishInstall({
      failure: { reason: "unsupported", message: "platform" },
    });
    return;
  }

  const gamePath = path.join(download.downloadPath, download.folderName);
  const installer = findInstallerInFolder(gamePath);

  if (!installer) {
    await finishInstall({ failure: { reason: "no-installer" } });
    return;
  }

  const userPreferences = await getUserPreferences();
  const installRoot = resolveInstallRoot(
    download,
    game,
    objectId,
    userPreferences
  );

  if (!installRoot) {
    await finishInstall({
      failure: { reason: "unsupported", message: "no-install-root" },
    });
    return;
  }

  const installDirPath = path.join(
    installRoot,
    sanitizeInstallDirName(game.title)
  );

  const requiredBytes =
    (download.selectedFilesSize ?? download.fileSize ?? 0) *
    INSTALLED_SIZE_ESTIMATE_FACTOR;
  if (requiredBytes > 0) {
    const diskUsage = await getDiskUsage(installDirPath);
    if (diskUsage && diskUsage.free < requiredBytes) {
      await finishInstall({
        failure: {
          reason: "insufficient-space",
          requiredBytes,
          freeBytes: diskUsage.free,
        },
      });
      return;
    }
  }

  const winePrefixPath =
    process.platform === "linux"
      ? Wine.getEffectivePrefixPath(game.winePrefixPath, objectId)
      : null;

  await downloadsSublevel.put(gameKey, {
    ...download,
    installing: true,
    installStartedAt: Date.now(),
    installFailure: null,
    installPath: installDirPath,
  });
  WindowManager.sendDownloadsUpdated();

  activeInstall = {
    gameKey,
    child: null,
    cancelling: false,
    stopProgressMonitor: startInstallProgressMonitor(
      shop,
      objectId,
      installDirPath
    ),
    attemptStartedAt: Date.now(),
    seedingWasPaused: false,
  };

  if (
    userPreferences?.pauseSeedingWhileInstalling &&
    download.shouldSeed &&
    download.downloader === Downloader.Torrent
  ) {
    await DownloadManager.pauseSeeding(gameKey).catch((error) =>
      logger.warn(
        "[AutoInstallManager] Failed to pause seeding before install",
        error
      )
    );
    activeInstall.seedingWasPaused = true;
  }

  const interactiveAllowed = userPreferences?.autoInstallInteractive ?? true;
  const innoLogPath = path.join(gamePath, "hydra-inno-install.log");

  const completeSuccessfulInstall = async () => {
    const boundExePath = await rescanAndBindExecutableAfterInstall(
      shop,
      objectId,
      gamePath,
      winePrefixPath,
      installDirPath
    );

    const installedPath = boundExePath
      ? path.dirname(boundExePath)
      : installDirPath;

    if (boundExePath) {
      const latestGame = await gamesSublevel.get(gameKey).catch(() => null);
      if (latestGame) {
        const installedSizeInBytes = await getDirectorySize(
          installedPath
        ).catch(() => null);
        await gamesSublevel.put(gameKey, {
          ...latestGame,
          installedSizeInBytes,
        });
      }
    } else {
      // The install finished but the catalogue has no executable match yet;
      // keep polling so the game still binds when it can.
      scheduleRescanPoll(
        shop,
        objectId,
        gamePath,
        winePrefixPath,
        installDirPath
      );
    }

    if (
      userPreferences?.deleteInstallerFilesAfterInstall &&
      !download.shouldSeed &&
      boundExePath &&
      !boundExePath.startsWith(gamePath + path.sep)
    ) {
      await fs.promises
        .rm(gamePath, { recursive: true, force: true })
        .catch((error) =>
          logger.warn(
            "[AutoInstallManager] Failed to delete installer files",
            error
          )
        );
    }

    await finishInstall({ installedPath });

    if (
      boundExePath &&
      (userPreferences?.launchAfterInstall ?? true) &&
      getTrackedGamesRunning().length === 0
    ) {
      await launchGame({
        shop,
        objectId,
        executablePath: boundExePath,
        launchOptions: game.launchOptions ?? null,
        launchSource: "default",
      }).catch((error) =>
        logger.error(
          "[AutoInstallManager] Failed to launch game after install",
          error
        )
      );
    }
  };

  const runInstallerAttempt = (silent: boolean): Promise<void> => {
    return new Promise<void>((resolveAttempt) => {
      activeInstall!.attemptStartedAt = Date.now();
      const args = silent
        ? buildInnoSilentArgs(
            toInstallerDirArg(installDirPath, winePrefixPath),
            toInstallerDirArg(innoLogPath, winePrefixPath)
          )
        : [];

      void executeGameInstaller(installer.path, {
        args,
        gameId: objectId,
        winePrefixPath,
        protonPath: game.protonPath,
        onChildSpawned: (child) => {
          if (activeInstall?.gameKey === gameKey) {
            activeInstall.child = child;
          }
        },
        onIndeterminateLaunch: () => {
          void (async () => {
            scheduleRescanPoll(
              shop,
              objectId,
              gamePath,
              winePrefixPath,
              installDirPath
            );
            await finishInstall({
              failure: { reason: "needs-interaction" },
            });
            resolveAttempt();
          })();
        },
        onExit: (code, _signal) => {
          void (async () => {
            if (activeInstall?.gameKey === gameKey) {
              activeInstall.child = null;
            }

            if (activeInstall?.cancelling) {
              await finishInstall({ failure: { reason: "aborted" } });
              resolveAttempt();
              return;
            }

            const ranMs = activeInstall
              ? Date.now() - activeInstall.attemptStartedAt
              : 0;
            const wroteNothing = directoryIsEmptyOrMissing(installDirPath);
            const installTook = code === 0 || code === null;

            if (
              silent &&
              (!installTook ||
                (ranMs < SILENT_FAIL_THRESHOLD_MS && wroteNothing))
            ) {
              if (interactiveAllowed) {
                logger.info(
                  `[AutoInstallManager] Silent install for ${gameKey} did not take (code=${code}, ranMs=${ranMs}); retrying interactively`
                );
                await runInstallerAttempt(false);
                resolveAttempt();
                return;
              }

              await finishInstall({
                failure: installTook
                  ? { reason: "needs-interaction" }
                  : { reason: "installer-exit", exitCode: code },
              });
              resolveAttempt();
              return;
            }

            if (!installTook) {
              await finishInstall({
                failure: { reason: "installer-exit", exitCode: code },
              });
              resolveAttempt();
              return;
            }

            await completeSuccessfulInstall();
            resolveAttempt();
          })();
        },
      }).then((launched) => {
        if (!launched) {
          void (async () => {
            await finishInstall({
              failure: { reason: "installer-exit", exitCode: null },
            });
            resolveAttempt();
          })();
        }
      });
    });
  };

  // "auto-attempt" and "inno-silent" both start silent; "preinstalled"
  // sources never reach this function (gated by the pipeline hook), but an
  // explicit installGame call still runs the installer it found.
  await runInstallerAttempt(true);
};

const processInstallQueue = async () => {
  if (processingQueue) return;
  processingQueue = true;

  try {
    while (activeInstall === null && installQueue.length > 0) {
      const next = installQueue.shift()!;
      await runInstall(next);
    }
  } catch (error) {
    logger.error("[AutoInstallManager] Install queue processing failed", error);
    activeInstall?.stopProgressMonitor?.();
    activeInstall = null;
  } finally {
    processingQueue = false;
  }
};

/**
 * Reconcile records left `installing` by a previous run: the installer child
 * is gone with the process, but an orphaned Inno setup may still be writing
 * files -- start the rescan poll and surface the game as needing attention.
 */
export const reconcileInstallsOnStartup = async (): Promise<void> => {
  const downloads = await downloadsSublevel
    .values()
    .all()
    .catch(() => []);

  for (const download of downloads) {
    if (!download.installing) continue;

    const gameKey = levelKeys.game(download.shop, download.objectId);
    await downloadsSublevel
      .put(gameKey, {
        ...download,
        installing: false,
        installFailure: { reason: "needs-interaction" },
      })
      .catch((error) =>
        logger.warn(
          `[AutoInstallManager] Failed to reconcile install state for ${gameKey}`,
          error
        )
      );

    if (download.folderName) {
      const game = await gamesSublevel.get(gameKey).catch(() => null);
      const winePrefixPath =
        process.platform === "linux"
          ? Wine.getEffectivePrefixPath(game?.winePrefixPath, download.objectId)
          : null;

      scheduleRescanPoll(
        download.shop,
        download.objectId,
        path.join(download.downloadPath, download.folderName),
        winePrefixPath,
        download.installPath
      );
    }
  }

  WindowManager.sendDownloadsUpdated();
};
