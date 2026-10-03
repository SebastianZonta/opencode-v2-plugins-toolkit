"""On-device voice helper: record a Clip, transcribe it to Spanish via Whistle."""
import os
import sys
import wave

RATE = 16000
MAX_SECONDS = 30


def cmd_transcribe(wav_path: str) -> int:
    try:
        import needle  # type: ignore # ponytail: lazy import so tests can stub needle
    except ImportError:
        print("error: missing cactus-needle; pip install 'cactus-needle[mic]'", file=sys.stderr)
        return 3
    try:
        res = needle.transcribe(wav_path, language="es")
    except TypeError:
        print("error: installed cactus-needle lacks language= support; upgrade it", file=sys.stderr)
        return 1
    except FileNotFoundError:
        print(f"error: no such file: {wav_path}", file=sys.stderr)
        return 1
    except Exception as e:  # keep glue thin: model errors become exit 1 + toast upstream
        print(f"error: transcribe failed: {e}", file=sys.stderr)
        return 1
    text = (res.get("text", "") if isinstance(res, dict) else str(res)).strip()
    if not text:
        return 2
    print(text)
    return 0


def cmd_record(out_path: str, seconds: float = MAX_SECONDS) -> int:
    seconds = min(max(seconds, 1.0), MAX_SECONDS)
    try:
        import sounddevice as sd  # type: ignore
        import numpy as np  # type: ignore (sounddevice dependency)
        import signal
        import threading
    except ImportError:
        print("error: missing sounddevice; pip install 'cactus-needle[mic]' + portaudio (apt: libportaudio2)", file=sys.stderr)
        return 3
    chunks: list = []
    stop = threading.Event()

    def on_stop(_signum, _frame) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, on_stop)
    signal.signal(signal.SIGINT, on_stop)
    try:
        # Stream so SIGTERM (toggle-stop) keeps the partial Clip instead of losing it
        with sd.InputStream(samplerate=RATE, channels=1, dtype="int16",
                            callback=lambda data, *_: chunks.append(data.copy())):
            stop.wait(seconds)
    except Exception as e:
        print(f"error: record failed: {e}", file=sys.stderr)
        return 1
    pcm = np.concatenate(chunks).tobytes() if chunks else b""
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    os.chmod(out_path, 0o600)  # Clip is voice data: owner-only in shared /tmp
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[1] not in ("record", "transcribe"):
        print("usage: voice.py record <out.wav> [seconds] | transcribe <clip.wav>", file=sys.stderr)
        return 1
    if argv[1] == "transcribe":
        return cmd_transcribe(argv[2])
    secs = float(argv[3]) if len(argv) > 3 else MAX_SECONDS
    return cmd_record(argv[2], secs)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
