"""Prefill throughput at realistic agent-loop context lengths, after warmup.
This is the number that decides whether re-prefilling each iteration is affordable."""
import os, sys, time, numpy as np, onnxruntime as ort
from tokenizers import Tokenizer

ROOT = os.environ.get("MODEL_DIR", "LFM2.5-1.2B-Instruct-ONNX")
variant = sys.argv[1] if len(sys.argv) > 1 else "model_q4"
tok = Tokenizer.from_file(f"{ROOT}/tokenizer.json")
so = ort.SessionOptions(); so.log_severity_level = 3; so.intra_op_num_threads = 4
sess = ort.InferenceSession(f"{ROOT}/onnx/{variant}.onnx", so, providers=["CPUExecutionProvider"])
in_names = [i.name for i in sess.get_inputs()]
out_names = [o.name for o in sess.get_outputs()]

def empty_cache():
    c = {}
    for i in sess.get_inputs():
        if i.name in ("input_ids", "attention_mask"):
            continue
        shape = [0 if (isinstance(d, str) and "sequence" in d) else (1 if isinstance(d, str) else d) for d in i.shape]
        c[i.name] = np.zeros(shape, dtype=np.float32)
    return c

def run(n_tok):
    ids = list(np.random.randint(100, 60000, size=n_tok))
    feeds = {"input_ids": np.array([ids], dtype=np.int64),
             "attention_mask": np.ones((1, n_tok), dtype=np.int64), **empty_cache()}
    t0 = time.time(); sess.run(None, feeds); return time.time() - t0

run(8)  # warm up: first inference pays allocation and page-in costs
print(f"variant={variant}, 4 threads, after warmup")
print(f"{'ctx tokens':>11} {'seconds':>9} {'tok/s':>9}")
for n in (32, 128, 512, 1024, 2048):
    ts = sorted(run(n) for _ in range(2))
    print(f"{n:>11} {ts[0]:>9.2f} {n/ts[0]:>9.1f}")
