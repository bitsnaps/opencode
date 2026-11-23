import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { collectNodeAssets, normalizeAssetKey } from "../script/node-assets"
import { nodeTarget, photonWasmAsset } from "../src/node/target"

test("collects each SEA asset key once", async () => {
  const assets = await collectNodeAssets(nodeTarget(process.platform, process.arch))
  const keys = assets.map((asset) => asset.key)

  expect(new Set(keys).size).toBe(keys.length)
  expect(keys.some((key) => key.includes("\\"))).toBe(false)
  expect(keys.filter((key) => key === nodeTarget(process.platform, process.arch).opencodePtyAsset)).toHaveLength(1)
  expect(keys.some((key) => key.startsWith("@opentui/core-"))).toBe(false)
  expect(keys.some((key) => key.startsWith("@ff-labs/fff-bin-") || key.startsWith("@yuuang/ffi-rs-"))).toBe(false)
  expect(assets.filter((asset) => asset.key === photonWasmAsset)).toEqual([
    {
      key: photonWasmAsset,
      source: fileURLToPath(import.meta.resolve(photonWasmAsset)),
    },
  ])
})

test("normalizes Windows separators in SEA asset keys", () => {
  expect(normalizeAssetKey("@lydell/node-pty-win32-x64/lib\\conpty_console_list_agent.js")).toBe(
    "@lydell/node-pty-win32-x64/lib/conpty_console_list_agent.js",
  )
})
