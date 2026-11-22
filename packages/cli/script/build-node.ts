#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "vite"
import { Script } from "@opencode/script"
import { embed } from "@opencode/script/highlights"
import pkg from "../package.json"
import { collectNodeAssets, copyNodeAssets, hashNodeAssets, seaAssetMap } from "./node-assets"
import { appArchiveAsset, mainConfig } from "../vite.node.config"
import { nodeExecArgv, nodeTarget, type NodeTarget } from "../src/node/target"
import { buildAppArchive } from "./app-assets"
import { verifyArtifact } from "./verify-artifact"
import { NativeArch } from "../../../script/native-arch"
import { bundledModelsSnapshot } from "../../core/script/models-snapshot"

const NODE_VERSION = "22.18.0"
const dir = path.resolve(import.meta.dirname, "..")
const outdir = path.resolve(
  dir,
  process.argv.find((arg) => arg.startsWith("--outdir="))?.slice("--outdir=".length) ?? "dist/node",
)
if (outdir === dir) throw new Error("--outdir must not be the package directory")
if (outdir === path.join(dir, "dist-node")) {
  throw new Error("--outdir must not be dist-node because it contains temporary files")
}
const bundleOnly = process.argv.includes("--bundle-only")
const single = process.argv.includes("--single")
const skipInstall = process.argv.includes("--skip-install")
const appArchiveOnly = process.argv.includes("--app-archive-only")
const highlights = Script.preview ? undefined : embed(process.env.OPENCODE_RELEASE_NOTES)
const requestedArchive = process.env.OPENCODE_APP_ARCHIVE
const archivePath = requestedArchive ? path.resolve(dir, requestedArchive) : undefined
const requested = process.env.OPENCODE_TARGET
const allTargets = [
  nodeTarget("linux", "arm64"),
  nodeTarget("linux", "x64"),
  nodeTarget("darwin", "arm64"),
  nodeTarget("darwin", "x64"),
  nodeTarget("win32", "arm64"),
  nodeTarget("win32", "x64"),
]
const targets = requested
  ? allTargets.filter((target) => targetName(target) === requested)
  : single || bundleOnly
    ? [nodeTarget(process.platform, process.arch)]
    : allTargets

process.chdir(dir)
if (!skipInstall) run(process.execPath, ["install", "--os=*", "--cpu=*"])
if (appArchiveOnly) {
  if (!archivePath) throw new Error("--app-archive-only requires OPENCODE_APP_ARCHIVE")
  await mkdir(path.dirname(archivePath), { recursive: true })
  await writeFile(archivePath, await buildAppArchive(Script.channel, Script.version))
  process.exit(0)
}
if (targets.length === 0) throw new Error(`Unknown Node target: ${requested}`)
const modelsSnapshot = await bundledModelsSnapshot()
const appArchive = archivePath ? await Bun.file(archivePath).bytes() : await buildAppArchive(Script.channel, Script.version)
if (!bundleOnly) await rm(outdir, { recursive: true, force: true })
const builder =
  !bundleOnly || targets.some((target) => target.platform === process.platform && target.arch === process.arch)
    ? await resolveHostNode()
    : undefined

// Vite silently rewrites text imports of known asset types (.txt) to asset
// URL strings when the raw-text plugin doesn't intercept them first — the
// bundle still builds and `--help` still runs, so only content assertions
// catch it. Guards the models.dev snapshot and the prompt/tool description
// text that ships inside the bundle.
async function assertTextImportsInlined(bundlePath: string) {
  const bundle = await readFile(bundlePath, "utf8")
  const markers = [
    { marker: '"zhipuai"', source: "models-dev snapshot" },
    { marker: "/assets/snapshot", source: "models-dev snapshot inlined as asset URL", forbidden: true },
    { marker: '="/assets/', source: "text import inlined as asset URL", forbidden: true },
  ]
  for (const { marker, source, forbidden } of markers) {
    const present = bundle.includes(marker)
    if (forbidden ? present : !present)
      throw new Error(`${bundlePath}: ${source} — text imports are not inlined as content (marker ${marker})`)
  }
}

for (const target of targets) {
  console.log(`building cli-node-${targetName(target)}`)
  const assets = await collectNodeAssets(target)
  await rm("dist-node", { recursive: true, force: true })
  const assetHash = await hashNodeAssets(assets)
  const input = {
    version: Script.version,
    channel: Script.channel,
    highlights,
    modelsSnapshot,
    assetHash,
    assetKeys: assets.map((asset) => asset.key),
    target,
  }
  await copyNodeAssets(assets)
  await writeFile(path.join("dist-node", "assets", appArchiveAsset), appArchive)
  await build(mainConfig(input))
  await assertTextImportsInlined("dist-node/opencode.mjs")
  if (bundleOnly) await verifyArtifact("dist-node/opencode.mjs")

  const host = target.platform === process.platform && target.arch === process.arch
  if (host) {
    if (!builder) throw new Error("Node SEA builder is unavailable")
    run(builder, [...nodeExecArgv, "dist-node/opencode.mjs", "--version"])
    run(builder, [...nodeExecArgv, "dist-node/opencode.mjs", "--help"])
  }
  if (bundleOnly) continue

  const name = `cli-node-${targetName(target)}`
  const binary = target.platform === "win32" ? "opencode2-node.exe" : "opencode2-node"
  const output = path.join(outdir, name, "bin", binary)
  if (!builder) throw new Error("Node SEA builder is unavailable")
  await mkdir(path.dirname(output), { recursive: true })
  await copyFile("dist-node/opencode.mjs", "dist-node/assets/opencode.mjs")
  await writeFile("dist-node/main.cjs", seaBootstrap(target))
  const config = {
    main: "dist-node/main.cjs",
    output: "dist-node/sea-prep.blob",
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: await seaAssetMap(),
  }
  await writeFile("dist-node/sea.json", `${JSON.stringify(config, null, 2)}\n`)
  run(builder, ["--experimental-sea-config", "dist-node/sea.json"])
  await copyFile(await resolveTargetNode(target, builder), output)
  if (target.platform === "darwin") run("codesign", ["--remove-signature", output])
  run(builder, [
    fileURLToPath(import.meta.resolve("postject/dist/cli.js")),
    output,
    "NODE_SEA_BLOB",
    "dist-node/sea-prep.blob",
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(target.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  ])
  if (target.platform !== "win32") await chmod(output, 0o755)
  await NativeArch.verify(output, target.arch)
  if (target.platform === "darwin" && process.platform === "darwin") run("codesign", ["--sign", "-", output])
  if (target.platform === "darwin" && process.platform !== "darwin") {
    console.warn(`${output} must be signed on macOS before it can run`)
  }
  await writeFile(
    path.join(outdir, name, "package.json"),
    `${JSON.stringify(
      {
        name: `@opencode/${name}`,
        version: Script.version,
        license: pkg.license,
        repository: { type: "git", url: "git+https://github.com/anomalyco/opencode.git" },
        os: [target.platform],
        cpu: [target.arch],
      },
      null,
      2,
    )}\n`,
  )
  await verifyArtifact(path.join(outdir, name))
  if (host) await smoke(output)
}

async function resolveHostNode() {
  const candidates = [process.env.NODE_BIN, "node"].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    const result = spawnSync(
      candidate,
      ["-p", "JSON.stringify({version:process.versions.node,path:process.execPath})"],
      {
        encoding: "utf8",
      },
    )
    if (result.status !== 0) continue
    const info = JSON.parse(result.stdout) as { version: string; path: string }
    if (info.version === NODE_VERSION) return realpath(info.path)
  }
  return resolveTargetNode(nodeTarget(process.platform, process.arch))
}

async function resolveTargetNode(target: NodeTarget, host?: string) {
  if (host && target.platform === process.platform && target.arch === process.arch) return host
  const cache = path.resolve(dir, ".cache", "node")
  const platform = target.platform === "win32" ? "win" : target.platform
  const archiveName = `node-v${NODE_VERSION}-${platform}-${target.arch}`
  const targetDirectory = path.join(cache, archiveName)
  const executable = path.join(targetDirectory, target.platform === "win32" ? "node.exe" : "bin/node")
  if (
    (await stat(executable).then(
      () => true,
      () => false,
    )) &&
    (await stat(path.join(targetDirectory, ".verified")).then(
      () => true,
      () => false,
    ))
  )
    return realpath(executable)
  await mkdir(cache, { recursive: true })
  const extension = target.platform === "win32" ? "zip" : "tar.gz"
  const filename = `${archiveName}.${extension}`
  const archive = path.join(cache, filename)
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`
  const [response, sums] = await Promise.all([fetch(`${base}/${filename}`), fetch(`${base}/SHASUMS256.txt`)])
  if (!response.ok) throw new Error(`Failed to download Node ${NODE_VERSION}: ${response.status}`)
  if (!sums.ok) throw new Error(`Failed to download Node ${NODE_VERSION} checksums: ${sums.status}`)
  const data = new Uint8Array(await response.arrayBuffer())
  const expected = (await sums.text())
    .split("\n")
    .find((line) => line.endsWith(`  ${filename}`))
    ?.split(/\s+/)[0]
  if (!expected) throw new Error(`Missing checksum for ${filename}`)
  if (createHash("sha256").update(data).digest("hex") !== expected) throw new Error(`Checksum mismatch for ${filename}`)
  await writeFile(archive, data)
  const temporary = path.join(cache, `${archiveName}.${process.pid}.tmp`)
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary)
  if (target.platform !== "win32") run("tar", ["-xzf", archive, "-C", temporary])
  if (target.platform === "win32" && process.platform === "win32") {
    run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "-C", temporary])
  }
  if (target.platform === "win32" && process.platform !== "win32") run("unzip", ["-q", archive, "-d", temporary])
  await rm(targetDirectory, { recursive: true, force: true })
  await rename(path.join(temporary, archiveName), targetDirectory)
  await writeFile(path.join(targetDirectory, ".verified"), `${expected}\n`)
  await rm(temporary, { recursive: true, force: true })
  await rm(archive, { force: true })
  return realpath(executable)
}

async function smoke(output: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-node-smoke-"))
  const executable = path.join(root, path.basename(output))
  await copyFile(output, executable)
  if (process.platform !== "win32") await chmod(executable, 0o755)
  run(executable, ["--version"], root)
  run(executable, ["--help"], root)
  await rm(root, { recursive: true, force: true })
}

function targetName(target: NodeTarget) {
  return `${target.platform === "win32" ? "windows" : target.platform}-${target.arch}`
}

function seaBootstrap(target: NodeTarget) {
  return `const { createHash, randomUUID } = require("node:crypto")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { getAsset, isSea } = require("node:sea")
const { pathToFileURL } = require("node:url")

if (!process.env.OPENCODE_NODE_SYSTEM_CA_REEXEC) {
  const env = {
    ...process.env,
    OPENCODE_NODE_SYSTEM_CA_REEXEC: "1",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--use-system-ca"].filter(Boolean).join(" "),
  }
  const result = spawnSync(process.execPath, process.argv.slice(2), { env, stdio: "inherit" })
  if (result.error) throw result.error
  process.exitCode = result.status ?? (result.signal ? 128 + os.constants.signals[result.signal] : 1)
} else {
  start()
}

function start() {
  if (!isSea()) {
    import(pathToFileURL(path.join(__dirname, "opencode.mjs")).href)
    return
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  const root = path.join(os.tmpdir(), \`opencode-node-\${uid ?? "user"}\`)
  try {
    fs.mkdirSync(root, { mode: 0o700 })
  } catch (error) {
    if (!fs.existsSync(root)) throw error
  }
  const rootInfo = fs.lstatSync(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Unsafe Node asset cache path")
  if (uid !== undefined && rootInfo.uid !== uid) throw new Error("Node asset cache is owned by another user")
  if (uid !== undefined) fs.chmodSync(root, 0o700)

  const app = Buffer.from(getAsset("opencode.mjs"))
  const hash = createHash("sha256").update(app).digest("hex").slice(0, 16)
  const assets = path.join(root, \`\${hash}-${target.platform}-${target.arch}\`)
  try {
    fs.mkdirSync(assets, { mode: 0o700 })
  } catch (error) {
    if (!fs.existsSync(assets)) throw error
  }
  const assetsInfo = fs.lstatSync(assets)
  if (!assetsInfo.isDirectory() || assetsInfo.isSymbolicLink()) throw new Error("Unsafe Node asset directory")
  if (uid !== undefined && assetsInfo.uid !== uid) throw new Error("Node asset directory is owned by another user")

  const entry = path.join(assets, "opencode.mjs")
  if (fs.existsSync(entry)) {
    const entryInfo = fs.lstatSync(entry)
    if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) throw new Error("Unsafe Node application bundle")
    if (createHash("sha256").update(fs.readFileSync(entry)).digest("hex").slice(0, 16) !== hash)
      fs.unlinkSync(entry)
  }
  if (!fs.existsSync(entry)) {
    const temporary = \`\${entry}.\${process.pid}.\${randomUUID()}.tmp\`
    fs.writeFileSync(temporary, app, { mode: 0o600, flag: "wx" })
    try {
      fs.renameSync(temporary, entry)
    } catch (error) {
      fs.rmSync(temporary, { force: true })
      if (!fs.existsSync(entry)) throw error
    }
  }

  process.env.OPENCODE_NODE_ASSETS_DIR = assets
  import(pathToFileURL(entry).href)
}
`
}

function run(command: string, args: readonly string[], cwd = dir) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`)
}
