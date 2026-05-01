import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const adapterDir = path.resolve(__dirname, "..")
const rootDir = path.resolve(adapterDir, "..")
const outputDir = path.join(adapterDir, "dist")
const sourceDir = path.join(rootDir, "out")
const env = {
  ...process.env,
  OTOOLS_PLUGIN: "1",
}

const build = spawnSync("pnpm", ["--dir", rootDir, "build"], {
  stdio: "inherit",
  env,
})

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

if (!existsSync(sourceDir)) {
  console.error(`Static export not found: ${sourceDir}`)
  process.exit(1)
}

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })
cpSync(sourceDir, outputDir, { recursive: true })

console.log(`Copied static export to ${outputDir}`)
