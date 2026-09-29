import { useEffect, useMemo, useRef, useState } from "react";

import {
  CONTROLLER_DIAGRAM_CONTROLS,
  REMAP_DEFAULT_VALUE,
  type ControlGlyph,
} from "@shared";
import type {
  ControllerDeviceInfo,
  ControllerProfile,
  ControllerState,
} from "@types";

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

export interface RemapOption {
  value: string;
  label: string;
}

interface ControllerRemapDiagramProps {
  device: ControllerDeviceInfo;
  profile: ControllerProfile | null;
  liveState: ControllerState | null;
  lightbarColor?: string;
  remapOptions: RemapOption[];
  controlLabel: (controlId: string) => string;
  remapAriaLabel: (control: string, target: string) => string;
  onRemap: (controlId: string, target: string) => void;
}

export function ControllerRemapDiagram({
  device,
  profile,
  liveState,
  lightbarColor,
  remapOptions,
  controlLabel,
  remapAriaLabel,
  onRemap,
}: Readonly<ControllerRemapDiagramProps>) {
  const [openControlId, setOpenControlId] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openControlId) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || frameRef.current?.contains(target)) return;
      setOpenControlId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenControlId(null);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openControlId]);

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

  const pressed = useMemo(() => new Set(liveState?.pressed ?? []), [liveState]);

  return (
    <div
      ref={frameRef}
      className="controller-remap-diagram"
      style={
        lightbarColor
          ? ({ "--pad-lightbar": lightbarColor } as React.CSSProperties)
          : undefined
      }
    >
      <svg
        className="controller-remap-diagram__pad"
        viewBox="0 0 600 340"
        aria-hidden="true"
      >
        {/* Silhouette traced from the DS4 front-view reference:
            flat top edge, walls flaring to max width at ~82% height,
            steep inner grips meeting a shallow center plate. */}
        <path
          className="controller-remap-diagram__body"
          d="M114 5C90 12 62 45 50 85C38 125 26 170 20 235C14 290 40 325 72 335C105 332 135 310 146 299C155 290 158 250 171 216C210 220 390 220 429 216C442 250 445 290 454 299C465 310 495 332 528 335C560 325 586 290 580 235C574 170 562 125 550 85C538 45 510 12 486 5Z"
        />
        <path
          className="controller-remap-diagram__seam"
          d="M30 265Q100 305 168 302"
        />
        <path
          className="controller-remap-diagram__seam"
          d="M570 265Q500 305 432 302"
        />
        <rect
          className="controller-remap-diagram__touchpad"
          x="203"
          y="28"
          width="194"
          height="84"
          rx="8"
        />
        <rect
          className="controller-remap-diagram__lightbar"
          x="222"
          y="4"
          width="156"
          height="6"
          rx="3"
        />
        <circle
          className="controller-remap-diagram__dish"
          cx="90"
          cy="105"
          r="46"
        />
        <circle
          className="controller-remap-diagram__dish"
          cx="510"
          cy="105"
          r="46"
        />
        {device.model === "ds4" ? (
          <g className="controller-remap-diagram__speaker">
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
          className="controller-remap-diagram__stick"
          cx="222"
          cy="180"
          r="40"
        />
        <circle
          className="controller-remap-diagram__stick"
          cx="378"
          cy="180"
          r="40"
        />
        <circle
          className="controller-remap-diagram__stick-cap"
          cx="222"
          cy="180"
          r="22"
        />
        <circle
          className="controller-remap-diagram__stick-cap"
          cx="378"
          cy="180"
          r="22"
        />
      </svg>

      {visibleControls.map((control) => {
        const target = profile?.remap[control.id] ?? REMAP_DEFAULT_VALUE;
        const remapped =
          target !== REMAP_DEFAULT_VALUE && target !== control.id;
        const controlName = controlLabel(control.id);
        const targetLabel =
          remapOptions.find((option) => option.value === target)?.label ??
          controlName;
        const isOpen = openControlId === control.id;
        const flipX = control.x > 55;
        const flipY = control.y > 50;

        return (
          <div
            key={control.id}
            className="controller-remap-diagram__node"
            data-pressed={pressed.has(control.id) || undefined}
            style={{ left: `${control.x}%`, top: `${control.y}%` }}
          >
            <button
              type="button"
              className="controller-remap-diagram__glyph"
              aria-label={remapAriaLabel(controlName, targetLabel)}
              aria-haspopup="listbox"
              aria-expanded={isOpen}
              data-open={isOpen || undefined}
              title={controlName}
              onClick={() =>
                setOpenControlId((current) =>
                  current === control.id ? null : control.id
                )
              }
            >
              <svg
                className="controller-remap-diagram__glyph-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <ControlGlyphIcon glyph={control.glyph} />
              </svg>
              {remapped ? (
                <span
                  className="controller-remap-diagram__remap-dot"
                  aria-hidden="true"
                />
              ) : null}
            </button>

            {isOpen ? (
              <ul
                className="controller-remap-diagram__menu"
                data-flip-x={flipX || undefined}
                data-flip-y={flipY || undefined}
                role="listbox"
                aria-label={controlName}
              >
                {remapOptions.map((option) => (
                  <li key={option.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={option.value === target}
                      className="controller-remap-diagram__option"
                      data-selected={option.value === target || undefined}
                      onClick={() => {
                        onRemap(control.id, option.value);
                        setOpenControlId(null);
                      }}
                    >
                      {option.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
