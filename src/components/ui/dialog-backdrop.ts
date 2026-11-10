import type { MouseEvent } from "react";

/** Native dialog backdrop clicks target the dialog, just like its own padding.
 * Include borders and scrollbar gutters in the dialog's protected bounds.
 */
export function isDialogBackdropClick(event: MouseEvent<HTMLDialogElement>): boolean {
  if (event.target !== event.currentTarget) return false;
  const bounds = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  );
}
