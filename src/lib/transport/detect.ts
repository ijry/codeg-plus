import { isOtoolsPluginRuntime } from "otools-plugin-sdk"

export type TransportEnvironment = "tauri" | "web"

export function detectEnvironment(): TransportEnvironment {
  if (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || isOtoolsPluginRuntime())
  ) {
    return "tauri"
  }
  return "web"
}
