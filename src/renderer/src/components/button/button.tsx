import cn from "classnames";
import { PlacesType, Tooltip } from "react-tooltip";

import "./button.scss";
import { forwardRef, useId } from "react";

export interface ButtonProps
  extends React.DetailedHTMLProps<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    HTMLButtonElement
  > {
  tooltip?: string;
  tooltipPlace?: PlacesType;
  theme?: "primary" | "outline" | "dark" | "danger" | "cloud";
  /** 0–1 fill shown behind the content when set. */
  progress?: number | null;
}

export const Button = forwardRef<HTMLButtonElement, Readonly<ButtonProps>>(
  function Button(
    {
      children,
      theme = "primary",
      className,
      tooltip,
      tooltipPlace = "top",
      progress = null,
      style,
      ...props
    },
    ref
  ) {
    const id = useId();
    const hasProgress =
      typeof progress === "number" && Number.isFinite(progress);

    const tooltipProps = tooltip
      ? {
          "data-tooltip-id": id,
          "data-tooltip-place": tooltipPlace,
          "data-tooltip-content": tooltip,
        }
      : {};

    return (
      <>
        <button
          ref={ref}
          type="button"
          className={cn("button", `button--${theme}`, className, {
            "button--progress": hasProgress,
          })}
          style={
            hasProgress
              ? ({
                  "--button-progress": Math.min(Math.max(progress, 0), 1),
                  ...style,
                } as React.CSSProperties)
              : style
          }
          {...props}
          {...tooltipProps}
        >
          {children}
        </button>

        {tooltip && <Tooltip id={id} />}
      </>
    );
  }
);
