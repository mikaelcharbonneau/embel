import { redirect } from "next/navigation";

// Older "new logo" links open Home, which starts every new project.
export default function NewLogoPage() {
  redirect("/");
}
