import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { CONTROLLER_DIAGRAM_CONTROLS, type ControlGlyph } from "@shared";
import {
  DropdownSelect,
  GridFocusGroup,
  type DropdownSelectOption,
} from "../../../components";
import type { FocusOverrides, FocusOverrideTarget } from "../../../services";
import type {
  ControllerDeviceInfo,
  ControllerProfile,
  ControllerState,
} from "@types";

import { CONTROL_LABEL_KEYS, REMAP_DEFAULT_VALUE } from "./controller-controls";
import { getControllerRemapFocusId } from "../settings-navigation";

/** Matches the silhouette viewBox so node angles feel isotropic. */
const DIAGRAM_ASPECT = 600 / 340;

const DIAGRAM_DIRECTIONS: Record<
  "up" | "down" | "left" | "right",
  { x: number; y: number }
> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/**
 * Nearest-neighbor navigation inside the diagram: for each direction pick the
 * closest node within a ~57-degree cone (aspect-corrected), else leave the
 * direction unset so the region-level overrides handle the exit.
 */
function computeNodeOverrides(
  deviceId: string,
  controls: readonly { id: string; x: number; y: number }[]
): Record<string, FocusOverrides> {
  const overrides: Record<string, FocusOverrides> = {};

  for (const control of controls) {
    const entry: FocusOverrides = {};

    for (const [direction, vector] of Object.entries(DIAGRAM_DIRECTIONS)) {
      let best: { id: string; distance: number } | null = null;

      for (const candidate of controls) {
        if (candidate.id === control.id) continue;

        const dx = (candidate.x - control.x) * DIAGRAM_ASPECT;
        const dy = candidate.y - control.y;
        const distance = Math.hypot(dx, dy);
        if (distance === 0) continue;

        const alignment = (dx * vector.x + dy * vector.y) / distance;
        if (alignment <= 0.55) continue;

        if (!best || distance < best.distance) {
          best = { id: candidate.id, distance };
        }
      }

      if (best) {
        entry[direction as keyof typeof DIAGRAM_DIRECTIONS] = {
          type: "item",
          itemId: getControllerRemapFocusId(deviceId, best.id),
        } satisfies FocusOverrideTarget;
      }
    }

    overrides[getControllerRemapFocusId(deviceId, control.id)] = entry;
  }

  return overrides;
}

function ControlGlyphIcon({ glyph }: Readonly<{ glyph: ControlGlyph }>) {
  switch (glyph.type) {
    case "path":
      return <path d={glyph.d} />;
    case "circle":
      return <circle cx="12" cy="12" r="7.5" />;
    case "rect":
      return <rect x="4" y="4" width="16" height="16" rx={glyph.rx ?? 0} />;
    case "text":
      return (
        <text x="12" y="16" textAnchor="middle">
          {glyph.text}
        </text>
      );
    default:
      return null;
  }
}

interface ControllerRemapDiagramProps {
  device: ControllerDeviceInfo;
  profile: ControllerProfile | null;
  liveState: ControllerState | null;
  /** CSS color for the silhouette's lightbar strip. */
  lightbarColor?: string;
  regionId: string;
  regionOverrides: FocusOverrides | undefined;
  remapOptions: Array<DropdownSelectOption<string>>;
  onRemap: (controlId: string, target: string) => void;
}

export function ControllerRemapDiagram({
  device,
  profile,
  liveState,
  lightbarColor,
  regionId,
  regionOverrides,
  remapOptions,
  onRemap,
}: Readonly<ControllerRemapDiagramProps>) {
  const { t } = useTranslation("big_picture");

  const visibleControls = useMemo(
    () =>
      CONTROLLER_DIAGRAM_CONTROLS.filter((control) => {
        if (control.hardware === "edge")
          return device.model === "dualsense-edge";
        if (control.hardware === "dualSense")
          return (
            device.model === "dualsense" || device.model === "dualsense-edge"
          );
        return true;
      }),
    [device.model]
  );

  const nodeOverrides = useMemo(
    () => computeNodeOverrides(device.id, visibleControls),
    [device.id, visibleControls]
  );

  const pressed = useMemo(() => new Set(liveState?.pressed ?? []), [liveState]);

  return (
    <GridFocusGroup
      regionId={regionId}
      navigationOverrides={regionOverrides}
      autoScrollMode="region"
      className="controller-diagram"
    >
      <div
        className="controller-diagram__frame"
        style={
          lightbarColor
            ? ({ "--pad-lightbar": lightbarColor } as React.CSSProperties)
            : undefined
        }
      >
        <svg
          className="controller-diagram__pad"
          viewBox="0 0 600 340"
          aria-hidden="true"
        >
          {/* Silhouette traced from the DS4 front-view reference:
              flat top edge, walls flaring to max width at ~82% height,
              steep inner grips meeting a shallow center plate. */}
          <path
            className="controller-diagram__body"
            d="M114 5C90 12 62 45 50 85C38 125 26 170 20 235C14 290 40 325 72 335C105 332 135 310 146 299C155 290 158 250 171 216C210 220 390 220 429 216C442 250 445 290 454 299C465 310 495 332 528 335C560 325 586 290 580 235C574 170 562 125 550 85C538 45 510 12 486 5Z"
          />
          <path
            className="controller-diagram__seam"
            d="M30 265Q100 305 168 302"
          />
          <path
            className="controller-diagram__seam"
            d="M570 265Q500 305 432 302"
          />
          <rect
            className="controller-diagram__touchpad"
            x="203"
            y="28"
            width="194"
            height="84"
            rx="8"
          />
          <rect
            className="controller-diagram__lightbar"
            x="222"
            y="4"
            width="156"
            height="6"
            rx="3"
          />
          <circle
            className="controller-diagram__dish"
            cx="90"
            cy="105"
            r="46"
          />
          <circle
            className="controller-diagram__dish"
            cx="510"
            cy="105"
            r="46"
          />
          {device.model === "ds4" ? (
            <g className="controller-diagram__speaker">
              <circle cx="276" cy="136" r="1.8" />
              <circle cx="288" cy="136" r="1.8" />
              <circle cx="300" cy="136" r="1.8" />
              <circle cx="312" cy="136" r="1.8" />
              <circle cx="324" cy="136" r="1.8" />
              <circle cx="282" cy="144" r="1.8" />
              <circle cx="294" cy="144" r="1.8" />
              <circle cx="306" cy="144" r="1.8" />
              <circle cx="318" cy="144" r="1.8" />
            </g>
          ) : null}
          <circle
            className="controller-diagram__stick"
            cx="222"
            cy="180"
            r="40"
          />
          <circle
            className="controller-diagram__stick"
            cx="378"
            cy="180"
            r="40"
          />
          <circle
            className="controller-diagram__stick-cap"
            cx="222"
            cy="180"
            r="22"
          />
          <circle
            className="controller-diagram__stick-cap"
            cx="378"
            cy="180"
            r="22"
          />
        </svg>

        {visibleControls.map((control) => {
          const target = profile?.remap[control.id] ?? REMAP_DEFAULT_VALUE;
          const remapped =
            target !== REMAP_DEFAULT_VALUE && target !== control.id;
          const controlName = t(CONTROL_LABEL_KEYS[control.id]);
          const targetOption = remapOptions.find(
            (option) => option.value === target
          );
          const targetLabel =
            typeof targetOption?.label === "string"
              ? targetOption.label
              : controlName;
          const focusId = getControllerRemapFocusId(device.id, control.id);

          return (
            <div
              key={control.id}
              className="controller-diagram__node"
              data-pressed={pressed.has(control.id) || undefined}
              style={{ left: `${control.x}%`, top: `${control.y}%` }}
            >
              <DropdownSelect
                hideLabel
                className="controller-diagram__select"
                value={target}
                options={remapOptions}
                focusId={focusId}
                focusNavigationOverrides={nodeOverrides[focusId]}
                menuRegionId={`${focusId}-menu`}
                ariaLabel={t("settings_controllers_remap_aria", {
                  control: controlName,
                  target: targetLabel,
                })}
                triggerContent={
                  <span className="controller-diagram__glyph">
                    <svg
                      className="controller-diagram__glyph-icon"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <ControlGlyphIcon glyph={control.glyph} />
                    </svg>
                    {remapped ? (
                      <span
                        className="controller-diagram__remap-dot"
                        aria-hidden="true"
                      />
                    ) : null}
                  </span>
                }
                onValueChange={(value) => onRemap(control.id, value)}
              />
            </div>
          );
        })}
      </div>
    </GridFocusGroup>
  );
}
