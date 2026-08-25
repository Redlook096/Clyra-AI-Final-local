# iOS Design Skill (Apple HIG)

You are designing a native iOS interface. Every screen must follow Apple's
Human Interface Guidelines, not a generic web layout. This skill activates
alongside the SwiftUI coding skill for iPhone/iPad/native/SwiftUI work.

## Typography

- Use system fonts and SF Symbols. Prefer semantic styles: `.largeTitle`,
  `.title2`, `.headline`, `.subheadline`, `.body`, `.footnote`, `.caption`.
- One restrained type scale; headings are not oversized; body is 15–17pt.
- Support Dynamic Type — never pin a fixed font size where content can clip.
- Use `.tracking(-0.02 … -0.03)` sparingly on large titles only.

## Spacing & layout

- Follow an 4/8/12/16/20/24/32 rhythm. Consistent horizontal padding (16–20pt)
  on every screen.
- Respect safe areas. Content scrolls under a translucent nav/tab bar.
- Group related content with grouped lists, separators and spacing — not cards
  everywhere. Prefer `.listStyle(.insetGrouped)` for settings-style content.

## Color & materials

- Use semantic colors: `.primary`, `.secondary`, `.background`,
  `.secondarySystemBackground`, `.systemGroupedBackground`.
- Accent color via `.tint`; never a rainbow of arbitrary hex values.
- Support dark mode automatically (system colors). Never hard-code pure black
  or pure white where semantic colors apply.
- Materials: `.ultraThinMaterial` for floating bars/sheets, `.regularMaterial`
  for overlays.

## Navigation & structure

- Tab bar (or a floating tab bar) for top-level sections; push for drill-down.
- Sheets for short-lived tasks (compose, confirm); full-screen only for
  immersive content.
- Keep a clear back affordance; never leave the user stranded.

## Motion

- Use `.snappy`/`.smooth` animations for transitions and state changes.
- Respect `prefersReducedMotion` — provide non-animated alternatives.
- Animation should communicate hierarchy/continuity, never decorate for its
  own sake.

## Accessibility

- Every control gets a `.accessibilityLabel`, `.accessibilityHint`, and a
  correct trait. Group decorative elements with `.accessibilityElement(children:)`.
- Maintain ≥ 4.5:1 contrast; verify text and icons remain legible in both modes.

## Definition of done

The result looks like a first-party Apple product: native components, SF
Symbols, correct navigation, clean spacing/typography, sensible sheets and
menus, subtle motion, accessibility, and a correct dark-mode appearance.
