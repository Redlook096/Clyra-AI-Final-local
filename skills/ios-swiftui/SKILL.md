# iOS SwiftUI Coding Skill

You are building a **native iOS app in Swift + SwiftUI** — never HTML/CSS that
pretends to be iOS. This skill activates for any request to build or edit an
iPhone/iPad/native/SwiftUI app.

## Non-negotiables

- Produce real `.swift` files with `import SwiftUI`. No web fallbacks.
- Use a portable Swift Package (`Package.swift`) so the source compiles and
  previews without requiring Xcode on the host.
- Keep the workspace layout: `App/ Views/ Components/ Models/ ViewModels/
  Services/ Utilities/ Resources/ Tests/`. Never cram everything into one file.
- Use Swift concurrency (`async`/`await`, `@MainActor`, `ObservableObject` or
  `@Observable`) instead of blocking work.
- Honor `prefersReducedMotion` and Dynamic Type; every interactive element gets
  a meaningful accessibility label and a ≥44pt touch target.

## Architecture

- Views are small, focused and reusable; a view renders state, it never owns
  business logic.
- Prefer `@State` for local UI, `@StateObject`/`@EnvironmentObject` (or the
  `@Observable` macro with `@Environment`) for shared app state.
- Model real data with `Identifiable` structs. Use `AppStorage`/`UserDefaults`
  for lightweight persistence.
- Navigation: `NavigationStack` with `NavigationLink(value:)` + `.navigationDestination`,
  or `TabView` for top-level sections. Never chain modal sheets for core flows.
- Use `sheet`, `confirmationDialog`, `alert`, `Menu`, and `popover` where each
  is semantically correct.

## SwiftUI idiom checklist

- Layout: `VStack`/`HStack`/`ZStack`, `.frame(maxWidth: .infinity, alignment:)`,
  `.safeAreaInset`, `.ignoresSafeArea`, `LazyVStack`/`LazyVGrid` for lists.
- Styling: `.font`, `.foregroundStyle`, `.tint`, `.background(in:)`, `.clipShape`,
  `.padding`, `.contentShape(Rectangle())`.
- Animation: prefer implicit `withAnimation(.snappy)` and `animation(_, value:)`.
  Avoid animating layout in ways that jitter; animate opacity/transform where
  possible.
- Performance: avoid heavy work in `body`; use `Lazy` containers; `Equatable`
  views when diffing is expensive.

## Definition of done

1. Every visible action navigates, edits, filters, persists, or shows an
   explicit disabled state with a reason — no decorative buttons.
2. The app is stateful: mutations visibly update the screen and survive refresh.
3. Sample data is believable and product-specific, never a generic "Item 1".
4. The result runs through the iPhone Preview; interactions are exercised and
   verified before you report completion.
