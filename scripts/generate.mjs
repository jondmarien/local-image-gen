#!/usr/bin/env node
// local-image-gen — generate images with FLUX.2 [klein] 4B GGUF via a RUNNING ComfyUI server.
// Extracted from the ai-ugc-pipeline art engine; same tuned 8 GB defaults, zero coupling.
// Runs on Node 18+ or Bun. No npm dependencies.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
};

const HELP = `
local-image-gen — FLUX.2 [klein] 4B GGUF over a running ComfyUI (8 GB VRAM friendly)

USAGE
  bun run gen -- "<prompt>" ["<prompt 2>" ...] [flags]      (or: npm run gen / node scripts/generate.mjs)

  Each positional argument is one prompt → one image. Add --file=prompts.txt to read more
  prompts (one per line, # comments skipped). Images land in ./output/ as 001.png, 002.png …

PROMPTS (what works on klein)
  klein has NO prompt upsampler — the literal text is everything. Write PROSE, not tag soup,
  in Subject + Action + Style + Context order, and LEAD with the lighting (source/quality/
  direction) — it's the single highest-impact lever. 30–80 specific words beats 200 vague ones.

ENGINE & QUALITY
  --passes=N | --steps=N    sampling steps. klein is step-distilled: recommended 4–8,
                            hard max 12 (clamped; more passes = heat, not quality)
  --width=N --height=N      generation size, snapped to ×16 (default 1024×1280 portrait)
  --cfg=N                   guidance (default 1.2 so the negative prompt bites; BFL stock = 1.0)
  --negative="…"            negative prompt (default suppresses garbled text/UI/logos;
                            pass --negative="" to disable). Only active when --cfg > 1.
  --seed=N                  base seed (default 42; prompt #2 uses N+1, etc. — reproducible)
  --q6                      use flux-2-klein-4b-Q6_K.gguf (≈98% of fp16 vs Q5's ≈95%);
                            auto-downloads via the hf CLI if missing
  --model=NAME.gguf         any other klein-4B GGUF filename in ComfyUI's unet folder
  --cooldown=SEC            pause between generations (default 25; 0 disables). Sustained
                            back-to-back FLUX on a thermally-marginal 8 GB rig can trip an
                            OS CPU watchdog — the breather prevents it.

UPSCALE (integrated into the same graph)
  --upscale                 after VAE decode: 4× GAN upscale → lanczos downscale to
                            --width×--height × scale → save (sharper fine detail)
  --upscale-model=NAME.pth  RealESRGAN_x4plus.pth (default, BSD-3) | 4x-UltraSharp.pth —
                            both auto-download to <ComfyUI>/models/upscale_models
  --upscale-scale=N         final size = width/height × N (default 1)

WORKFLOW SOURCE
  (default)                 graph built in code
  --ui-format               execute the version-controlled ComfyUI workflow FILE from
                            ./workflows/ (the _with_upscale variant when --upscale). The
                            file's steps/CFG/size win; prompt + seed are patched per image.
                            Edit in the ComfyUI web UI, save over the file, re-run — WYSIWYG.

MISC
  --out=NAME | --outdir=DIR  output name (single prompt) / output directory (default ./output)
  --dry-run                  print config + prompts, submit nothing
  --help, -h                 this help

ENV  COMFYUI_URL (http://127.0.0.1:8000) · COMFYUI_DIR (E:\\ComfyUI) — models live under
     <COMFYUI_DIR>/models/{unet,text_encoders,vae,upscale_models}

EXAMPLES
  bun run gen -- "A single hard rim light rakes across a brass key dissolving into fine particles in the dark, premium editorial key art, generous negative space below"
  bun run gen -- "..." --upscale --passes=6 --seed=7
  bun run gen -- --file=prompts.txt --q6 --upscale --upscale-model=4x-UltraSharp.pth
`;

if (flags.has("--help") || flags.has("-h") || args.includes("-h")) { console.log(HELP); process.exit(0); }

// ---- prompts: positional args + optional --file (one prompt per line) ----
const prompts = args.filter((a) => !a.startsWith("--") && a !== "-h");
const promptFile = opt("file", "");
if (promptFile) {
  const p = path.isAbsolute(promptFile) ? promptFile : path.join(process.cwd(), promptFile);
  if (!existsSync(p)) { console.error(`✗ prompt file not found: ${p}`); process.exit(1); }
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) prompts.push(t);
  }
}
if (!prompts.length) { console.error(HELP); process.exit(1); }

// ---- config (same tuned defaults as the parent pipeline; everything overridable) ----
const URL_BASE = (process.env.COMFYUI_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const COMFY_DIR = process.env.COMFYUI_DIR || "E:\\ComfyUI";
const UNET_DIR = path.join(COMFY_DIR, "models", "unet");
const UPSCALE_DIR = path.join(COMFY_DIR, "models", "upscale_models");

const snap16 = (n) => Math.max(16, Math.round(n / 16) * 16);
const WIDTH = snap16(Number(opt("width", 1024)));
const HEIGHT = snap16(Number(opt("height", 1280)));
// klein is step-distilled: native 4, useful 4-8, nothing past ~8 but heat. Hard-clamp at 12.
const PASSES_HARD_MAX = 12;
const rawPasses = Number(opt("passes", opt("steps", 8)));
const STEPS = Math.max(1, Math.min(PASSES_HARD_MAX, Number.isFinite(rawPasses) ? Math.round(rawPasses) : 8));
if (Number.isFinite(rawPasses) && STEPS !== rawPasses)
  console.warn(`  ⚠ passes clamped ${rawPasses} → ${STEPS} (klein is step-distilled; >8 rarely helps, hard max ${PASSES_HARD_MAX}).`);
const CFG = Number(opt("cfg", 1.2));
// Text/UI suppression negative — only bites when CFG > 1 (at CFG 1 FLUX ignores the negative).
const NEG_DEFAULT =
  "text, words, letters, numbers, typography, captions, labels, signage, logo, watermark, " +
  "user interface, dashboard, control panel, charts, diagrams, icons, gibberish, fake writing";
const NEG_PROMPT = opt("negative", NEG_DEFAULT);
const SEED_BASE = Number(opt("seed", 42));
const COOLDOWN_MS = opt("cooldown", "") !== "" ? Math.max(0, Number(opt("cooldown", ""))) * 1000 : 25000;
const MODEL = flags.has("--q6") ? "flux-2-klein-4b-Q6_K.gguf" : opt("model", "flux-2-klein-4b-Q5_K_S.gguf");
const CLIP = "split_files/text_encoders/qwen_3_4b.safetensors";
const VAE = "split_files/vae/flux2-vae.safetensors";
const UPSCALE = flags.has("--upscale");
const UPSCALE_MODEL = opt("upscale-model", "RealESRGAN_x4plus.pth");
const UPSCALE_SCALE = Math.max(0.25, Number(opt("upscale-scale", "1")) || 1);
const UP_W = Math.round(WIDTH * UPSCALE_SCALE);
const UP_H = Math.round(HEIGHT * UPSCALE_SCALE);
const UI_FORMAT = flags.has("--ui-format");
const WF_DIR = path.join(ROOT, "workflows");
const WF_FILE = () => (UPSCALE ? "flux2_klein_4b_8gb_with_upscale.json" : "flux2_klein_4b_8gb.json");
const OUT_DIR = opt("outdir", path.join(process.cwd(), "output"));
const OUT_NAME = opt("out", "");
const DRY = flags.has("--dry-run");

// ---- model auto-downloads ----
const KLEIN_REPO = "unsloth/FLUX.2-klein-4B-GGUF";
function ensureGguf(file) {
  if (!existsSync(UNET_DIR)) { console.warn(`  ⚠ unet dir not found at ${UNET_DIR} (set COMFYUI_DIR). Make sure ${file} is installed.`); return; }
  if (existsSync(path.join(UNET_DIR, file))) return;
  console.log(`  ↓ ${file} not found — downloading from ${KLEIN_REPO} via hf…`);
  const r = spawnSync("hf", ["download", KLEIN_REPO, file, "--local-dir", UNET_DIR], { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) console.warn(`  ⚠ download failed. Run:  hf download ${KLEIN_REPO} ${file} --local-dir ${UNET_DIR}`);
}
const UPSCALE_SOURCES = {
  "RealESRGAN_x4plus.pth": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
  "4x-UltraSharp.pth": "https://huggingface.co/lokCX/4x-Ultrasharp/resolve/main/4x-UltraSharp.pth?download=true",
};
async function ensureUpscaleModel(file) {
  const url = UPSCALE_SOURCES[file];
  if (!url || !existsSync(UPSCALE_DIR) || existsSync(path.join(UPSCALE_DIR, file))) return;
  console.log(`  ↓ ${file} not found — downloading (~65 MB)…`);
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    writeFileSync(path.join(UPSCALE_DIR, file), Buffer.from(await r.arrayBuffer()));
    console.log(`  ✓ downloaded (ComfyUI may need a restart to register it).`);
  } catch (e) { console.warn(`  ⚠ download failed (${e.message}). Get it from ${url.split("?")[0]} → ${UPSCALE_DIR}`); }
}

// ---- graph builders (mirrored by workflows/*.json — keep them in sync) ----
function buildGraph(promptText, seed) {
  const g = {
    "4": { class_type: "UnetLoaderGGUF", inputs: { unet_name: MODEL } },
    "5": { class_type: "CLIPLoader", inputs: { clip_name: CLIP.replaceAll("/", "\\"), type: "flux2", device: "cpu" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: VAE.replaceAll("/", "\\") } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: promptText, clip: ["5", 0] } },
    "8": { class_type: "CLIPTextEncode", inputs: { text: NEG_PROMPT, clip: ["5", 0] } },
    "9": { class_type: "Flux2Scheduler", inputs: { steps: STEPS, width: WIDTH, height: HEIGHT } },
    "10": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "11": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "12": { class_type: "CFGGuider", inputs: { model: ["4", 0], positive: ["7", 0], negative: ["8", 0], cfg: CFG } },
    "13": { class_type: "EmptySD3LatentImage", inputs: { width: WIDTH, height: HEIGHT, batch_size: 1 } },
    "14": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["10", 0], guider: ["12", 0], sampler: ["11", 0], sigmas: ["9", 0], latent_image: ["13", 0] } },
    "15": { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["6", 0] } },
    "16": { class_type: "SaveImage", inputs: { filename_prefix: "local-image-gen/img", images: ["15", 0] } },
  };
  if (UPSCALE) {
    g["97"] = { class_type: "UpscaleModelLoader", inputs: { model_name: UPSCALE_MODEL } };
    g["98"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["97", 0], image: ["15", 0] } };
    g["99"] = { class_type: "ImageScale", inputs: { image: ["98", 0], upscale_method: "lanczos", width: UP_W, height: UP_H, crop: "disabled" } };
    g["16"].inputs.images = ["99", 0];
  }
  return g;
}

// --ui-format: execute the workflow FILE. UI→API conversion (widget values map positionally onto
// widget-bearing inputs; a seed's trailing "fixed"/"randomize" control value is skipped; muted
// nodes dropped), then patch prompt + seed (+ upscale model/canvas).
function uiToApi(ui) {
  const linkMap = new Map();
  for (const l of ui.links || []) linkMap.set(l[0], [String(l[1]), l[2]]);
  const api = {};
  for (const n of ui.nodes || []) {
    if (n.mode === 2 || n.mode === 4) continue;
    const inputs = {};
    const wv = n.widgets_values || [];
    let wi = 0;
    for (const inp of n.inputs || []) {
      if (inp.link != null && linkMap.has(inp.link)) inputs[inp.name] = linkMap.get(inp.link);
      else if (inp.widget) {
        inputs[inp.name] = wv[wi++];
        if (/seed/i.test(inp.name) && typeof wv[wi] === "string" && ["fixed", "randomize", "increment", "decrement"].includes(wv[wi])) wi++;
      }
    }
    api[String(n.id)] = { class_type: n.type, inputs };
  }
  return api;
}
let uiGraphCache = null;
function loadUiGraph(promptText, seed) {
  if (!uiGraphCache) {
    const file = path.join(WF_DIR, WF_FILE());
    if (!existsSync(file)) throw new Error(`--ui-format: workflow file not found: ${file}`);
    uiGraphCache = uiToApi(JSON.parse(readFileSync(file, "utf8")));
    console.log(`  (ui-format: executing ${WF_FILE()} — the file's steps/CFG/size win)`);
  }
  const g = structuredClone(uiGraphCache);
  const guider = Object.values(g).find((n) => n.class_type === "CFGGuider");
  const posId = guider?.inputs?.positive?.[0];
  if (posId && g[posId]?.class_type === "CLIPTextEncode") g[posId].inputs.text = promptText;
  else throw new Error("--ui-format: couldn't locate the positive CLIPTextEncode via CFGGuider.positive");
  const noise = Object.values(g).find((n) => n.class_type === "RandomNoise");
  if (noise) noise.inputs.noise_seed = seed;
  if (UPSCALE) {
    const up = Object.values(g).find((n) => n.class_type === "UpscaleModelLoader");
    const scale = Object.values(g).find((n) => n.class_type === "ImageScale");
    if (!up || !scale) throw new Error(`--ui-format --upscale: ${WF_FILE()} has no upscale chain`);
    up.inputs.model_name = UPSCALE_MODEL;
    scale.inputs.width = UP_W;
    scale.inputs.height = UP_H;
  }
  return g;
}

// ---- ComfyUI HTTP driver ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function generate(promptText, seed) {
  const graph = UI_FORMAT ? loadUiGraph(promptText, seed) : buildGraph(promptText, seed);
  const res = await fetch(`${URL_BASE}/prompt`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: crypto.randomUUID() }),
  });
  if (!res.ok) throw new Error(`/prompt ${res.status}: ${await res.text()}`);
  const { prompt_id, node_errors } = await res.json();
  if (node_errors && Object.keys(node_errors).length) throw new Error(`node_errors: ${JSON.stringify(node_errors)}`);
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const h = await fetch(`${URL_BASE}/history/${prompt_id}`).then((r) => r.json());
    const entry = h[prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === "error") throw new Error(`ComfyUI error (see its logs): ${JSON.stringify(entry.status?.messages)}`);
    const out = entry.outputs && Object.values(entry.outputs).find((o) => o.images?.length);
    if (out) return out.images[0];
  }
  throw new Error(`timed out waiting for ${prompt_id}`);
}
async function fetchImage(img) {
  const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output" });
  const r = await fetch(`${URL_BASE}/view?${q}`);
  if (!r.ok) throw new Error(`/view ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function cooldownPause(ms) {
  let remain = Math.round(ms / 1000);
  if (!process.stdout.isTTY) { console.log(`  cooldown ${remain}s…`); await sleep(ms); return; }
  while (remain > 0) {
    process.stdout.write(`\r  cooldown ${String(remain).padStart(2, " ")}s … (let CPU/GPU settle) `);
    await sleep(1000); remain -= 1;
  }
  process.stdout.write(`\r  cooldown done.                       \n`);
}

// ---- main ----
const cfgParts = [
  `model=${MODEL}`, `${WIDTH}x${HEIGHT}`, `${STEPS} steps`, `cfg=${CFG}`,
  ...(UPSCALE ? [`upscale=${UPSCALE_MODEL} → ${UP_W}x${UP_H}`] : []),
  ...(UI_FORMAT ? [`ui-format=${WF_FILE()} (file's settings win)`] : []),
  ...(COOLDOWN_MS ? [`cooldown=${Math.round(COOLDOWN_MS / 1000)}s`] : ["cooldown=off"]),
];
if (DRY) {
  console.log(`DRY RUN @ ${URL_BASE} · ${cfgParts.join(" · ")}`);
  prompts.forEach((p, i) => {
    console.log(`\n[image ${i + 1}] seed=${SEED_BASE + i}\n  ${p}`);
    if (UI_FORMAT) { const g = loadUiGraph(p, SEED_BASE + i); console.log(`  (ui-format dry-check: ${Object.keys(g).length} nodes)`); }
  });
  process.exit(0);
}

ensureGguf(MODEL);
if (UPSCALE) await ensureUpscaleModel(UPSCALE_MODEL);

let stats;
try { stats = await fetch(`${URL_BASE}/system_stats`).then((r) => r.json()); }
catch { console.error(`✗ Can't reach ComfyUI at ${URL_BASE}. Start ComfyUI first (override with COMFYUI_URL).`); process.exit(1); }
console.log(`ComfyUI ${stats?.system?.comfyui_version ?? "?"} @ ${URL_BASE} · ${cfgParts.join(" · ")}`);

mkdirSync(OUT_DIR, { recursive: true });
let ok = 0;
for (let i = 0; i < prompts.length; i++) {
  if (COOLDOWN_MS && i > 0) await cooldownPause(COOLDOWN_MS);
  const seed = SEED_BASE + i;
  const name = OUT_NAME && prompts.length === 1 ? OUT_NAME : `${String(i + 1).padStart(3, "0")}.png`;
  process.stdout.write(`  image ${i + 1}/${prompts.length} (seed ${seed})… `);
  const t0 = Date.now();
  const tick = process.stdout.isTTY
    ? setInterval(() => process.stdout.write(`\r  image ${i + 1}/${prompts.length} (seed ${seed})… ${Math.round((Date.now() - t0) / 1000)}s  `), 1000)
    : null;
  try {
    const img = await generate(prompts[i], seed);
    writeFileSync(path.join(OUT_DIR, name), await fetchImage(img));
    ok++;
    if (tick) clearInterval(tick);
    process.stdout.write(`\r  image ${i + 1}/${prompts.length} (seed ${seed})… ✓ ${name} (${Math.round((Date.now() - t0) / 1000)}s)        \n`);
  } catch (e) {
    if (tick) clearInterval(tick);
    process.stdout.write(`\r  image ${i + 1}/${prompts.length} (seed ${seed})… ✗ ${e.message}\n`);
  }
}
console.log(`\n✓ ${ok}/${prompts.length} image(s) → ${OUT_DIR}`);
