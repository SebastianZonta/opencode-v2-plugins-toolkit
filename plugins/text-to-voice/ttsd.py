"""Voice daemon: hold Kokoro pipelines in memory, synth latest-wins requests over stdio.

Protocol (one JSON object per line):
  stdin:  {"id": 7, "text": "...", "out": "/tmp/x.wav", "lang": "en"}  (lang optional)
  stdout: {"ready": true}                      (once, after both models load)
          {"id": 7, "ok": true}                (wav written)
          {"id": 7, "ok": false, "error": ...} ("empty" | "superseded" | speak error)
          {"fatal": "..."}                     (missing deps, daemon exits 3)

Language routes per request: no "lang" means auto-detect the Chunk
(stopword majority, Spanish on ties). Both pipelines stay hot so switching
languages costs no load wait (~770MB extra RSS for the second one).

Latest wins: while a synth runs, only the newest waiting request is kept;
replaced ones get an immediate "superseded" reply so no caller hangs.
Every request gets exactly one reply. stdin EOF drains and exits 0.
"""
import json
import sys
import threading

from tts import VOICES, detect_lang, load_pipeline, render, write_wav


def main() -> int:
    try:
        pipes = {lang: load_pipeline(code) for lang, (code, _voice) in VOICES.items()}
        import soundfile  # noqa: F401 — ensure the writer exists before announcing ready
    except ImportError:
        print(
            json.dumps({"fatal": "missing kokoro; pip install 'kokoro>=0.9.4' soundfile + apt: espeak-ng"}),
            flush=True,
        )
        return 3

    lock = threading.Lock()
    slot: dict | None = None
    work = threading.Event()
    done = threading.Event()

    def reply(obj: dict) -> None:
        with lock:
            print(json.dumps(obj), flush=True)

    def reader() -> None:
        nonlocal slot
        try:
            for line in sys.stdin:
                try:
                    req = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(req, dict) or req.get("id") is None or "out" not in req:
                    continue
                with lock:
                    old = slot
                    slot = req
                if old is not None:
                    reply({"id": old["id"], "ok": False, "error": "superseded"})
                work.set()
        finally:
            done.set()
            work.set()

    threading.Thread(target=reader, daemon=True).start()
    reply({"ready": True})
    while True:
        work.wait()
        with lock:
            req = slot
            slot = None
            if req is None:
                if done.is_set():
                    return 0
                work.clear()
                if slot is not None:  # arrived between take and clear: don't lose the wakeup
                    work.set()
                continue
        text = req.get("text", "")
        if not isinstance(text, str) or not text.strip():
            reply({"id": req["id"], "ok": False, "error": "empty"})
            continue
        lang = req.get("lang") or detect_lang(text)
        _lang_code, voice = VOICES.get(lang, VOICES["es"])
        try:
            write_wav(req["out"], render(pipes.get(lang, pipes["es"]), text.strip(), voice))
        except Exception as e:
            reply({"id": req["id"], "ok": False, "error": f"speak failed: {e}"})
            continue
        reply({"id": req["id"], "ok": True})


if __name__ == "__main__":
    raise SystemExit(main())
