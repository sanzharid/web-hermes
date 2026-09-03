"""Byte-level BPE tokenizer in the standard library alone.

Reads a Hugging Face tokenizer.json directly. Exists so a deployment needs only onnxruntime and
numpy from the package index: on a locked-down mirror, every avoidable dependency is a risk.
Verified against the `tokenizers` library for identical ids; see bench/verify_tokenizer.py.
"""
import json
import re
from functools import lru_cache


@lru_cache(maxsize=1)
def _byte_maps():
    """GPT-2's reversible byte <-> printable-codepoint mapping."""
    bs = list(range(ord('!'), ord('~') + 1)) + list(range(ord('\xa1'), ord('\xac') + 1)) + list(range(ord('\xae'), ord('\xff') + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    enc = {b: chr(c) for b, c in zip(bs, cs)}
    return enc, {v: k for k, v in enc.items()}


# The pre-tokenizer pattern uses \p{L} and \p{N}, which `re` lacks. [^\W\d_] is the standard
# stdlib equivalent for "unicode letter" and \d for "unicode digit". The negated classes cannot be
# written inline, because \w swallows "_" while \p{L} does not: without the lookaheads below,
# "snake_case" and "list_files" tokenise differently from the reference.
_NOT_LETTER = r"(?![^\W\d_])"
_SPLIT = re.compile(
    r"(?i:'s|'t|'re|'ve|'m|'ll|'d)"
    rf"|(?:{_NOT_LETTER}[^\r\n\d])?[^\W\d_]+"
    r"|\d{1,3}"
    rf"| ?(?:{_NOT_LETTER}[^\s\d])+[\r\n]*"
    r"|\s*[\r\n]+"
    r"|\s+(?!\S)"
    r"|\s+",
    re.UNICODE,
)


class MinBPE:
    def __init__(self, path):
        with open(path, encoding='utf-8') as f:
            spec = json.load(f)
        model = spec['model']
        self.vocab = model['vocab']
        self.ids = {i: t for t, i in self.vocab.items()}
        merges = model.get('merges', [])
        pairs = (tuple(m) if isinstance(m, list) else tuple(m.split(' ', 1)) for m in merges)
        self.ranks = {p: i for i, p in enumerate(pairs)}
        self.added = {t['content']: t['id'] for t in spec.get('added_tokens', [])}
        for t in spec.get('added_tokens', []):
            self.ids[t['id']] = t['content']
        self.specials = sorted(self.added, key=len, reverse=True)
        self._special_re = re.compile('(' + '|'.join(re.escape(s) for s in self.specials) + ')') if self.specials else None
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
                mapped = ''.join(enc[b] for b in piece.encode('utf-8'))
                for sym in self._bpe(mapped):
                    tid = self.vocab.get(sym)
                    if tid is None:  # unmergeable symbol: fall back to its characters
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
                    text.append(bytes(dec[c] for c in ''.join(buf)).decode('utf-8', errors='replace'))
                    buf = []
                if not skip_special_tokens:
                    text.append(tok)
            else:
                buf.append(tok)
        if buf:
            text.append(bytes(dec[c] for c in ''.join(buf)).decode('utf-8', errors='replace'))
        return ''.join(text)
