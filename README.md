# local-image-gen

Local AI image generation on an **8 GB consumer GPU** (RTX 3070-class and up), tuned and battle-tested. **FLUX.2 [klein] 4B** (Apache-2.0, commercial-safe) in GGUF quantization over a running **ComfyUI**, driven by a tiny zero-dependency CLI. One-shot model setup, integrated GAN upscaling, reproducible seeds, and version-controlled workflows you can open and edit in the ComfyUI web UI.

Extracted from a production Instagram-content pipeline; this repo is just the image engine, decoupled from everything else.

## What you get

- **`npm run setup`** — one command installs every model into your ComfyUI: the klein 4B **Q5_K_S** GGUF (~3 GB), the Qwen3-4B text encoder, the FLUX.2 VAE, the RealESRGAN upscaler, the ComfyUI-GGUF custom node, and the workflows. Idempotent.
- **`npm run gen -- "your prompt"`** — generates via ComfyUI's HTTP API. Sensible 8 GB defaults (1024×1280, 8 steps, CFG 1.2 with a text-suppression negative), everything overridable.
- **`--upscale`** — 4× GAN upscale → lanczos downscale, integrated into the same graph for crisper fine detail.
- **`--ui-format`** — run the workflow **file** in `./workflows/` instead of the code-built graph: edit it in the ComfyUI web UI, save, re-run. WYSIWYG.
- **Thermal pacing** — a 25 s cooldown between generations (tunable) so sustained FLUX runs don't trip an OS watchdog on thermally-marginal rigs.

## Requirements

| Thing | Notes |
| --- | --- |
| GPU | 8 GB VRAM minimum (tested on an RTX 3070 Ti). The text encoder runs on CPU, so ~32 GB+ system RAM is comfortable. |
| [ComfyUI](https://www.comfy.org/download) | Desktop app or portable. Must be **running** when you generate (default `http://127.0.0.1:8000` — override with `COMFYUI_URL`). |
| Node 18+ or [Bun](https://bun.sh) | The scripts have **zero npm dependencies**. |
| `git` + the `hf` CLI | `pip install -U huggingface_hub` (gives you the `hf` command) — used to download the GGUF/encoder/VAE. |

## Quickstart

```bash
git clone https://github.com/jondmarien/local-image-gen
cd local-image-gen

# 1. point at your ComfyUI install and pull all models (~12 GB total, one time)
npm run setup -- --comfyui-dir="E:\ComfyUI"

# 2. start ComfyUI, then generate
npm run gen -- "A single hard rim light rakes across a brass key dissolving into fine particles in the dark, premium editorial key art, generous negative space below"
```

Images land in `./output/`. Run `npm run gen -- --help` and `npm run setup -- --help` for everything.

## Writing prompts klein actually responds to

klein has **no prompt upsampler** — the literal text is everything. What works:

1. **Prose, not tag soup.** Describe the scene like a sentence.
2. **Order = priority:** `Subject + Action + Style + Context`, focal subject first.
3. **Lead with the lighting** (source / quality / direction / temperature) — it is the single highest-impact lever on output quality.
4. **30–80 specific words.** Filler hurts; one or two strong effects, not a stack.
5. **Don't write "no text" or quoted words** — klein renders them as garbled type. Phrase it positively: "clean unmarked surfaces, generous negative space."

## Flags worth knowing

| Flag | What it does |
| --- | --- |
| `--passes=N` | Sampling steps. klein is **step-distilled**: native 4, useful 4–8, hard-clamped at 12 (more = heat, not quality). |
| `--q6` | Swap to the Q6_K GGUF (~98% of fp16 quality vs Q5's ~95%); auto-downloads. Still fits 8 GB fully on GPU. |
| `--cfg=N` / `--negative="…"` | Default CFG 1.2 + a text/UI-suppression negative (negatives only bite at CFG > 1). `--cfg=1 --negative=""` = BFL stock behavior. |
| `--upscale` | Integrated GAN upscale (RealESRGAN_x4plus default; `--upscale-model=4x-UltraSharp.pth` also auto-downloads). |
| `--ui-format` | Execute `workflows/flux2_klein_4b_8gb[_with_upscale].json` literally; the file's steps/CFG/size win, your prompt + seed are patched in. |
| `--file=prompts.txt` | Batch: one prompt per line, `#` comments skipped. Seeds increment from `--seed` (default 42) — fully reproducible. |
| `--cooldown=SEC` | Breather between generations (default 25, `0` disables). If your machine hard-resets under sustained load, keep it — and consider power-limiting/undervolting the GPU, the real fix. |

## The workflows

`workflows/` holds the exact graphs the CLI builds, in ComfyUI's UI format — open them in the web UI to inspect or tweak. `setup` copies them into ComfyUI's workflow library. If you edit one and want the CLI to run your edits, use `--ui-format`. (If you change the code's graph instead, update the files — they're meant to stay mirrors.)

## Troubleshooting

- **"Can't reach ComfyUI"** — start ComfyUI first; if it's not on `127.0.0.1:8000`, set `COMFYUI_URL`.
- **`UnetLoaderGGUF` missing** — the ComfyUI-GGUF custom node isn't loaded; re-run setup or install via ComfyUI-Manager, then restart ComfyUI.
- **Model dropdown empty after a download** — restart ComfyUI so it re-scans `models/`.
- **Hard reset / CPU-watchdog crash during a batch** — raise `--cooldown`, and power-limit/undervolt the GPU. A 4B model at Q5/Q6 should run **fully on GPU**; avoid CPU-offloading the transformer (that's what causes the sustained all-core load).
- **Garbled text in images** — keep CFG ≥ 1.2 so the negative bites, and remove any quoted words from your prompt.

## Licenses

- **This code:** MIT.
- **FLUX.2 [klein] 4B** (and its GGUF): **Apache-2.0** — commercial use OK. (The 9B variant is *not*; this repo deliberately uses only the 4B.)
- **RealESRGAN_x4plus:** BSD-3-Clause. **4x-UltraSharp:** verify terms before commercial use.
- Generated images: your responsibility — check the model licenses above and your jurisdiction's rules.
