"""Check minbpe.py against the reference `tokenizers` library, id for id.

Run where `tokenizers` is installed. If this passes, the dependency can be dropped in
environments where the package index does not carry it.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from minbpe import MinBPE

ROOT = os.environ.get("MODEL_DIR", "LFM2.5-1.2B-Instruct-ONNX")
path = os.path.join(ROOT, "tokenizer.json")

CASES = [
    "Hello world",
    "List ten short, distinct English nouns as a comma-separated line, then stop.",
    "<|startoftext|><|im_start|>user\nrename my files<|im_end|>\n<|im_start|>assistant\n",
    "naïve café résumé — em dash, ellipsis…",
    "日本語のファイル名とテキスト",
    "emoji 🎉🚀 party and a ZWJ family 👨‍👩‍👧",
    "  leading and   collapsing   spaces\t\ttabs\n\n\nnewlines",
    "digits 0 7 42 1234 56789 3.14159 2026-09-03",
    "it's don't we're I'll they've I'd",
    "snake_case CamelCase kebab-case SCREAMING_SNAKE path/to/file.txt",
    "<|tool_call_start|>[list_files(ext='.pdf')]<|tool_call_end|>",
    '{"from":3,"to":"invoice-acme-2024-03-11.txt","reason":"matches"}',
    "Ünïcödé ẞ ß Ελληνικά العربية עברית",
    "",
    "a" * 300,
    " non-breaking thin　ideographic spaces",
]

def main():
    mine = MinBPE(path)
    try:
        from tokenizers import Tokenizer
    except ImportError:
        print("`tokenizers` not installed here; cannot compare. Run this where it is available.")
        return 2
    ref = Tokenizer.from_file(path)

    bad = 0
    for text in CASES:
        want = ref.encode(text, add_special_tokens=False).ids
        got = mine.encode(text)
        label = (text[:44] + "…") if len(text) > 45 else text
        if want != got:
            bad += 1
            print(f"MISMATCH {label!r}\n    ref {want[:24]}\n    min {got[:24]}")
        else:
            rt = mine.decode(got)
            if rt != text:
                bad += 1
                print(f"ROUNDTRIP {label!r} -> {rt!r}")
            else:
                print(f"ok  {len(got):>4} tok  {label!r}")
    print("\nall identical to the reference tokenizer" if not bad else f"\n{bad} FAILED")
    return 1 if bad else 0

if __name__ == "__main__":
    raise SystemExit(main())
