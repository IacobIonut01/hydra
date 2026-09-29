import { shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

import { updateGameExecutablePath } from "@main/helpers/update-executable-path";
import { withGameRecordLock } from "@main/helpers/game-record-lock";
import {
  rankExecutableCandidates,
  type ExecutableSearchScope,
  type KnownGameExecutable,
} from "@main/helpers/game-executable-ranking";
import { getInstallLocationScanDirectories } from "@main/events/library/scan-installed-games";
import { gamesSublevel, levelKeys } from "@main/level";
import { GameShop } from "@types";
import {
  GameExecutables,
  logger,
  Umu,
  WindowManager,
  runAutomaticCloudSaveSync,
} from "@main/services";

const MAX_INSTALL_SCAN_DEPTH = 6;

const collectAccessibleFilePaths = async (
  rootPath: string
): Promise<string[]> => {
  const filePaths: string[] = [];

  const walk = async (currentPath: string, depth: number) => {
    if (depth > MAX_INSTALL_SCAN_DEPTH) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentPath, {
        withFileTypes: true,
      });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await walk(entryPath, depth + 1);
        } else if (entry.isFile()) {
          filePaths.push(path.relative(rootPath, entryPath));
        }
      })
    );
  };

  await walk(rootPath, 0);
  return filePaths;
};

const findGameExecutableResilient = async (
  folderPath: string,
  executables: KnownGameExecutable[],
  scope: ExecutableSearchScope
): Promise<string | null> => {
  if (executables.length === 0) return null;

  const relativeFilePaths = await collectAccessibleFilePaths(folderPath);
  const match = rankExecutableCandidates(relativeFilePaths, executables, scope);

  return match ? path.join(folderPath, match) : null;
};

interface ScanCandidate {
  folderPath: string;
  // "installation" commits to a pick even when ambiguous, appropriate for
  // the download folder since extraction only ever puts one game there.
  // "library" backs off to null on ambiguity instead, required for shared
  // roots (Program Files-equivalents, Steam library folders) that can
  // contain other installed software or games with clashing executable
  // names -- see rankExecutableCandidates in game-executable-ranking.ts.
  scope: ExecutableSearchScope;
}

const getScanCandidates = async (
  downloadFolderPath: string,
  winePrefixPath?: string | null,
  installDirPath?: string | null
): Promise<ScanCandidate[]> => {
  const candidates: ScanCandidate[] = [
    { folderPath: downloadFolderPath, scope: "installation" },
  ];

  if (installDirPath && installDirPath !== downloadFolderPath) {
    candidates.push({ folderPath: installDirPath, scope: "installation" });
  }

  if (process.platform === "linux" && winePrefixPath) {
    candidates.push({
      folderPath: path.join(winePrefixPath, "drive_c"),
      scope: "library",
    });
  }

  if (process.platform === "win32") {
    const sharedInstallDirectories = await getInstallLocationScanDirectories();
    candidates.push(
      ...sharedInstallDirectories.map((folderPath) => ({
        folderPath,
        scope: "library" as const,
      }))
    );
  }

  return candidates;
};

export const rescanAndBindExecutableAfterInstall = async (
  shop: GameShop,
  objectId: string,
  downloadFolderPath: string,
  winePrefixPath?: string | null,
  installDirPath?: string | null
): Promise<string | null> => {
  try {
    const gameKey = levelKeys.game(shop, objectId);
    const game = await gamesSublevel.get(gameKey);

    if (!game || game.executablePath) return game?.executablePath ?? null;

    const executables = GameExecutables.getExecutablesForGame(objectId);
    if (!executables || executables.length === 0) {
      logger.info(
        `[installerRunner] Installer exited for ${objectId}, but no known executables to search for -- skipping rescan`
      );
      return null;
    }

    logger.info(
      `[installerRunner] Installer exited for ${objectId}, scanning for executable`
    );

    const candidateFolders = await getScanCandidates(
      downloadFolderPath,
      winePrefixPath,
      installDirPath
    );

    for (const candidate of candidateFolders) {
      if (!fs.existsSync(candidate.folderPath)) continue;

      const foundExePath = await findGameExecutableResilient(
        candidate.folderPath,
        executables,
        candidate.scope
      );

      if (!foundExePath) continue;

      const bound = await withGameRecordLock(gameKey, async () => {
        const latestGame = await gamesSublevel.get(gameKey);
        if (!latestGame || latestGame.executablePath) return false;

        await gamesSublevel.put(gameKey, {
          ...updateGameExecutablePath(latestGame, foundExePath),
        });

        return true;
      });

      if (!bound) return foundExePath;

      logger.info(
        `[installerRunner] Auto-detected executable after installer exit for ${objectId}: ${foundExePath}`
      );

      void runAutomaticCloudSaveSync(objectId, shop, "environment-changed");
      WindowManager.sendToAppWindows("on-library-batch-complete");
      return foundExePath;
    }

    logger.info(
      `[installerRunner] Scanned ${candidateFolders.length} candidate folder(s) for ${objectId}, no matching executable found`
    );
    return null;
  } catch (error) {
    logger.error(
      `[installerRunner] Error scanning for executable after install: ${objectId}`,
      error
    );
    return null;
  }
};

// shell.openPath (the fallback when we can't spawn the installer ourselves,
// e.g. it needs elevation) hands the launch off to the OS and returns as
// soon as that succeeds -- there's no child process to observe exiting, so
// rescanAndBindExecutableAfterInstall would otherwise never run for these
// launches. Poll instead: check periodically for a bounded window, stopping
// as soon as the executable is found or the game is otherwise linked.
const POST_INSTALL_POLL_INTERVAL_MS = 30_000;
const POST_INSTALL_POLL_ATTEMPTS = 60;

export const scheduleRescanPoll = (
  shop: GameShop,
  objectId: string,
  downloadFolderPath: string,
  winePrefixPath?: string | null,
  installDirPath?: string | null,
  attemptsRemaining = POST_INSTALL_POLL_ATTEMPTS
) => {
  if (attemptsRemaining <= 0) return;

  setTimeout(() => {
    void (async () => {
      const gameKey = levelKeys.game(shop, objectId);
      const game = await gamesSublevel.get(gameKey).catch(() => null);
      if (!game || game.executablePath) return;

      const foundExePath = await rescanAndBindExecutableAfterInstall(
        shop,
        objectId,
        downloadFolderPath,
        winePrefixPath,
        installDirPath
      );

      if (foundExePath) return;

      scheduleRescanPoll(
        shop,
        objectId,
        downloadFolderPath,
        winePrefixPath,
        installDirPath,
        attemptsRemaining - 1
      );
    })();
  }, POST_INSTALL_POLL_INTERVAL_MS);
};

const launchInstallerWithWine = async (
  filePath: string,
  args: string[],
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  onChildSpawned?: (child: ChildProcess) => void
): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("wine", [filePath, ...args], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });

    child.once("spawn", () => {
      onChildSpawned?.(child);
      if (!onChildSpawned) child.unref();
      resolve(true);
    });

    child.once("exit", (code, signal) => {
      onExit?.(code, signal);
    });

    child.once("error", (error) => {
      logger.error("Failed to execute game installer with wine", error);
      resolve(false);
    });
  });
};

// Capture a child stderr stream and log it once if the process exits
// non-zero -- the elevated wrapper turns "UAC declined" into a legible
// Start-Process error instead of an opaque code 1.
const collectChildStderr = (child: ChildProcess, label: string) => {
  let output = "";
  const capture = (chunk: Buffer | string) => {
    if (output.length < 8192) output += chunk;
  };
  child.stderr?.on("data", capture);
  // PowerShell can write a terminating error to stdout too.
  child.stdout?.on("data", capture);
  child.once("exit", (code) => {
    const message = output.trim();
    if (code !== 0 && message) {
      logger.warn(`[installerRunner] ${label} exited ${code}: ${message}`);
    }
  });
};

const launchInstallerDirectly = async (
  filePath: string,
  args: string[],
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  onChildSpawned?: (child: ChildProcess) => void
): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(filePath, args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
      windowsHide: true,
    });
    collectChildStderr(child, "installer");

    child.once("spawn", () => {
      onChildSpawned?.(child);
      if (!onChildSpawned) child.unref();
      resolve(true);
    });

    child.once("exit", (code, signal) => {
      onExit?.(code, signal);
    });

    child.once("error", (error) => {
      logger.error("Failed to execute game installer directly", error);
      resolve(false);
    });
  });
};

// Repack Inno setups carry a requireAdministrator manifest, so a
// non-elevated Hydra cannot spawn them -- CreateProcess returns
// ERROR_ELEVATION_REQUIRED. Start-Process -Verb RunAs is the supported way
// to elevate from a non-elevated parent AND it preserves our Inno silent
// args, which shell.openPath would drop. -Wait -PassThru lets the
// (non-elevated) powershell wrapper observe the elevated child's exit code,
// so the install pipeline still gets a real completion signal.
const toPowerShellLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

const launchInstallerElevated = async (
  filePath: string,
  args: string[],
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  onChildSpawned?: (child: ChildProcess) => void
): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    // -LiteralPath, not -FilePath: repack folders are named like
    // "Cuphead [FitGirl Repack]" and [] are PowerShell wildcard
    // metacharacters -- -FilePath fails to resolve them and the whole
    // elevated launch dies before Inno ever runs. -WorkingDirectory keeps
    // the elevated child out of system32: Inno resolves {src} itself, but
    // repacker [Code] that locates fg-*.bin via the current directory
    // aborts before /LOG is ever opened. ArgumentList goes as ONE verbatim
    // string, not an array: PS5.1 re-quotes array elements that contain
    // spaces or embedded quotes, which can split /DIR="..." /LOG="..."
    // into garbage tokens Inno either ignores or chokes on.
    const argumentList = args.join(" ");
    const command =
      `$p = Start-Process -LiteralPath ${toPowerShellLiteral(filePath)} ` +
      `-ArgumentList ${toPowerShellLiteral(argumentList)} ` +
      `-Verb RunAs -Wait -PassThru ` +
      `-WorkingDirectory ${toPowerShellLiteral(path.dirname(filePath))} ` +
      `-ErrorAction Stop; exit $p.ExitCode`;

    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      }
    );
    collectChildStderr(child, "elevated installer wrapper");

    child.once("spawn", () => {
      onChildSpawned?.(child);
      if (!onChildSpawned) child.unref();
      resolve(true);
    });

    child.once("exit", (code, signal) => {
      // UAC declined surfaces as exit code 1 from the throwing Start-Process.
      onExit?.(code, signal);
    });

    child.once("error", (error) => {
      logger.error("Failed to launch installer elevated via powershell", error);
      resolve(false);
    });
  });
};

const openPathAndCheck = async (filePath: string): Promise<boolean> => {
  const openError = await shell.openPath(filePath);
  return openError.length === 0;
};

export interface ExecuteInstallerOptions {
  args?: string[];
  gameId?: string;
  winePrefixPath?: string | null;
  protonPath?: string | null;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onIndeterminateLaunch?: () => void;
  onChildSpawned?: (child: ChildProcess) => void;
}

export const executeGameInstaller = async (
  filePath: string,
  options?: ExecuteInstallerOptions
) => {
  const args = options?.args ?? [];

  const fallBackToShellOpen = async (targetPath: string) => {
    const opened = await openPathAndCheck(targetPath);
    if (opened) options?.onIndeterminateLaunch?.();
    return opened;
  };

  if (process.platform === "win32") {
    const launchedDirectly = await launchInstallerDirectly(
      filePath,
      args,
      options?.onExit,
      options?.onChildSpawned
    );
    if (launchedDirectly) {
      return true;
    }

    const launchedElevated = await launchInstallerElevated(
      filePath,
      args,
      options?.onExit,
      options?.onChildSpawned
    );
    if (launchedElevated) {
      return true;
    }

    return await fallBackToShellOpen(filePath);
  }

  if (process.platform === "linux") {
    try {
      await Umu.launchExecutable(filePath, args, {
        gameId: options?.gameId,
        winePrefixPath: options?.winePrefixPath,
        protonPath: options?.protonPath,
        onExit: options?.onExit,
        onChildSpawned: options?.onChildSpawned,
      });
      return true;
    } catch (error) {
      logger.error("Failed to execute game installer with umu-run", error);

      const launchedWithWine = await launchInstallerWithWine(
        filePath,
        args,
        options?.onExit,
        options?.onChildSpawned
      );
      if (launchedWithWine) {
        return true;
      }

      return await fallBackToShellOpen(filePath);
    }
  }

  return await fallBackToShellOpen(filePath);
};
