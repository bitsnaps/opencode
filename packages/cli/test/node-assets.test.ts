import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { collectNodeAssets } from "../script/node-assets"
import { nodeTarget, photonWasmAsset } from "../src/node/target"

test("collects each SEA asset key once", async () => {
  const assets = await collectNodeAssets(nodeTarget(process.platform, process.arch))
  const keys = assets.map((asset) => asset.key)

  expect(new Set(keys).size).toBe(keys.length)
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
