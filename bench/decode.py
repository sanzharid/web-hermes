"""Native onnxruntime benchmark of the same LFM2.5 ONNX weights the browser runs.
Measures prefill and decode separately, with KV cache reuse across steps."""
import os, sys, time, numpy as np, onnxruntime as ort
from tokenizers import Tokenizer

ROOT = os.environ.get("MODEL_DIR", "LFM2.5-1.2B-Instruct-ONNX")
variant = sys.argv[1] if len(sys.argv) > 1 else "model_q4"
threads = int(sys.argv[2]) if len(sys.argv) > 2 else 4

tok = Tokenizer.from_file(f"{ROOT}/tokenizer.json")
so = ort.SessionOptions()
so.log_severity_level = 3
so.intra_op_num_threads = threads
t0 = time.time()
sess = ort.InferenceSession(f"{ROOT}/onnx/{variant}.onnx", so, providers=["CPUExecutionProvider"])
load_s = time.time() - t0

in_names = [i.name for i in sess.get_inputs()]
out_names = [o.name for o in sess.get_outputs()]
# present.* outputs feed back into the matching past.* inputs next step.
def to_past(name):
    # present_conv.N -> past_conv.N ; present.N.key -> past_key_values.N.key
    if name.startswith("present_conv."):
        return name.replace("present_conv.", "past_conv.")
    return name.replace("present.", "past_key_values.")

pairs = [(o, to_past(o)) for o in out_names if o != "logits"]
missing = [p for _, p in pairs if p not in in_names]
assert not missing, f"unmapped: {missing}"
assert len(pairs) == len(in_names) - 2, f"count mismatch: {len(pairs)} vs {len(in_names)-2}"

def empty_cache():
    c = {}
    for i in sess.get_inputs():
        if i.name in ("input_ids", "attention_mask"):
            continue
        shape = [1 if isinstance(d, str) else d for d in i.shape]
        # sequence dims are symbolic and start empty; conv state is a fixed-size zero block
        shape = [0 if isinstance(d, str) and "sequence" in d else s for d, s in zip(i.shape, shape)]
        c[i.name] = np.zeros(shape, dtype=np.float32)
    return c

PROMPT = "List ten short, distinct English nouns as a comma-separated line, then stop."
text = f"<|startoftext|><|im_start|>user\n{PROMPT}<|im_end|>\n<|im_start|>assistant\n"
ids = tok.encode(text, add_special_tokens=False).ids
n_prompt = len(ids)

cache = empty_cache()
feeds = {"input_ids": np.array([ids], dtype=np.int64),
         "attention_mask": np.ones((1, n_prompt), dtype=np.int64), **cache}
t0 = time.time()
out = sess.run(None, feeds)
prefill_s = time.time() - t0
res = dict(zip(out_names, out))
for o, p in pairs:
    cache[p] = res[o]

MAX_NEW = 24
gen, total = [], n_prompt
t0 = time.time()
for _ in range(MAX_NEW):
    nxt = int(res["logits"][0, -1].argmax())
    gen.append(nxt)
    if nxt == 7:  # eos
        break
    total += 1
    feeds = {"input_ids": np.array([[nxt]], dtype=np.int64),
             "attention_mask": np.ones((1, total), dtype=np.int64), **cache}
    out = sess.run(None, feeds)
    res = dict(zip(out_names, out))
    for o, p in pairs:
        cache[p] = res[o]
decode_s = time.time() - t0

print(f"variant={variant} threads={threads}")
print(f"  load           {load_s:6.1f} s")
print(f"  prefill        {n_prompt} tok in {prefill_s:5.2f} s = {n_prompt/prefill_s:6.1f} tok/s")
print(f"  decode         {len(gen)} tok in {decode_s:5.2f} s = {len(gen)/decode_s:6.2f} tok/s")
print(f"  output: {tok.decode(gen, skip_special_tokens=True)!r}")
