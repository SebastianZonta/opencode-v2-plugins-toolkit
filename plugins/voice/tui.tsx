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
      initial: { phase: "idle" as "idle" | "rec" | "busy" | "polish", elapsed: 0 },
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

    const reset = () => {
      stopTimer()
      updateState((d: any) => {
        d.phase = "idle"
        d.elapsed = 0
      })
    }

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

    // ponytail: render-time session goes stale on new tabs — resolve the
    // active session at send time so dictation lands in the focused chat.
    // Tabs first: the active tab IS the focused chat. Router second.
    // Render-time id is the last resort, and may be stale.
    const currentSessionID = (): string | null => {
      try {
        const tabs = (context.ui as any).tabs
        if (tabs?.enabled?.()) {
          const active = (tabs.list() ?? []).find((t: any) => t.active)
          if (active?.sessionID) return active.sessionID
        }
      } catch {}
      try {
        const r = (context.ui as any).router.current()
        if (r?.type === "session" && r.sessionID) return r.sessionID
      } catch {}
      return liveSessionID
    }

    const sessionLabel = (sessionID: string): string => {
      try {
        return (context.data as any).session.get(sessionID)?.title ?? sessionID.slice(-6)
      } catch {
        return sessionID.slice(-6)
      }
    }

    async function sendText(context: any, text: string): Promise<string | null> {
      const sessionID = currentSessionID()
      if (!sessionID) return null
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
        await transcribeAndInsert()
        return
      }
      clipPath = newClipPath()
      try {
        captureProc = Bun.spawn(["python3", VOICE, "record", clipPath, String(MAX_SECONDS)], {
          stdout: "ignore",
          stderr: "pipe",
        })
      } catch {
        clipPath = null
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
        const err = await new Response(captureProc.stderr).text().catch(() => "")
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
        liveSessionID = slot?.sessionID ?? liveSessionID
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
                fallback={<text>…transcribing (first run downloads model)</text>}
              >
                <text>polishing with agent{".".repeat(1 + (s.elapsed % 3))}{" ".repeat(2 - (s.elapsed % 3))}</text>
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
    }
  },
})
