const PROMPT = `Find out what changed in the currently installed OpenCode v2 version and summarize it in English, short and grouped.

Steps:
1. Detect the installed version (run \`opencode --version\`).
2. Look up its release notes: first \`https://github.com/anomalyco/opencode/releases/tag/v<version>\` (webfetch) and the changelog at \`https://opencode.ai/changelog\`.
3. That tag is usually empty (version bump only). In that case use the compare API to list the real commits between the previous and current versions: \`https://api.github.com/repos/anomalyco/opencode/compare/v<prev>...v<curr>\` (v2 tags are \`v2.0.x\`) and summarize their messages.
4. Reply in English, concise: tag date, note when the bump itself is empty, and a list of main Feats/Fixes with PR numbers when available. Link the tag and the compare at the end. No essays, no feature tours.`;

export default {
  id: "what-changed",
  async setup(ctx: any) {
    const registration = await ctx.command.transform((draft: any) => {
      draft.add({
        name: "what-changed",
        description: "Summarize what changed in the current OpenCode v2 version",
        execute: async (input: any) => {
          await ctx.session.prompt({
            sessionID: input.sessionID,
            text: PROMPT,
            delivery: input.delivery,
          });
        },
      });
    });
    return async () => {
      await registration.dispose();
    };
  },
};
