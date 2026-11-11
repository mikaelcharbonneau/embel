#!/usr/bin/env node
// Local-only switches for audit recipes (the same switches as docs/emergency-stop.md, on the
// LOCAL database). Always finish with `reset` (or reseed).
//
//   node design-audit/seed/switch.mjs kind logo.concepts off     one AI step unavailable
//   node design-audit/seed/switch.mjs pause on                   every AI step unavailable
//   node design-audit/seed/switch.mjs daily-limit logo.concepts 1  "today's limit" (429) once used today (minimum 1)
//   node design-audit/seed/switch.mjs credits audit-free 30      set an audit account's credits
//   node design-audit/seed/switch.mjs reset                      everything back to normal
//   node design-audit/seed/switch.mjs status
import { settleCredits, withDatabase } from "./accounts.mjs";
import { auditStack } from "./stack.mjs";

/** Daily limits as the migrations set them (fluid_private.generation_kinds.max_per_day). */
const DEFAULT_DAILY = {
  "engine.probe": 5,
  "identity.directions": 10,
  "logo.concepts": 20,
  "logo.refine": 60,
  "logo.style_note": 30,
  "naming.generate": 30,
  "strategy.audience": 40,
  "strategy.competitors": 20,
  "strategy.personality": 40,
  "strategy.positioning": 40,
  "strategy.reformulate": 100,
  "strategy.slogan": 40,
};
const stack = auditStack();
const [command, a, b] = process.argv.slice(2);
const on = (value) => {
  if (!["on", "off"].includes(value)) throw new Error("Use on or off.");
  return value === "on";
};
await withDatabase(stack, async (db) => {
  switch (command) {
    case "kind":
      if (!DEFAULT_DAILY[a]) throw new Error(`Unknown kind ${a}. Kinds: ${Object.keys(DEFAULT_DAILY).join(", ")}`);
      await db.query("update fluid_private.generation_kinds set enabled = $2 where kind = $1", [a, on(b)]);
      break;
    case "pause":
      await db.query("update fluid_private.engine_settings set paused = $1", [on(a)]);
      break;
    case "daily-limit":
      if (!DEFAULT_DAILY[a]) throw new Error(`Unknown kind ${a}.`);
      await db.query("update fluid_private.generation_kinds set max_per_day = $2 where kind = $1", [a, Number(b)]);
      break;
    case "credits": {
      const { rows } = await db.query("select id from auth.users where email = $1", [`${a}@example.test`]);
      if (!/^audit-(fresh|free|pro)$/u.test(a) || !rows[0])
        throw new Error("Use audit-fresh, audit-free or audit-pro.");
      await settleCredits(stack, rows[0].id, Number(b));
      break;
    }
    case "reset":
      await db.query("update fluid_private.generation_kinds set enabled = true");
      for (const [kind, limit] of Object.entries(DEFAULT_DAILY))
        await db.query("update fluid_private.generation_kinds set max_per_day = $2 where kind = $1", [kind, limit]);
      await db.query("update fluid_private.engine_settings set paused = false");
      break;
    case "status":
      break;
    default:
      throw new Error(
        "Commands: kind <kind> on|off, pause on|off, daily-limit <kind> <n>, credits <account> <n>, reset, status",
      );
  }
  const kinds = await db.query(
    "select kind, enabled, credits, max_per_day from fluid_private.generation_kinds order by kind",
  );
  const settings = await db.query("select paused from fluid_private.engine_settings");
  console.table(kinds.rows);
  console.log(`engine paused: ${settings.rows[0]?.paused}`);
});
