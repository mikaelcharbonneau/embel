import { redirect } from "next/navigation";
import { homeHref } from "../../../_home/scope-query";

// A logo-only project now starts from Home's Visual identity choice.
export default function NewLogoPage() {
  redirect(homeHref("visual_identity_only"));
}
