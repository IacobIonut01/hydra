import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { FocusDirection, FocusOverrides } from "../../../services";
import {
  getGamepadRepeatInterval,
  GAMEPAD_REPEAT_INITIAL_DELAY,
} from "../../../helpers";

export type VirtualKeyboardKey =
  | { type: "character"; label: string; value: string }
  | { type: "shift"; label: string }
  | { type: "toggle-layer"; label: string }
  | { type: "backspace"; label: string }
  | { type: "space"; label: string }
  | { type: "clear"; label: string }
  | { type: "enter"; label: string }
  | { type: "cursor-left"; label: string }
  | { type: "cursor-right"; label: string };

export type VirtualKeyboardLayer = "alphabetic" | "symbols";

export type VirtualKeyboardLayoutKey = VirtualKeyboardKey & {
  column: number;
  row: number;
  columnSpan?: number;
  rowSpan?: number;
};

export type VirtualKeyboardKeyPosition = {
  centerColumn: number;
  centerRow: number;
};

export const VIRTUAL_KEYBOARD_LAYER_ID = "big-picture-virtual-keyboard-layer";
export const VIRTUAL_KEYBOARD_REGION_ID = "big-picture-virtual-keyboard";
export const VIRTUAL_KEYBOARD_FIRST_KEY_ID =
  "big-picture-virtual-keyboard-key-1";
export const VIRTUAL_KEYBOARD_BACKSPACE_KEY_ID =
  "big-picture-virtual-keyboard-key-backspace";
export const VIRTUAL_KEYBOARD_ENTER_KEY_ID =
  "big-picture-virtual-keyboard-key-enter";
export const VIRTUAL_KEYBOARD_TOGGLE_LAYER_KEY_ID =
  "big-picture-virtual-keyboard-key-toggle-layer";
export const VIRTUAL_KEYBOARD_COLUMNS = 11;

export const ALPHABETIC_KEY_LAYOUT: VirtualKeyboardLayoutKey[] = [
  ..."1234567890".split("").map((value, index) => ({
    type: "character" as const,
    label: value,
    value,
    row: 1,
    column: index + 1,
  })),
  { type: "backspace", label: "⌫", row: 1, column: 11 },
  ..."qwertyuiop".split("").map((value, index) => ({
    type: "character" as const,
    label: value,
    value,
    row: 2,
    column: index + 1,
  })),
  { type: "clear", label: "Clear", row: 2, column: 11 },
  ..."asdfghjkl/".split("").map((value, index) => ({
    type: "character" as const,
    label: value,
    value,
    row: 3,
    column: index + 1,
  })),
  { type: "enter", label: "Enter", row: 3, column: 11, rowSpan: 2 },
  { type: "shift", label: "Shift", row: 4, column: 1 },
  ..."zxcvbnm,.".split("").map((value, index) => ({
    type: "character" as const,
    label: value,
    value,
    row: 4,
    column: index + 2,
  })),
  { type: "toggle-layer", label: "123#", row: 5, column: 1, columnSpan: 2 },
  { type: "space", label: "Space", row: 5, column: 3, columnSpan: 7 },
  { type: "cursor-left", label: "←", row: 5, column: 10 },
  { type: "cursor-right", label: "→", row: 5, column: 11 },
];

export const SYMBOLS_KEY_LAYOUT: VirtualKeyboardLayoutKey[] = [
  ..."1234567890".split("").map((value, index) => ({
    type: "character" as const,
    label: value,
    value,
    row: 1,
    column: index + 1,
  })),
  { type: "backspace", label: "⌫", row: 1, column: 11 },
  ..."@#$%&*()-+".split("").map((value, index) => ({
    type: "character" as const,
    label: value,
    value,
    row: 2,
    column: index + 1,
  })),
  { type: "clear", label: "Clear", row: 2, column: 11 },
  ...["!", "?", ":", ";", "'", '"', "/", "\\", "_", "="].map(
    (value, index) => ({
      type: "character" as const,
      label: value,
      value,
      row: 3,
      column: index + 1,
    })
  ),
  { type: "enter", label: "Enter", row: 3, column: 11, rowSpan: 2 },
  ...["[", "]", "{", "}", "<", ">", ",", ".", "|", "~"].map((value, index) => ({
    type: "character" as const,
    label: value,
    value,
    row: 4,
    column: index + 1,
  })),
  { type: "toggle-layer", label: "ABC", row: 5, column: 1, columnSpan: 2 },
  { type: "space", label: "Space", row: 5, column: 3, columnSpan: 7 },
  { type: "cursor-left", label: "←", row: 5, column: 10 },
  { type: "cursor-right", label: "→", row: 5, column: 11 },
];

export function getKeyId(key: VirtualKeyboardKey) {
  if (key.type === "character") {
    return `big-picture-virtual-keyboard-key-${key.value}`;
  }

  if (key.type === "toggle-layer") {
    return VIRTUAL_KEYBOARD_TOGGLE_LAYER_KEY_ID;
  }

  return `big-picture-virtual-keyboard-key-${key.type}`;
}

export function getKeyStyle(key: VirtualKeyboardLayoutKey) {
  return {
    "--virtual-keyboard-key-column": key.column,
    "--virtual-keyboard-key-row": key.row,
    "--virtual-keyboard-key-column-span": key.columnSpan ?? 1,
    "--virtual-keyboard-key-row-span": key.rowSpan ?? 1,
  } as CSSProperties;
}

export function getKeyPosition(key: VirtualKeyboardLayoutKey) {
  return {
    centerColumn: key.column + ((key.columnSpan ?? 1) - 1) / 2,
    centerRow: key.row + ((key.rowSpan ?? 1) - 1) / 2,
  };
}

export function getKeyShortcutLabel(
  key: VirtualKeyboardKey,
  layer: VirtualKeyboardLayer
) {
  if (key.type === "backspace") return "X";
  if (key.type === "space") return "Y";
  if (key.type === "shift" && layer === "alphabetic") return "L3";
  if (key.type === "toggle-layer") return "R3";
  if (key.type === "enter") return "RT";
  if (key.type === "cursor-left") return "LB";
  if (key.type === "cursor-right") return "RB";

  return null;
}

export function findLayoutKeyById(
  layout: VirtualKeyboardLayoutKey[],
  focusId: string | null
) {
  if (!focusId) return null;

  return layout.find((key) => getKeyId(key) === focusId) ?? null;
}

export function findClosestLayoutKeyByPosition(
  layout: VirtualKeyboardLayoutKey[],
  position: VirtualKeyboardKeyPosition
) {
  return layout.reduce<VirtualKeyboardLayoutKey | null>((closest, key) => {
    if (!closest) return key;

    const keyPosition = getKeyPosition(key);
    const closestPosition = getKeyPosition(closest);
    const keyDistance =
      (keyPosition.centerColumn - position.centerColumn) ** 2 +
      (keyPosition.centerRow - position.centerRow) ** 2;
    const closestDistance =
      (closestPosition.centerColumn - position.centerColumn) ** 2 +
      (closestPosition.centerRow - position.centerRow) ** 2;

    return keyDistance < closestDistance ? key : closest;
  }, null);
}

function getCoveredIndexes(start: number, span = 1) {
  return Array.from({ length: span }, (_, index) => start + index);
}

function setBoundaryNavigationOverride(
  candidates: Record<
    string,
    Partial<Record<FocusDirection, { score: number; targetId: string }>>
  >,
  sourceId: string,
  direction: FocusDirection,
  targetId: string,
  score: number
) {
  if (sourceId === targetId) return;

  const currentCandidate = candidates[sourceId]?.[direction];

  if (currentCandidate && currentCandidate.score <= score) {
    return;
  }

  candidates[sourceId] = {
    ...candidates[sourceId],
    [direction]: { score, targetId },
  };
}

export function getVirtualKeyboardNavigationOverrides(
  layout: VirtualKeyboardLayoutKey[]
): Record<string, FocusOverrides> {
  const entries = layout.map((key) => ({
    key,
    keyId: getKeyId(key),
    position: getKeyPosition(key),
    rows: getCoveredIndexes(key.row, key.rowSpan),
    columns: getCoveredIndexes(key.column, key.columnSpan),
  }));
  const candidates: Record<
    string,
    Partial<Record<FocusDirection, { score: number; targetId: string }>>
  > = {};
  const rows = Array.from(new Set(entries.flatMap((entry) => entry.rows))).sort(
    (a, b) => a - b
  );
  const columns = Array.from(
    new Set(entries.flatMap((entry) => entry.columns))
  ).sort((a, b) => a - b);

  for (const row of rows) {
    const rowEntries = entries
      .filter((entry) => entry.rows.includes(row))
      .sort((left, right) => {
        if (left.key.column !== right.key.column) {
          return left.key.column - right.key.column;
        }

        return left.position.centerColumn - right.position.centerColumn;
      });
    const firstEntry = rowEntries[0];
    const lastEntry = rowEntries.at(-1);

    if (firstEntry && lastEntry) {
      setBoundaryNavigationOverride(
        candidates,
        firstEntry.keyId,
        "left",
        lastEntry.keyId,
        Math.abs(row - firstEntry.position.centerRow)
      );
      setBoundaryNavigationOverride(
        candidates,
        lastEntry.keyId,
        "right",
        firstEntry.keyId,
        Math.abs(row - lastEntry.position.centerRow)
      );
    }
  }

  for (const column of columns) {
    const columnEntries = entries
      .filter((entry) => entry.columns.includes(column))
      .sort((top, bottom) => {
        if (top.key.row !== bottom.key.row) {
          return top.key.row - bottom.key.row;
        }

        return top.position.centerRow - bottom.position.centerRow;
      });
    const firstEntry = columnEntries[0];
    const lastEntry = columnEntries.at(-1);

    if (firstEntry && lastEntry) {
      setBoundaryNavigationOverride(
        candidates,
        firstEntry.keyId,
        "up",
        lastEntry.keyId,
        Math.abs(column - firstEntry.position.centerColumn)
      );
      setBoundaryNavigationOverride(
        candidates,
        lastEntry.keyId,
        "down",
        firstEntry.keyId,
        Math.abs(column - lastEntry.position.centerColumn)
      );
    }
  }

  return Object.fromEntries(
    Object.entries(candidates).map(([keyId, overrides]) => [
      keyId,
      Object.fromEntries(
        Object.entries(overrides).map(([direction, candidate]) => [
          direction,
          {
            type: "item",
            itemId: candidate.targetId,
          },
        ])
      ) as FocusOverrides,
    ])
  );
}

export function useAcceleratedHoldAction({
  enabled,
  isPressed,
  onAction,
}: {
  enabled: boolean;
  isPressed: boolean;
  onAction: () => void;
}) {
  const onActionRef = useRef(onAction);

  useEffect(() => {
    onActionRef.current = onAction;
  }, [onAction]);

  useEffect(() => {
    if (!enabled || !isPressed) return;

    let timerId: number | null = null;

    const clearTimer = () => {
      if (timerId === null) return;

      globalThis.window.clearTimeout(timerId);
      timerId = null;
    };

    const scheduleRepeat = (delay: number) => {
      timerId = globalThis.window.setTimeout(() => {
        onActionRef.current();

        scheduleRepeat(getGamepadRepeatInterval());
      }, delay);
    };

    onActionRef.current();
    scheduleRepeat(GAMEPAD_REPEAT_INITIAL_DELAY);

    return clearTimer;
  }, [enabled, isPressed]);
}
