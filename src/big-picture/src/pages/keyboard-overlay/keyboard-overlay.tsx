import "./keyboard-overlay.scss";
import "../../components/common/virtual-keyboard/styles.scss";

import { motion } from "framer-motion";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  VK_BACK,
  VK_CONTROL,
  VK_KEY_A,
  VK_LEFT,
  VK_RETURN,
  VK_RIGHT,
} from "@types";
import { Button } from "../../components/common/button";
import { GridFocusGroup } from "../../components/common/grid-focus-group";
import { NavigationLayer } from "../../components/common/navigation-layer";
import {
  ALPHABETIC_KEY_LAYOUT,
  findClosestLayoutKeyByPosition,
  findLayoutKeyById,
  getKeyId,
  getKeyPosition,
  getKeyShortcutLabel,
  getKeyStyle,
  getVirtualKeyboardNavigationOverrides,
  SYMBOLS_KEY_LAYOUT,
  useAcceleratedHoldAction,
  VIRTUAL_KEYBOARD_BACKSPACE_KEY_ID,
  VIRTUAL_KEYBOARD_COLUMNS,
  VIRTUAL_KEYBOARD_ENTER_KEY_ID,
  VIRTUAL_KEYBOARD_FIRST_KEY_ID,
  VIRTUAL_KEYBOARD_LAYER_ID,
  VIRTUAL_KEYBOARD_REGION_ID,
  VIRTUAL_KEYBOARD_TOGGLE_LAYER_KEY_ID,
  type VirtualKeyboardKey,
  type VirtualKeyboardKeyPosition,
  type VirtualKeyboardLayer,
} from "../../components/common/virtual-keyboard/shared";
import {
  useGamepad,
  useNavigationActions,
  useNavigationScreenActions,
} from "../../hooks";
import { useNavigationStore } from "../../stores";
import { GamepadButtonType } from "../../types";

const KEYBOARD_OVERLAY_BODY_CLASS = "keyboard-overlay-window";

export default function KeyboardOverlay() {
  const { t } = useTranslation("big_picture");
  const [isShiftActive, setIsShiftActive] = useState(false);
  const [layer, setLayer] = useState<VirtualKeyboardLayer>("alphabetic");
  const [pulsingKeyId, setPulsingKeyId] = useState<string | null>(null);
  const currentFocusId = useNavigationStore((state) => state.currentFocusId);
  const { setFocus } = useNavigationActions();
  const { isButtonPressed, onButtonPressed, isActiveGamepadEvent } =
    useGamepad();
  const pulseFrameRef = useRef<number | null>(null);
  const pendingLayerFocusPositionRef =
    useRef<VirtualKeyboardKeyPosition | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    globalThis.document.body.classList.add(KEYBOARD_OVERLAY_BODY_CLASS);

    return () => {
      globalThis.document.body.classList.remove(KEYBOARD_OVERLAY_BODY_CLASS);
    };
  }, []);

  const pulseKey = useCallback((keyId: string) => {
    if (pulseFrameRef.current !== null) {
      globalThis.cancelAnimationFrame(pulseFrameRef.current);
    }

    setPulsingKeyId(null);
    pulseFrameRef.current = globalThis.requestAnimationFrame(() => {
      setPulsingKeyId(keyId);
      pulseFrameRef.current = null;
    });
  }, []);

  const hideOverlay = useCallback(() => {
    void globalThis.window.electron.hideKeyboardOverlay();
  }, []);

  const insertText = useCallback((text: string) => {
    void globalThis.window.electron.sendTextInput(text);
    setIsShiftActive(false);
  }, []);

  const backspace = useCallback(() => {
    void globalThis.window.electron.sendVirtualKeyChord([VK_BACK]);
  }, []);

  const hotkeyBackspace = useCallback(() => {
    pulseKey(VIRTUAL_KEYBOARD_BACKSPACE_KEY_ID);
    backspace();
  }, [backspace, pulseKey]);

  const toggleLayer = useCallback(() => {
    const activeLayout =
      layer === "alphabetic" ? ALPHABETIC_KEY_LAYOUT : SYMBOLS_KEY_LAYOUT;
    const activeKey = findLayoutKeyById(activeLayout, currentFocusId);

    pendingLayerFocusPositionRef.current = activeKey
      ? getKeyPosition(activeKey)
      : getKeyPosition(
          findLayoutKeyById(
            activeLayout,
            VIRTUAL_KEYBOARD_TOGGLE_LAYER_KEY_ID
          ) ?? activeLayout[0]
        );

    setLayer((currentLayer) => {
      const nextLayer =
        currentLayer === "alphabetic" ? "symbols" : "alphabetic";

      if (nextLayer === "symbols") {
        setIsShiftActive(false);
      }

      return nextLayer;
    });
  }, [currentFocusId, layer]);

  const hotkeyToggleLayer = useCallback(() => {
    pulseKey(VIRTUAL_KEYBOARD_TOGGLE_LAYER_KEY_ID);
    toggleLayer();
  }, [pulseKey, toggleLayer]);

  const hotkeySpace = useCallback(() => {
    pulseKey(getKeyId({ type: "space", label: "Space" }));
    insertText(" ");
  }, [insertText, pulseKey]);

  const hotkeyShift = useCallback(() => {
    if (layer !== "alphabetic") return;

    pulseKey(getKeyId({ type: "shift", label: "Shift" }));
    setIsShiftActive((current) => !current);
  }, [layer, pulseKey]);

  const clear = useCallback(() => {
    void globalThis.window.electron.sendVirtualKeyChord([VK_CONTROL, VK_KEY_A]);
    void globalThis.window.electron.sendVirtualKeyChord([VK_BACK]);
  }, []);

  const moveCursor = useCallback((direction: "left" | "right") => {
    void globalThis.window.electron.sendVirtualKeyChord([
      direction === "left" ? VK_LEFT : VK_RIGHT,
    ]);
  }, []);

  const enter = useCallback(() => {
    void globalThis.window.electron.sendVirtualKeyChord([VK_RETURN]);
    hideOverlay();
  }, [hideOverlay]);

  const hotkeyEnter = useCallback(() => {
    pulseKey(VIRTUAL_KEYBOARD_ENTER_KEY_ID);
    enter();
  }, [enter, pulseKey]);

  const hotkeyBack = useCallback(() => {
    hideOverlay();
  }, [hideOverlay]);

  const handleKey = useCallback(
    (key: VirtualKeyboardKey) => {
      const keyId = getKeyId(key);

      pulseKey(keyId);

      if (key.type === "character") {
        insertText(isShiftActive ? key.value.toUpperCase() : key.value);
        return;
      }

      if (key.type === "space") {
        insertText(" ");
        return;
      }

      if (key.type === "backspace") {
        backspace();
        return;
      }

      if (key.type === "clear") {
        clear();
        return;
      }

      if (key.type === "enter") {
        enter();
        return;
      }

      if (key.type === "cursor-left") {
        moveCursor("left");
        return;
      }

      if (key.type === "cursor-right") {
        moveCursor("right");
        return;
      }

      if (key.type === "toggle-layer") {
        toggleLayer();
        return;
      }

      if (key.type === "shift") {
        setIsShiftActive((current) => !current);
      }
    },
    [
      backspace,
      clear,
      enter,
      insertText,
      isShiftActive,
      moveCursor,
      pulseKey,
      toggleLayer,
    ]
  );

  useNavigationScreenActions({
    press: {
      b: hotkeyBack,
      y: hotkeySpace,
    },
  });

  useAcceleratedHoldAction({
    enabled: true,
    isPressed: isButtonPressed(GamepadButtonType.BUTTON_X),
    onAction: hotkeyBackspace,
  });
  useAcceleratedHoldAction({
    enabled: true,
    isPressed: isButtonPressed(GamepadButtonType.LEFT_BUMPER),
    onAction: () => moveCursor("left"),
  });
  useAcceleratedHoldAction({
    enabled: true,
    isPressed: isButtonPressed(GamepadButtonType.RIGHT_BUMPER),
    onAction: () => moveCursor("right"),
  });

  useEffect(() => {
    const removeLeftStickPress = onButtonPressed(
      GamepadButtonType.LEFT_STICK_PRESS,
      (event) => {
        if (!isActiveGamepadEvent(event)) return;

        hotkeyShift();
      }
    );
    const removeRightStickPress = onButtonPressed(
      GamepadButtonType.RIGHT_STICK_PRESS,
      (event) => {
        if (!isActiveGamepadEvent(event)) return;

        hotkeyToggleLayer();
      }
    );
    const removeRightTrigger = onButtonPressed(
      GamepadButtonType.RIGHT_TRIGGER,
      (event) => {
        if (!isActiveGamepadEvent(event)) return;

        hotkeyEnter();
      }
    );

    return () => {
      removeLeftStickPress();
      removeRightStickPress();
      removeRightTrigger();
    };
  }, [
    hotkeyEnter,
    hotkeyShift,
    hotkeyToggleLayer,
    isActiveGamepadEvent,
    onButtonPressed,
  ]);

  useEffect(() => {
    return () => {
      if (pulseFrameRef.current !== null) {
        globalThis.cancelAnimationFrame(pulseFrameRef.current);
      }
    };
  }, []);

  const keyLayout =
    layer === "alphabetic" ? ALPHABETIC_KEY_LAYOUT : SYMBOLS_KEY_LAYOUT;
  const navigationOverridesByKeyId = useMemo(
    () => getVirtualKeyboardNavigationOverrides(keyLayout),
    [keyLayout]
  );

  useEffect(() => {
    const pendingPosition = pendingLayerFocusPositionRef.current;

    if (!pendingPosition) return;

    pendingLayerFocusPositionRef.current = null;

    const nextKey =
      findClosestLayoutKeyByPosition(keyLayout, pendingPosition) ??
      findLayoutKeyById(keyLayout, VIRTUAL_KEYBOARD_TOGGLE_LAYER_KEY_ID);
    const nextFocusId = nextKey
      ? getKeyId(nextKey)
      : VIRTUAL_KEYBOARD_TOGGLE_LAYER_KEY_ID;
    const animationFrameId = globalThis.requestAnimationFrame(() => {
      setFocus(nextFocusId);
    });

    return () => {
      globalThis.cancelAnimationFrame(animationFrameId);
    };
  }, [keyLayout, layer, setFocus]);

  return (
    <div className="keyboard-overlay">
      <motion.div
        ref={dockRef}
        className="keyboard-overlay__dock virtual-keyboard-dock"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 24 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      >
        <p className="keyboard-overlay__hint">
          {t("keyboard_overlay_hint")}
        </p>
        <NavigationLayer
          layerId={VIRTUAL_KEYBOARD_LAYER_ID}
          rootRegionId={VIRTUAL_KEYBOARD_REGION_ID}
          initialFocusId={VIRTUAL_KEYBOARD_FIRST_KEY_ID}
        >
          <div
            className="virtual-keyboard"
            role="dialog"
            aria-label="Virtual keyboard"
          >
            <GridFocusGroup
              regionId={VIRTUAL_KEYBOARD_REGION_ID}
              className="virtual-keyboard__keys"
              style={
                {
                  "--virtual-keyboard-columns": VIRTUAL_KEYBOARD_COLUMNS,
                } as CSSProperties
              }
            >
              {keyLayout.map((key) => {
                const keyStyle = getKeyStyle(key);

                const keyId = getKeyId(key);
                const label =
                  key.type === "character" &&
                  layer === "alphabetic" &&
                  isShiftActive
                    ? key.label.toUpperCase()
                    : key.label;
                const shortcutLabel = getKeyShortcutLabel(key, layer);

                return (
                  <Button
                    key={keyId}
                    type="button"
                    variant="secondary"
                    className="virtual-keyboard__key"
                    focusId={keyId}
                    focusNavigationOverrides={
                      navigationOverridesByKeyId[keyId]
                    }
                    style={keyStyle}
                    data-key-type={key.type}
                    data-active={
                      key.type === "shift" && isShiftActive ? "true" : undefined
                    }
                    data-pulsing={pulsingKeyId === keyId || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleKey(key)}
                  >
                    <span className="virtual-keyboard__key-label">{label}</span>
                    {shortcutLabel ? (
                      <span className="virtual-keyboard__key-shortcut">
                        {shortcutLabel}
                      </span>
                    ) : null}
                  </Button>
                );
              })}
            </GridFocusGroup>
          </div>
        </NavigationLayer>
      </motion.div>
    </div>
  );
}
