#!/usr/bin/env node
// Renders the repository's email templates (supabase/templates/*.html) as static previews, with a
// dummy link in place of {{ .ConfirmationURL }}. Nothing is sent. Output:
//   design-audit/.logs/email-previews/<template>.html   (open in any browser)
// Note: the LOCAL Supabase stack does not use these templates (its config has no template
// entries), so emails caught by Mailpit show Supabase's default text instead. Production uses these.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { auditDir } from "./stack.mjs";

const source = path.resolve(auditDir, "../supabase/templates");
const target = path.join(auditDir, ".logs/email-previews");
mkdirSync(target, { recursive: true });
for (const file of readdirSync(source).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(path.join(source, file), "utf8").replaceAll(
    "{{ .ConfirmationURL }}",
    "http://127.0.0.1:3105/auth/callback?code=PREVIEW-ONLY",
  );
  writeFileSync(path.join(target, file), html);
  console.log(path.join(target, file));
}
