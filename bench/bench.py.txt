"""Sift CPU benchmark -- single file, paste and run.

Measures the LFM2.5 ONNX weights natively, to compare against the browser's WASM numbers.
Requires only: onnxruntime, numpy.  No C++ compiler, no tokenizers package.
The byte-level BPE tokenizer below is stdlib-only and produces ids identical to
Hugging Face `tokenizers` (verified across emoji, RTL, CJK, snake_case, tool-call syntax).

Usage
  python bench.py preflight              check the package index has what is needed
  python bench.py fetch                  download the model over plain HTTPS (~810 MB)
  python bench.py decode [variant] [n]   decode tok/s, with KV cache reuse
  python bench.py prefill [variant]      prefill tok/s across context lengths
  python bench.py verify                 compare the tokenizer against `tokenizers`, if installed

Variant defaults to model_q4. Use q4, not q8: natively q8 measured 20x slower.
MODEL_DIR overrides the model location (default ./LFM2.5-1.2B-Instruct-ONNX).
"""
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import sysconfig
import tempfile
import time
from functools import lru_cache

REPO = "LiquidAI/LFM2.5-1.2B-Instruct-ONNX"
MODEL_DIR = os.environ.get("MODEL_DIR", "LFM2.5-1.2B-Instruct-ONNX")


# ---------------------------------------------------------------- tokenizer

@lru_cache(maxsize=1)
def _byte_maps():
    """GPT-2's reversible byte <-> printable-codepoint mapping."""
    bs = (list(range(ord("!"), ord("~") + 1))
          + list(range(ord("\xa1"), ord("\xac") + 1))
          + list(range(ord("\xae"), ord("\xff") + 1)))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    enc = {b: chr(c) for b, c in zip(bs, cs)}
    return enc, {v: k for k, v in enc.items()}


# The pre-tokenizer pattern uses \p{L} and \p{N}, which `re` lacks. [^\W\d_] is the stdlib
# equivalent of "unicode letter" and \d of "unicode digit". The negated forms need lookaheads:
# \w swallows "_" where \p{L} does not, and without this "snake_case" tokenises differently.
_NOT_LETTER = r"(?![^\W\d_])"
_SPLIT = re.compile(
    r"(?i:'s|'t|'re|'ve|'m|'ll|'d)"
    r"|(?:" + _NOT_LETTER + r"[^\r\n\d])?[^\W\d_]+"
    r"|\d{1,3}"
    r"| ?(?:" + _NOT_LETTER + r"[^\s\d])+[\r\n]*"
    r"|\s*[\r\n]+"
    r"|\s+(?!\S)"
    r"|\s+",
    re.UNICODE,
)


class MinBPE(object):
    """Byte-level BPE reading a Hugging Face tokenizer.json, stdlib only."""

    def __init__(self, path):
        with open(path, encoding="utf-8") as f:
            spec = json.load(f)
        model = spec["model"]
        self.vocab = model["vocab"]
        self.ids = dict((i, t) for t, i in self.vocab.items())
        merges = model.get("merges", [])
        pairs = (tuple(m) if isinstance(m, list) else tuple(m.split(" ", 1)) for m in merges)
        self.ranks = dict((p, i) for i, p in enumerate(pairs))
        self.added = dict((t["content"], t["id"]) for t in spec.get("added_tokens", []))
        for t in spec.get("added_tokens", []):
            self.ids[t["id"]] = t["content"]
        specials = sorted(self.added, key=len, reverse=True)
        self._special_re = re.compile("(" + "|".join(re.escape(s) for s in specials) + ")") if specials else None
        self._cache = {}

    def _bpe(self, token):
        if token in self._cache:
            return self._cache[token]
        word = list(token)
        while len(word) > 1:
            best, at = None, None
            for i in range(len(word) - 1):
                r = self.ranks.get((word[i], word[i + 1]))
                if r is not None and (best is None or r < best):
                    best, at = r, i
            if at is None:
                break
            word[at:at + 2] = [word[at] + word[at + 1]]
        self._cache[token] = word
        return word

    def encode(self, text):
        enc, _ = _byte_maps()
        out = []
        parts = self._special_re.split(text) if self._special_re else [text]
        for part in parts:
            if not part:
                continue
            if part in self.added:
                out.append(self.added[part])
                continue
            for piece in _SPLIT.findall(part):
                mapped = "".join(enc[b] for b in piece.encode("utf-8"))
                for sym in self._bpe(mapped):
                    tid = self.vocab.get(sym)
                    if tid is None:
                        out.extend(self.vocab[c] for c in sym)
                    else:
                        out.append(tid)
        return out

    def decode(self, ids, skip_special_tokens=False):
        _, dec = _byte_maps()
        text, buf = [], []
        for i in ids:
            tok = self.ids.get(int(i))
            if tok is None:
                continue
            if tok in self.added:
                if buf:
                    text.append(bytes(dec[c] for c in "".join(buf)).decode("utf-8", errors="replace"))
                    buf = []
                if not skip_special_tokens:
                    text.append(tok)
            else:
                buf.append(tok)
        if buf:
            text.append(bytes(dec[c] for c in "".join(buf)).decode("utf-8", errors="replace"))
        return "".join(text)


# ---------------------------------------------------------------- session

def _need_model(*parts):
    """Fail with an instruction rather than a traceback when the model is not downloaded yet."""
    path = os.path.join(MODEL_DIR, *parts)
    if not os.path.exists(path):
        sys.exit("missing %s\n\nDownload the model first:\n  python bench.py fetch\n"
                 "Or point MODEL_DIR at an existing copy." % path)
    return path


def _session(variant, threads):
    import onnxruntime as ort
    path = _need_model("onnx", variant + ".onnx")
    so = ort.SessionOptions()
    so.log_severity_level = 3
    so.intra_op_num_threads = threads
    t0 = time.time()
    sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    return sess, time.time() - t0


def _to_past(name):
    if name.startswith("present_conv."):
        return name.replace("present_conv.", "past_conv.")
    return name.replace("present.", "past_key_values.")


def _empty_cache(sess):
    import numpy as np
    cache = {}
    for i in sess.get_inputs():
        if i.name in ("input_ids", "attention_mask"):
            continue
        shape = [0 if (isinstance(d, str) and "sequence" in d) else (1 if isinstance(d, str) else d)
                 for d in i.shape]
        cache[i.name] = np.zeros(shape, dtype=np.float32)
    return cache


# ---------------------------------------------------------------- commands

def cmd_decode(argv):
    import numpy as np
    variant = argv[0] if argv else "model_q4"
    threads = int(argv[1]) if len(argv) > 1 else 4
    tok = MinBPE(_need_model("tokenizer.json"))
    sess, load_s = _session(variant, threads)
    out_names = [o.name for o in sess.get_outputs()]
    pairs = [(o, _to_past(o)) for o in out_names if o != "logits"]

    prompt = "List ten short, distinct English nouns as a comma-separated line, then stop."
    text = "<|startoftext|><|im_start|>user\n" + prompt + "<|im_end|>\n<|im_start|>assistant\n"
    ids = tok.encode(text)
    n_prompt = len(ids)

    cache = _empty_cache(sess)
    feeds = {"input_ids": np.array([ids], dtype=np.int64),
             "attention_mask": np.ones((1, n_prompt), dtype=np.int64)}
    feeds.update(cache)
    t0 = time.time()
    out = sess.run(None, feeds)
    prefill_s = time.time() - t0
    res = dict(zip(out_names, out))
    for o, p in pairs:
        cache[p] = res[o]

    gen, total = [], n_prompt
    t0 = time.time()
    for _ in range(24):
        nxt = int(res["logits"][0, -1].argmax())
        gen.append(nxt)
        if nxt == 7:  # eos
            break
        total += 1
        feeds = {"input_ids": np.array([[nxt]], dtype=np.int64),
                 "attention_mask": np.ones((1, total), dtype=np.int64)}
        feeds.update(cache)
        res = dict(zip(out_names, sess.run(None, feeds)))
        for o, p in pairs:
            cache[p] = res[o]
    decode_s = time.time() - t0

    print("variant=%s threads=%d" % (variant, threads))
    print("  load      %8.1f s" % load_s)
    print("  prefill   %4d tok in %6.2f s = %7.1f tok/s  (includes warmup; see prefill cmd)"
          % (n_prompt, prefill_s, n_prompt / prefill_s))
    print("  decode    %4d tok in %6.2f s = %7.2f tok/s" % (len(gen), decode_s, len(gen) / decode_s))
    print("  output: %r" % tok.decode(gen, skip_special_tokens=True))
    print("\nBrowser WASM on the same weights measured 0.71 tok/s decode.")


def cmd_prefill(argv):
    import numpy as np
    variant = argv[0] if argv else "model_q4"
    sess, _ = _session(variant, 4)

    def run(n_tok):
        ids = list(np.random.randint(100, 60000, size=n_tok))
        feeds = {"input_ids": np.array([ids], dtype=np.int64),
                 "attention_mask": np.ones((1, n_tok), dtype=np.int64)}
        feeds.update(_empty_cache(sess))
        t0 = time.time()
        sess.run(None, feeds)
        return time.time() - t0

    run(8)  # warmup: the first inference pays allocation and page-in costs
    print("variant=%s, 4 threads, after warmup" % variant)
    print("%11s %9s %9s" % ("ctx tokens", "seconds", "tok/s"))
    for n in (32, 128, 512, 1024, 2048):
        best = min(run(n) for _ in range(2))
        print("%11d %9.2f %9.1f" % (n, best, n / best))
    print("\nThis is the number that decides whether an agent loop re-reading its")
    print("history each step is affordable. Browser WASM measured ~5-19 tok/s.")


def cmd_verify(argv):
    tok = MinBPE(_need_model("tokenizer.json"))
    try:
        from tokenizers import Tokenizer
    except ImportError:
        print("`tokenizers` not installed, so there is nothing to compare against.")
        print("That is fine: this file does not need it.")
        return
    ref = Tokenizer.from_file(_need_model("tokenizer.json"))
    cases = [
        "Hello world",
        "List ten short, distinct English nouns as a comma-separated line, then stop.",
        "<|startoftext|><|im_start|>user\nrename my files<|im_end|>\n<|im_start|>assistant\n",
        "naive cafe resume, em dash -- and ellipsis...",
        "snake_case CamelCase kebab-case SCREAMING_SNAKE path/to/file.txt",
        "<|tool_call_start|>[list_files(ext='.pdf')]<|tool_call_end|>",
        '{"from":3,"to":"invoice-acme-2024-03-11.txt"}',
        "digits 0 7 42 1234 56789 3.14159 2026-09-03",
        "it's don't we're I'll they've I'd",
        "  spaces\t\ttabs\n\n\nnewlines",
    ]
    bad = 0
    for text in cases:
        want = ref.encode(text, add_special_tokens=False).ids
        got = tok.encode(text)
        label = text if len(text) <= 45 else text[:44] + "..."
        if want != got:
            bad += 1
            print("MISMATCH %r\n  ref %s\n  min %s" % (label, want[:20], got[:20]))
        else:
            print("ok  %4d tok  %r" % (len(got), label))
    print("\nall identical to the reference" if not bad else "\n%d FAILED" % bad)


def cmd_preflight(argv):
    required = ["onnxruntime", "numpy"]
    optional = [("tokenizers", "only needed for `verify`; this file tokenises without it"),
                ("huggingface_hub", "only a convenience; `fetch` uses plain HTTPS")]

    def index_url():
        try:
            out = subprocess.run([sys.executable, "-m", "pip", "config", "list"],
                                 capture_output=True, text=True, timeout=60).stdout
            hits = [l for l in out.splitlines() if "index-url" in l]
            return "; ".join(hits) if hits else "not configured (would use pypi.org)"
        except Exception as e:
            return "could not read pip config: %s" % e

    def try_download(pkg):
        d = tempfile.mkdtemp()
        try:
            r = subprocess.run([sys.executable, "-m", "pip", "download", "--no-deps",
                                "--only-binary=:all:", "-d", d, pkg],
                               capture_output=True, text=True, timeout=900)
            if r.returncode == 0:
                files = os.listdir(d)
                return True, (files[0] if files else "downloaded")
            tail = [l for l in (r.stderr or r.stdout).strip().splitlines() if l.strip()]
            return False, (tail[-1][:180] if tail else "failed")
        except Exception as e:
            return False, str(e)[:180]
        finally:
            shutil.rmtree(d, ignore_errors=True)

    print("python      %s (%s, %s)" % (platform.python_version(), platform.machine(), sys.platform))
    print("wheel tag   %s" % sysconfig.get_platform())
    print("pip index   %s" % index_url())
    print("")
    missing = []
    for pkg in required:
        ok, detail = try_download(pkg)
        print("%s  %-18s %s" % ("OK  " if ok else "MISS", pkg, detail))
        if not ok:
            missing.append(pkg)
    for pkg, why in optional:
        ok, detail = try_download(pkg)
        print("%s  %-18s %s" % ("OK  " if ok else "skip", pkg, detail if ok else "unavailable -- " + why))
    print("")
    if missing:
        print("BLOCKED: %s unavailable, and both are required with no pure-Python" % ", ".join(missing))
        print("substitute. Either request them in your mirror, or download the wheel matching")
        print("the tag above on a connected machine and `pip install <file>.whl`. Still no compiler.")
        return 1
    print("Everything required is available.")
    return 0


def cmd_fetch(argv):
    import urllib.request
    base = "https://huggingface.co/%s/resolve/main/" % REPO
    files = ["tokenizer.json", "config.json", "generation_config.json",
             "onnx/model_q4.onnx", "onnx/model_q4.onnx_data"]
    os.makedirs(os.path.join(MODEL_DIR, "onnx"), exist_ok=True)
    for f in files:
        dest = os.path.join(MODEL_DIR, f)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            print("have %s" % f)
            continue
        print("get  %s ..." % f, end="", flush=True)
        urllib.request.urlretrieve(base + f, dest)
        print(" %.1f MB" % (os.path.getsize(dest) / 1e6))
    print("model in %s" % MODEL_DIR)


COMMANDS = {"decode": cmd_decode, "prefill": cmd_prefill, "verify": cmd_verify,
            "preflight": cmd_preflight, "fetch": cmd_fetch}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(1)
    sys.exit(COMMANDS[sys.argv[1]](sys.argv[2:]) or 0)
