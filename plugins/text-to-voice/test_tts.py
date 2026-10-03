"""TTS-path contract for tts.py: text in, 24kHz mono WAV out, voice routes by language (Kokoro stubbed)."""
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
TTS = HERE / "tts.py"

_ES_PCM = b"\x01\x02" * 2400
_EN_PCM = b"\x03\x04" * 2400

_STUBS = [
    "import sys, types",
    # stub numpy: passthrough concatenate for fake chunks exposing tobytes()
    "_np = types.ModuleType('numpy')",
    "class _Arr:",
    "    def __init__(self, parts): self._parts = parts",
    "_np.concatenate = lambda arrs: _Arr(list(arrs))",
    "_np.asarray = lambda a: a",
    "sys.modules['numpy'] = _np",
    # stub soundfile: record args, write a real minimal WAV so file asserts hold
    "_sf = types.ModuleType('soundfile')",
    "_seen = {}",
    "def _write(path, data, rate):",
    "    _seen.update(path=path, rate=rate, chunks=len(data._parts))",
    "    import wave as _w",
    "    _blob = b''.join(getattr(c, '_pcm', b'\\x00\\x00') for c in data._parts)",
    "    _f = _w.open(str(path), 'wb')",
    "    _f.setnchannels(1); _f.setsampwidth(2); _f.setframerate(rate)",
    "    _f.writeframes(_blob); _f.close()",
    "_sf.write = _write",
    "sys.modules['soundfile'] = _sf",
    # stub kokoro: one pipe per lang, distinct PCM marker per voice so tests
    # can prove routing from the WAV bytes alone
    "_ko = types.ModuleType('kokoro')",
    "_PCM = {'em_alex': b'\\x01\\x02' * 2400, 'am_michael': b'\\x03\\x04' * 2400}",
    "class _Pipe:",
    "    def __init__(self, lang_code=None):",
    "        assert lang_code in ('e', 'a'), lang_code",
    "        self._lang = lang_code",
    "    def __call__(self, text, voice=None, speed=1):",
    "        assert (self._lang, voice) in (('e', 'em_alex'), ('a', 'am_michael')), (self._lang, voice)",
    "        assert text == _TEXT, text",
    "        class _C:",
    "            pass",
    "        _c = _C(); _c._pcm = _PCM[voice]",
    "        yield (None, None, _c)",
    "_ko.KPipeline = _Pipe",
    "sys.modules['kokoro'] = _ko",
]


def run_say(out: Path, text: str, lang: str | None = None) -> subprocess.CompletedProcess:
    argv = ["tts.py", "say"] + (["--lang", lang] if lang else []) + [str(out), text]
    lines = _STUBS + [
        f"_TEXT = {text!r}",
        f"sys.argv = {argv!r}",
        f"exec(open({str(TTS)!r}).read())",
    ]
    return subprocess.run([sys.executable, "-c", "\n".join(lines)], capture_output=True, text=True)


def read_pcm(out: Path) -> bytes:
    with wave.open(str(out), "rb") as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 24000)
        return w.readframes(w.getnframes())


class TestSay(unittest.TestCase):
    def test_spanish_routes_spanish_voice(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "reply.wav"
            p = run_say(out, "Hola mundo")
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(p.stdout, "")
            self.assertEqual(read_pcm(out), _ES_PCM)

    def test_english_routes_english_voice(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "reply.wav"
            p = run_say(out, "The weather is nice today")
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(read_pcm(out), _EN_PCM)

    def test_lang_hint_wins_over_detect(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "reply.wav"
            p = run_say(out, "Hola mundo", lang="en")
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(read_pcm(out), _EN_PCM)

    def test_mixed_chunk_majority_wins(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "reply.wav"
            p = run_say(out, "The deployment with todos los cambios")
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(read_pcm(out), _EN_PCM)

    def test_empty_text_exit_2_silent(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "reply.wav"
            p = run_say(out, "   ")
            self.assertEqual(p.returncode, 2)
            self.assertEqual(p.stdout, "")
            self.assertFalse(out.exists())

    def test_missing_kokoro_exit_3(self):
        lines = [
            "import sys",
            "sys.modules['kokoro'] = None",  # force ImportError on `from kokoro import`
            "sys.argv = ['tts.py', 'say', 'o.wav', 'Hola']",
            f"exec(open({str(TTS)!r}).read())",
        ]
        p = subprocess.run([sys.executable, "-c", "\n".join(lines)], capture_output=True, text=True)
        self.assertEqual(p.returncode, 3)
        self.assertEqual(p.stdout, "")
        self.assertIn("kokoro", p.stderr)


class TestDetectLang(unittest.TestCase):
    def test_detect(self):
        sys.path.insert(0, str(HERE))
        try:
            from tts import detect_lang
        finally:
            sys.path.remove(str(HERE))
        self.assertEqual(detect_lang("Hola mundo, ¿cómo estás?"), "es")
        self.assertEqual(detect_lang("The quick brown fox jumps"), "en")
        self.assertEqual(detect_lang("The deployment with todos los cambios"), "en")
        self.assertEqual(detect_lang("haz deploy del fix"), "es")
        self.assertEqual(detect_lang(""), "es")
        self.assertEqual(detect_lang("no a son era"), "es")  # cross-language words excluded
        self.assertEqual(detect_lang("the el"), "es")  # tie goes Spanish


if __name__ == "__main__":
    unittest.main()
