# Third-Party Licenses

## SwiftUI Design Skill

- Repository: `https://github.com/Wholiver/swiftui-design-skill.git`
- License: MIT (`lib/swiftui-design-skill/LICENSE`)
- Usage: copied as agent-only SwiftUI product/design guidance into iOS project
  workspaces. It is never rendered in Clyra and does not add a runtime
  dependency to generated applications.

## Claude Code Apple Skills

- Repository: `https://github.com/rshankras/claude-code-apple-skills.git`
- Reviewed commit: `9ffb831`
- License: MIT (`lib/claude-code-apple-skills/LICENSE`)
- Usage: iOS project workspaces receive the repository's skills as agent-only
  product, SwiftUI, design, testing, accessibility and release-review context.
  The skills are not shipped into the renderer and no source code is copied
  into generated customer applications automatically.

## OpenCluely source donor

- Repository: `https://github.com/TechyCSR/OpenCluely.git`
- Reviewed commit: `dffdf1a8f7ccefe895fb8de928b177167df11d58`
- License file: Apache License 2.0 (`vendor-src/OpenCluely/LICENSE`)
- Usage: architectural review only so far; no donor source file has been copied into Clyra.

Before copying a donor implementation, retain required notices and record the copied source path and modification details here.
