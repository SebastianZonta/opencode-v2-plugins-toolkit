"""Record-path contract for voice.py: stubbed mic in, 16kHz mono WAV file out."""
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import wave
from pathlib import Path

VOICE = Path(__file__).resolve().parent / "voice.py"

_STUB_NUMPY = [
    "import sys, types",
    "_np = types.ModuleType('numpy')",
    "class _Arr:",
    "    def __init__(self, b): self._b = bytes(b)",
    "    def copy(self): return _Arr(self._b)",
    "def _concat(arrs):",
    "    _blob = b''.join(a._b for a in arrs)",
    "    class _C:",
    "        pass",
    "    _c = _C()",
    "    _c.tobytes = lambda: _blob",
    "    return _c",
    "_np.concatenate = _concat",
    "sys.modules['numpy'] = _np",
]

def _feed_stub(enter_lines):
    lines = [
        "import types",
        "_sd = types.ModuleType('sounddevice')",
        "_seen = {}",
        "class _Stream:",
        "    def __init__(self, samplerate=None, channels=None, dtype=None, callback=None):",
        "        _seen.update(samplerate=samplerate, channels=channels, dtype=dtype)",
        "        self._cb = callback",
        "    def __enter__(self):",
    ]
    lines += ["        " + ln for ln in enter_lines] or ["        pass"]
    lines += [
        "        return self",
        "    def __exit__(self, *a): return False",
        "_sd.InputStream = _Stream",
        "sys.modules['sounddevice'] = _sd",
    ]
    return lines


def _run(argv, stub_lines, tail_lines=(), timeout=60):
    code = list(stub_lines)
    code.append(f"import sys; sys.argv = {argv!r}")
    code.append(f"_src = open({str(VOICE)!r}).read()")
    code.append("try:")
    code.append("    exec(_src)")
    code.append("except SystemExit as _e:")
    for t in tail_lines:
        code.append(f"    {t}")
    code.append("    raise")
    return subprocess.run(
        [sys.executable, "-c", "\n".join(code)],
        capture_output=True, text=True, timeout=timeout,
    )


def _wav_params(path):
    with wave.open(str(path), "rb") as w:
        return w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()


class TestRecord(unittest.TestCase):
    def test_valid_wav_output(self):
        blob = bytes([1, 0, 2, 0]) * 80  # 320 bytes fed twice -> 640 bytes -> 320 frames
        with tempfile.TemporaryDirectory() as d:
            out = str(Path(d) / "clip.wav")
            stub = _STUB_NUMPY + _feed_stub([
                "self._cb(_Arr(_BLOB))",
                "self._cb(_Arr(_BLOB))",
            ])
            stub.insert(0, f"_BLOB = {blob!r}")
            r = _run(["voice.py", "record", out, "1"], stub, tail_lines=[
                "print('SEEN_SR', repr(_seen.get('samplerate')))",
                "print('SEEN_CH', repr(_seen.get('channels')))",
                "print('SEEN_DT', repr(_seen.get('dtype')))",
            ])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(_wav_params(out), (1, 2, 16000, 320))
            with wave.open(out, "rb") as w:
                self.assertEqual(w.readframes(320), blob * 2)
            self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)
            self.assertIn("SEEN_SR 16000", r.stdout)
            self.assertIn("SEEN_CH 1", r.stdout)
            self.assertIn("SEEN_DT 'int16'", r.stdout)

    def test_empty_stream_writes_valid_empty_wav(self):
        with tempfile.TemporaryDirectory() as d:
            out = str(Path(d) / "clip.wav")
            r = _run(["voice.py", "record", out, "1"],
                     _STUB_NUMPY + _feed_stub([]))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(_wav_params(out), (1, 2, 16000, 0))

    def test_stop_signal_flushes_partial_clip(self):
        for signame in ("SIGTERM", "SIGINT"):
            with self.subTest(signal=signame), tempfile.TemporaryDirectory() as d:
                out = str(Path(d) / "clip.wav")
                blob = bytes([3, 0, 4, 0]) * 80  # 320 bytes -> 160 frames
                stub = [
                    f"_BLOB = {blob!r}",
                    f"_SIG = {signame!r}",
                ] + _STUB_NUMPY + _feed_stub([
                    "self._cb(_Arr(_BLOB))",
                    "import os as _os, signal as _sg, threading as _th",
                    "_th.Timer(0.2, lambda: _os.kill(_os.getpid(), getattr(_sg, _SIG))).start()",
                ])
                start = time.monotonic()
                r = _run(["voice.py", "record", out, "30"], stub, timeout=30)
                elapsed = time.monotonic() - start
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertLess(elapsed, 10, "wait was not interrupted by the signal")
                self.assertEqual(_wav_params(out), (1, 2, 16000, 160))
                with wave.open(out, "rb") as w:
                    self.assertEqual(w.readframes(160), blob)

    def test_max_seconds_cap(self):
        with tempfile.TemporaryDirectory() as d:
            out = str(Path(d) / "clip.wav")
            start = time.monotonic()
            r = _run(["voice.py", "record", out, "999"],
                     _STUB_NUMPY + _feed_stub([]), timeout=120)
            elapsed = time.monotonic() - start
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertGreaterEqual(elapsed, 29)  # capped at 30, not 999
            self.assertLess(elapsed, 90)
            self.assertEqual(_wav_params(out), (1, 2, 16000, 0))

    def test_min_seconds_floor(self):
        with tempfile.TemporaryDirectory() as d:
            out = str(Path(d) / "clip.wav")
            start = time.monotonic()
            r = _run(["voice.py", "record", out, "0.2"],
                     _STUB_NUMPY + _feed_stub([]), timeout=30)
            elapsed = time.monotonic() - start
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertGreaterEqual(elapsed, 0.9)  # floored to 1.0, not 0.2
            self.assertLess(elapsed, 10)

    def test_default_seconds_is_max(self):
        with tempfile.TemporaryDirectory() as d:
            out = str(Path(d) / "clip.wav")
            start = time.monotonic()
            r = _run(["voice.py", "record", out],
                     _STUB_NUMPY + _feed_stub([]), timeout=120)
            elapsed = time.monotonic() - start
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertGreaterEqual(elapsed, 29)  # default is MAX_SECONDS = 30
            self.assertLess(elapsed, 90)

    def test_record_without_output_path_shows_usage(self):
        r = _run(["voice.py", "record"], _STUB_NUMPY + _feed_stub([]))
        self.assertEqual(r.returncode, 1)
        self.assertIn("usage", r.stderr)

    def test_non_numeric_seconds_fails(self):
        with tempfile.TemporaryDirectory() as d:
            out = str(Path(d) / "clip.wav")
            r = _run(["voice.py", "record", out, "abc"],
                     _STUB_NUMPY + _feed_stub([]))
            self.assertEqual(r.returncode, 1)
            self.assertIn("ValueError", r.stderr)
            self.assertFalse(Path(out).exists())

    def test_missing_sounddevice_exits_3(self):
        with tempfile.TemporaryDirectory() as d:
            out = str(Path(d) / "clip.wav")
            r = _run(["voice.py", "record", out, "1"],
                     ["import sys", "sys.modules['sounddevice'] = None"])
            self.assertEqual(r.returncode, 3, r.stdout)
            self.assertIn("sounddevice", r.stderr)
            self.assertFalse(Path(out).exists())

    def test_record_failure_exits_1(self):
        with tempfile.TemporaryDirectory() as d:
            out = str(Path(d) / "clip.wav")
            r = _run(["voice.py", "record", out, "1"],
                     _STUB_NUMPY + _feed_stub(["raise RuntimeError('mic busy')"]))
            self.assertEqual(r.returncode, 1, r.stdout)
            self.assertIn("record failed", r.stderr)
            self.assertFalse(Path(out).exists())

    def test_unwritable_output_path(self):
        with tempfile.TemporaryDirectory() as d:
            out = str(Path(d) / "no-such-dir" / "clip.wav")
            r = _run(["voice.py", "record", out, "1"],
                     _STUB_NUMPY + _feed_stub([]))
            self.assertEqual(r.returncode, 1)
            self.assertIn("FileNotFoundError", r.stderr)
            self.assertFalse(Path(out).exists())


if __name__ == "__main__":
    unittest.main()
