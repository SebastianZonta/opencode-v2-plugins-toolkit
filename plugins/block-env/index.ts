export default {
  id: "block-env",
  async setup(ctx: any) {
    await ctx.permission.hook("evaluate", (event) => {
      if (event.action !== "read" && event.action !== "edit" && event.action !== "shell") return
      const stripExcludes = (r: string) =>
        r
          .replace(/--exclude(?:-dir)?\s*=?\s*['"]?\.env[^'"\s]*/g, "")
          .replace(/(?:--glob|\s-g)\s+['"]?!?\.env[^'"\s]*['"]?/g, "")
          .replace(/-not\s+[^\n;|&]*?\.env[^'"\s]*['"]?/g, "")
      const shellHitsEnv = (r: string) => /\.env(?![A-Za-z0-9_])/.test(stripExcludes(r))
      const hit = event.resources.some((r) =>
        event.action === "shell"
          ? shellHitsEnv(r)
          : r.split(/[\\/]/).some((s) => s.startsWith(".env")),
      )
      if (hit) {
        event.effect = "deny"
        event.message = "Blocked by block-env: .env files are off-limits"
        return
      }
      if (event.action === "shell") {
        for (const r of event.resources) {
          // ponytail: deny-all recursive scans without exclude; per-path parsing if false positives hurt
          const recursive = /(?:^|\s)grep\s+[^;|&]*?(?:-[A-Za-z]*r[A-Za-z]*(?:\s|$|;|'|")|--recursive\b)/.test(r) || /\b(rg|ripgrep)\b/.test(r) || /\bfind\b/.test(r)
          const excluded = /--exclude(?:-dir)?\s*=?\s*['"]?\.env/.test(r) || /(?:--glob|\s-g)\s+['"]?!?\.env/.test(r) || /-not\s+[^\n;|&]*?\.env/.test(r)
          if (recursive && !excluded) {
            event.effect = "deny"
            event.message = "Blocked by block-env: recursive scan without --exclude=.env* denied; re-run with --exclude=.env*"
            return
          }
        }
      }
    })
  }
}
