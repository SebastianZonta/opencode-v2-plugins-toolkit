// Ponytail v2 native wrapper.
//
// The published `@dietrichgebert/ponytail` package only exports a v1 server
// function, so the v2 server rejects it with:
//   "Plugin must export a default definition with an id and an effect or
//    setup function."
// This local plugin re-implements the same behavior on the native v2 API
// (`Plugin.define`-compatible plain object): it appends the ponytail ruleset
// to every model request via `session.hook("context")` and registers the
// `/ponytail` command plus the bundled skills. Ruleset text vendored from
// ponytail 4.10.0 (`instructions-*.txt` next to this file).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

const RUNTIME_MODES = ["off", "lite", "full", "ultra"] as const;
type RuntimeMode = (typeof RUNTIME_MODES)[number];

const DEFAULT_MODE: RuntimeMode = "full";

// Flag file written by the v1 ponytail plugin; honored for migration.
const LEGACY_FLAG_PATH = path.join(os.homedir(), ".config", "opencode", ".ponytail-active");

const FALLBACK_INSTRUCTIONS: Record<Exclude<RuntimeMode, "off">, string> = {
  lite: "PONYTAIL MODE ACTIVE — level: lite. Build what's asked, but name the lazier alternative in one line.",
  full: "PONYTAIL MODE ACTIVE — level: full. Enforce the ladder: YAGNI, reuse, stdlib, native platform, installed deps, one line, then minimum code. Shortest diff, shortest explanation.",
  ultra:
    "PONYTAIL MODE ACTIVE — level: ultra. YAGNI extremist. Deletion before addition. Ship the one-liner and challenge the rest in the same breath.",
};

function normalizeMode(raw: unknown): RuntimeMode | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (RUNTIME_MODES as readonly string[]).includes(v) ? (v as RuntimeMode) : null;
}

function envDefaultMode(): RuntimeMode | null {
  return normalizeMode(process.env.PONYTAIL_DEFAULT_MODE);
}

function legacyFlagMode(): RuntimeMode | null {
  try {
    return normalizeMode(fs.readFileSync(LEGACY_FLAG_PATH, "utf8").trim());
  } catch {
    return null;
  }
}

function writeLegacyFlag(mode: RuntimeMode) {
  try {
    fs.mkdirSync(path.dirname(LEGACY_FLAG_PATH), { recursive: true });
    fs.writeFileSync(LEGACY_FLAG_PATH, mode, "utf8");
  } catch {
    // Flag file is best-effort migration state; storage is authoritative.
  }
}

function readInstructions(mode: Exclude<RuntimeMode, "off">): string {
  try {
    const text = fs.readFileSync(path.join(PLUGIN_DIR, `instructions-${mode}.txt`), "utf8").trim();
    if (text) return text;
  } catch {
    // Fall through to the embedded fallback below.
  }
  return FALLBACK_INSTRUCTIONS[mode];
}

function frontmatterField(body: string, field: string): string | undefined {
  const m = new RegExp(`^${field}:\\s*(.+?)\\s*$`, "m").exec(body);
  return m?.[1]?.replace(/^>\s*/, "").trim();
}

export default {
  id: "ponytail-v2",

  async setup(ctx: any) {
    const registrations: Array<{ dispose(): Promise<void> }> = [];

    let mode: RuntimeMode = envDefaultMode() ?? legacyFlagMode() ?? DEFAULT_MODE;
    try {
      const stored = normalizeMode(await ctx.storage.get("mode"));
      if (stored) mode = stored;
    } catch {
      // Storage unavailable; flag file / env default stands.
    }

    async function setMode(next: RuntimeMode) {
      mode = next;
      writeLegacyFlag(next);
      try {
        await ctx.storage.set("mode", next);
      } catch {
        // Best effort; in-memory mode still applies this process lifetime.
      }
    }

    function activeInstructions(): string | null {
      if (mode === "off") return null;
      return readInstructions(mode);
    }

    // Core injection: append the ruleset to every agent-loop model request.
    // Mirrors goal-plugin's `session.hook("context")` systemReminder merge.
    registrations.push(
      await ctx.session.hook("context", (event: any) => {
        const instructions = activeInstructions();
        if (!instructions) return;
        if (event.system.some((p: any) => p?.type === "text" && typeof p.text === "string" && p.text.includes("PONYTAIL MODE ACTIVE")))
          return;
        event.system.push({ type: "text", text: instructions });
      }),
    );

    // Keep the ruleset visible to checkpoint summaries (defensive: older
    // hosts may not expose this hook yet).
    try {
      const hook = ctx.session.hook as (name: "compaction", cb: (e: any) => void) => Promise<{ dispose(): Promise<void> }>;
      registrations.push(
        await hook("compaction", (event: any) => {
          const instructions = activeInstructions();
          if (!instructions) return;
          event.system.push({ type: "text", text: `Ponytail remains active (level: ${mode}). ${instructions}` });
        }),
      );
    } catch {
      // Host predates the compaction hook.
    }

    // `/ponytail [lite|full|ultra|off]` — mode switch.
    registrations.push(
      await ctx.command.transform((draft: any) => {
        draft.add({
          name: "ponytail",
          description: "Set ponytail intensity (lite|full|ultra|off); no args reports the level",
          execute: async (input: any) => {
            const arg = normalizeMode(String(input?.prompt?.text ?? "").split(/\s+/)[0] ?? "");
            if (!arg) {
              await ctx.session.prompt({
                sessionID: input.sessionID,
                text: `Ponytail level: **${mode}**. Switch with \`/ponytail lite|full|ultra|off\`.`,
                delivery: input.delivery,
              });
              return;
            }
            await setMode(arg);
            await ctx.session.prompt({
              sessionID: input.sessionID,
              text:
                arg === "off"
                  ? "Ponytail off. Building normally."
                  : `Ponytail level set to **${arg}**. Ruleset applies from the next response.`,
              delivery: input.delivery,
            });
          },
        });
      }),
    );

    // Register the bundled skills (review/audit/debt/gain/help + main).
    try {
      const skillsDir = path.join(PLUGIN_DIR, "skills");
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      if (entries.length > 0) {
        registrations.push(
          await ctx.skill.transform((editor: any) => {
            for (const entry of entries) {
              const location = path.join(skillsDir, entry.name, "SKILL.md");
              let body = "";
              try {
                body = fs.readFileSync(location, "utf8");
              } catch {
                continue;
              }
              editor.add({
                id: entry.name,
                name: frontmatterField(body, "name") ?? entry.name,
                description: frontmatterField(body, "description") ?? `Ponytail skill: ${entry.name}`,
                path: location,
                content: body,
              });
            }
          }),
        );
      }
    } catch {
      // Skills are additive; injection + command still work without them.
    }

    return async () => {
      for (const r of registrations) {
        try {
          await r.dispose();
        } catch {
          // Unload must not throw.
        }
      }
    };
  },
};
