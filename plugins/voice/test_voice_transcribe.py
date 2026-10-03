"""Tests for the transcribe path of voice.py (stdlib unittest only)."""
import io
import sys
import types
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import voice


def _install_fake_needle(transcribe_fn):
    mod = types.ModuleType("needle")
    mod.transcribe = transcribe_fn
    sys.modules["needle"] = mod
    return mod


class TranscribePathTest(unittest.TestCase):
    def tearDown(self):
        sys.modules.pop("needle", None)

    def _run_transcribe(self, wav="clip.wav"):
        out = io.StringIO()
        err = io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = voice.cmd_transcribe(wav)
        return rc, out.getvalue(), err.getvalue()

    def test_success_dict_returns_zero_and_prints_text(self):
        _install_fake_needle(lambda *a, **k: {"text": "hola mundo"})
        rc, out, err = self._run_transcribe()
        self.assertEqual(rc, 0)
        self.assertEqual(out, "hola mundo\n")
        self.assertEqual(err, "")

    def test_success_strips_surrounding_whitespace(self):
        _install_fake_needle(lambda *a, **k: {"text": "  hola  \n"})
        rc, out, _ = self._run_transcribe()
        self.assertEqual(rc, 0)
        self.assertEqual(out, "hola\n")

    def test_success_non_dict_string_result(self):
        _install_fake_needle(lambda *a, **k: "buenas tardes")
        rc, out, _ = self._run_transcribe()
        self.assertEqual(rc, 0)
        self.assertEqual(out, "buenas tardes\n")

    def test_empty_text_returns_two_and_prints_nothing(self):
        _install_fake_needle(lambda *a, **k: {"text": ""})
        rc, out, _ = self._run_transcribe()
        self.assertEqual(rc, 2)
        self.assertEqual(out, "")

    def test_whitespace_only_returns_two(self):
        _install_fake_needle(lambda *a, **k: {"text": "   \n "})
        rc, out, _ = self._run_transcribe()
        self.assertEqual(rc, 2)
        self.assertEqual(out, "")

    def test_missing_text_key_returns_two(self):
        _install_fake_needle(lambda *a, **k: {})
        rc, out, _ = self._run_transcribe()
        self.assertEqual(rc, 2)
        self.assertEqual(out, "")

    def test_empty_string_result_returns_two(self):
        _install_fake_needle(lambda *a, **k: "   ")
        rc, out, _ = self._run_transcribe()
        self.assertEqual(rc, 2)
        self.assertEqual(out, "")

    def test_language_forced_to_spanish(self):
        seen = {}

        def fake(wav_path, **kwargs):
            seen["args"] = (wav_path,)
            seen["kwargs"] = kwargs
            return {"text": "hola"}

        _install_fake_needle(fake)
        rc, _, _ = self._run_transcribe("clip.wav")
        self.assertEqual(rc, 0)
        self.assertEqual(seen["args"], ("clip.wav",))
        self.assertEqual(seen["kwargs"], {"language": "es"})

    def test_missing_wav_returns_one(self):
        def boom(wav_path, **kwargs):
            raise FileNotFoundError("nope")
        _install_fake_needle(boom)
        rc, out, err = self._run_transcribe("missing.wav")
        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("missing.wav", err)
        self.assertIn("no such file", err)

    def test_missing_needle_dependency_returns_three(self):
        sys.modules.pop("needle", None)
        # Ensure a real import would fail: block it via meta-path guard.
        with mock.patch.dict(sys.modules, {"needle": None}):
            # None entry makes `import needle` raise ImportError.
            rc, out, err = self._run_transcribe()
        self.assertEqual(rc, 3)
        self.assertEqual(out, "")
        self.assertIn("cactus-needle", err)

    def test_old_needle_without_language_kwarg_returns_one(self):
        def old_needs_no_kwarg(wav_path):
            raise TypeError("transcribe() got an unexpected keyword argument 'language'")
        _install_fake_needle(old_needs_no_kwarg)
        rc, out, err = self._run_transcribe()
        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("lacks language", err)

    def test_corrupt_wav_returns_one(self):
        import wave

        def boom(wav_path, **kwargs):
            raise wave.Error("file does not start with RIFF id")
        _install_fake_needle(boom)
        rc, out, err = self._run_transcribe("corrupt.wav")
        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("transcribe failed", err)
        self.assertIn("RIFF", err)

    def test_generic_model_error_returns_one(self):
        def boom(wav_path, **kwargs):
            raise RuntimeError("weights exploded")
        _install_fake_needle(boom)
        rc, out, err = self._run_transcribe()
        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("transcribe failed", err)
        self.assertIn("weights exploded", err)

    # --- CLI parsing for the transcribe subcommand ---

    def _run_main(self, argv):
        out = io.StringIO()
        err = io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = voice.main(argv)
        return rc, out.getvalue(), err.getvalue()

    def test_main_transcribe_success_delegates(self):
        _install_fake_needle(lambda *a, **k: {"text": "hola"})
        rc, out, _ = self._run_main(["voice.py", "transcribe", "clip.wav"])
        self.assertEqual(rc, 0)
        self.assertEqual(out, "hola\n")

    def test_main_transcribe_propagates_empty_exit_two(self):
        _install_fake_needle(lambda *a, **k: {"text": ""})
        rc, out, _ = self._run_main(["voice.py", "transcribe", "clip.wav"])
        self.assertEqual(rc, 2)
        self.assertEqual(out, "")

    def test_main_transcribe_passes_wav_through(self):
        with mock.patch.dict(sys.modules):
            sys.modules.pop("needle", None)
            fake = mock.MagicMock(return_value={"text": "hola"})
            mod = types.ModuleType("needle")
            mod.transcribe = fake
            sys.modules["needle"] = mod
            rc, _, _ = self._run_main(["voice.py", "transcribe", "mi.wav"])
            self.assertEqual(rc, 0)
            fake.assert_called_once_with("mi.wav", language="es")

    def test_main_usage_no_args(self):
        rc, out, err = self._run_main(["voice.py"])
        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("usage:", err)

    def test_main_usage_transcribe_missing_wav(self):
        rc, out, err = self._run_main(["voice.py", "transcribe"])
        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("usage:", err)

    def test_main_usage_unknown_subcommand(self):
        rc, out, err = self._run_main(["voice.py", "bogus", "clip.wav"])
        self.assertEqual(rc, 1)
        self.assertEqual(out, "")
        self.assertIn("usage:", err)


if __name__ == "__main__":
    unittest.main()
