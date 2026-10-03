"""Daemon-path contract for ttsd.py: stdio JSON protocol, per-chunk language routing (Kokoro stubbed)."""
import json
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
TTSD = HERE / "ttsd.py"

_ES_PCM = b"\x01\x02" * 2400
_EN_PCM = b"\x03\x04" * 2400

_STUBS = [
    "import sys, types",
    "_np = types.ModuleType('numpy')",
    "class _Arr:",
    "    def __init__(self, parts): self._parts = parts",
    "_np.concatenate = lambda arrs: _Arr(list(arrs))",
    "_np.asarray = lambda a: a",
    "sys.modules['numpy'] = _np",
    "_sf = types.ModuleType('soundfile')",
    "def _write(path, data, rate):",
    "    import wave as _w",
    "    _blob = b''.join(getattr(c, '_pcm', b'\\x00\\x00') for c in data._parts)",
    "    _f = _w.open(str(path), 'wb')",
    "    _f.setnchannels(1); _f.setsampwidth(2); _f.setframerate(rate)",
    "    _f.writeframes(_blob); _f.close()",
    "_sf.write = _write",
    "sys.modules['soundfile'] = _sf",
    "_ko = types.ModuleType('kokoro')",
    "_PCM = {'em_alex': b'\\x01\\x02' * 2400, 'am_michael': b'\\x03\\x04' * 2400}",
    "class _Pipe:",
    "    def __init__(self, lang_code=None):",
    "        assert lang_code in ('e', 'a'), lang_code",
    "        self._lang = lang_code",
    "    def __call__(self, text, voice=None, speed=1):",
    "        assert (self._lang, voice) in (('e', 'em_alex'), ('a', 'am_michael')), (self._lang, voice)",
    "        class _C:",
    "            pass",
    "        _c = _C(); _c._pcm = _PCM[voice]",
    "        yield (None, None, _c)",
    "_ko.KPipeline = _Pipe",
    "sys.modules['kokoro'] = _ko",
]


def run_daemon(request_lines: list[str], timeout: float = 60) -> tuple[list[dict], str]:
    code = "\n".join(_STUBS + [f"exec(open({str(TTSD)!r}).read())"])
    p = subprocess.run(
        [sys.executable, "-c", code],
        input="".join(request_lines),
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(HERE),  # so `from tts import ...` resolves next to ttsd.py
    )
    assert p.returncode == 0, f"daemon exited {p.returncode}: {p.stderr}"
    assert p.stderr == "", p.stderr
    return [json.loads(line) for line in p.stdout.splitlines()], p.stderr


def req(rid: int, text: str, out: Path, lang: str | None = None) -> str:
    obj: dict = {"id": rid, "text": text, "out": str(out)}
    if lang:
        obj["lang"] = lang
    return json.dumps(obj) + "\n"


def read_pcm(out: Path) -> bytes:
    with wave.open(str(out), "rb") as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 24000)
        return w.readframes(w.getnframes())


class TestTtsd(unittest.TestCase):
    def test_ready_then_ok(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "one.wav"
            lines, _ = run_daemon([req(1, "Hola mundo", out)])
            self.assertEqual(lines[0], {"ready": True})
            self.assertEqual(lines[1], {"id": 1, "ok": True})
            self.assertEqual(read_pcm(out), _ES_PCM)

    def test_english_chunk_auto_routes_english_voice(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "en.wav"
            lines, _ = run_daemon([req(1, "The weather is nice today", out)])
            self.assertEqual(lines[1], {"id": 1, "ok": True})
            self.assertEqual(read_pcm(out), _EN_PCM)

    def test_lang_hint_wins_over_detect(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "hint.wav"
            lines, _ = run_daemon([req(1, "Hola mundo", out, lang="en")])
            self.assertEqual(lines[1], {"id": 1, "ok": True})
            self.assertEqual(read_pcm(out), _EN_PCM)

    def test_empty_text_reports_empty(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "empty.wav"
            lines, _ = run_daemon([req(1, "   ", out)])
            self.assertEqual(lines[0], {"ready": True})
            self.assertEqual(lines[1], {"id": 1, "ok": False, "error": "empty"})
            self.assertFalse(out.exists())

    def test_bad_line_ignored_then_ok(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "two.wav"
            lines, _ = run_daemon(["not json\n", "{}\n", req(2, "Hola", out)])
            self.assertEqual(lines[0], {"ready": True})
            self.assertEqual(lines[1], {"id": 2, "ok": True})
            self.assertEqual(read_pcm(out), _ES_PCM)

    def test_sequential_requests_newest_always_ok(self):
        # worker/reader race decides req1's fate, but the contract holds:
        # every request gets exactly one reply, newest is always synthesized
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d) / "a.wav", Path(d) / "b.wav"
            lines, _ = run_daemon([req(1, "Primera", a), req(2, "Segunda", b)])
            by_id = {m.get("id"): m for m in lines if "id" in m}
            self.assertEqual(set(by_id), {1, 2})
            self.assertTrue(by_id[2].get("ok"), by_id)
            if by_id[1].get("ok"):
                self.assertEqual(read_pcm(a), _ES_PCM)
            else:
                self.assertEqual(by_id[1], {"id": 1, "ok": False, "error": "superseded"})
                self.assertFalse(a.exists())
            self.assertEqual(read_pcm(b), _ES_PCM)


if __name__ == "__main__":
    unittest.main()
