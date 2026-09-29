import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFile, type ChildProcess } from "node:child_process";

import { launchGame } from "@main/helpers/launch-game";
import { db, downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import { getDirectorySize } from "@main/events/helpers/get-directory-size";
import {
  DownloadManager,
  getDiskUsage,
  logger,
  NativeAddon,
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
import {
  VK_RETURN,
  VK_UP,
  type Download,
  type Game,
  type GameShop,
  type InstallFailure,
  type UserPreferences,
} from "@types";

import { findInstallerInFolder } from "./installer-locator";
import { pickInnoSetupLanguage } from "./inno-inspector";
import { startInstallProgressMonitor } from "./install-progress-monitor";
import {
  executeGameInstaller,
  rescanAndBindExecutableAfterInstall,
  scheduleRescanPoll,
} from "./installer-runner";

// A silent Inno run that dies or reports success this fast without leaving
// any evidence of activity never installed -- the flags were rejected or
// the payload could not be read. That is the escalation signal, not a real
// install.
const SILENT_FAIL_THRESHOLD_MS = 60_000;
// The delegated Inno process can take a few seconds to open the /LOG file
// after the bootstrapper exits, so give it a grace window before deciding
// the silent run never took.
const INNO_LOG_GRACE_MS = 12_000;
// When the wrapper exited but Inno activity is still visible, the real
// installer is a detached child: wait for Inno to drop its uninstaller
// (unins*.exe/.dat) rather than declaring victory at bootstrapper exit.
const INNO_COMPLETION_WAIT_MS = 45 * 60_000;
const INNO_COMPLETION_POLL_MS = 10_000;
const SPLASH_UNLOCK_WINDOW_MS = 60_000;
const SPLASH_UNLOCK_POLL_MS = 1_500;
const INSTALLER_AUDIO_MUTE_POLL_MS = 2_000;
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
  stopSplashWatch: (() => void) | null;
  stopAudioMuteWatch: (() => void) | null;
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

const INNO_UNINSTALL_MARKER = /^unins.*\.(exe|dat|msg)$/i;

/**
 * A setup.exe already running when the pipeline starts is almost always a
 * leftover interactive wizard -- Inno refuses a second instance and exits
 * 1 within a second or two, which looks identical to rejected flags and
 * also spams a pointless UAC consent per retry. Surface it up front.
 */
const installerAlreadyRunning = async (exeName: string): Promise<boolean> => {
  try {
    const processes = await NativeAddon.listProcesses();
    const wanted = exeName.toLowerCase();
    return processes.some(
      (process) =>
        process.name?.toLowerCase() === wanted ||
        path.basename(process.exe ?? "").toLowerCase() === wanted
    );
  } catch {
    return false;
  }
};

/**
 * Inno records the exact "Command line:" it received at the top of /LOG --
 * when a silent run dies before writing anything, that absence (or the
 * captured line) is the difference between a launch-level failure
 * (declined UAC, wrapper error) and Inno rejecting our args.
 */
const reportInnoLogTail = (logPath: string, gameKey: string) => {
  try {
    if (!fs.existsSync(logPath)) {
      logger.info(
        `[AutoInstallManager] No Inno /LOG was produced for ${gameKey}; the elevated launch never reached the installer`
      );
      return;
    }
    const contents = fs.readFileSync(logPath, "utf8");
    const lines = contents.split(/\r?\n/).filter(Boolean);
    logger.info(
      `[AutoInstallManager] Inno /LOG tail for ${gameKey}: ${lines
        .slice(-15)
        .join(" | ")}`
    );
  } catch {
    // diagnostics only
  }
};

const innoLogAppears = (logPath: string, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (fs.existsSync(logPath)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });

const waitForInnoUninstallMarker = (
  installDirPath: string,
  timeoutMs: number
): Promise<boolean> =>
  new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      let found = false;
      try {
        found = fs
          .readdirSync(installDirPath)
          .some((entry) => INNO_UNINSTALL_MARKER.test(entry));
      } catch {
        // dir missing -- keep polling, the delegated installer may create it
      }
      if (found) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, INNO_COMPLETION_POLL_MS);
    };
    check();
  });

/**
 * Installer windows that steal focus during a silent run are always
 * blockers: DODI-style wrappers paint a key-gated splash before Inno
 * proper, and multi-language repackers can still pop the Select Language
 * dialog. The same chord answers both -- Up then Enter -- so the watcher
 * polls for the window, fires the chord once when it appears, and stops.
 * Repeat sends could advance a real wizard page unintentionally.
 * Returns a disposer; the chord best-effort depends on the native addon
 * and on Hydra running at the same integrity level as the installer
 * (SendInput cannot reach an elevated installer from a non-elevated app).
 */
const watchForSplashAndUnlock = (installerPath: string): (() => void) => {
  const exeName = path.basename(installerPath);
  let timer: NodeJS.Timeout | null = null;
  let unlocked = false;
  const deadline = Date.now() + SPLASH_UNLOCK_WINDOW_MS;

  const poll = () => {
    if (unlocked || Date.now() >= deadline || activeInstall === null) return;

    let focused = false;
    try {
      focused = NativeAddon.focusGameWindow?.([exeName]) ?? false;
    } catch {
      focused = false;
    }

    if (focused) {
      unlocked = true;
      try {
        NativeAddon.sendVirtualKeyChord?.([VK_UP]);
        setTimeout(() => {
          try {
            NativeAddon.sendVirtualKeyChord?.([VK_RETURN]);
          } catch {
            // chord injection unavailable -- the splash stays up and the
            // install simply waits for manual input
          }
        }, 600);
      } catch {
        // same non-fatal path
      }
      return;
    }

    timer = setTimeout(poll, SPLASH_UNLOCK_POLL_MS);
  };

  poll();

  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
};

/**
 * Inno repacks play music from a [Code]-spawned audio session that no
 * silent flag disables. The session is created lazily inside the setup
 * process -- and any elevated respawn keeps the same exe basename -- so
 * poll for the install's lifetime and SetMute whatever sessions a
 * toolhelp match finds. Returns a disposer that stops polling and
 * best-effort unmutes in case the installer outlives the attempt.
 */
const watchInstallerAudioAndMute = (installerPath: string): (() => void) => {
  const exeName = path.basename(installerPath);
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const poll = () => {
    if (stopped || activeInstall === null) return;
    try {
      NativeAddon.muteAudioByProcessName(exeName, true);
    } catch {
      // addon unavailable -- the music stays, nothing else to do
    }
    timer = setTimeout(poll, INSTALLER_AUDIO_MUTE_POLL_MS);
  };

  poll();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      NativeAddon.muteAudioByProcessName(exeName, false);
    } catch {
      // best effort
    }
  };
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

    // A needs-interaction install can still be completed by hand; keep the
    // rescan poll running so the exe binds whenever the user finishes it.
    if (
      params.failure?.reason === "needs-interaction" &&
      download?.folderName
    ) {
      scheduleRescanPoll(
        shop,
        objectId,
        gamePath,
        winePrefixPath,
        installDirPath
      );
    }

    activeInstall?.stopProgressMonitor?.();
    activeInstall?.stopSplashWatch?.();
    activeInstall?.stopAudioMuteWatch?.();
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

  // download.installPath is persisted back as the full install dir, so a
  // stored path may already carry the title suffix -- appending it again
  // nests "Game\Game\Game..." deeper on every retry. Strip every trailing
  // segment that already equals the title, then append it exactly once.
  const titleDirName = sanitizeInstallDirName(game.title);
  let installBase = installRoot;
  while (path.basename(installBase) === titleDirName) {
    installBase = path.dirname(installBase);
  }
  const installDirPath = path.join(installBase, titleDirName);

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
    stopSplashWatch: null,
    stopAudioMuteWatch: null,
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
  // Keep /LOG out of the repack folder: Inno exits 1 before writing a byte
  // when the log target cannot be created, and an elevated token may not
  // share the user's view of the download drive. tmpdir is always writable.
  const innoLogPath = path.join(
    os.tmpdir(),
    `hydra-inno-install-${objectId}.log`
  );

  // Read the setup's own [Languages] table so /LANG names a language the
  // repack actually ships instead of guessing "english". Falls back to
  // "english" when the header cannot be parsed; a rejected name still
  // gets the retry-without-/LANG path below.
  const innoLanguage = pickInnoSetupLanguage(
    NativeAddon.inspectInnoSetup(installer.path)
  );

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

  const runInstallerAttempt = (
    silent: boolean,
    withLanguageParam = true
  ): Promise<void> => {
    return new Promise<void>((resolveAttempt) => {
      void (async () => {
        if (silent && withLanguageParam && process.platform === "win32") {
          if (await installerAlreadyRunning(path.basename(installer.path))) {
            logger.warn(
              `[AutoInstallManager] ${installer.path} is already running; the existing copy must finish before a silent install can start`
            );
            await finishInstall({
              failure: { reason: "needs-interaction" },
            });
            resolveAttempt();
            return;
          }
        }

        activeInstall!.attemptStartedAt = Date.now();
        const args = silent
          ? buildInnoSilentArgs(
              toInstallerDirArg(installDirPath, winePrefixPath),
              toInstallerDirArg(innoLogPath, winePrefixPath),
              withLanguageParam ? innoLanguage : undefined
            )
          : [];

        if (silent) {
          logger.info(
            `[AutoInstallManager] Silent install args for ${gameKey}: ${args.join(" ")}`
          );
        }

        if (silent && process.platform === "win32") {
          activeInstall!.stopSplashWatch?.();
          activeInstall!.stopSplashWatch = watchForSplashAndUnlock(
            installer.path
          );
          activeInstall!.stopAudioMuteWatch?.();
          activeInstall!.stopAudioMuteWatch = watchInstallerAudioAndMute(
            installer.path
          );
        }

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
                (!installTook || ranMs < SILENT_FAIL_THRESHOLD_MS)
              ) {
                // A clean exit that left Inno evidence behind (files in the
                // install dir or a /LOG that opened) means the bootstrapper
                // handed off to a detached child that is still unpacking.
                // Everything else means the silent run never took -- rejected
                // flags, declined UAC -- and only then is escalation right.
                const silentTook = installTook
                  ? !wroteNothing ||
                    (await innoLogAppears(innoLogPath, INNO_LOG_GRACE_MS))
                  : false;

                if (!silentTook) {
                  reportInnoLogTail(innoLogPath, gameKey);
                  if (withLanguageParam) {
                    // Inno aborts when /LANG names a language the repack
                    // does not ship -- indistinguishable from rejected flags
                    // at this speed, so retry silently without it once
                    // before calling the flags rejected.
                    logger.info(
                      `[AutoInstallManager] Silent install for ${gameKey} failed fast with /LANG (code=${code}); retrying without the language override`
                    );
                    await runInstallerAttempt(true, false);
                    resolveAttempt();
                    return;
                  }

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

                logger.info(
                  `[AutoInstallManager] Installer for ${gameKey} exited with Inno activity still visible; waiting for the detached installer`
                );
                const detachedFinished = await waitForInnoUninstallMarker(
                  installDirPath,
                  INNO_COMPLETION_WAIT_MS
                );
                if (!detachedFinished) {
                  logger.warn(
                    `[AutoInstallManager] Timed out waiting for detached installer for ${gameKey}; completing anyway`
                  );
                }
                await completeSuccessfulInstall();
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
      })();
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
