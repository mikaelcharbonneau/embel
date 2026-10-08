import "server-only";
import { runLogoTextProcess } from "../../../../worker/logo-vector/text-process";
import { snapshotLogoTextInput, validateShapedLogoText, type LogoTextInput, type ShapedLogoText } from "../../../../worker/logo-vector/text-engine";
import { LogoVectorError } from "../model/errors";
export type { ShapedLogoText } from "../../../../worker/logo-vector/text-engine";
/** Requires a server-resolved PermittedFont. No runtime registration or publication is enabled here. */
export async function shapeLogoText(input: LogoTextInput, signal: AbortSignal): Promise<ShapedLogoText> {
  if (signal.aborted) throw new LogoVectorError("cancelled", "Text shaping was cancelled.");
  const frozen = snapshotLogoTextInput(input);
  const output = await runLogoTextProcess(frozen, signal);
  if (signal.aborted) throw new LogoVectorError("cancelled", "Text shaping was cancelled.");
  return validateShapedLogoText(output, frozen.source);
}
