"""Voice helper contract: WAV in -> Spanish text out (Whistle stubbed)."""
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

VOICE = Path(__file__).resolve().parent / "voice.py"


def make_wav(path: Path, seconds: float = 1.0) -> None:
    frames = int(16000 * seconds)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * frames)


def run_transcribe(wav: Path, stub_text: str) -> subprocess.CompletedProcess:
    lines = [
        "import sys, types",
        "m = types.ModuleType('needle')",
        "def _stub(p, **k):",
        "    assert k.get('language') == 'es', k",
        f"    return {{'text': {stub_text!r}}}",
        "m.transcribe = _stub",
        "sys.modules['needle'] = m",
        f"sys.argv = ['voice.py', 'transcribe', {str(wav)!r}]",
        f"exec(open({str(VOICE)!r}).read())",
    ]
    return subprocess.run([sys.executable, "-c", "\n".join(lines)], capture_output=True, text=True)


class TestTranscribe(unittest.TestCase):
    def test_transcription_to_stdout(self):
        with tempfile.TemporaryDirectory() as d:
            wav = Path(d) / "clip.wav"
            make_wav(wav)
            r = run_transcribe(wav, "hola mundo")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout.strip(), "hola mundo")

    def test_empty_transcription_signals_empty(self):
        with tempfile.TemporaryDirectory() as d:
            wav = Path(d) / "clip.wav"
            make_wav(wav)
            r = run_transcribe(wav, "   ")
            self.assertEqual(r.returncode, 2)
            self.assertEqual(r.stdout.strip(), "")

    def test_missing_clip_fails_without_stdout(self):
        code = (
            "import sys, types;"
            "m=types.ModuleType('needle');"
            "m.transcribe=lambda p,**k: (_ for _ in ()).throw(FileNotFoundError(p));"
            "sys.modules['needle']=m;"
            "sys.argv=['voice.py','transcribe','/tmp/never-created-clip.wav'];"
            f"exec(open({str(VOICE)!r}).read())"
        )
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout, "")


if __name__ == "__main__":
    unittest.main()
