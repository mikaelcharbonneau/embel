import type { ReactNode } from "react";
import { IconButton } from "./button";
import { Icon, type IconName } from "./icon";

export type MessageTone = "neutral" | "positive" | "warning" | "danger";
/** field: text under a field; block: in a card or section; banner: full width under the navigation. */
export type MessageForm = "field" | "block" | "banner";

const icons: Record<MessageTone, IconName> = {
  neutral: "info",
  positive: "circle-check",
  warning: "triangle-alert",
  danger: "circle-alert",
};

/**
 * The one way to tell the person something in place: an icon plus text, never colour alone. Danger and warning
 * are alerts; neutral and positive are polite status. The recovery action is a secondary Button in `actions`.
 */
export function InlineMessage({
  tone = "neutral",
  form = "block",
  title,
  actions,
  onDismiss,
  id,
  live = true,
  className,
  children,
}: {
  tone?: MessageTone;
  form?: MessageForm;
  title?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  id?: string;
  /** Announce the message when it appears. Turn off for messages present on page load. */
  live?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const classes = ["e-message", `e-message--${form}`, tone !== "neutral" && `e-message--${tone}`, className]
    .filter(Boolean)
    .join(" ");
  const role = !live ? undefined : tone === "danger" || tone === "warning" ? "alert" : "status";
  return (
    <div className={classes} id={id} role={role}>
      <Icon name={icons[tone]} size={form === "field" ? "sm" : "md"} />
      <div className="e-message__body">
        {title ? <p className="e-message__title">{title}</p> : null}
        {children ? <div>{children}</div> : null}
        {actions ? <div className="e-message__actions">{actions}</div> : null}
      </div>
      {onDismiss ? <IconButton icon="x" label="Dismiss" size="sm" tooltip={false} onClick={onDismiss} /> : null}
    </div>
  );
}
