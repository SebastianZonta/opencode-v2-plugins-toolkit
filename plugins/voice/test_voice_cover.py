"""In-process coverage for the record path of voice.py.

test_voice_record.py proves end-to-end behavior via subprocesses, which
coverage cannot trace. These tests stub `sounddevice`/`numpy` via
sys.modules fakes (+ Event/signal recorders) so every branch of
cmd_record / main-record / __main__ is measured in-process.
"""
import runpy
import signal as signalmod
import stat
import sys
import threading
import types
import wave
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import voice


class _Chunk:
    def __init__(self, b):
        self._b = bytes(b)

    def copy(self):
        return _Chunk(self._b)


class _Event:
    made = []

    def __init__(self):
        self.set_called = False
        self.waited = None
        _Event.made.append(self)

    def set(self):
        self.set_called = True

    def wait(self, timeout=None):
        self.waited = timeout
        return True


def _stub_audio(monkeypatch, feed=(), enter_exc=None):
    """Install fake sounddevice+numpy; return dict of observed stream kwargs."""
    seen = {}
    sd = types.ModuleType("sounddevice")

    class _Stream:
        def __init__(self, samplerate=None, channels=None, dtype=None, callback=None):
            seen.update(samplerate=samplerate, channels=channels, dtype=dtype)
            self._cb = callback

        def __enter__(self):
            if enter_exc is not None:
                raise enter_exc
            for blob in feed:
                self._cb(_Chunk(blob))
            return self

        def __exit__(self, *a):
            return False

    sd.InputStream = _Stream
    npmod = types.ModuleType("numpy")

    def _concat(arrs):
        blob = b"".join(a._b for a in arrs)

        class _C:
            pass

        c = _C()
        c.tobytes = lambda: blob
        return c

    npmod.concatenate = _concat
    monkeypatch.setitem(sys.modules, "sounddevice", sd)
    monkeypatch.setitem(sys.modules, "numpy", npmod)
    monkeypatch.setattr(threading, "Event", _Event)
    _Event.made.clear()
    return seen


def _stub_signals(monkeypatch):
    reg = {}
    monkeypatch.setattr(signalmod, "signal", lambda sig, h: reg.__setitem__(sig, h))
    return reg


def _wav_params(path):
    with wave.open(str(path), "rb") as w:
        return w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()


def test_record_success_writes_wav_and_chmod(tmp_path, monkeypatch):
    blob = bytes([1, 0, 2, 0]) * 80
    seen = _stub_audio(monkeypatch, feed=[blob, blob])
    _stub_signals(monkeypatch)
    out = str(tmp_path / "clip.wav")
    assert voice.cmd_record(out) == 0
    assert _wav_params(out) == (1, 2, 16000, 320)
    with wave.open(out, "rb") as w:
        assert w.readframes(320) == blob * 2
    assert stat.S_IMODE((tmp_path / "clip.wav").stat().st_mode) == 0o600
    assert (seen["samplerate"], seen["channels"], seen["dtype"]) == (16000, 1, "int16")
    assert _Event.made[-1].waited == voice.MAX_SECONDS  # default seconds


def test_record_empty_chunks_writes_valid_empty_wav(tmp_path, monkeypatch):
    _stub_audio(monkeypatch, feed=[])
    _stub_signals(monkeypatch)
    out = str(tmp_path / "clip.wav")
    assert voice.cmd_record(out, 1.0) == 0
    assert _wav_params(out) == (1, 2, 16000, 0)


def test_record_clamps_seconds_low(tmp_path, monkeypatch):
    _stub_audio(monkeypatch, feed=[])
    _stub_signals(monkeypatch)
    assert voice.cmd_record(str(tmp_path / "c.wav"), 0.2) == 0
    assert _Event.made[-1].waited == 1.0


def test_record_clamps_seconds_high(tmp_path, monkeypatch):
    _stub_audio(monkeypatch, feed=[])
    _stub_signals(monkeypatch)
    assert voice.cmd_record(str(tmp_path / "c.wav"), 999) == 0
    assert _Event.made[-1].waited == voice.MAX_SECONDS


def test_record_signal_handlers_set_stop(monkeypatch):
    _stub_audio(monkeypatch, feed=[])
    reg = _stub_signals(monkeypatch)
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        assert voice.cmd_record(str(Path(d) / "c.wav"), 1.0) == 0
    assert set(reg) == {signalmod.SIGTERM, signalmod.SIGINT}
    for handler in reg.values():
        handler(signalmod.SIGTERM, None)
    assert _Event.made[-1].set_called is True


def test_record_missing_sounddevice_returns_3(tmp_path, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "sounddevice", None)
    out = tmp_path / "clip.wav"
    assert voice.cmd_record(str(out), 1.0) == 3
    assert "sounddevice" in capsys.readouterr().err
    assert not out.exists()


def test_record_missing_numpy_returns_3(tmp_path, monkeypatch, capsys):
    _stub_audio(monkeypatch, feed=[])
    monkeypatch.setitem(sys.modules, "numpy", None)
    out = tmp_path / "clip.wav"
    assert voice.cmd_record(str(out), 1.0) == 3
    assert "sounddevice" in capsys.readouterr().err
    assert not out.exists()


def test_record_stream_exception_returns_1(tmp_path, monkeypatch, capsys):
    _stub_audio(monkeypatch, enter_exc=RuntimeError("mic busy"))
    _stub_signals(monkeypatch)
    out = tmp_path / "clip.wav"
    assert voice.cmd_record(str(out), 1.0) == 1
    assert "record failed" in capsys.readouterr().err
    assert not out.exists()


def test_main_record_default_seconds_is_max():
    with mock.patch.object(voice, "cmd_record", return_value=0) as m:
        assert voice.main(["voice.py", "record", "o.wav"]) == 0
    m.assert_called_once_with("o.wav", voice.MAX_SECONDS)


def test_main_record_explicit_seconds():
    with mock.patch.object(voice, "cmd_record", return_value=0) as m:
        assert voice.main(["voice.py", "record", "o.wav", "5"]) == 0
    m.assert_called_once_with("o.wav", 5.0)


def test_dunder_main_routes_through_system_exit(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["voice.py"])  # usage -> exit 1
    with pytest.raises(SystemExit) as e:
        runpy.run_path(str(Path(voice.__file__)), run_name="__main__")
    assert e.value.code == 1
