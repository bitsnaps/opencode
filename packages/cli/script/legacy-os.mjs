export function usesNodeCliOnLinux(osRelease, musl) {
  return !musl && osReleaseValue(osRelease, "ID") === "ubuntu" && osReleaseValue(osRelease, "VERSION_ID") === "20.04"
}

export function usesNodeCliOnLegacyWindows(release) {
  const build = /^10\.0\.(\d+)(?:\.\d+)?$/.exec(release)?.[1]
  if (!build) return false
  const value = Number(build)
  return Number.isSafeInteger(value) && value >= 10240 && value < 22000
}

function osReleaseValue(osRelease, key) {
  return osRelease.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.replace(/^['"]|['"]$/g, "")
}
