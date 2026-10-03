import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"

const MAX_SECONDS = 30
const VOICE = decodeURIComponent(new URL("./voice.py", import.meta.url).pathname)
const newClipPath = () =>
  `${process.env.TMPDIR ?? "/tmp"}/opencode-voice-${process.pid}-${Math.random().toString(36).slice(2)}.wav`

async function appendDraft(context: any, text: string): Promise<"inserted" | "clipboard" | "failed"> {
  const client = context.client as any
  try {
    // v1 server API; no-op throw on v2 where client.tui is undefined
    await client.tui.appendPrompt({ body: { text } })
    return "inserted"
  } catch { /* fall through to clipboard path */ }
  // v2 has no draft API: copy to clipboard and paste via the host command
  try {
    const data = new TextEncoder().encode(text)
    for (const [cmd, args] of [["wl-copy", [] as string[]], ["xclip", ["-selection", "clipboard"]]] as const) {
      try {
        const p = Bun.spawn([cmd, ...args], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
        p.stdin.write(data)
        p.stdin.end()
        await p.exited
        if (p.exitCode === 0) break
      } catch { /* try next tool */ }
    }
    context.keymap.dispatch("prompt.paste")
    return "clipboard"
  } catch {
    return "failed"
  }
}

export default Plugin.define({
  id: "voice.cli",
  setup(context) {
    const [state, updateState] = context.storage.memory("voice", {
      initial: { phase: "idle" as "idle" | "rec" | "busy" | "polish", elapsed: 0, tick: 0 },
    })
    // Polish setting: plugin options win on every (re)load; the toggle
    // only overrides at runtime until the next restart.
    const [settings, updateSettings] = context.storage.store("voice-settings", {
      initial: { polishSpeechWithAgent: true },
    })
    void updateSettings((d: any) => {
      d.polishSpeechWithAgent = (context.options as any)?.polishSpeechWithAgent !== false
    })
    let captureProc: any = null
    let timer: any = null
    let clipPath: string | null = null
    let settled = true // no live cycle; first of (manual stop | auto-stop | proc-exit) claims it

    const toast = (message: string, variant: "error" | "info" = "error") =>
      context.ui.toast.show({ message, variant })

    const stopTimer = () => {
      if (timer) clearInterval(timer)
      timer = null
    }

    // ponytail: busy/polish animation needs its own fast ticker. The 1s REC
    // timer is capped at MAX_SECONDS, so sharing it freezes the dots.
    let anim: any = null
    const stopAnim = () => {
      if (anim) clearInterval(anim)
      anim = null
    }
    const startAnim = () => {
      stopAnim()
      anim = setInterval(() => {
        updateState((d: any) => {
          d.tick = ((d.tick ?? 0) + 1) % 40
        })
      }, 250)
    }

    const reset = () => {
      stopTimer()
      stopAnim()
      updateState((d: any) => {
        d.phase = "idle"
        d.elapsed = 0
        d.tick = 0
      })
    }
    // ponytail: memory storage survives plugin reloads/remounts while the
    // capture proc and timer do not — a stale rec/busy/polish freezes the
    // indicator (timer dead, settled=true blocks stop) so clear it on mount.
    if ((state as any).phase !== "idle") reset()

    const stopCapture = () => {
      try {
        captureProc?.kill()
      } catch {}
      captureProc = null
    }

    // ponytail: auto-stop timer and proc-exit race on the same Clip; first claims, second no-ops
    const claimCycle = () => {
      if (settled) return false
      settled = true
      return true
    }

    // EXP polish-first: one headless agent pass over the raw transcription.
    // Returns polished text, or null to fall back to raw (never blocks insert).
    async function polishText(raw: string): Promise<string | null> {
      try {
        updateState((d: any) => {
          d.phase = "polish"
          d.elapsed = 0
        })
        const p = Bun.spawn(
          [
            "opencode",
            "run",
            "-m",
            "opencode-go/deepseek-v4-flash",
            "--format",
            "json",
            "Reescribe el siguiente texto dictado en español: corrige gramática, " +
              "puntuación y muletillas, mantén el idioma y el significado, no añadas " +
              "contenido. Devuelve SOLO el texto corregido, sin comillas ni explicaciones. " +
              "Texto: " +
              raw,
          ],
          { stdout: "pipe", stderr: "ignore" },
        )
        const [out] = await Promise.all([new Response(p.stdout).text(), p.exited])
        if (p.exitCode !== 0) return null
        const polished = out
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              const evt = JSON.parse(line)
              return evt.type === "text" ? (evt.part?.text ?? "") : ""
            } catch {
              return ""
            }
          })
          .join("")
          .trim()
        return polished || null
      } catch {
        return null
      }
    }

    // EXP auto-send: live session id tracked from the slot input, since
    // v2 offers no draft API and the draft is skipped entirely here.
    let liveSessionID: string | null = null
    // ponytail: keypress-time owner of the in-flight dictation. Resolving at
    // send time lands in whatever tab is focused after seconds of
    // transcribe+polish (user switched, router moved, slot re-rendered) —
    // the text belongs to the chat where recording started.
    let targetSessionID: string | null = null
    let targetConfident = false

    // ponytail: host shapes vary across versions (sessionID/sessionId/id,
    // nested data/params) — accept all of them so a new chat never falls
    // back to a stale id.
    const pickID = (o: any): string | null => {
      if (!o || typeof o !== "object") return null
      const v =
        o.sessionID ?? o.sessionId ?? o.session_id ?? o.data?.sessionID ?? o.data?.sessionId ?? o.params?.sessionID ?? null
      return typeof v === "string" && v ? v : null
    }

    // ponytail: a guessed session id is how text lands in the wrong chat.
    // Only auto-send when two independent sources agree on the id; the
    // caller falls back to draft/paste (focused chat = correct chat) when
    // they disagree. The newest-session guess is gone on purpose.
    const freshSessionID = (): { tabs: string | null; router: string | null } => {
      let tabs: string | null = null
      try {
        const t = (context.ui as any).tabs
        if (t?.enabled?.()) {
          const list = t.list() ?? []
          const active = list.find((x: any) => x.active ?? x.focused ?? x.selected) ?? null
          tabs = pickID(active) ?? (typeof active === "string" ? active : null)
        }
      } catch {}
      let router: string | null = null
      try {
        const r = (context.ui as any).router.current()
        router = pickID(r) ?? pickID(r?.data) ?? pickID(r?.params)
        if (!router && r && typeof r.id === "string" && (r.type === "session" || r.route === "session" || r.name === "session"))
          router = r.id
      } catch {}
      return { tabs, router }
    }

    const resolveSession = (): { id: string | null; confident: boolean } => {
      const { tabs, router } = freshSessionID()
      if (tabs && router && tabs === router) return { id: tabs, confident: true }
      if (tabs && tabs === liveSessionID) return { id: tabs, confident: true }
      if (router && router === liveSessionID) return { id: router, confident: true }
      return { id: tabs ?? router ?? liveSessionID, confident: false }
    }

    // ponytail: temporary debug flag — set debugVoice:true in plugin options,
    // restart, reproduce, report the toasts. Remove once diagnosed.
    const DEBUG = (context.options as any)?.debugVoice === true
    const short = (id: string | null) => (id ? id.slice(-6) : "-")
    // ponytail: file log beats toasts (transient) — read it directly after repro.
    const dbgLines: string[] = []
    const dbgLog = async (line: string) => {
      if (!DEBUG) return
      try {
        dbgLines.push(new Date().toISOString() + " " + line)
        while (dbgLines.length > 50) dbgLines.shift()
        await Bun.write(`${process.env.TMPDIR ?? "/tmp"}/opencode-voice-debug.log`, dbgLines.join("\n") + "\n")
      } catch {}
    }
    const dbgSources = (): string => {
      let tabs = "-"
      try {
        const t = (context.ui as any).tabs
        if (t?.enabled?.()) {
          const l = t.list() ?? []
          tabs = l.map((x: any) => `${String(x.sessionID ?? "?").slice(-4)}${x.active ? "*" : ""}`).join(",") || "empty"
        } else tabs = "off"
      } catch {
        tabs = "err"
      }
      let router = "-"
      try {
        const r = (context.ui as any).router.current()
        router = r?.type === "session" ? String(r.sessionID).slice(-6) : (r?.type ?? "?")
      } catch {
        router = "err"
      }
      return `tabs:${tabs} router:${router} live:${short(liveSessionID)}`
    }

    const sessionLabel = (sessionID: string): string => {
      try {
        return (context.data as any).session.get(sessionID)?.title ?? sessionID.slice(-6)
      } catch {
        return sessionID.slice(-6)
      }
    }

    async function sendText(context: any, text: string): Promise<string | null> {
      // ponytail: only a confident id may auto-send; anything else falls
      // back to draft/paste in the focused chat (never a guessed session).
      void dbgLog(`send target:${short(targetSessionID)} conf:${targetConfident ? 1 : 0} fresh:${dbgSources()}`)
      if (!targetSessionID || !targetConfident) return null
      const sessionID = targetSessionID
      try {
        await (context.client as any).session.prompt({ sessionID, text })
        return sessionID
      } catch {
        return null
      }
    }

    async function transcribeAndInsert() {
      const clip = clipPath
      clipPath = null
      updateState((d: any) => {
        d.phase = "busy"
      })
      startAnim()
      try {
        const p = Bun.spawn(["python3", VOICE, "transcribe", clip!], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const [out, err, code] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ])
        await Bun.$`rm -f ${clip}`.quiet().catch(() => {})
        const text = out.trim()
        if (code === 2 || !text) {
          toast("No speech detected — draft untouched", "info")
          return
        }
        if (code !== 0) {
          toast(err.trim() || "Transcription failed — draft untouched")
          return
        }
        // EXP polish-first: hold the insert until the enhanced text returns.
        // Each polish leaves a throwaway session behind (no sessionless run mode).
        // Skipped entirely when Polish is off (config or runtime toggle).
        const polished = (settings as any).polishSpeechWithAgent !== false ? await polishText(text) : null
        const final = polished ?? text
        // EXP auto-send: submit the text straight into the live session,
        // skipping the draft middleman (v2 has no draft-write API anyway).
        // Falls back to draft insert + submit dispatch when direct send fails.
        const sentID = await sendText(context, final)
        if (sentID) {
          toast(polished ? `Polished and sent → ${sessionLabel(sentID)}` : `Sent → ${sessionLabel(sentID)}`, "info")
          return
        }
        const result = await appendDraft(context, final)
        if (result === "inserted") context.keymap.dispatch("prompt.submit")
        else if (result === "clipboard") toast("Pasted via clipboard — press ctrl+v if empty", "info")
        else if (result === "failed") toast("Could not insert into draft — text discarded")
      } finally {
        targetSessionID = null
        reset()
      }
    }

    async function toggle() {
      const s = state as any
      if (s.phase === "busy" || s.phase === "polish") {
        toast("Transcribing — wait a moment", "info")
        return
      }
      if (s.phase === "rec") {
        if (!claimCycle()) return
        stopCapture()
        // ponytail: stop keypress is fresher than start — it wins only when
        // confident; otherwise the start snap stands.
        const stopRes = resolveSession()
        if (stopRes.confident) {
          targetSessionID = stopRes.id
          targetConfident = true
        }
        if (DEBUG) toast(`voice stop ${dbgSources()} target:${short(targetSessionID)} conf:${targetConfident ? 1 : 0}`, "info")
        void dbgLog(`stop ${dbgSources()} target:${short(targetSessionID)} conf:${targetConfident ? 1 : 0}`)
        await transcribeAndInsert()
        return
      }
      clipPath = newClipPath()
      // ponytail: snapshot synchronously with the keypress — everything after
      // this (record seconds, transcribe, agent polish) resolves too late.
      const startRes = resolveSession()
      targetSessionID = startRes.id
      targetConfident = startRes.confident
      if (DEBUG) toast(`voice start ${dbgSources()} target:${short(targetSessionID)} conf:${targetConfident ? 1 : 0}`, "info")
      void dbgLog(`start ${dbgSources()} target:${short(targetSessionID)} conf:${targetConfident ? 1 : 0}`)
      try {
        captureProc = Bun.spawn(["python3", VOICE, "record", clipPath, String(MAX_SECONDS)], {
          stdout: "ignore",
          stderr: "pipe",
        })
      } catch {
        clipPath = null
        targetSessionID = null
        reset()
        toast("Could not start recorder — draft untouched")
        return
      }
      settled = false
      updateState((d: any) => {
        d.phase = "rec"
        d.elapsed = 0
      })
      timer = setInterval(() => {
        updateState((d: any) => {
          d.elapsed = Math.min(d.elapsed + 1, MAX_SECONDS)
        })
        if ((state as any).phase === "rec" && (state as any).elapsed >= MAX_SECONDS) {
          void toggle()
        }
      }, 1000)
      captureProc.exited.then(async (code: number) => {
        if ((state as any).phase !== "rec" || !claimCycle()) return
        const proc = captureProc
        if (!proc) {
          reset()
          return
        }
        const err = await new Response(proc.stderr).text().catch(() => "")
        stopCapture()
        reset()
        toast(err.trim() || `Recorder exited (${code}) — draft untouched`)
      })
    }

    async function cancel() {
      const s = state as any
      if (s.phase === "idle") {
        toast("Nothing recording — draft untouched", "info")
        return
      }
      if (s.phase === "busy" || s.phase === "polish") {
        toast("Transcribing — wait a moment", "info")
        return
      }
      if (!claimCycle()) return
      stopCapture()
      if (clipPath) await Bun.$`rm -f ${clipPath}`.quiet().catch(() => {})
      clipPath = null
      targetSessionID = null
      reset()
      toast("Recording discarded — draft untouched", "info")
    }

    // ponytail: keymap.layer needs Keymap.Provider, which only exists under
    // a rendered component — and the layer is owned by that component, so
    // register on every render (no once-guard: remounts must re-register)
    const registerKeymap = () => {
      context.keymap.layer(() => ({
        mode: "global",
        enabled: () => true,
        commands: [
          {
            id: "voice.record",
            title: "Voice: record / stop",
            group: "Voice",
            bind: "ctrl+q",
            palette: true,
            slash: { name: "voice-record" },
            run: () => void toggle(),
          },
          {
            id: "voice.cancel",
            title: "Voice: discard recording",
            group: "Voice",
            palette: true,
            slash: { name: "voice-cancel" },
            run: () => void cancel(),
          },
          {
            id: "voice.polish.toggle",
            title: "Voice: toggle agent polish",
            group: "Voice",
            palette: true,
            slash: { name: "toggle-voice-polish" },
            run: () =>
              void updateSettings((d: any) => {
                d.polishSpeechWithAgent = !(d.polishSpeechWithAgent !== false)
              }).then(() =>
                toast(
                  (settings as any).polishSpeechWithAgent !== false ? "Polish on — transcripts get cleaned" : "Polish off — raw transcripts",
                  "info",
                ),
              ),
          },
        ],
        bindings: ["voice.record"],
      }))
    }

    context.ui.slot({
      append: "prompt.footer.status",
      render: (slot: any) => {
        const sid = pickID(slot)
        if (sid) liveSessionID = sid
        registerKeymap()
        return <Mic />
      },
    })

    function Mic() {
      const s = state as any
      return (
        <Show
          when={s.phase !== "idle"}
          fallback={<text>🎤 voice (ctrl+q)</text>}
        >
          <Show
            when={s.phase === "rec"}
            fallback={
              <Show
                when={(s.phase as string) === "polish"}
                fallback={<text>…transcribing{".".repeat(1 + ((s.tick ?? 0) % 3))}{" ".repeat(2 - ((s.tick ?? 0) % 3))}</text>}
              >
                <text>polishing with agent{".".repeat(1 + ((s.tick ?? 0) % 3))}{" ".repeat(2 - ((s.tick ?? 0) % 3))}</text>
              </Show>
            }
          >
            <text>
              {s.elapsed % 2 === 0 ? "●" : "○"} REC {String(s.elapsed).padStart(2, "0")}/{MAX_SECONDS}s
            </text>
          </Show>
        </Show>
      )
    }

    return () => {
      stopTimer()
      stopCapture()
      // ponytail: proc+timer die with this closure but memory state persists —
      // reset so a remount never rehydrates a dead REC indicator.
      const clip = clipPath
      clipPath = null
      targetSessionID = null
      if (clip) void Bun.$`rm -f ${clip}`.quiet().catch(() => {})
      try {
        reset()
      } catch {}
    }
  },
})
