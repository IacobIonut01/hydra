import { shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  GameShop,
  type Game,
  type GameLaunchResult,
  type LaunchSource,
  type UserPreferences,
} from "@types";
import { db, gamesSublevel, levelKeys } from "@main/level";
import { updateGameExecutablePath } from "./update-executable-path";
import {
  clearCloudSaveLaunchGuard,
  canRunAutomaticCloudSaveSync,
  canCreateCloudSaveUploadGuard,
  createPendingCloudSaveCustomPathApproval,
  getCloudSaveGameContext,
  rotateCloudSavePrefixGeneration,
  runAutomaticCloudSaveSyncDetailed,
  runWithCloudSaveLaunchGate,
  setCloudSaveLaunchGuard,
  shouldBlockGameLaunchForCloudSave,
} from "@main/services/cloud-save";
import {
  WindowManager,
  logger,
  Umu,
  PowerSaveBlockerManager,
  Wine,
  NativeAddon,
  DisplayManager,
  launchedGamePids,
  beginGameLaunch,
  consumeGameLaunchCancellation,
  failGameLaunch,
  setGameLaunchPhase,
} from "@main/services";
import { updateGameRecord } from "@main/services/game-record-updater";
import { dispatchSteamProtocolLaunch } from "@main/services/steam-integration/steam-protocol-launch-dispatch";
import { resolveSteamProtocolLaunch } from "@main/services/steam-integration/steam-protocol-launch";
import { CommonRedistManager } from "@main/services/common-redist-manager";
import { runAchievementMetadataExport } from "@main/services/achievements/metadata-export";
import { parseExecutablePath } from "../events/helpers/parse-executable-path";
import { ensureFirewallAllowRule } from "./firewall-rules";
import { isGamemodeAvailable } from "./is-gamemode-available";
import { isMangohudAvailable } from "./is-mangohud-available";
import { resolveLaunchCommand } from "./resolve-launch-command";
import {
  buildWindowsBatchCommand,
  isWindowsBatchFile,
} from "./windows-batch-command";

export interface LaunchGameOptions {
  shop: GameShop;
  objectId: string;
  executablePath: string;
  launchOptions?: string | null;
  launchSource?: LaunchSource;
}

const LAUNCH_DELAY_IN_MS = 2_000;

const isWindowsExecutable = (executablePath: string) =>
  path.extname(executablePath).toLowerCase() === ".exe";

const ensureExecutablePermission = (executablePath: string) => {
  try {
    const currentMode = fs.statSync(executablePath).mode;
    const hasOwnerExecuteBit = (currentMode & 0o100) !== 0;

    if (!hasOwnerExecuteBit) {
      fs.chmodSync(executablePath, currentMode | 0o100);
    }
  } catch (error) {
    logger.warn("Failed to ensure executable permission", {
      executablePath,
      error,
    });
  }
};

type LaunchSpawnOutcome =
  | { ok: true; pid: number | null }
  | { ok: false; detail: string };

const spawnDetached = (
  command: string,
  args: string[],
  spawnOptions: Parameters<typeof spawn>[2]
): Promise<LaunchSpawnOutcome> =>
  new Promise<LaunchSpawnOutcome>((resolve) => {
    const processRef = spawn(command, args, spawnOptions);

    processRef.once("spawn", () => {
      processRef.unref();
      resolve({ ok: true, pid: processRef.pid ?? null });
    });

    processRef.once("error", (error) => {
      logger.error("Failed to launch game", error);
      resolve({ ok: false, detail: error.message });
    });
  });

const launchNatively = async (
  executablePath: string,
  launchOptions?: string | null,
  useMangohud = false,
  useGamemode = false
): Promise<LaunchSpawnOutcome> => {
  const workingDirectory = path.dirname(executablePath);
  const resolvedLaunchCommand = resolveLaunchCommand({
    baseCommand: executablePath,
    launchOptions,
    wrapperCommands: [
      ...(useGamemode ? ["gamemoderun"] : []),
      ...(useMangohud ? ["mangohud"] : []),
    ],
  });

  if (process.platform === "linux") {
    ensureExecutablePermission(executablePath);
  } else if (
    resolvedLaunchCommand.command === executablePath &&
    resolvedLaunchCommand.args.length === 0 &&
    Object.keys(resolvedLaunchCommand.env).length === 0
  ) {
    const openError = await shell.openPath(executablePath);
    if (!openError) return { ok: true, pid: null };

    logger.error("Failed to launch game", {
      executablePath,
      error: openError,
    });
    return { ok: false, detail: openError };
  }

  if (
    process.platform === "win32" &&
    isWindowsBatchFile(resolvedLaunchCommand.command)
  ) {
    return spawnDetached(
      buildWindowsBatchCommand(
        resolvedLaunchCommand.command,
        resolvedLaunchCommand.args
      ),
      [],
      {
        shell: true,
        detached: true,
        stdio: "ignore",
        cwd: workingDirectory,
        env: {
          ...process.env,
          ...resolvedLaunchCommand.env,
        },
      }
    );
  }

  return spawnDetached(
    resolvedLaunchCommand.command,
    resolvedLaunchCommand.args,
    {
      shell: false,
      detached: true,
      stdio: "ignore",
      cwd: workingDirectory,
      env: {
        ...process.env,
        ...resolvedLaunchCommand.env,
      },
    }
  );
};

const launchWithWine = async (
  executablePath: string,
  launchOptions?: string | null,
  useMangohud = false,
  useGamemode = false,
  winePrefixPath?: string | null
): Promise<boolean> => {
  const workingDirectory = path.dirname(executablePath);
  const resolvedLaunchCommand = resolveLaunchCommand({
    baseCommand: "wine",
    baseArgs: [executablePath],
    launchOptions,
    wrapperCommands: [
      ...(useGamemode ? ["gamemoderun"] : []),
      ...(useMangohud ? ["mangohud"] : []),
    ],
  });

  return await new Promise<boolean>((resolve) => {
    const processRef = spawn(
      resolvedLaunchCommand.command,
      resolvedLaunchCommand.args,
      {
        shell: false,
        detached: true,
        stdio: "ignore",
        cwd: workingDirectory,
        env: {
          ...process.env,
          ...(winePrefixPath ? { WINEPREFIX: winePrefixPath } : {}),
          ...resolvedLaunchCommand.env,
        },
      }
    );

    processRef.once("spawn", () => {
      processRef.unref();
      resolve(true);
    });

    processRef.once("error", (error) => {
      logger.error("Failed to launch game with Wine", error);
      resolve(false);
    });
  });
};

interface LinuxCompatibilityLaunchContext {
  protonPath: string | null;
  winePrefixPath: string | null;
}

const isValidWinePrefix = (winePrefixPath: string | null) => {
  if (!winePrefixPath) return false;

  try {
    return Wine.validatePrefix(winePrefixPath);
  } catch {
    return false;
  }
};

const resolveProtonPathForLaunch = async (
  gameProtonPath?: string | null
): Promise<string | null> => {
  if (gameProtonPath && Umu.isValidProtonPath(gameProtonPath)) {
    return gameProtonPath;
  }

  const userPreferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);

  const defaultProtonPath = userPreferences?.defaultProtonPath;

  if (defaultProtonPath && Umu.isValidProtonPath(defaultProtonPath)) {
    return defaultProtonPath;
  }

  return null;
};

interface CloudSavePrefixPreparationResult {
  winePrefixPath: string | null;
  readyForRestore: boolean;
  safeForUpload: boolean;
  generationOverride?: Awaited<
    ReturnType<typeof rotateCloudSavePrefixGeneration>
  >;
}

const prepareWinePrefixIfNeeded = async (
  context: LinuxCompatibilityLaunchContext,
  objectId: string,
  prefixWasReadyForRestore: boolean
) => {
  if (prefixWasReadyForRestore) return false;

  try {
    await Umu.preparePrefix({
      winePrefixPath: context.winePrefixPath!,
      protonPath: context.protonPath,
      gameId: objectId,
    });
    return false;
  } catch (error) {
    logger.error("Failed to prepare Wine prefix before cloud save restore", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
    return true;
  }
};

const prepareCompatibilityPrefixForCloudSave = async (
  context: LinuxCompatibilityLaunchContext,
  objectId: string
): Promise<CloudSavePrefixPreparationResult> => {
  const winePrefixPath = context.winePrefixPath;
  if (!winePrefixPath) {
    return {
      winePrefixPath: null,
      readyForRestore: false,
      safeForUpload: false,
    };
  }

  const prefixWasValid = isValidWinePrefix(winePrefixPath);
  const prefixWasReadyForRestore =
    prefixWasValid && Wine.isPrefixReadyForRestore(winePrefixPath);
  const preparationFailed = await prepareWinePrefixIfNeeded(
    context,
    objectId,
    prefixWasReadyForRestore
  );

  const canonicalWinePrefixPath =
    (await Wine.resolvePrefixPath(winePrefixPath)) ?? winePrefixPath;
  const prefixValid = isValidWinePrefix(canonicalWinePrefixPath);
  const wineProfiles = prefixValid
    ? Wine.getPrefixUserProfiles(canonicalWinePrefixPath)
    : [];
  const readyForRestore = prefixValid && wineProfiles.length > 0;

  logger.info("[Cloud Save] Wine prefix preparation result", {
    objectId,
    requestedWinePrefixPath: winePrefixPath,
    canonicalWinePrefixPath,
    prefixValid,
    wineProfiles,
    readyForRestore,
    preparationFailed,
  });

  if (!readyForRestore) {
    return {
      winePrefixPath: canonicalWinePrefixPath,
      readyForRestore: false,
      safeForUpload: false,
    };
  }

  if (prefixWasReadyForRestore) {
    return {
      winePrefixPath: canonicalWinePrefixPath,
      readyForRestore: true,
      safeForUpload: !preparationFailed,
    };
  }

  const generationOverride = await rotateCloudSavePrefixGeneration(
    canonicalWinePrefixPath
  ).catch((error: unknown) => {
    logger.error("Failed to rotate cloud save prefix generation", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
    return undefined;
  });

  return {
    winePrefixPath: canonicalWinePrefixPath,
    readyForRestore: true,
    safeForUpload: !preparationFailed && generationOverride?.durable === true,
    generationOverride,
  };
};

const cleanupStaleCompatibilityProcesses = async (
  objectId: string,
  winePrefixPath: string | null
) => {
  if (process.platform !== "linux" || !winePrefixPath) return;

  const defaultPrefixPath = await Wine.resolvePrefixPath(
    Wine.getDefaultPrefixPathForGame(objectId)
  );
  if (defaultPrefixPath !== winePrefixPath) return;

  const processes = await NativeAddon.listProcesses();

  const stalePids = processes
    .filter((runningProcess) => {
      const processPrefix = runningProcess.environ?.STEAM_COMPAT_DATA_PATH;
      if (processPrefix !== winePrefixPath) return false;

      const processExe = runningProcess.exe?.toLowerCase() ?? "";
      const processName = runningProcess.name.toLowerCase();

      return (
        processExe.includes("wine") ||
        processName.endsWith(".exe") ||
        processName === "wineserver"
      );
    })
    .map((runningProcess) => runningProcess.pid);

  if (!stalePids.length) return;

  logger.info("Killing stale compatibility processes before game launch", {
    objectId,
    winePrefixPath,
    stalePids,
  });

  for (const pid of stalePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore races and missing permissions.
    }
  }
};

const launchWindowsBinaryOnLinux = async (
  gameKey: string,
  objectId: string,
  parsedPath: string,
  compatibilityContext: LinuxCompatibilityLaunchContext,
  launchOptions: string | null | undefined,
  useMangohud: boolean,
  useGamemode: boolean
): Promise<LaunchSpawnOutcome> => {
  const { protonPath, winePrefixPath } = compatibilityContext;
  let umuErrorDetail = "umu-run launch failed";

  try {
    await Umu.launchExecutable(parsedPath, [], {
      winePrefixPath,
      protonPath,
      gameId: objectId,
      launchOptions,
      useGamemode,
      useMangohud,
    });
    PowerSaveBlockerManager.markCompatibilityLaunchStarted(gameKey);
    return { ok: true, pid: null };
  } catch (error) {
    logger.error("Failed to launch game with umu-run, falling back", error);
    umuErrorDetail = error instanceof Error ? error.message : umuErrorDetail;
  }

  const launchedWithWine = await launchWithWine(
    parsedPath,
    launchOptions,
    useMangohud,
    useGamemode,
    winePrefixPath
  );

  if (launchedWithWine) {
    PowerSaveBlockerManager.markCompatibilityLaunchStarted(gameKey);
    return { ok: true, pid: null };
  }

  return { ok: false, detail: umuErrorDetail };
};

interface PreparedLinuxCompatibility {
  context: LinuxCompatibilityLaunchContext | null;
  prefixReadyForRestore: boolean;
  prefixSafeForUpload: boolean;
  prefixGenerationOverride?: Awaited<
    ReturnType<typeof rotateCloudSavePrefixGeneration>
  >;
}

const prepareSteamCompatibilityForCloudSave = (
  compatibilityPrefixPath: string
): PreparedLinuxCompatibility => {
  const prefixValid = isValidWinePrefix(compatibilityPrefixPath);
  const prefixReadyForRestore =
    prefixValid && Wine.isPrefixReadyForRestore(compatibilityPrefixPath);

  logger.info("[Cloud Save] Resolved Steam compatibility prefix", {
    compatibilityPrefixPath,
    prefixValid,
    prefixReadyForRestore,
  });

  return {
    context: {
      protonPath: null,
      winePrefixPath: compatibilityPrefixPath,
    },
    prefixReadyForRestore,
    prefixSafeForUpload: prefixReadyForRestore,
  };
};

const prepareLinuxCompatibilityForLaunch = async (
  parsedPath: string,
  game: Game | undefined,
  objectId: string,
  shop: GameShop,
  shouldPrepareForCloudSave: boolean
): Promise<PreparedLinuxCompatibility> => {
  if (process.platform !== "linux" || !isWindowsExecutable(parsedPath)) {
    return {
      context: null,
      prefixReadyForRestore: true,
      prefixSafeForUpload: true,
    };
  }

  const requestedWinePrefixPath = Wine.getEffectivePrefixPath(
    game?.winePrefixPath,
    objectId
  );
  let context: LinuxCompatibilityLaunchContext = {
    protonPath: await resolveProtonPathForLaunch(game?.protonPath),
    winePrefixPath: await Wine.resolvePrefixPath(requestedWinePrefixPath),
  };
  logger.info("[Cloud Save] Resolved authoritative launch prefix", {
    shop,
    objectId,
    requestedWinePrefixPath,
    canonicalWinePrefixPath: context.winePrefixPath,
    prefixSource: game?.winePrefixPath ? "game" : "default",
  });
  await cleanupStaleCompatibilityProcesses(objectId, context.winePrefixPath);

  if (!shouldPrepareForCloudSave) {
    return {
      context,
      prefixReadyForRestore: true,
      prefixSafeForUpload: true,
    };
  }

  const prefixPreparation = await prepareCompatibilityPrefixForCloudSave(
    context,
    objectId
  );
  context = {
    ...context,
    winePrefixPath: prefixPreparation.winePrefixPath,
  };
  return {
    context,
    prefixReadyForRestore: prefixPreparation.readyForRestore,
    prefixSafeForUpload: prefixPreparation.safeForUpload,
    prefixGenerationOverride: prefixPreparation.generationOverride,
  };
};

const redirectBlockedCloudSaveLaunch = (
  shop: GameShop,
  objectId: string,
  title: string,
  searchParam: "openCloudSavePathApproval" | "openCloudSaveConflict"
) => {
  const searchParams = new URLSearchParams({
    title,
    [searchParam]: "1",
  });
  clearCloudSaveLaunchGuard(objectId, shop);
  WindowManager.closeGameLauncherWindow();
  WindowManager.redirectToGameWindow(
    `game/${shop}/${objectId}?${searchParams.toString()}`
  );
};

const runCommonRedistPreflight = async (shop: GameShop, objectId: string) => {
  if (process.platform !== "win32") return;

  try {
    logger.log("Starting preflight check for game launch", {
      shop,
      objectId,
    });
    const preflightPassed = await CommonRedistManager.runPreflight();
    logger.log("Preflight check result", { passed: preflightPassed });
  } catch (error) {
    logger.error("Preflight check failed with error", error);
  }
};

const getLaunchDisplay = async (launchSource?: LaunchSource) => {
  if (launchSource !== "big-picture") {
    return undefined;
  }

  return DisplayManager.getBigPictureDisplay();
};

const prepareBigPictureDisplayForLaunchSource = async (
  launchSource?: LaunchSource
) => {
  if (launchSource !== "big-picture") {
    return;
  }

  // Re-assert at launch time because display settings can change while Big Picture stays open.
  await DisplayManager.prepareBigPictureDisplayForLaunch();
  await WindowManager.reapplyBigPictureUiScalePreference();
};

const launchResolvedGame = async (
  gameKey: string,
  shop: GameShop,
  objectId: string,
  parsedPath: string,
  compatibilityContext: LinuxCompatibilityLaunchContext | null,
  launchOptions: string | null | undefined,
  useMangohud: boolean,
  useGamemode: boolean
): Promise<GameLaunchResult> => {
  if (process.platform !== "linux") {
    const outcome = await launchNatively(
      parsedPath,
      launchOptions,
      useMangohud,
      useGamemode
    );

    if (!outcome.ok) {
      clearCloudSaveLaunchGuard(objectId, shop);
      return {
        status: "failed",
        error: "spawn-failed",
        detail: outcome.detail,
      };
    }

    return { status: "launched", pid: outcome.pid };
  }

  if (isWindowsExecutable(parsedPath)) {
    if (!compatibilityContext) {
      clearCloudSaveLaunchGuard(objectId, shop);
      return {
        status: "failed",
        error: "wine-failed",
        detail: "no compatibility context resolved",
      };
    }

    const compatOutcome = await launchWindowsBinaryOnLinux(
      gameKey,
      objectId,
      parsedPath,
      compatibilityContext,
      launchOptions,
      useMangohud,
      useGamemode
    );
    if (compatOutcome.ok) return { status: "launched", pid: null };
    clearCloudSaveLaunchGuard(objectId, shop);
  }

  const outcome = await launchNatively(
    parsedPath,
    launchOptions,
    useMangohud,
    useGamemode
  );

  if (!outcome.ok) {
    clearCloudSaveLaunchGuard(objectId, shop);
    return {
      status: "failed",
      error: "spawn-failed",
      detail: outcome.detail,
    };
  }

  if (outcome.pid !== null) launchedGamePids.set(gameKey, outcome.pid);
  return { status: "launched", pid: outcome.pid };
};

interface ResolvedLaunchGameOptions extends LaunchGameOptions {
  userPreferences: UserPreferences | null;
  gameMode: boolean;
}

/**
 * Shows the launcher window and launches the game executable
 * Shared between deep link handler and openGame event
 */
const launchGameWithCloudSaveChecks = async (
  options: ResolvedLaunchGameOptions
): Promise<GameLaunchResult> => {
  const { shop, objectId, executablePath, launchOptions, launchSource } =
    options;

  const parsedPath = parseExecutablePath(executablePath);

  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);
  clearCloudSaveLaunchGuard(objectId, shop);

  const steamProtocolLaunch =
    shop === "steam"
      ? await resolveSteamProtocolLaunch(
          objectId,
          parsedPath,
          launchOptions
        ).catch((error) => {
          logger.error("Failed to resolve Steam protocol launch", {
            objectId,
            executablePath: parsedPath,
            error,
          });
          return null;
        })
      : null;

  const userPreferences = options.userPreferences;

  const useMangohud =
    (userPreferences?.autoRunMangohud === true ||
      game?.autoRunMangohud === true) &&
    isMangohudAvailable();

  const useGamemode =
    (userPreferences?.autoRunGamemode === true ||
      game?.autoRunGamemode === true) &&
    isGamemodeAvailable();

  const steamCompatibilityPrefixPath =
    process.platform === "linux" &&
    isWindowsExecutable(parsedPath) &&
    steamProtocolLaunch
      ? steamProtocolLaunch.compatibilityPrefixPath
      : null;

  const updatedGame = game
    ? await updateGameRecord(gameKey, (currentGame) => ({
        ...updateGameExecutablePath(currentGame, parsedPath),
        launchOptions,
        ...(steamCompatibilityPrefixPath
          ? { winePrefixPath: steamCompatibilityPrefixPath }
          : {}),
      }))
    : null;
  const launchGameRecord = updatedGame ?? game;

  if (!options.gameMode) {
    const launchDisplay = await getLaunchDisplay(launchSource);
    await WindowManager.createGameLauncherWindow(shop, objectId, launchDisplay);
  }

  const shouldRunV2AutomaticSync = await canRunAutomaticCloudSaveSync(
    objectId,
    shop
  );
  const {
    context: compatibilityContext,
    prefixReadyForRestore,
    prefixSafeForUpload,
    prefixGenerationOverride,
  } = steamCompatibilityPrefixPath
    ? prepareSteamCompatibilityForCloudSave(steamCompatibilityPrefixPath)
    : await prepareLinuxCompatibilityForLaunch(
        parsedPath,
        launchGameRecord,
        objectId,
        shop,
        shouldRunV2AutomaticSync
      );

  const cloudSaveContext = shouldRunV2AutomaticSync
    ? await getCloudSaveGameContext(objectId, shop, {
        executablePath: parsedPath,
        winePrefixPath: compatibilityContext?.winePrefixPath,
        prefixGenerationOverride,
      }).catch((error: unknown) => {
        logger.error("Failed to resolve cloud save launch environment", error);
        return null;
      })
    : null;
  const customPathApproval =
    prefixReadyForRestore && cloudSaveContext
      ? await createPendingCloudSaveCustomPathApproval(
          options,
          cloudSaveContext
        ).catch((error: unknown) => {
          logger.error(
            "[Cloud Save] Failed to inspect custom restore destinations",
            error
          );
          return null;
        })
      : null;

  if (customPathApproval) {
    logger.warn(
      "[Cloud Save] Game launch blocked by an unapproved custom restore path",
      {
        shop,
        objectId,
        rawPath: customPathApproval.rawPath,
      }
    );
    redirectBlockedCloudSaveLaunch(
      shop,
      objectId,
      launchGameRecord?.title ?? objectId,
      "openCloudSavePathApproval"
    );
    failGameLaunch(shop, objectId, "cloud-save-blocked");
    return { status: "blocked" };
  }

  setGameLaunchPhase(shop, objectId, "syncing-saves");

  const preLaunchOutcome =
    shouldRunV2AutomaticSync && prefixReadyForRestore
      ? await runAutomaticCloudSaveSyncDetailed(
          objectId,
          shop,
          "pre-launch",
          cloudSaveContext ?? undefined
        )
      : { status: "skipped" as const, result: null };
  const preLaunchResult = preLaunchOutcome.result;
  const hasPreLaunchConflict =
    preLaunchResult?.trigger === "pre-launch" &&
    preLaunchResult.action === "conflict";

  if (shouldRunV2AutomaticSync && !prefixReadyForRestore) {
    logger.warn(
      "[Cloud Save] Pre-launch restore skipped because Wine prefix is invalid",
      { shop, objectId }
    );
  }

  if (
    shouldBlockGameLaunchForCloudSave(
      preLaunchResult,
      preLaunchOutcome.status === "failed"
    )
  ) {
    logger.warn("[Cloud Save] Game launch blocked by pre-launch sync", {
      shop,
      objectId,
      reason: hasPreLaunchConflict ? "conflict" : "restore_failed",
    });
    if (hasPreLaunchConflict) {
      redirectBlockedCloudSaveLaunch(
        shop,
        objectId,
        launchGameRecord?.title ?? objectId,
        "openCloudSaveConflict"
      );
    } else {
      clearCloudSaveLaunchGuard(objectId, shop);
      WindowManager.closeGameLauncherWindow();
    }
    failGameLaunch(shop, objectId, "cloud-save-blocked");
    return { status: "blocked" };
  }

  if (cloudSaveContext) {
    setCloudSaveLaunchGuard(objectId, shop, {
      environmentId: cloudSaveContext.environmentId,
      baseRemoteHash: preLaunchResult?.remoteHash ?? null,
      uploadAllowed: canCreateCloudSaveUploadGuard(
        prefixSafeForUpload &&
          cloudSaveContext.prefixIdentityMode !== "session",
        cloudSaveContext.environmentId,
        preLaunchResult
      ),
      createdAt: new Date().toISOString(),
    });
  }

  // Run preflight check for common redistributables (Windows only)
  // Wrapped in try/catch to ensure game launch is never blocked
  setGameLaunchPhase(shop, objectId, "checking-redistributables");
  await runCommonRedistPreflight(shop, objectId);

  if (updatedGame) {
    setGameLaunchPhase(shop, objectId, "exporting-achievements");
    void runAchievementMetadataExport(gameKey, updatedGame);
  }

  await new Promise((resolve) => setTimeout(resolve, LAUNCH_DELAY_IN_MS));
  await prepareBigPictureDisplayForLaunchSource(launchSource);

  if (consumeGameLaunchCancellation(shop, objectId)) {
    clearCloudSaveLaunchGuard(objectId, shop);
    failGameLaunch(shop, objectId, "cancelled");
    return { status: "cancelled" };
  }

  setGameLaunchPhase(shop, objectId, "launching");

  if (process.platform === "win32" && NativeAddon.isProcessElevated()) {
    await ensureFirewallAllowRule(
      parsedPath,
      launchGameRecord?.title ?? objectId
    );
  }

  if (steamProtocolLaunch) {
    if (launchOptions?.includes("%command%") || useMangohud || useGamemode) {
      logger.warn(
        "Steam protocol launch delegates command wrappers to Steam settings",
        {
          objectId,
          hasCommandWrapper: launchOptions?.includes("%command%") === true,
          useMangohud,
          useGamemode,
        }
      );
    }

    const dispatchResult = await dispatchSteamProtocolLaunch(
      steamProtocolLaunch,
      (url) => shell.openExternal(url),
      async (compatibilityPrefixPath) => {
        logger.warn("Falling back from Steam protocol launch", {
          objectId,
          executablePath: parsedPath,
          compatibilityPrefixPath,
        });

        return launchResolvedGame(
          gameKey,
          shop,
          objectId,
          parsedPath,
          compatibilityContext,
          launchOptions,
          useMangohud,
          useGamemode
        );
      }
    );

    if (dispatchResult.method === "steam") {
      if (steamCompatibilityPrefixPath) {
        PowerSaveBlockerManager.markCompatibilityLaunchStarted(gameKey);
      }
      logger.info("Launched game through Steam protocol", {
        objectId,
        executablePath: parsedPath,
      });
      setGameLaunchPhase(shop, objectId, "awaiting-process");
      return { status: "launched", pid: null };
    }

    logger.error("Failed to launch game through Steam protocol", {
      objectId,
      executablePath: parsedPath,
      error: dispatchResult.error,
    });

    if (dispatchResult.value?.status === "failed") {
      failGameLaunch(
        shop,
        objectId,
        dispatchResult.value.error,
        dispatchResult.value.detail ?? null
      );
    }

    return dispatchResult.value;
  }

  const result = await launchResolvedGame(
    gameKey,
    shop,
    objectId,
    parsedPath,
    compatibilityContext,
    launchOptions,
    useMangohud,
    useGamemode
  );

  if (result.status === "launched") {
    setGameLaunchPhase(shop, objectId, "awaiting-process");
  } else if (result.status === "failed") {
    failGameLaunch(shop, objectId, result.error, result.detail ?? null);
  }

  return result;
};

const hasLaunchableExecutable = (executablePath: string) => {
  if (!executablePath || !fs.existsSync(executablePath)) return false;

  try {
    return fs.existsSync(parseExecutablePath(executablePath));
  } catch {
    return false;
  }
};

export const launchGame = async (
  options: LaunchGameOptions
): Promise<GameLaunchResult> => {
  const launchSource = options.launchSource ?? "default";
  const userPreferences = await db
    .get<string, UserPreferences | null>(levelKeys.userPreferences, {
      valueEncoding: "json",
    })
    .catch(() => null);

  const gameMode =
    launchSource === "big-picture" &&
    userPreferences?.bigPictureGameModeEnabled === true;

  beginGameLaunch(options.shop, options.objectId, launchSource, gameMode);

  if (gameMode) {
    WindowManager.bigPictureWindow?.webContents.send(
      "on-navigate",
      `/big-picture/launching/${options.shop}/${options.objectId}`
    );
  }

  if (!hasLaunchableExecutable(options.executablePath)) {
    logger.warn("Game executable not found", {
      shop: options.shop,
      objectId: options.objectId,
      executablePath: options.executablePath,
    });
    failGameLaunch(options.shop, options.objectId, "executable-not-found");
    WindowManager.sendToAppWindows(
      "on-game-executable-not-found",
      options.shop,
      options.objectId
    );
    return { status: "failed", error: "executable-not-found" };
  }

  try {
    return await runWithCloudSaveLaunchGate(
      options.objectId,
      options.shop,
      () =>
        launchGameWithCloudSaveChecks({ ...options, userPreferences, gameMode })
    );
  } catch (error) {
    logger.error("Game launch was rejected by the cloud save gate", {
      shop: options.shop,
      objectId: options.objectId,
      error,
    });
    failGameLaunch(options.shop, options.objectId, "cloud-save-blocked");
    return { status: "blocked" };
  }
};
