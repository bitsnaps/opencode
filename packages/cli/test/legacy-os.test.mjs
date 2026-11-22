import { expect, test } from "bun:test"
import { usesNodeCliOnLegacyWindows, usesNodeCliOnLinux } from "../script/legacy-os.mjs"

test("selects the Node CLI for Ubuntu 20.04 only on glibc", () => {
  const ubuntu = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="20.04"\n'
  expect(usesNodeCliOnLinux(ubuntu, false)).toBe(true)
  expect(usesNodeCliOnLinux(ubuntu, true)).toBe(false)
  expect(usesNodeCliOnLinux('ID=ubuntu\nVERSION_ID="22.04"\n', false)).toBe(false)
  expect(usesNodeCliOnLinux('ID=debian\nVERSION_ID="20.04"\n', false)).toBe(false)
})

test("selects the Node CLI for Windows 10 builds but not Windows 11", () => {
  expect(usesNodeCliOnLegacyWindows("10.0.10240")).toBe(true)
  expect(usesNodeCliOnLegacyWindows("10.0.19045")).toBe(true)
  expect(usesNodeCliOnLegacyWindows("10.0.21999")).toBe(true)
  expect(usesNodeCliOnLegacyWindows("10.0.22000")).toBe(false)
  expect(usesNodeCliOnLegacyWindows("6.3.9600")).toBe(false)
  expect(usesNodeCliOnLegacyWindows("not-a-version")).toBe(false)
})
