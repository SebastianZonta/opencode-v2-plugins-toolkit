// Server-side entry the loader requires alongside "./tui". Voice has no
// server hooks, so this stays an empty registration. Note: no imports —
// the server runtime does not resolve "@opencode/plugin" for local plugins.
export default {
  id: "voice",
  async setup() {},
}
