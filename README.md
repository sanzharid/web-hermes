# Sift

Point a local language model at a folder and do bulk file work — rename, move, folder —
with a review step before anything is written. Everything runs in the browser: no server,
no API key, no account, no network after the model weights are cached.

Static files, built with Vite. Chromium desktop only (File System Access API).
Target: Windows VDI, ~16 GB RAM, probably no GPU.

## Status

| Step | State | Checkpoint |
| --- | --- | --- |
| 0 Environment check | built; **not yet run on the target VDI** | see below |
| 1 Filesystem spine | done | rename, restore handle, rename again — passes headless |
| 2 Rules engine + review UI + undo | done | 200-file batch renames and undoes cleanly, both move paths |
| 3 Runtime adapter | done | cached model loads and generates with the network off (10.9 s load, headless); throughput below |
| 4 Execution pass | done | 40 mixed files, invalid suggestions caught by validation |
| 5 Interpretation pass | done | spec screen, presets; Instruct produced a recognisable spec in 291 s; thinking on/off compared below |
| 6 Harness | done | real-model query: `get_stats` call then answer in 2 iterations; a rename request is queued, not written (121 s and 149 s on the sandbox CPU) |
| 7 PWA polish | done | manifest, generated service worker; offline audit passes: shell offline, COOP/COEP injected by the worker, model offline; rules-only without a model |

## Environment check (step 0)

The check runs at startup and is on the **Environment** screen. It reports WebGPU presence,
adapter vendor/architecture, `maxBufferSize`, `maxStorageBufferBindingSize`, cross-origin
isolation (which decides single- vs multi-threaded WASM), CPU threads, storage quota and
persistence, and classifies the machine:

- **gpu** — hardware WebGPU adapter. Inference on WebGPU.
- **software** — WebGPU present but SwiftShader/llvmpipe/fallback adapter. Treated as no GPU.
- **none** — no WebGPU. Inference on the CPU through WebAssembly.

I could not run it in the target VDI from here. The headless Chromium used for the tests
reports `software` (Google SwiftShader), which is the case the spec warns about, so the CPU
path is the one that has been exercised end to end. **Run the check on the VDI before
deciding anything about the model tier**; it takes one page load. Also look at `chrome://gpu`
for blocklist status, which a page cannot read.

### Things that contradict the spec (say so and stop)

1. **LFM2.5-8B-A1B cannot run in a browser today.** Liquid's own ONNX card states the export
   is too large for WebGPU browser inference; its smallest variant (q4f16) is 4.7 GB, above the
   4 GB address space of 32-bit WebAssembly, so the "8B-A1B on the WASM/CPU backend" plan for the
   no-GPU case is not possible with any current browser runtime, MoE or not. The spec's own
   fallback applies: **LFM2.5-1.2B on CPU.** The 8B entry stays in the registry, disabled with
   the reason shown, so it can be enabled when a build under the limit appears.
2. **Thinking is not a per-call switch in LFM2.5.** There is no chat-template flag, system
   directive or documented prefill token. Reasoning is a property of the checkpoint:
   `LFM2.5-1.2B-Instruct` never emits a trace, `LFM2.5-1.2B-Thinking` and `8B-A1B` always open
   with `<think>…</think>`. The one candidate for per-call control, prefilling an empty think
   block, was tried and **measured ineffective**: 1.2B-Thinking then deliberates untagged in the
   content instead (see "Thinking policy" below). `capabilities().thinkingControl` is `false`;
   the thinking policy is implemented by choosing the checkpoint, not a flag.
3. **No XGrammar.** WebLLM/MLC has no LFM2 builds (nothing in the prebuilt list, nothing in
   the `mlc-ai` HF org), so the only runtime with LFM2.5 is Transformers.js, which has no
   sampler-level grammar. `capabilities().grammarConstraints` is `false`; the execution pass
   prefills the opening bracket, parses leniently, retries once on unparseable output, and
   every entry goes through validation regardless.

## Verified before building (items A–E)

| | Finding |
| --- | --- |
| **A. Runtime** | Transformers.js 4.2.0 supports `lfm2` and `lfm2_moe`. Liquid publishes official ONNX exports: `LFM2.5-1.2B-Instruct-ONNX`, `LFM2.5-1.2B-Thinking-ONNX` (both 760 MB q4f16 / 850 MB q4 / 1.77 GB q8) and `LFM2.5-8B-A1B-ONNX` (4.7 GB q4f16). WebLLM has none. Decision: Transformers.js on both backends. |
| **B. `move()`** | Present on `FileSystemFileHandle` in Chromium; works on OPFS in the test browser. On local directories Chromium may still throw `NotSupportedError`; the layer tries `move()` once, remembers the answer, and falls back to read → create → write → verify size → `removeEntry`. Both paths are exercised by the browser test. Case-only renames go through a temporary name. |
| **C. Tool-call format** | Confirmed from the chat template: tools are serialised into the system prompt as `List of tools: [...]`; calls are emitted as `<\|tool_call_start\|>[...]<\|tool_call_end\|>`, Pythonic by default; the docs say adding "Output function calls as JSON" to the system prompt switches to JSON. The adapter adds that directive; the parser accepts both forms. |
| **D. Thinking toggle** | Per-checkpoint, not per-call (see above). The 1.2B-Thinking template keeps only the *last* assistant turn's trace (`keep_past_thinking` defaults false); the loop strips traces explicitly anyway. |
| **E. Persistent permission** | Handles are stored in IndexedDB and restored with `queryPermission({mode:'readwrite'})`; `requestPermission` is only called from the Reconnect click. `navigator.storage.persist()` is requested after the first successful model load and the result is shown on the Environment screen. Whether an installed PWA on the VDI remembers access without re-prompting is not verifiable headlessly; the app works either way. |

Two runtime details found the hard way:

- Transformers.js selects the `asyncify` ORT build (the one with the WebGPU execution
  provider) and loads it from a CDN. Its CPU kernel set lacks `GatherBlockQuantized`, which the
  q4 exports use for embeddings, so q4 fails on the CPU with that build. The app self-hosts the
  ORT runtime under `ort/` and uses the plain CPU-only build whenever the backend is WASM.
- Chromium only gets multi-threaded WASM when the page is cross-origin isolated. Firebase and
  Cloudflare set the headers from config (`firebase.json`, `public/_headers`); for hosts that
  cannot, the service worker adds them to every same-origin response.

## Model tiers

| Machine | Backend | Default | Alternative |
| --- | --- | --- | --- |
| hardware WebGPU | webgpu | LFM2.5-1.2B-Instruct q4f16 (760 MB) | 1.2B-Thinking |
| software / none | wasm | LFM2.5-1.2B-Instruct q4 (850 MB) | 1.2B-Thinking |
| any | — | LFM2.5-8B-A1B: listed, disabled | — |

Sampling follows the model cards: Instruct `temperature 0.1, top_k 50, repetition_penalty 1.05`;
Thinking `temperature 0.05`; interpretation calls raise temperature to 0.4.

## Measured throughput

Measured in the headless Chromium of the build sandbox (4 vCPU, WebGPU = SwiftShader, so the
**wasm** backend with 4 threads). These are the sandbox's numbers, not the VDI's; the VDI
measures itself on the Models screen ("Measure tokens/s") and the number is shown in the top bar.

| Model | Variant | Load (cached) | Prefill | Decode |
| --- | --- | --- | --- | --- |
| LFM2.5-1.2B-Instruct | q4 (811 MB) | 27 s | 12–19 tok/s | **0.7 tok/s** |
| LFM2.5-1.2B-Instruct | q8 (1.45 GB) | 7–33 s | 12–19 tok/s | **0.69 tok/s** |

Decode is the same at q4 and q8, so on this CPU it is compute-bound in ORT's WASM kernels, not
weight-bandwidth-bound. Both produced the same, sensible answer to the scratch prompt
(`QuarterlyReport_Q3_2024_Finance.pdf`).

What that means for the execution pass: a 25-file batch is roughly 1,000–1,400 prompt tokens
(around 1.5 minutes of prefill) plus 15–30 output tokens per changed file (10–15 minutes of
decode at 0.7 tok/s). Measured: a 10-file batch (`scripts/plan-test.mjs`, `FILES=10`) took **13.3 minutes** (536
output tokens). The model returned one object per file as asked; validation dropped the 8
no-ops, leaving a case-only rename and one wrong name (the model copied the example filename
from the specification onto an unrelated file). Nothing invalid reached the review screen, which
is the guarantee the design relies on. The 1.2B checkpoint on CPU is usable for small batches
with a human reviewing, not for 200-file runs.

Two runtime details the raw output revealed: the model repeats the opening bracket after the
`[` prefill (`[[{…}]]`, now unwrapped), and small models copy any literal example in the prompt,
so the execution prompt describes the shape instead of showing an example.

The spec's threshold was "a rename batch in under a minute". On this sandbox the 1.2B tier is an
order of magnitude off that on CPU. Whether the VDI is closer depends entirely on its CPU; a
hardware WebGPU adapter would change the picture completely. Rules-based renaming needs none of
this and is the default path.

## Thinking policy, measured

Same instruction ("make these look nicer and group them by project"), same 40 files, sandbox CPU:

| Checkpoint | `thinking` | Output | Time |
| --- | --- | --- | --- |
| 1.2B-Instruct | off (no trace exists) | 6-rule spec, recognisable, a little chatty | 186 tokens, 291 s |
| 1.2B-Thinking | off via empty `<think></think>` prefill | 600 tokens of untagged deliberation, no spec reached (cap) | 870 s |
| 1.2B-Thinking | on | 2,601 chars of tagged reasoning, no spec reached within the 600-token cap | 855 s |

Conclusions that change the spec's table:

- Per-call routing on LFM2.5 means **per-checkpoint routing**. "Thinking on" = load the Thinking
  checkpoint; "thinking off" = load Instruct. The adapter reports this as `thinkingControl: false`
  and the harness's `thinking` flag is accepted but cannot change behaviour.
- On a CPU backend, the Thinking checkpoint is not usable for interpretation: it needs several
  hundred reasoning tokens before the first line of output, which is 10+ minutes at 0.7 tok/s.
  The Instruct checkpoint is the default for every call on `wasm`. On a hardware WebGPU adapter
  (tens of tok/s) the Thinking checkpoint becomes a reasonable choice for the interpretation pass.
- Thinking traces are stripped from history in the loop explicitly (`stripThinking`), and the
  1.2B-Thinking template itself only keeps the last assistant turn's trace.

## Architecture

```
src/runtime   adapter (worker-backed Transformers.js), model registry, LFM2.5 helpers, env check
src/fs        File System Access wrapper, IndexedDB handles, undo journal
src/plan      validation, rules, enrichment, execution pass, interpretation pass
src/harness   tool registry, loop, file tools
src/ui        screens: connect, work, interpret, review, result, journals, models, env
```

- **Runtime adapter** — `init / generate / capabilities / unload` per the spec, in a Web
  Worker. Byte progress, cancel (terminates the worker), Cache API, storage estimate before
  download, `persist()` after the first load. Tokens stream as `think` / `content` pieces.
- **Filesystem** — paths are relative, `/`-separated, one level deep at most. `applyPlan` is
  sequential, stops on first error, and writes `.sift-undo-<ISO8601>.json` before the first
  mutation (closed and committed before anything moves), then annotates it with what was
  applied. Undo reverses the applied operations, newest first, through the same review screen.
  Folders that were created are left in place: the app never deletes anything.
- **Validation** — every rule on every entry; rejects the entry, never the batch. Windows
  naming rules, reserved device names, 260-character path budget (the absolute path of the
  connected folder is not exposed, so its length is a setting, default 64), extension
  preserved, source unchanged since listing, no collisions with disk or within the batch,
  no-ops dropped silently. If the listing itself contains names differing only by case the
  filesystem is case-sensitive and comparisons become exact.
- **Harness** — registry entries `{name, description, schema, handler, sideEffects}`;
  exposure is filtered per turn; side-effecting tools never execute, they queue into a plan.
  Loop capped at 8 iterations, interruptible at every await, state serialisable (a copy is kept
  in `sessionStorage`), thinking stripped from history explicitly.
- **Two passes** — *interpretation* (thinking on where the checkpoint allows, temperature 0.4)
  turns the instruction into an editable written specification; *execution* (thinking off,
  batches of 25, per-file facts only) turns spec + filenames into `{from, to, reason}`.

## Interface

Connect → Work (file table + rules / instruction / ask) → Interpret (editable spec) →
Review (diff, `j`/`k` move, `x` toggle, `Enter` apply, then confirm) → Result (applied, failed,
undo). Rules run without a model. Model download is background; progress is shown in MB.

## Develop and test

```
npm install          # also copies the ORT WASM runtime into public/ort
npm run dev
npm run build        # dist/ with a generated sw.js
npm test             # unit tests: names, validation, rules, LFM parsing, harness loop
node scripts/browser-test.mjs           # headless e2e over OPFS: 200 adversarial names, apply + undo
node scripts/bench-model.mjs [modelId]  # load the model, measure tokens/s
node scripts/plan-test.mjs [modelId]    # 40 mixed files through the execution and interpretation passes
node scripts/offline-test.mjs           # service worker, COOP/COEP injection, shell and model offline
```

The headless tests use the Origin Private File System as the folder (same handle API) and need
a UTF-8 locale for non-ASCII names. `HF_MIRROR=<dir>` points the model scripts at a local copy
of the Hugging Face layout (`<org>/<model>/resolve/main/...`) when the sandbox blocks the
browser's outbound TLS.

## Deploy

`dist/` is the artifact. `firebase.json` and `public/_headers` set the isolation headers for
Firebase Hosting and Cloudflare Pages; GitHub Pages works too because the service worker adds
them on the second load.

## Non-goals

Cloud inference, mobile, editing file contents, whole-drive recursion, deleting files.
