import { expect, test } from "bun:test"
import { tuiUnavailable } from "../src/node/compat"

test("the Node CLI explains its unsupported interactive TUI", () => {
  expect(tuiUnavailable()).toContain("headless Node CLI")
})
