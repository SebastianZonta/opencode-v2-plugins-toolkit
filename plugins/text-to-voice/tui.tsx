import { Plugin } from "@opencode/plugin/tui"
import { readFileSync, writeFileSync } from "node:fs"
import { Show } from "solid-js"

const TTS = decodeURIComponent(new URL("./tts.py", import.meta.url).pathname)
const TTSD = decodeURIComponent(new URL("./ttsd.py", import.meta.url).pathname)
const newOutPath = () =>
  `${process.env.TMPDIR ?? "/tmp"}/opencode-tts-${process.pid}-${Math.random().toString(36).slice(2)}.wav`
const rmWav = (f: string) => Bun.$`rm -f ${f}`.quiet().catch(() => {})

// ponytail: setup() can run more than once per process, and stale setups
// keep their event listeners — every one of them would speak the same reply
// (heard as repeated sentences) and pile up Kokoro synths (100% CPU). All
// audio state lives here so only the newest setup speaks; stale setups bail
// via setupEpoch. One daemon, one synth at a time, shared latest-wins.
let setupEpoch = 0
let generation = 0 // every stop invalidates in-flight continuations
let playProc: any = null
let synthProc: any = null
let ttsOn = true
let daemonProc: any = null
let daemonAlive = false
let daemonStarting: Promise<boolean> | null = null
const daemonReadyWaiters = new Set<(v: boolean) => void>()
let synthReqId = 0
const synthWaiters = new Map<number, { resolve: (r: any) => void; reject: (e: any) => void; timeout: any }>()
let soloQueue: Promise<void> = Promise.resolve()
let toggling = false
let audioSessionID: string | null = null // session whose reply is currently speaking

// ponytail: the module can load N times per process (plugin hot-reload),
// and module state is per-instance — epoch/generation guards can't silence
// rival instances, which is heard as simultaneous audios. Leadership lives
// in tiny /tmp files (the only memory all instances share): only the newest
// setup speaks. Scoped per user+project so other checkouts are unaffected.
// Fail-open on missing files: never total-mute over a deleted tmp file.
const TTS_UID = (() => {
  try {
    return String((process as any).getuid?.() ?? process.env.USER ?? "u")
  } catch {
    return "u"
  }
})()
let ttsScope = "shared"
const ttsPaths = () => {
  const base = `${process.env.TMPDIR ?? "/tmp"}/opencode-tts-${TTS_UID}-${ttsScope}`
  return { leader: `${base}.leader`, daemonPid: `${base}.daemon.pid` }
}
const readTiny = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8").trim() || null
  } catch {
    return null
  }
}
const writeTiny = (p: string, v: string) => {
  try {
    writeFileSync(p, v)
  } catch {}
}
// pid-reuse safe: only SIGKILL a live process whose cmdline is our daemon
const isOurDaemonPid = (pid: number): boolean => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").includes("ttsd.py")
  } catch {
    return false
  }
}
const killPid = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return
  if (!isOurDaemonPid(pid)) return
  try {
    process.kill(pid, "SIGKILL")
  } catch {}
}

// ponytail: Bun kill can silently miss (lost handle = orphaned synth at
// 120% CPU), so kill by pid first, then the Bun handle as fallback
const killProc = (p: any) => {
  if (!p) return
  try {
    process.kill(p.pid, "SIGKILL")
  } catch {}
  try {
    p.kill(9)
  } catch {}
  try {
    p.kill()
  } catch {}
}

const killDaemon = () => {
  for (const [, w] of synthWaiters) {
    clearTimeout(w.timeout)
    w.reject(new Error("daemon gone"))
  }
  synthWaiters.clear()
  daemonAlive = false
  for (const r of daemonReadyWaiters) r(false)
  daemonReadyWaiters.clear()
  killProc(daemonProc)
  daemonProc = null
}

const handleDaemonLine = (line: string) => {
  let msg: any = null
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg?.ready === true) {
    daemonAlive = true
    for (const r of daemonReadyWaiters) r(true)
    daemonReadyWaiters.clear()
    return
  }
  if (msg?.fatal) {
    killDaemon() // waiters reject -> callers fall back to one-shot
    return
  }
  if (msg?.id === undefined || msg?.id === null) return
  const w = synthWaiters.get(msg.id)
  if (!w) return
  synthWaiters.delete(msg.id)
  clearTimeout(w.timeout)
  w.resolve(msg)
}

async function pumpDaemon(proc: any) {
  try {
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        handleDaemonLine(line)
      }
    }
    try {
      reader.releaseLock()
    } catch {}
  } catch {
    /* stream errors surface as death via exited below */
  }
}

function runDaemon(): void {
  let resolveStartup!: (v: boolean) => void
  const p: Promise<boolean> = new Promise<boolean>((r) => {
    resolveStartup = r
  })
  daemonStarting = p
  void p.then(() => {
    if (daemonStarting === p) daemonStarting = null
  })
  let proc: any = null
  try {
    proc = Bun.spawn(["python3", TTSD], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
  } catch {
    daemonProc = null
    resolveStartup(false)
    return
  }
  daemonProc = proc
  try {
    writeTiny(ttsPaths().daemonPid, String(proc.pid))
  } catch {}
  void pumpDaemon(proc)
  proc.exited.then(() => {
    if (daemonProc === proc) killDaemon() // rejects waiters; next speak respawns
  })
  daemonReadyWaiters.add(resolveStartup)
  setTimeout(() => {
    if (daemonReadyWaiters.delete(resolveStartup)) resolveStartup(false)
    // slow load: waiter falls back, daemon keeps loading for the next speak
  }, 120000)
}

async function ensureDaemon(): Promise<boolean> {
  if (!ttsOn) return false
  if (daemonProc && daemonAlive) return true
  if (!daemonStarting) runDaemon()
  const starting = daemonStarting
  if (!starting) return false
  return Promise.race([starting, new Promise<boolean>((r) => setTimeout(() => r(false), 120000))])
}

function daemonSynth(text: string, out: string): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!daemonProc || !daemonAlive) {
      reject(new Error("daemon not ready"))
      return
    }
    const id = ++synthReqId
    const timeout = setTimeout(() => {
      synthWaiters.delete(id)
      killDaemon() // wedged: drop it, callers fall back to one-shot
      reject(new Error("synth timed out"))
    }, 180000)
    synthWaiters.set(id, { resolve, reject, timeout })
    try {
      daemonProc.stdin.write(JSON.stringify({ id, text, out }) + "\n")
      ;(daemonProc.stdin as any)?.flush?.()
    } catch {
      clearTimeout(timeout)
      synthWaiters.delete(id)
      reject(new Error("daemon write failed"))
    }
  })
}

export default Plugin.define({
  id: "text-to-voice.cli",
  setup(context) {
    const [state, updateState] = context.storage.memory("text-to-voice", {
      initial: { phase: "idle" as "idle" | "speaking", elapsed: 0 },
    })
    // Config wins on every (re)load; the toggle only overrides at runtime.
    const [settings, updateSettings] = context.storage.store("text-to-voice-settings", {
      initial: { speakResponses: true },
    })
    void updateSettings((d: any) => {
      d.speakResponses = (context.options as any)?.speakResponses !== false
    })
    let liveSessionID: string | null = null
    let tabSeen = false // audio session seen in the open-tab list at least once
    let timer: any = null
    let flushTimer: any = null
    const pending = new Map<string, string>() // sessionID -> accumulated response text
    const epoch = ++setupEpoch // stale setups keep listeners but never speak
    // newest setup across ALL module instances leads — older ones go silent
    try {
      const loc: any = (context as any)?.location ?? {}
      const dir = String(loc?.directory ?? loc?.project?.directory ?? loc?.project?.canonical ?? "shared")
      let h = 5381
      for (let i = 0; i < dir.length; i++) h = ((h << 5) + h + dir.charCodeAt(i)) | 0
      ttsScope = `p${(h >>> 0).toString(36)}`
    } catch {
      ttsScope = "shared"
    }
    const myLeadership = `${process.pid}:${epoch}:${Math.random().toString(36).slice(2)}`
    const paths = ttsPaths()
    writeTiny(paths.leader, myLeadership)
    const iAmLeader = () => {
      const cur = readTiny(paths.leader)
      return cur === null || cur === myLeadership
    }
    // superseded daemon (rival instance's) frees ~2GB; pid-reuse safe
    try {
      const old = Number(readTiny(paths.daemonPid))
      if (Number.isInteger(old) && old > 0) killPid(old)
    } catch {}
    ttsOn = (context.options as any)?.speakResponses !== false

    const toast = (message: string, variant: "error" | "info" = "error") =>
      context.ui.toast.show({ message, variant })

    const stopTimer = () => {
      if (timer) clearInterval(timer)
      timer = null
    }

    const stopAudio = () => {
      generation++
      audioSessionID = null
      killProc(playProc)
      killProc(synthProc)
      playProc = synthProc = null
    }

    const reset = () => {
      stopTimer()
      updateState((d: any) => {
        d.phase = "idle"
        d.elapsed = 0
      })
    }

    async function playFile(myGen: number, file: string) {
      // paplay via the sound server first, ALSA straight fallback
      for (const cmd of [["paplay", file], ["aplay", "-q", file]]) {
        if (myGen !== generation) return true // superseded: stop silently
        try {
          const player = (playProc = Bun.spawn(cmd as string[], { stdout: "ignore", stderr: "ignore" }))
          await player.exited
          if (playProc === player) playProc = null // exited handle: drop it so later kills can't hit a reused pid
          if (myGen !== generation) return true // killed by a newer speak: never replay via fallback
          if (player.exitCode === 0) return true
        } catch { /* try next player */ }
      }
      return false
    }

    async function synthChunk(
      text: string,
      file: string,
    ): Promise<{ status: "ok" | "silent" | "failed"; err?: string }> {
      if (await ensureDaemon()) {
        try {
          const r = await daemonSynth(text, file)
          if (r?.ok) return { status: "ok" }
          if (r?.error === "empty" || r?.error === "superseded") return { status: "silent" }
          return { status: "failed", err: typeof r?.error === "string" ? r.error : "Could not speak reply" }
        } catch {
          /* daemon died/wedged mid-request: one-shot fallback below */
        }
      }
      if (!ttsOn || epoch !== setupEpoch) return { status: "silent" }
      // ponytail: fallback path must never pile up — one one-shot at a time
      // per process, and stale/superseded callers skip instead of queueing work
      const ticket = soloQueue
      let release!: () => void
      soloQueue = new Promise<void>((r) => {
        release = r
      })
      await ticket
      if (!ttsOn || epoch !== setupEpoch) {
        release()
        return { status: "silent" }
      }
      const queuedGen = generation
      try {
        if (queuedGen !== generation) return { status: "silent" }
        const solo = (synthProc = Bun.spawn(["python3", TTS, "say", file, text], {
          stdout: "ignore",
          stderr: "pipe",
        }))
        await solo.exited
        if (synthProc === solo) synthProc = null
        if (solo.exitCode === 0) return { status: "ok" }
        if (solo.exitCode === 2) return { status: "silent" }
        const err = await new Response(solo.stderr).text().catch(() => "")
        return { status: "failed", err: err.trim() || "Could not speak reply" }
      } catch {
        return { status: "failed", err: "Could not speak reply" }
      } finally {
        release()
      }
    }

    // ponytail: time-to-first-audio beats total time — split long replies
    // into sentences so the first chunk plays after ~1-2s of synth instead
    // of waiting for the whole reply.
    const splitSpeech = (text: string): string[] => {
      const parts = text.match(/[^.!?…]+[.!?…]+["'”»)\]]?|[^.!?…]+$/g) ?? [text]
      const out: string[] = []
      for (const part of parts) {
        const t = part.trim()
        if (!t) continue
        if (t.length <= 450) {
          out.push(t)
          continue
        }
        let rest = t
        while (rest.length > 450) {
          let cut = rest.lastIndexOf(" ", 450)
          if (cut < 200) cut = 450
          out.push(rest.slice(0, cut).trim())
          rest = rest.slice(cut).trim()
        }
        if (rest) out.push(rest)
      }
      return out.length ? out : [text.trim()]
    }

    async function speak(text: string, sessionID: string) {
      if (epoch !== setupEpoch) return // stale setup: never touch audio
      if (!iAmLeader()) return // rival instance took over: stay silent
      stopAudio() // interrupt: latest response wins, never a queue
      audioSessionID = sessionID
      tabSeen = false
      const myGen = generation
      updateState((d: any) => {
        d.phase = "speaking"
        d.elapsed = 0
      })
      stopTimer()
      timer = setInterval(() => {
        // no tab-close event exists on the bus: a tab closed mid-playback
        // vanishes from the open-tab list, and that silences its audio
        try {
          if (audioSessionID && context.ui.tabs.enabled()) {
            if (context.ui.tabs.list().some((t) => t.sessionID === audioSessionID)) {
              tabSeen = true
            } else if (tabSeen) {
              stopAudio()
              reset()
              return
            }
          }
        } catch { /* tabs API unavailable: keep playing */ }
        updateState((d: any) => {
          d.elapsed = (d.elapsed ?? 0) + 1
        })
      }, 500)
      try {
        const chunks = splitSpeech(text)
        // ponytail: depth-1 Prefetch — synth chunk i+1 while chunk i plays
        // so sentences join without pauses. The daemon worker is serial,
        // so deeper prefetch would only supersede itself: exactly one ahead.
        const synthToFile = async (chunk: string) => {
          const file = newOutPath()
          return { file, r: await synthChunk(chunk, file) }
        }
        let upcoming: Promise<{ file: string; r: Awaited<ReturnType<typeof synthChunk>> }> | null = null
        const dropPrefetch = () => {
          if (upcoming) void upcoming.then(({ file }) => rmWav(file)).catch(() => {})
          upcoming = null
        }
        for (let i = 0; i < chunks.length; i++) {
          if (myGen !== generation || !iAmLeader()) {
            dropPrefetch()
            return // superseded: stay silent
          }
          const prefetched = upcoming !== null
          const ready = upcoming ?? synthToFile(chunks[i])
          const { file: myFile, r } = await ready
          if (myGen !== generation) {
            void rmWav(myFile)
            dropPrefetch()
            return
          }
          // ponytail: fire next synth only once this one resolved (during
          // playback). Two outstanding synths race in the daemon's 1-slot
          // latest-wins inbox and the older one is discarded unheard.
          upcoming = i + 1 < chunks.length ? synthToFile(chunks[i + 1]) : null
          try {
            if (r.status === "silent") continue // empty chunk: skip, keep playing the rest
            if (r.status === "failed") {
              if (prefetched) continue // bad Prefetch skips silently, the rest still plays
              dropPrefetch()
              reset()
              toast(r.err || "Could not speak reply")
              return
            }
            if (!(await playFile(myGen, myFile))) {
              if (myGen !== generation) {
                dropPrefetch()
                return
              }
              dropPrefetch()
              reset()
              toast("No audio player found (paplay/aplay)")
              return
            }
          } finally {
            await rmWav(myFile)
          }
        }
        if (myGen !== generation) return
        reset()
      } catch {
        reset()
        toast("Could not speak reply")
      }
    }

    // Finished assistant text blocks accumulate per session; the turn-end
    // event flushes the whole response into one synthesis (Q14).
    try {
      const data = (context as any).data
      data.on("session.text.ended", (e: any) => {
        const id = e?.data?.sessionID
        const text = e?.data?.text
        if (!id || !text || id !== liveSessionID) return
        pending.set(id, (pending.get(id) ?? "") + text)
      })
      // ponytail: idle + execution.succeeded fire for the same turn (and per
      // step in tool-using turns) — debounce trailing so one turn = one synth.
      // Without this, every step spawns a CPU-heavy Kokoro synth that the next
      // step immediately supersedes: pileup, 100% CPU, frozen indicator.
      const scheduleFlush = (sessionID: string) => {
        clearTimeout(flushTimer)
        flushTimer = setTimeout(() => {
          if (epoch !== setupEpoch) return // stale setup: only the newest speaks
          if (!iAmLeader()) {
            reset()
            return // rival instance took over: stay silent
          }
          const text = (pending.get(sessionID) ?? "").trim()
          pending.delete(sessionID)
          if (!text || !ttsOn || (settings as any).speakResponses === false) {
            reset()
            return
          }
          void speak(text, sessionID)
        }, 800)
      }
    const flush = (e: any) => {
      if (epoch !== setupEpoch) return
      const id = e?.data?.sessionID
      if (!id || id !== liveSessionID) return
      scheduleFlush(id)
    }
      data.on("session.idle", flush)
      data.on("session.execution.succeeded", flush)
      // closing the tab (or deleting the session) must silence its audio:
      // otherwise the speak loop keeps playing orphaned chunks to the end
      const stopSession = (e: any) => {
        if (epoch !== setupEpoch) return
        const id = e?.data?.sessionID ?? e?.data?.id ?? e?.sessionID ?? null
        if (id) pending.delete(id)
        if (id !== null && id !== audioSessionID) return // another session's audio: leave it
        stopAudio()
        reset()
      }
      data.on("session.deleted", stopSession)
      // NOTE: session.tab.close and session.closed do not exist on the
      // bus — closed tabs are caught by the speaking-timer tab check above.
      // hitting enter (a new execution starts) silences current audio:
      // otherwise stale speech keeps playing over the user's next turn
      data.on("session.execution.started", (e: any) => {
        if (epoch !== setupEpoch) return
        const id = e?.data?.sessionID
        if (!id || id !== liveSessionID) return
        clearTimeout(flushTimer)
        pending.delete(id)
        stopAudio()
        reset()
      })
      data.on("session.execution.failed", (e: any) => {
        clearTimeout(flushTimer)
        pending.delete(e?.data?.sessionID)
        stopAudio()
        reset()
      })
    } catch {
      toast("Speak: response events unavailable")
    }

    // ponytail: keymap.layer needs Keymap.Provider, which only exists under
    // a rendered component — register on every render (no once-guard)
    const registerKeymap = () => {
      context.keymap.layer(() => ({
        mode: "global",
        enabled: () => true,
        commands: [
          {
            id: "tts.toggle",
            title: "TTS: toggle voice output",
            group: "TTS",
            palette: true,
            slash: { name: "toggle-tts" },
            run: () => {
              // ponytail: several setups may register this command; only the
              // first run per tick applies so stacked layers can't flip twice
              if (toggling) return
              toggling = true
              setTimeout(() => {
                toggling = false
              }, 0)
              ttsOn = !ttsOn
              const target = ttsOn
              if (!target) {
                clearTimeout(flushTimer)
                // shared pid kill: the toggle may run in a rival instance,
                // but the daemon to free is always the leader's (~2GB)
                try {
                  const recorded = Number(readTiny(paths.daemonPid))
                  if (Number.isInteger(recorded) && recorded > 0) killPid(recorded)
                } catch {}
                killDaemon() // free ~1.7GB while off; next speak respawns
                stopAudio()
                pending.clear()
                reset()
              } else {
                if (iAmLeader()) void ensureDaemon() // prewarm so the next speak finds it hot
              }
              return void updateSettings((d: any) => {
                d.speakResponses = target
              }).then(() =>
                toast(target ? "Speak on — responses read aloud" : "Speak off — silent", "info"),
              )
            },
          },
        ],
        bindings: [],
      }))
    }

    // ponytail: prewarm Kokoro while the user works so the first speak
    // finds a hot daemon instead of paying ~8s import+load on demand.
    // Leader-only: rival instances must not pile up their own daemons.
    if (iAmLeader()) void ensureDaemon()

    context.ui.slot({
      append: "prompt.footer.status",
      render: (slot: any) => {
        liveSessionID = slot?.sessionID ?? liveSessionID
        registerKeymap()
        return <Speaker />
      },
    })

    function Speaker() {
      const s = state as any
      return (
        <Show when={s.phase !== "idle"} fallback={<text>🔊 tts</text>}>
          <text>
            playing{".".repeat(1 + ((s.elapsed ?? 0) % 3))}{" ".repeat(2 - ((s.elapsed ?? 0) % 3))}
          </text>
        </Show>
      )
    }
    return () => {
      if (epoch !== setupEpoch) return // stale setup: don't kill the active one's audio
      clearTimeout(flushTimer)
      killDaemon()
      stopTimer()
      stopAudio()
    }
  },
})
