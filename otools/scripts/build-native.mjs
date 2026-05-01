import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const adapterDir = path.resolve(__dirname, "..")
const nativeDir = path.join(adapterDir, "native")
const outputDir = path.join(adapterDir, "lib")
const profile = process.argv[2] === "debug" ? "debug" : "release"

const artifact = (() => {
  switch (process.platform) {
    case "darwin":
      return {
        source: "libcodeg_otools_native.dylib",
        target: "macOS.dylib",
      }
    case "win32":
      return {
        source: "codeg_otools_native.dll",
        target: "Windows.dll",
      }
    default:
      return {
        source: "libcodeg_otools_native.so",
        target: "Linux.so",
      }
  }
})()

const cargoArgs = ["build"]
if (profile === "release") {
  cargoArgs.push("--release")
}

const build = spawnSync("cargo", cargoArgs, {
  cwd: nativeDir,
  stdio: "inherit",
})

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

const sourcePath = path.join(nativeDir, "target", profile, artifact.source)
if (!existsSync(sourcePath)) {
  console.error(`Native artifact not found: ${sourcePath}`)
  process.exit(1)
}

mkdirSync(outputDir, { recursive: true })
const targetPath = path.join(outputDir, artifact.target)
copyFileSync(sourcePath, targetPath)

console.log(`Copied native library to ${targetPath}`)
