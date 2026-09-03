# CPU benchmark: native onnxruntime vs the browser

Answers one question on your own hardware: how much faster is the same model outside the
browser? Needs **no C++ compiler** — `onnxruntime` ships prebuilt wheels for Windows, Linux and
macOS, which is exactly what `llama-cpp-python` does not.

## First: will your package index cooperate?

On a corporate mirror that only partly mirrors PyPI, check before planning anything. `preflight.py`
uses the standard library alone, so it runs before you install a thing, and it *downloads* each
wheel rather than trusting metadata — a mirror can list a package and still have no wheel for your
platform.

```bash
python bench/preflight.py
```

It reports your wheel tag, the index pip is pointed at, and which packages are actually fetchable.

**Only two packages are genuinely required: `onnxruntime` and `numpy`.** Both ship prebuilt wheels
for Windows, Linux and macOS, so no C++ compiler is involved — the thing that rules out
`llama-cpp-python` does not apply here. If either is missing from your mirror there is no
pure-Python substitute, and the fallback is to fetch the wheel matching your tag on a connected
machine and `pip install` the file.

`tokenizers` and `huggingface_hub` are *not* required. `minbpe.py` implements the model's
byte-level BPE with the standard library only, verified to produce identical ids to the reference
library across emoji with ZWJ joiners, RTL scripts, CJK, `snake_case` and tool-call syntax
(`verify_tokenizer.py`). Weights can be fetched over plain HTTPS.

## Then: run it

```bash
python -m venv .venv
.venv/bin/pip install onnxruntime numpy          # Windows: .venv\Scripts\pip

# the same weights the web app uses, ~810 MB, over plain HTTPS
BASE=https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-ONNX/resolve/main
mkdir -p LFM2.5-1.2B-Instruct-ONNX/onnx
for f in tokenizer.json config.json generation_config.json; do curl -L -o LFM2.5-1.2B-Instruct-ONNX/$f $BASE/$f; done
for f in onnx/model_q4.onnx onnx/model_q4.onnx_data; do curl -L -o LFM2.5-1.2B-Instruct-ONNX/$f $BASE/$f; done

.venv/bin/python bench/decode.py model_q4 4     # decode tok/s, with KV cache reuse
.venv/bin/python bench/prefill.py model_q4      # prefill tok/s across context lengths
```

`MODEL_DIR` overrides the model location.

## Measured here (4-core Xeon with AVX-512 + VNNI, same weights both ways)

| | Browser (WASM) | Native Python | |
| --- | ---: | ---: | --- |
| decode, q4 | 0.71 tok/s | **5.6-14 tok/s** | 8-20x |
| prefill, warmed, 512-2048 ctx | ~5-19 tok/s | **~117 tok/s** | ~6-20x |
| decode, q8 | 0.69 tok/s | 0.28 tok/s | avoid q8 natively |
| decode, 1 thread vs 4 | — | 5.52 vs 5.65 | no scaling |

Decode varies with machine load; both figures are the same weights and prompt, and the browser
produced character-identical output, so the comparison is like for like.

Three things follow.

**Use q4 natively, not q8.** Natively q8 is 20x *slower* than q4, the reverse of the browser
where they tied. Do not carry the browser's variant choice across.

**Decode is memory-bandwidth bound, not compute bound.** One thread is as fast as four, so extra
VDI cores will not buy decode speed; memory bandwidth and the model's active parameter count will.

**Prefill is the part the browser is worst at.** That matters for an agent loop, where each step
re-reads the conversation so far.

## Caveats

The gain comes largely from native SIMD: this CPU has AVX-512 and VNNI, while WASM SIMD is fixed
at 128-bit. A VDI CPU without AVX-512 will show a smaller gap, though WASM's ceiling applies
regardless. Run it there rather than trusting these numbers.
