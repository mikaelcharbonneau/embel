import { redirect } from "next/navigation";

// Home starts every new project; older links with a ?scope= open Home as is.
export default function NewProjectPage() {
  redirect("/");
}
