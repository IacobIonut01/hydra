/**
 * Repack install strategy resolution.
 *
 * Repack sources fall into two broad shapes: "preinstalled" archives that
 * already contain the game files (OnlineFix, SteamRip, scene releases) and
 * installer-based repacks (DODI, FitGirl and most other repackers), which
 * ship an Inno Setup `setup.exe` plus compressed .bin payloads. A third
 * bucket covers everything we cannot classify: those get "auto-attempt",
 * which runs the installer with silent Inno flags first and escalates to a
 * visible installer UI when the silent run does not take.
 */
export type RepackInstallStrategy =
  | "preinstalled"
  | "inno-silent"
  | "auto-attempt";

export interface RepackInstallContext {
  downloadSourceName?: string | null;
  repackTitle?: string | null;
}

const PREINSTALLED_SOURCE_PATTERNS = [
  /online[\s-]*fix/i,
  /steam[\s-]*rip/i,
  /\binsanes?\b/i,
  /\brune\b/i,
  /\bfairlight\b/i,
  /\bflt\b/i,
  /\btenoke\b/i,
  /\bskidrow\b/i,
  /\breloaded\b/i,
  /\bcodex\b/i,
  /\bplaza\b/i,
  /\bempress\b/i,
  /\brazor\s*1911\b/i,
];

const INNO_SILENT_SOURCE_PATTERNS = [
  /fit[\s-]*girl/i,
  /\bdodi\b/i,
  /\bxatab\b/i,
  /\bkaos/i,
  /masquerade/i,
  /darck/i,
  /tiny[\s-]*repack/i,
  /re[\s-]*louis/i,
  /el[\s-]*amigos/i,
  /armgddn/i,
  /\bgog\b/i,
  /r\.?\s*g\.?\s*(mechanics|catalyst|freedom|origins|games)?\b/i,
];

export const resolveRepackInstallStrategy = (
  context: RepackInstallContext
): RepackInstallStrategy => {
  const haystacks = [context.downloadSourceName, context.repackTitle]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());

  if (haystacks.length === 0) return "auto-attempt";

  for (const haystack of haystacks) {
    if (
      PREINSTALLED_SOURCE_PATTERNS.some((pattern) => pattern.test(haystack))
    ) {
      return "preinstalled";
    }
  }

  for (const haystack of haystacks) {
    if (INNO_SILENT_SOURCE_PATTERNS.some((pattern) => pattern.test(haystack))) {
      return "inno-silent";
    }
  }

  return "auto-attempt";
};

/**
 * Silent Inno Setup flags honored by DODI/FitGirl-family repack scripts.
 * `/DIR` redirects the target directory and `/LOG` gives us a file to tail
 * for progress. Quotes stay inside the argument because Inno strips them
 * itself and repacker-authored [Code] sections may parse Params raw.
 */
export const buildInnoSilentArgs = (
  installDir: string,
  logPath: string
): string[] => [
  "/VERYSILENT",
  "/SUPPRESSMSGBOXES",
  "/NORESTART",
  "/SP-",
  `/DIR="${installDir}"`,
  `/LOG="${logPath}"`,
];

/** Folder-name-safe version of a game title for install dir conventions. */
export const sanitizeInstallDirName = (title: string): string => {
  const sanitized = title
    // eslint-disable-next-line no-control-regex -- NTFS forbids control chars in folder names, strip them intentionally
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return sanitized.length > 0 ? sanitized : "Game";
};
