/**
 * PlayStation controller vocabulary shared by the main process, the
 * big-picture settings UI and the desktop renderer settings UI.
 * Control ids match the native addon (controls.rs Ds4Control::name).
 */

export const LIGHTBAR_SWATCHES: ReadonlyArray<{
  r: number;
  g: number;
  b: number;
  key: string;
}> = [
  { r: 255, g: 255, b: 255, key: "white" },
  { r: 0, g: 0, b: 255, key: "blue" },
  { r: 0, g: 128, b: 255, key: "azure" },
  { r: 0, g: 255, b: 255, key: "cyan" },
  { r: 0, g: 255, b: 128, key: "mint" },
  { r: 0, g: 200, b: 60, key: "green" },
  { r: 180, g: 255, b: 0, key: "lime" },
  { r: 255, g: 255, b: 0, key: "yellow" },
  { r: 255, g: 160, b: 0, key: "amber" },
  { r: 255, g: 60, b: 0, key: "orange" },
  { r: 255, g: 0, b: 0, key: "red" },
  { r: 255, g: 0, b: 180, key: "magenta" },
  { r: 160, g: 0, b: 255, key: "purple" },
  { r: 60, g: 0, b: 120, key: "violet" },
];

export const FLASH_AT_OPTIONS = [0, 10, 20, 30, 40, 50] as const;

export const DEADZONE_OPTIONS = [0, 0.05, 0.08, 0.1, 0.15, 0.2] as const;

export const MIC_LED_OPTIONS = [0, 1, 2] as const;

export const PLAYER_LED_MAX = 5;

/** Physical controls shown in the remap editor, in display order. */
export const MAPPABLE_CONTROL_IDS = [
  "cross",
  "circle",
  "square",
  "triangle",
  "dpadUp",
  "dpadDown",
  "dpadLeft",
  "dpadRight",
  "l1",
  "r1",
  "l2",
  "r2",
  "l3",
  "r3",
  "share",
  "options",
  "ps",
  "touchClick",
  "mute",
] as const;

export const EDGE_EXTRA_CONTROL_IDS = [
  "fnL",
  "fnR",
  "paddleLeft",
  "paddleRight",
] as const;

/** Remap output choices shared by every row: each physical pad output. */
export const REMAP_OUTPUT_IDS = MAPPABLE_CONTROL_IDS;

export const REMAP_UNBOUND_VALUE = "unbound";
export const REMAP_DEFAULT_VALUE = "__default";

export const TRIGGER_EFFECT_PRESETS: ReadonlyArray<{
  value: string;
  mode: number;
  params: number[];
}> = [
  { value: "off", mode: 0, params: [] },
  { value: "feedback", mode: 1, params: [5, 6] },
  { value: "weapon", mode: 2, params: [2, 5, 8] },
  { value: "vibration", mode: 3, params: [5, 6, 4] },
];

/** A drawable glyph for one mappable control, rendered inside a 24x24 svg box. */
export type ControlGlyph =
  | { readonly type: "path"; readonly d: string }
  | { readonly type: "circle" }
  | { readonly type: "rect"; readonly rx?: number }
  | { readonly type: "text"; readonly text: string };

export interface ControllerDiagramControl {
  readonly id: string;
  /** Horizontal center as a percentage of the diagram width. */
  readonly x: number;
  /** Vertical center as a percentage of the diagram height. */
  readonly y: number;
  readonly glyph: ControlGlyph;
  /** Render only when the pad exposes this hardware. */
  readonly hardware?: "dualSense" | "edge";
}

/**
 * Mappable controls arranged over a DualShock/DualSense-style pad outline.
 * `MAPPABLE_CONTROL_IDS` is the superset; this table adds placement + glyph.
 */
export const CONTROLLER_DIAGRAM_CONTROLS: readonly ControllerDiagramControl[] =
  [
    // Shoulders: L1/L2 and R1/R2 are the paired bumps on the top lip
    // (trigger outer, bumper inner), as seen edge-on in a front view.
    { id: "l2", x: 17, y: 4, glyph: { type: "text", text: "L2" } },
    { id: "r2", x: 83, y: 4, glyph: { type: "text", text: "R2" } },
    { id: "l1", x: 23, y: 4, glyph: { type: "text", text: "L1" } },
    { id: "r1", x: 77, y: 4, glyph: { type: "text", text: "R1" } },
    // Share/Options: small pills flanking the touchpad's upper corners.
    {
      id: "share",
      x: 29,
      y: 11,
      glyph: { type: "path", d: "M12 4l5 5h-3v7h-4V9H7z" },
    },
    {
      id: "options",
      x: 71,
      y: 11,
      glyph: { type: "path", d: "M6 8h12M6 12h12M6 16h12" },
    },
    { id: "touchClick", x: 50, y: 21, glyph: { type: "rect", rx: 3 } },
    // Left cluster dish (dpad) centered at ~15/31, face cluster at ~85/31.
    {
      id: "dpadUp",
      x: 15,
      y: 24,
      glyph: { type: "path", d: "M12 6l6 9H6z" },
    },
    {
      id: "triangle",
      x: 85,
      y: 24,
      glyph: { type: "path", d: "M12 4l9 16H3z" },
    },
    {
      id: "dpadLeft",
      x: 11,
      y: 31,
      glyph: { type: "path", d: "M6 12l9-6v12z" },
    },
    { id: "square", x: 81, y: 31, glyph: { type: "rect", rx: 0 } },
    {
      id: "dpadRight",
      x: 19,
      y: 31,
      glyph: { type: "path", d: "M18 12l-9-6v12z" },
    },
    { id: "circle", x: 89, y: 31, glyph: { type: "circle" } },
    {
      id: "dpadDown",
      x: 15,
      y: 38,
      glyph: { type: "path", d: "M12 18l-6-9h12z" },
    },
    {
      id: "cross",
      x: 85,
      y: 38,
      glyph: { type: "path", d: "M6 6l12 12M18 6L6 18" },
    },
    // Sticks at ~37/63 x 53; PS between them just above their centers.
    { id: "l3", x: 37, y: 53, glyph: { type: "text", text: "L3" } },
    { id: "r3", x: 63, y: 53, glyph: { type: "text", text: "R3" } },
    { id: "ps", x: 50, y: 50, glyph: { type: "text", text: "PS" } },
    {
      id: "mute",
      x: 50,
      y: 60,
      glyph: { type: "text", text: "MUTE" },
      hardware: "dualSense",
    },
    // Edge extras: fn nubs under the sticks, paddles on the inner grips.
    {
      id: "fnL",
      x: 37,
      y: 64,
      glyph: { type: "text", text: "FN" },
      hardware: "edge",
    },
    {
      id: "fnR",
      x: 63,
      y: 64,
      glyph: { type: "text", text: "FN" },
      hardware: "edge",
    },
    {
      id: "paddleLeft",
      x: 25,
      y: 78,
      glyph: { type: "text", text: "PDL" },
      hardware: "edge",
    },
    {
      id: "paddleRight",
      x: 75,
      y: 78,
      glyph: { type: "text", text: "PDR" },
      hardware: "edge",
    },
  ];
