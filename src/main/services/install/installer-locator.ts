import path from "node:path";
import fs from "node:fs";

export interface LocatedInstaller {
  path: string;
  kind: "setup" | "single-exe";
}

const SETUP_EXE_PATTERN = /^setup.*\.exe$/i;

const listExeFiles = (dirPath: string): string[] => {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => path.extname(name).toLowerCase() === ".exe");
  } catch {
    return [];
  }
};

const listSubDirectories = (dirPath: string): string[] => {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

/**
 * Locates a runnable installer inside a downloaded repack folder.
 *
 * Search order mirrors how repacks are actually laid out:
 *   1. `setup.exe` at the root (DODI/FitGirl/Xatab convention)
 *   2. `setup*.exe` at the root (GOG offline installers, e.g.
 *      `setup_game_1.0_(64bit)_(12345).exe`)
 *   3. a single `.exe` at the root (repacks that ship one bootstrapper)
 *   4. `setup*.exe` one directory level deep (archives that unpack into a
 *      single nested folder)
 */
export const findInstallerInFolder = (
  gamePath: string
): LocatedInstaller | null => {
  if (!fs.existsSync(gamePath)) return null;

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(gamePath);
  } catch {
    return null;
  }
  if (!stats.isDirectory()) return null;

  const setupPath = path.join(gamePath, "setup.exe");
  if (fs.existsSync(setupPath)) {
    return { path: setupPath, kind: "setup" };
  }

  const rootExeFiles = listExeFiles(gamePath);

  const rootSetupCandidate = rootExeFiles.find((name) =>
    SETUP_EXE_PATTERN.test(name)
  );
  if (rootSetupCandidate) {
    return { path: path.join(gamePath, rootSetupCandidate), kind: "setup" };
  }

  if (rootExeFiles.length === 1) {
    return { path: path.join(gamePath, rootExeFiles[0]), kind: "single-exe" };
  }

  for (const subDirectory of listSubDirectories(gamePath)) {
    const nestedDir = path.join(gamePath, subDirectory);
    const nestedSetup = listExeFiles(nestedDir).find((name) =>
      SETUP_EXE_PATTERN.test(name)
    );
    if (nestedSetup) {
      return { path: path.join(nestedDir, nestedSetup), kind: "setup" };
    }
  }

  return null;
};
