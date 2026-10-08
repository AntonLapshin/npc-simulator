# Phase 0 Laya quality gate — runbook (owner's machine)

The Phase 0 gate (`scripts/eval-laya.ts --gate`) needs a **real** `laya-serve`
with the **typed-decisions checkpoint**. It cannot run in CI or on machines
without the model. This runbook covers a full run on your RTX machine.

## 1. Install (one time)

Python ≥ 3.10 required.

```bash
cd ~/workspace/npc-simulator
npm run setup:laya -- --all   # english + multilingual + typed-decisions checkpoints
```

`--all` matters: the base English checkpoint scores near-random zero-shot on
typed decisions (per the model card); the gate is only meaningful against the
`typed-decisions` checkpoint.

If `laya.load()` hangs during setup, it is transformers probing TensorFlow —
the script already exports `USE_TF=0` to avoid that.

## 2. Serve

```bash
# CPU (works, ~60–80 ms/decision):
npm run serve:laya

# GPU (your 5070 Ti — much faster; needs CUDA torch):
LAYA_DEVICE=cuda npm run serve:laya
```

This starts `laya-serve` on `0.0.0.0:8000` (`POST /v1/systemone`).
`LAYA_PRELOAD=1` (default) preloads checkpoints so the first call doesn't stall.

Sanity check:

```bash
npm run diagnose:ai -- --live   # expect "laya live — server answered a decisions request"
```

## 3. Run the gate

```bash
npx tsx scripts/eval-laya.ts --gate
# optional: --url http://127.0.0.1:8000  (or set LAYA_URL)
```

What it does: 120 hand-labeled cases (`scripts/eval-datasets/laya-eval.json`;
50 selection, 40 judge, 30 triage/salience) against the live server, reporting
per-group accuracy, ECE over 10 bins for yes/no questions, and latency
(mean/p50/p99).

Gate thresholds (`--gate` exits non-zero below these):

| Group | Metric | Threshold |
|---|---|---|
| selection | argmax accuracy | ≥ 0.70 |
| judge | argmax accuracy | ≥ 0.60 |
| triage | accuracy | ≥ 0.70 |
| salience | exact 1–5 | ≥ 0.50 |
| all noul | ECE (10 bins) | ≤ 0.15 |

## 4. Interpreting the result

- **PASS** → Phase 0 GO. Proceed with Phase 1+ wiring (already shipped behind
  flags); enable `LAYA_MODE=static` + `LAYA_SELECTION=1` first, then the rest
  per the rollout in `LAYA_PLAN.md`.
- **FAIL on accuracy** → the typed-decisions checkpoint isn't enough for our
  question distribution. Options before wiring anything: (a) confirm the
  server is actually serving the typed-decisions checkpoint, not base;
  (b) collect failures as fine-tuning data (the checkpoint family is designed
  to be specialized); (c) keep Laya for triage/salience only if those groups
  passed.
- **FAIL on ECE only** → argmax ranking is fine but probabilities are
  miscalibrated: fit one temperature per question type (the model card's own
  prescription) and re-run; meanwhile treat outputs as rankings, not
  thresholds.
- **Latency p99 > 500 ms on CPU** → expected on CPU; use `LAYA_DEVICE=cuda`
  or accept it (still 100× faster than a chat-LLM call).

## 5. Notes

- `--stub` mode (`npx tsx scripts/eval-laya.ts --stub --gate`) is plumbing
  only — it always passes and says nothing about model quality.
- The eval never mutates anything; it only POSTs to `/v1/systemone`.
- Why this didn't run in the dev VM: no GPU, ~1 GB free RAM, and the network
  blocks large PyPI downloads (torch wheel stalled at 248 MB across 27
  attempts) — the checkpoint (~808 MB+) would hit the same wall.
