# OTools Runtime Unification Design

**Date:** 2026-04-30

**Status:** Approved for planning

## Goal

Remove project-specific hard-coding from the OTools runtime integration by:

- extracting the reusable Rust-side OTools plugin runtime into a shared crate under `otools-plugin-sdk`
- moving popup command and synthetic event rules out of the SDK source code and into plugin-local `plugin.json`

The design keeps `MenuGit` as a generic native plugin host and keeps each plugin responsible for wiring its own backend.

## Non-Goals

- Moving app-specific backend logic into `MenuGit`
- Introducing a required `otools.config.ts` alongside `plugin.json`
- Designing a general-purpose expression language for runtime event transforms
- Migrating unrelated plugins in the same change

## Current Problems

### Rust runtime reuse

`codeg/src-tauri/src/otools_bridge.rs` currently combines:

- native plugin ABI behavior
- global tokio runtime management
- in-process Axum `Router::oneshot` dispatch
- buffered backend event polling
- `codeg`-specific app state, router, and background-task wiring

This works for `codeg`, but it does not scale. A second app would need to copy and edit a large bridge file even though most of the logic is generic.

### SDK hard-coded behavior

`vendor/otools-plugin-sdk/src/runtime.ts` currently hard-codes:

- popup command names such as `open_commit_window` and `open_settings_window`
- no-op command names such as `set_window_theme`
- synthetic event behavior for specific app commands such as `switch_provider`

That makes the SDK behave like a `codeg` compatibility layer instead of a reusable OTools runtime.

## Design Overview

The solution has two parts:

1. A shared Rust crate under `otools-plugin-sdk` that owns the reusable native runtime mechanics.
2. A `plugin.json` runtime configuration block that tells the TypeScript SDK which commands need popup handling, no-op handling, and static synthetic events.

The key boundary is:

- `MenuGit` remains a generic host that loads a plugin DLL and calls the OTools native ABI.
- the shared Rust crate provides reusable ABI/runtime plumbing for plugin authors
- each plugin still owns its app-specific state, router, and event wiring

## Shared Rust Runtime Crate

### Location

Create a shared crate under the SDK repository, for example:

- `vendor/otools-plugin-sdk/rust/otools-plugin-runtime/`

### Responsibilities

The shared crate is responsible for:

- parsing native ABI input and serializing `{ "ok": true, "data": ... }` or `{ "ok": false, "error": ... }`
- hosting a lazily initialized tokio runtime for blocking native entrypoints
- managing a singleton plugin runtime instance
- dispatching invoke calls into an in-process Axum `Router` through `oneshot`
- storing backend events in a queue and exposing `poll_events`

### Explicitly Out of Scope

The shared crate must not own:

- app-specific `AppState`
- database initialization details
- background task logic
- event source subscriptions that depend on a specific app type
- router definitions for any specific app

### Integration Shape

The crate should use a light abstraction based on app-provided wiring rather than a heavy trait framework.

The plugin-side integration should look conceptually like:

- app constructs its own state
- app builds its own router
- app optionally attaches event forwarding into the shared queue
- app gives those pieces to the shared runtime bootstrap

This means `codeg/src-tauri/src/otools_bridge.rs` remains, but becomes a thin wiring layer rather than a full runtime implementation.

### `codeg` After Refactor

After extraction, `codeg` keeps:

- `src-tauri/src/otools_bridge.rs`
- `otools/native/src/lib.rs`

But those files only:

- build `codeg` state
- build `codeg` router
- register `codeg` backend event forwarding
- delegate ABI/runtime behavior to the shared crate

## `plugin.json` Runtime Configuration

### Configuration Source

The SDK should use `plugin.json` as the primary runtime configuration source.

No new required `otools.config.ts` file is introduced.

### Configuration Block

Add a namespaced runtime block to the plugin manifest:

```json
{
  "runtime": {
    "popupCommands": [
      "open_commit_window",
      "open_merge_window",
      "open_settings_window",
      "open_stash_window",
      "open_push_window",
      "open_project_boot_window"
    ],
    "noopCommands": [
      "set_window_theme",
      "update_tray_menu"
    ],
    "syntheticEvents": [
      {
        "command": "switch_provider",
        "event": "provider-switched",
        "payload": {
          "appType": "$invoke.payload.app",
          "providerId": "$invoke.payload.id",
          "source": "native-plugin",
          "result": "$invoke.result"
        }
      }
    ]
  }
}
```

### Semantics

#### `popupCommands`

- list of native command names
- if a command is listed, the SDK invokes it through `invokeNative`
- if the result contains a string `path`, the SDK opens that path through the popup manager
- if the result has no `path`, the SDK returns the raw result unchanged

#### `noopCommands`

- list of command names that should resolve successfully without native work in OTools runtime
- this replaces the current hard-coded direct Tauri no-op list

#### `syntheticEvents`

- list of declarative event mappings triggered after a successful native invoke
- each rule matches exactly one command name
- each rule emits one client-side event name
- each rule builds a payload from literals plus simple path references

Supported template values:

- literals such as strings, numbers, booleans, `null`, arrays, and objects
- `"$invoke.payload.app"`
- `"$invoke.result.connection.id"`

If a referenced path is missing, the resolved value becomes `null`.

### Deliberate Limits

The first version does not support:

- arbitrary expressions
- conditionals
- function references
- JavaScript execution from manifest data

This keeps the manifest static, reviewable, and safe.

## SDK Runtime Behavior

### Loading Strategy

When running inside OTools runtime, the SDK loads runtime configuration in this order:

1. host-provided plugin metadata if directly available
2. `plugin.json` located from the current plugin asset root
3. empty runtime configuration as fallback

If runtime configuration cannot be loaded, the SDK must not crash. It falls back to generic behavior.

### Generic Baseline Behavior

With no `runtime` block present, the SDK keeps only generic OTools compatibility behavior:

- generic `invokeNative`
- generic native event bridging
- popup manager utilities
- Tauri shim compatibility that does not depend on app-specific command names

It must not retain hard-coded `codeg` command or event knowledge in the shared SDK source.

## Host Boundary

`MenuGit` already exposes generic host-side native plugin loading and an optional host API binding surface.

This design keeps that boundary intact:

- `MenuGit` does not absorb app-specific router or backend responsibilities
- plugins continue to ship their own backend runtime entrypoint
- the shared Rust crate reduces duplicate code on the plugin side without turning the host into an app runtime

This is important because app-specific backend state, database setup, background workers, and router shapes remain plugin-owned concerns.

## Compatibility and Migration

### `codeg`

`codeg/otools/plugin.json` must gain the new `runtime` block during migration so behavior remains equivalent after SDK hard-codes are removed.

### SDK

The SDK should move directly to manifest-driven runtime behavior rather than keeping a long-lived dual system.

Short transition handling is acceptable during the refactor, but the final state must not leave project-specific command lists inside shared runtime source.

### Other Plugins

No immediate migration is required for unrelated plugins.

Plugins without a `runtime` block continue to function with the generic fallback behavior. They only need a manifest runtime block if they rely on popup command handling or synthetic events.

## Testing Strategy

### Shared Rust Crate

Add focused tests for:

- successful ABI request/response handling
- failure ABI request/response handling
- `poll_events` queue draining
- in-process router dispatch through `oneshot`

### TypeScript SDK

Add focused tests for:

- runtime config parsing from manifest data
- popup handling driven by `runtime.popupCommands`
- no-op handling driven by `runtime.noopCommands`
- synthetic event emission driven by `runtime.syntheticEvents`
- fallback behavior when runtime config is absent

### `codeg` Integration

Keep and update `codeg` integration tests so they verify the refactored thin bridge still:

- returns popup paths for window-opening commands
- bridges backend events to `poll_events`
- works without a local HTTP server

### `MenuGit` Host Smoke

Keep the external `MenuGit` ignored smoke that validates:

- nested `otools/` source root binding
- actual DLL loading
- native invoke success
- `poll_events` compatibility

This confirms the refactor does not break host integration.

## Acceptance Criteria

The design is successful when:

- `codeg` no longer owns a large bespoke OTools runtime implementation
- the shared Rust crate holds the generic ABI/runtime logic
- `otools-plugin-sdk` no longer hard-codes `codeg` popup or synthetic event rules
- `codeg/otools/plugin.json` declares the popup and synthetic event behavior it needs
- `MenuGit` host integration continues to pass the existing external smoke coverage
