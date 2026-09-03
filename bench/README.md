# CPU benchmark: native onnxruntime vs the browser

Answers one question on your own hardware: how much faster is the same model outside the
browser? Needs **no C++ compiler** — `onnxruntime` ships prebuilt wheels for Windows, Linux and
macOS, which is exactly what `llama-cpp-python` does not.

```bash
python -m venv .venv
.venv/bin/pip install onnxruntime numpy tokenizers huggingface_hub    # Windows: .venv\Scripts\pip

# fetch the same weights the web app uses (~810 MB)
.venv/bin/python -c "from huggingface_hub import snapshot_download as d; \
  d('LiquidAI/LFM2.5-1.2B-Instruct-ONNX', local_dir='LFM2.5-1.2B-Instruct-ONNX', \
    allow_patterns=['*.json','onnx/model_q4.onnx*'])"

.venv/bin/python bench/decode.py model_q4 4     # decode tok/s, with KV cache reuse
.venv/bin/python bench/prefill.py model_q4      # prefill tok/s across context lengths
```

`MODEL_DIR` overrides the model location.

## Measured here (4-core Xeon with AVX-512 + VNNI, same weights both ways)

| | Browser (WASM) | Native Python | |
| --- | ---: | ---: | --- |
| decode, q4 | 0.71 tok/s | **5.65 tok/s** | 8x |
| prefill, warmed, 512-2048 ctx | ~5-19 tok/s | **~117 tok/s** | ~6-20x |
| decode, q8 | 0.69 tok/s | 0.28 tok/s | avoid q8 natively |
| decode, 1 thread vs 4 | — | 5.52 vs 5.65 | no scaling |

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
