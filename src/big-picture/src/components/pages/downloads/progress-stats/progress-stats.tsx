import type { CSSProperties } from "react";
import { Typography } from "../../../common";

import "./progress-stats.scss";

interface DownloadsProgressStatsProps {
  title: string;
  progress: number;
  progressLabel: string;
  transferLabel: string;
  etaLabel: string;
  indeterminate?: boolean;
  accentColor?: string;
}

function clampProgress(progress: number) {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(1, Math.max(0, progress));
}

export function DownloadsProgressStats({
  title,
  progress,
  progressLabel,
  transferLabel,
  etaLabel,
  indeterminate = false,
  accentColor,
}: Readonly<DownloadsProgressStatsProps>) {
  const clampedProgress = clampProgress(progress);
  const fillStyle = {
    width: `${clampedProgress * 100}%`,
    backgroundColor: accentColor ?? "var(--primary)",
  } satisfies CSSProperties;

  return (
    <section className="downloads-progress-stats" aria-label={title}>
      <div className="downloads-progress-stats__row downloads-progress-stats__row--primary">
        <Typography variant="h5">{title}</Typography>
        <Typography variant="h5">{progressLabel}</Typography>
      </div>

      <div
        className={`downloads-progress-stats__bar${
          indeterminate ? " downloads-progress-stats__bar--indeterminate" : ""
        }`}
        aria-hidden="true"
      >
        <div
          className="downloads-progress-stats__fill"
          style={indeterminate ? undefined : fillStyle}
        />
      </div>

      <div className="downloads-progress-stats__row downloads-progress-stats__row--secondary">
        <Typography>{transferLabel}</Typography>
        <Typography>{etaLabel}</Typography>
      </div>
    </section>
  );
}
