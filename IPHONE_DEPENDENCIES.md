# Clyra iPhone system — external dependencies

Every dependency the real Apple Simulator pipeline uses, what it's for, and
its exact tested version on this development host. None of these are
tracked against `main` in production use — `resolveBin()` in
[lib/iphone/host.ts](lib/iphone/host.ts) resolves a specific installed
binary, and if that binary is absent the corresponding provider capability
reports `false` rather than silently falling back to an untested version.

| Repository | Purpose in Clyra | License | Tested version | Install method used here | Platforms | Fallback if absent |
|---|---|---|---|---|---|---|
| [XcodesOrg/xcodes](https://github.com/XcodesOrg/xcodes) | Discovers and installs Xcode versions; feeds [xcodeCompatibility.ts](lib/iphone/xcodeCompatibility.ts)'s live version catalog | MIT | `2.0.3` | Precompiled `xcodes.zip` release asset (Homebrew's own bottle requires a working Xcode to build from source — circular on a CLT-only host) | macOS only (Apple Host) | Setup wizard shows only the manual App Store path; version list/recommendation unavailable |
| [lycorp-jp/sim-use](https://github.com/lycorp-jp/sim-use) | Primary semantic control layer: `ui`, `tap`, `long-press`, `swipe`, `type`, `button`, `screenshot`, `stream-video`, `app-state` | Apache-2.0 | `0.13.0` | Homebrew bottle, via a user-owned no-sudo Homebrew checkout at `~/.homebrew` (the official installer refuses without admin rights) | macOS only (Apple Host); universal binary, no architecture restriction | [SimctlProvider](lib/iphone/SimctlProvider.ts) reports `getAccessibilityTree()` unavailable (no fabricated tree); tap/swipe/type fall back to `serve-sim`'s CLI where that's available |
| [EvanBacon/serve-sim](https://github.com/EvanBacon/serve-sim) | Optional fast streaming/HID path via a native N-API addon | Apache-2.0 | `0.1.46` | `npx serve-sim` (no persistent install) | **Apple Silicon (arm64) only** — its native addon (`serve-sim-native.node`) is not built for x86_64 and throws on `require()`; [host.ts](lib/iphone/host.ts)'s `supportsFastStream()` gates every call to it | Intel/other hosts use [simUseStream.ts](lib/iphone/simUseStream.ts)'s MJPEG relay instead — never attempted on non-arm64 |
| [facebook/idb](https://github.com/facebook/idb) | Alternate low-level automation layer (`idb_companion` + client) | MIT | not installed | N/A — `brew info facebook/fb/idb-companion` confirms it requires Xcode ≥ 26, same blocker as everything else | macOS only (Apple Host, companion); client is cross-platform | [IdbProvider.ts](lib/iphone/IdbProvider.ts) is real, complete adapter code; `IdbProvider.isInstalled()` reports `false` and it is never selected until the binary exists |
| [himanshkukreja/ios-bridge](https://github.com/himanshkukreja/ios-bridge) | Reference architecture only (Mac server / remote client / session management) | not adopted as a runtime dependency | — | Not installed — its actual server/streaming code was not integrated; Clyra's own [remote/](lib/iphone/remote/) implements the same Mac-server / remote-client shape independently (tested end-to-end: pairing, token reconnect, RPC dispatch) | — | — |

## Why no dependency is pinned to a commit hash

`xcodes` and `serve-sim` are consumed as released binaries/npm packages
(version numbers above), not as source checkouts — there's no `main` branch
being tracked in either case. `sim-use` is consumed as a Homebrew formula
version. None of the three genuinely-adopted dependencies are used as
unpinned git checkouts.

## The one blocker every single one of these shares

All five require **full Xcode** to do anything beyond what's listed above —
`sim-use`, `idb`, and the actual Apple Simulator itself all ultimately call
through `xcrun simctl`, which does not exist without it. This is not a
per-dependency problem to work around; it's the one thing every real Apple
Simulator toolchain requires, with no exception. Installing it needs Apple
ID sign-in, which this session cannot perform — see the setup wizard
([IPhoneSetupWizard.tsx](src/components/clyra-code/IPhoneSetupWizard.tsx))
for the exact remaining human step on this specific host.
