import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ComponentProps, ReactNode, Ref } from "react";
import { Icon, type IconName } from "./icon";

/** primary: the one main action of a view; secondary: every other action; quiet: low emphasis beside a primary;
 * danger: starts a destructive flow; danger-filled: only the final button of a destructive confirmation. */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "danger-filled";

type Look = {
  variant?: ButtonVariant;
  /** 36 px for dense rows on pointer devices; the 44 px target is kept by the component layer. */
  size?: "md" | "sm";
  /** Full width: only the single action of a narrow form, or dialog actions at compact width. */
  block?: boolean;
  /** An icon that leads the label (a plus, a download). */
  icon?: IconName;
};

export function buttonClass({ variant = "secondary", size = "md", block = false }: Look, extra?: string) {
  return ["e-button", `e-button--${variant}`, size === "sm" && "e-button--sm", block && "e-button--block", extra]
    .filter(Boolean)
    .join(" ");
}

export function Spinner({ size = "sm", label }: { size?: "sm" | "md"; label?: string }) {
  const className = size === "md" ? "e-spinner e-spinner--md" : "e-spinner";
  return label ? (
    <span className={className} role="status" aria-label={label} />
  ) : (
    <span className={className} aria-hidden="true" />
  );
}

export type ButtonProps = Look &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    children: ReactNode;
    ref?: Ref<HTMLButtonElement>;
    /** Busy keeps the label and focus: the button stays enabled for focus but ignores presses. */
    loading?: boolean;
  };

/** The one way to trigger an action. Labels are verbs in sentence case. */
export function Button({
  variant,
  size,
  block,
  icon,
  loading = false,
  className,
  type = "button",
  onClick,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={buttonClass({ variant, size, block }, className)}
      aria-busy={loading || undefined}
      aria-disabled={loading || rest["aria-disabled"] || undefined}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} size="sm" /> : null}
      {children}
    </button>
  );
}

export type ButtonLinkProps = Look &
  Omit<ComponentProps<typeof Link>, "className" | "children"> & {
    children: ReactNode;
    className?: string;
    /** A trailing arrow, only for a control that goes to another page. */
    arrow?: boolean;
  };

/** A link drawn as a button: for actions that navigate. */
export function ButtonLink({
  variant,
  size,
  block,
  icon,
  arrow = false,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link {...rest} className={buttonClass({ variant, size, block }, className)}>
      {icon ? <Icon name={icon} size="sm" /> : null}
      {children}
      {arrow ? <Icon name="arrow-right" size="sm" /> : null}
    </Link>
  );
}

/** A plain anchor drawn as a button, for downloads and external pages. */
export function ButtonAnchor({
  variant,
  size,
  block,
  icon,
  className,
  children,
  ...rest
}: Look & AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) {
  return (
    <a {...rest} className={buttonClass({ variant, size, block }, className)}>
      {icon ? <Icon name={icon} size="sm" /> : null}
      {children}
    </a>
  );
}

export type IconButtonVariant = "outlined" | "quiet" | "on-artwork" | "primary";

/** A round control that shows only an icon. The label is its accessible name and its tooltip. */
export function IconButton({
  icon,
  label,
  variant = "quiet",
  size = "md",
  pressed,
  tooltip = true,
  className,
  type = "button",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label" | "aria-pressed"> & {
  icon: IconName;
  label: string;
  /** For a trigger that something else focuses, such as a Menu's. */
  ref?: Ref<HTMLButtonElement>;
  variant?: IconButtonVariant;
  size?: "md" | "sm";
  /** Set for toggles (a heart, show password): pressed is an ink fill with a white icon. */
  pressed?: boolean;
  /** Show the label as a tooltip on hover and keyboard focus. */
  tooltip?: boolean;
}) {
  const classes = ["e-icon-button", `e-icon-button--${variant}`, size === "sm" && "e-icon-button--sm", className]
    .filter(Boolean)
    .join(" ");
  const button = (
    <button {...rest} type={type} className={classes} aria-label={label} aria-pressed={pressed}>
      <Icon name={icon} size={size === "sm" ? "sm" : "md"} />
    </button>
  );
  if (!tooltip) return button;
  return (
    <span className="e-tooltip-host">
      {button}
      <span className="e-tooltip" aria-hidden="true">
        {label}
      </span>
    </span>
  );
}
