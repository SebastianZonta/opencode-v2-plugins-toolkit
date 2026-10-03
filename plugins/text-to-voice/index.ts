// Server-side entry the loader requires alongside "./tui". Speak injects a
// hidden per-request system instruction so responses arrive speakable
// (no tables, no code dumps unless asked). Note: no imports — the server
// runtime does not resolve "@opencode/plugin" for local plugins.
export default {
  id: "text-to-voice",
  async setup(ctx: any) {
    // Config flag gates the instruction; the runtime toggle only gates
    // speech (the TUI store is invisible from here).
    if ((ctx.options as any)?.speakResponses === false) return
    await ctx.session.hook("context", (e: any) => {
      e.system.push({
        type: "text",
        text: "Format every response so it reads well aloud: short sentences, no tables, no code blocks unless explicitly asked, no URLs spelled out.",
      })
    })
  },
}
