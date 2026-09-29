import {
  isErroredDownload,
  isQueuedDownload,
  type DownloadProgress,
  type LibraryGame,
} from "@types";

export type HeroDownloadDisplayKind =
  | "downloading"
  | "extracting"
  | "installing"
  | "queued"
  | "paused"
  | "error";

export interface HeroDownloadDisplay {
  kind: HeroDownloadDisplayKind;
  /** 0–1 fill amount, or null when the state has no meaningful fill. */
  progress: number | null;
  label: string;
}

function toPercent(progress: number) {
  return Math.round(Math.min(Math.max(progress, 0), 1) * 100);
}

/**
 * Resolves the in-progress download state a hero button should surface for a
 * game, or null when the download is in a state the hero handles elsewhere
 * (complete/seeding → install, removed → none).
 */
export function getHeroDownloadDisplay(
  game: LibraryGame | null | undefined,
  lastPacket: DownloadProgress | null | undefined,
  extractionProgressByGameId?: Record<string, number>
): HeroDownloadDisplay | null {
  const download = game?.download;

  if (!game || !download) return null;

  const storedProgress = download.progress ?? 0;
  const isLivePacket = lastPacket?.gameId === game.id;

  if (download.extracting || download.status === "extracting") {
    const progress =
      extractionProgressByGameId?.[game.id] ??
      download.extractionProgress ??
      storedProgress;

    return {
      kind: "extracting",
      progress,
      label: `Extracting… ${toPercent(progress)}%`,
    };
  }

  if (download.installing) {
    return { kind: "installing", progress: null, label: "Installing…" };
  }

  if (download.status === "active") {
    if (isLivePacket && lastPacket) {
      if (lastPacket.isDownloadingMetadata) {
        return {
          kind: "downloading",
          progress: null,
          label: "Downloading metadata…",
        };
      }

      if (lastPacket.isCheckingFiles) {
        return {
          kind: "downloading",
          progress: null,
          label: "Checking files…",
        };
      }

      if (lastPacket.isReconnecting) {
        return {
          kind: "downloading",
          progress: null,
          label: "Reconnecting…",
        };
      }

      if (lastPacket.isRecovering) {
        const progress = lastPacket.recoveryProgress ?? lastPacket.progress;

        return {
          kind: "downloading",
          progress,
          label: `Resuming… ${toPercent(progress)}%`,
        };
      }

      return {
        kind: "downloading",
        progress: lastPacket.progress,
        label: `Downloading… ${toPercent(lastPacket.progress)}%`,
      };
    }

    return {
      kind: "downloading",
      progress: storedProgress,
      label: `Downloading… ${toPercent(storedProgress)}%`,
    };
  }

  if (isQueuedDownload(download)) {
    return { kind: "queued", progress: storedProgress, label: "Queued" };
  }

  if (isErroredDownload(download)) {
    return {
      kind: "error",
      progress: storedProgress,
      label: "Download failed",
    };
  }

  if (download.status === "paused") {
    return {
      kind: "paused",
      progress: storedProgress,
      label: `Paused… ${toPercent(storedProgress)}%`,
    };
  }

  return null;
}
