"""On-device voice output: Spanish/English text to WAV via Kokoro."""
import os
import re
import sys

RATE = 24000
# Voice: fixed speaker per language (Kokoro lang_code, voice id).
VOICES = {"es": ("e", "em_alex"), "en": ("a", "am_michael")}

# ponytail: stopword-majority detect, no deps — chunks are short and the
# reply already splits per sentence, so a tiny distinctive list is enough.
# Deliberately excludes cross-language words (no, a, son, era).
_ES_WORDS = frozenset(
    "el la los las de del en una uno que qué está están este esta estos estas "
    "para porque como cómo cuando donde quién quienes sus les nos también muy "
    "hay fue tiene tienen hacer hace cada entre hasta desde puedo quiero "
    "gracias hola estás estamos gracias mismo misma entre sobre tras ante".split()
)
_EN_WORDS = frozenset(
    "the of and to in is you that this with they have from had were been "
    "will would there their what about which when your said each than then "
    "them these some other into more very after hello thanks please are was "
    "has being".split()
)

_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)


def detect_lang(text: str) -> str:
    """Return 'es' or 'en' by stopword majority; ties and unknowns are 'es'."""
    es = en = 0
    for w in _WORD.findall(text.lower()):
        if w in _ES_WORDS:
            es += 1
        elif w in _EN_WORDS:
            en += 1
    return "en" if en > es else "es"


def load_pipeline(lang_code: str):
    from kokoro import KPipeline  # type: ignore # ponytail: lazy import so tests can stub kokoro
    return KPipeline(lang_code=lang_code)


def render(pipe, text: str, voice: str):
    import numpy as np  # type: ignore
    chunks = [audio for _gs, _ps, audio in pipe(text, voice=voice)]
    return np.concatenate([np.asarray(a) for a in chunks])


def write_wav(out_path: str, audio) -> None:
    import soundfile as sf  # type: ignore
    sf.write(out_path, audio, RATE)
    os.chmod(out_path, 0o600)  # reply audio is voice data: owner-only in shared /tmp


def cmd_say(out_path: str, text: str, lang: str | None = None) -> int:
    text = text.strip()
    if not text:
        return 2
    lang = lang or detect_lang(text)
    lang_code, voice = VOICES.get(lang, VOICES["es"])
    try:
        write_wav(out_path, render(load_pipeline(lang_code), text, voice))
    except ImportError:
        print("error: missing kokoro; pip install 'kokoro>=0.9.4' soundfile + apt: espeak-ng", file=sys.stderr)
        return 3
    except Exception as e:  # keep glue thin: model errors become exit 1 + toast upstream
        print(f"error: speak failed: {e}", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str]) -> int:
    args = argv[1:]
    lang = None
    if len(args) >= 2 and args[0] == "say" and args[1] in ("--lang", "-l"):
        if len(args) < 3:
            print("usage: tts.py say [--lang es|en] <out.wav> <text...>", file=sys.stderr)
            return 1
        lang = args[2]
        args = ["say"] + args[3:]
    if len(args) < 3 or args[0] != "say":
        print("usage: tts.py say [--lang es|en] <out.wav> <text...>", file=sys.stderr)
        return 1
    return cmd_say(args[1], " ".join(args[2:]), lang)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
