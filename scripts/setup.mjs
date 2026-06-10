#!/usr/bin/env node
// local-image-gen setup — one-shot model install into an existing ComfyUI.
// Downloads everything generate.mjs needs into <COMFYUI_DIR>/models/…, installs the
// ComfyUI-GGUF custom node if missing, and copies the workflows into ComfyUI's library.
// Runs on Node 18+ or Bun. Needs: git, and the Hugging Face CLI (`pip install -U huggingface_hub`
// or `pipx install huggingface_hub` — the `hf` command).
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
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
local-image-gen setup — one-shot model install into an existing ComfyUI

USAGE
  npm run setup -- --comfyui-dir="E:\\ComfyUI" [flags]     (or set COMFYUI_DIR env)

WHAT IT DOES (idempotent — safe to re-run; skips anything already present)
  1. FLUX.2 [klein] 4B GGUF (Q5_K_S, ~3 GB, Apache-2.0)   → models/unet
  2. Qwen3-4B text encoder (~8 GB)                         → models/text_encoders
  3. FLUX.2 VAE                                            → models/vae
  4. RealESRGAN_x4plus.pth upscaler (~64 MB, BSD-3)        → models/upscale_models
  5. ComfyUI-GGUF custom node (city96, required for .gguf) → custom_nodes (git clone)
  6. The two workflows                                     → user/default/workflows

FLAGS
  --comfyui-dir=PATH   where ComfyUI lives (or env COMFYUI_DIR; default E:\\ComfyUI)
  --with-q6            also download the Q6_K GGUF (~3.5 GB, higher quality)
  --with-ultrasharp    also download 4x-UltraSharp.pth (verify its licence for commercial use)
  --skip-models        only do the custom node + workflows steps
  --help, -h           this help

PREREQS  a working ComfyUI install (https://www.comfy.org/download), git, and the hf CLI.
AFTER    start ComfyUI, then:  npm run gen -- "your prompt here"
`;
if (flags.has("--help") || flags.has("-h") || args.includes("-h")) { console.log(HELP); process.exit(0); }

const COMFY = opt("comfyui-dir", process.env.COMFYUI_DIR || "E:\\ComfyUI");
if (!existsSync(COMFY)) {
  console.error(`✗ ComfyUI not found at ${COMFY}.\n  Install it first (https://www.comfy.org/download), then re-run with --comfyui-dir=PATH.`);
  process.exit(1);
}
console.log(`ComfyUI: ${COMFY}\n`);

const sh = (cmd, argv) => spawnSync(cmd, argv, { stdio: "inherit", shell: process.platform === "win32" });
const hfOk = spawnSync("hf", ["--help"], { shell: process.platform === "win32" }).status === 0;

function hfDownload(repo, file, destSub) {
  const dest = path.join(COMFY, "models", destSub);
  mkdirSync(dest, { recursive: true });
  // hf preserves the repo's subpath (e.g. split_files/...), which is exactly how ComfyUI scans it.
  const already = file.includes("/") ? path.join(dest, ...file.split("/")) : path.join(dest, file);
  if (existsSync(already)) { console.log(`  ✓ ${file} already present`); return; }
  if (!hfOk) { console.warn(`  ⚠ hf CLI not found — install with: pip install -U huggingface_hub\n    then run: hf download ${repo} ${file} --local-dir ${dest}`); return; }
  console.log(`  ↓ ${repo} :: ${file}`);
  const r = sh("hf", ["download", repo, file, "--local-dir", dest]);
  if (r.status !== 0) console.warn(`  ⚠ failed — run manually: hf download ${repo} ${file} --local-dir ${dest}`);
}

async function directDownload(url, destSub, file) {
  const dest = path.join(COMFY, "models", destSub);
  mkdirSync(dest, { recursive: true });
  const target = path.join(dest, file);
  if (existsSync(target)) { console.log(`  ✓ ${file} already present`); return; }
  console.log(`  ↓ ${file} (~65 MB)`);
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    writeFileSync(target, Buffer.from(await r.arrayBuffer()));
    console.log(`  ✓ ${file}`);
  } catch (e) { console.warn(`  ⚠ failed (${e.message}) — download ${url.split("?")[0]} into ${dest}`); }
}

if (!flags.has("--skip-models")) {
  console.log("— Diffusion model (GGUF) —");
  hfDownload("unsloth/FLUX.2-klein-4B-GGUF", "flux-2-klein-4b-Q5_K_S.gguf", "unet");
  if (flags.has("--with-q6")) hfDownload("unsloth/FLUX.2-klein-4B-GGUF", "flux-2-klein-4b-Q6_K.gguf", "unet");

  console.log("\n— Text encoder + VAE —");
  hfDownload("Comfy-Org/flux2-klein", "split_files/text_encoders/qwen_3_4b.safetensors", "text_encoders");
  hfDownload("Comfy-Org/flux2-dev", "split_files/vae/flux2-vae.safetensors", "vae");

  console.log("\n— Upscale model(s) —");
  await directDownload("https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth", "upscale_models", "RealESRGAN_x4plus.pth");
  if (flags.has("--with-ultrasharp"))
    await directDownload("https://huggingface.co/lokCX/4x-Ultrasharp/resolve/main/4x-UltraSharp.pth?download=true", "upscale_models", "4x-UltraSharp.pth");
}

console.log("\n— ComfyUI-GGUF custom node (loads .gguf checkpoints) —");
const nodeDir = path.join(COMFY, "custom_nodes", "ComfyUI-GGUF");
if (existsSync(nodeDir)) console.log("  ✓ already installed");
else {
  const r = sh("git", ["clone", "https://github.com/city96/ComfyUI-GGUF", nodeDir]);
  if (r.status !== 0) console.warn("  ⚠ git clone failed — install ComfyUI-GGUF via ComfyUI-Manager instead.");
  else console.log("  ✓ cloned (restart ComfyUI to load it; it may need `pip install gguf` in ComfyUI's venv)");
}

console.log("\n— Workflows → ComfyUI library —");
const wfSrc = path.join(ROOT, "workflows");
const wfDest = path.join(COMFY, "user", "default", "workflows");
if (existsSync(wfDest)) {
  for (const f of readdirSync(wfSrc).filter((f) => f.endsWith(".json"))) {
    copyFileSync(path.join(wfSrc, f), path.join(wfDest, f));
    console.log(`  ✓ ${f}`);
  }
} else console.warn(`  ⚠ ${wfDest} not found — open the files in ./workflows/ via the ComfyUI UI instead.`);

console.log(`\n✓ Setup done. Start ComfyUI, then:\n    npm run gen -- "A single hard rim light rakes across a brass key dissolving into fine particles in the dark, premium editorial key art"\n  (set COMFYUI_DIR=${COMFY} in your shell profile so generate.mjs finds the model dirs)`);
