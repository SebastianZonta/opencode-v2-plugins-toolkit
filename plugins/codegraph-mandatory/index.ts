// Codegraph-mandatory: codegraph-first code search, always on.
//
// Mirrors ponytail-v2 injection pattern: appends the rule to every
// agent-loop model request via `session.hook("context")`.
export default {
  id: "codegraph-mandatory",

  async setup(ctx: any) {
    const INSTRUCTIONS =
      "CODEGRAPH MODE ACTIVE — codegraph-first code search, mandatory. " +
      "In a codebase, resolve file and symbol lookup via the codegraph MCP tool (codegraph_explore) FIRST, before built-in grep/glob/read; " +
      "call it first for how-does-X-work, architecture, bug, or where/what questions and before any edit. " +
      "Pass projectPath when querying a second codebase or monorepo sub-project. " +
      "Use built-in tools only when codegraph does not cover it (unindexed project, configs/docs, stale index).";

    const registrations: Array<{ dispose(): Promise<void> }> = [];

    registrations.push(
      await ctx.session.hook("context", (event: any) => {
        if (event.system.some((p: any) => p?.type === "text" && typeof p.text === "string" && p.text.includes("CODEGRAPH MODE ACTIVE")))
          return;
        event.system.push({ type: "text", text: INSTRUCTIONS });
      }),
    );

    try {
      const hook = ctx.session.hook as (name: "compaction", cb: (e: any) => void) => Promise<{ dispose(): Promise<void> }>;
      registrations.push(
        await hook("compaction", (event: any) => {
          event.system.push({ type: "text", text: INSTRUCTIONS });
        }),
      );
    } catch {
      // Host predates the compaction hook.
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
