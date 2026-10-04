# JKFixHub Design System

This document is the source of truth for JKFixHub's visual language. Keep it synchronized with the shipped UI whenever visual decisions change. The implementation currently lives in `css/polish.css`, with semantic content and the interactive demo in `index.html`.

## Product character

JKFixHub should feel like a calm, capable local-services product: trustworthy, warm, modern, and rooted in Jammu & Kashmir without relying on stock scenery or decorative cultural motifs. Use considered typography, useful hierarchy, and precise spacing to create quality. Avoid effects as a substitute for design.

The site is an interactive prototype. Worker profiles are fictional local demo data; ratings and availability are examples, not live marketplace facts. The interface must not imply that workers are verified, requests are sent, locations are tracked, or personal information is saved.

## Color tokens

Tokens are defined in `:root` in `css/polish.css`. Use these variables instead of one-off colors for interface surfaces and states.

| Role | Token | Value |
| --- | --- | --- |
| Main page | `--color-page` | `#f3f2ed` |
| Alternate page surface | `--color-page-soft` | `#ebece5` |
| Primary surface | `--color-surface` | `#fbfaf6` |
| Elevated surface | `--color-surface-raised` | `#fffefa` |
| Muted surface | `--color-surface-muted` | `#e8ebe4` |
| Primary text | `--color-ink` | `#242a26` |
| Secondary text | `--color-ink-soft` | `#38433c` |
| Muted text | `--color-muted` | `#68736b` |
| Strong muted text | `--color-muted-strong` | `#536057` |
| Border | `--color-border` | `#d9ddd5` |
| Emphasized border | `--color-border-strong` | `#b8c3b8` |
| Brand accent | `--color-primary` | `#315e48` |
| Brand hover | `--color-primary-hover` | `#254c39` |
| Soft brand surface | `--color-primary-soft` | `#e1eae1` |
| Secondary accent | `--color-secondary` | `#78876b` |
| Success | `--color-success` | `#477457` |
| Warning | `--color-warning` | `#a76d3d` |
| Error | `--color-error` | `#a54e46` |
| Warm landscape accent | `--color-warm` | `#b48b61` |
| Soft warm surface | `--color-warm-soft` | `#eee5d9` |

Use forest green for primary actions and purposeful emphasis, not as a full-page wash. Warm stone and sage are supporting colors. Reserve warning and error tokens for their semantic states.

## Typography

- Display and section headings: `--font-display` (Iowan Old Style, Palatino, Book Antiqua, Georgia fallback). Use a moderate weight, close but readable tracking, and balanced line lengths.
- Interface and body copy: `--font-sans` (Segoe UI, Helvetica Neue, Arial fallback). Maintain readable contrast and a relaxed line height.
- Numerical or compact technical labels: `--font-mono` where tabular alignment is helpful.
- Use `--text-display`, `--text-2xl`, `--text-xl`, `--text-lg`, `--text-base`, `--text-sm`, and `--text-xs` for the type scale. Responsive headings may use `clamp()` while preserving the same hierarchy.
- Keep long-form copy to a comfortable measure. Labels should be short and legible; avoid excessive uppercase tracking.

## Spacing, shape, and depth

- Use the `--space-*` scale (4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96px) for consistent gaps and section rhythm.
- Use `--radius-xs`, `--radius-sm`, `--radius-md`, `--radius-lg`, and `--radius-xl` for increasing component scale. Reserve pill radii for compact tags and buttons.
- Prefer `--shadow-sm` for cards at rest and `--shadow-md` for elevation or hover. Use `--shadow-lg` sparingly for dialogs.
- Borders should clarify grouping, not outline every nested element. Surfaces should be mostly opaque; glass effects belong only on the sticky navigation or brief overlays.
- Gradients are limited to subtle landscape surfaces and the brand mark. Prefer flat color for buttons and everyday components.

## Components

- **Navigation:** warm, lightly translucent surface; clear links; one primary action; compact accessible mobile menu.
- **Hero:** explicit Jammu & Kashmir prototype context, concise service-discovery message, two clear actions, and the original contour/network illustration. Keep the WebGL scene a quiet background layer.
- **Search:** raised ivory panel, visible labels, standard controls, unobtrusive local-demo loading feedback, and a useful empty state.
- **Service cards:** consistent icon blocks, concise names, deliberate click targets, quiet hover elevation, and selected/filter behavior unchanged.
- **Worker cards:** fictional demo identity is always visible. Show only fields present in local data; never imply actual verification or fabricate jobs, reviews, contact details, or business claims.
- **Profile and maintenance dialogs:** readable neutral surfaces, clear close controls, visible prototype status, and no backend-like success states.
- **Worker onboarding preview:** communicate that data is not saved or submitted.
- **Trust and process sections:** distinguish future product intentions from currently available prototype functionality.
- **Footer:** quiet, low-contrast navigation with the same spacing and control language as the rest of the page.

## Motion and interaction

- Motion should clarify hierarchy, state changes, or focus. It should feel calm, short, and intentional rather than continuously animated.
- Use `--ease-standard` for ordinary transitions and `--ease-emphasis` for restrained entrances or tactile feedback. Prefer durations from `--duration-fast` to `--duration-slow`.
- Scroll reveals should be subtle and play once. Avoid animating large blocks in a way that delays access to their content.
- Hover feedback may use slight elevation, a modest border shift, or a restrained surface change. Do not use glow as a default interaction cue.
- Magnetic pointer movement is optional and only for desktop pointer devices; keep its travel small. Touch users should receive the same functionality without pointer-only effects.
- Keep the Three.js scene: it is ambient, palette-matched, scaled for smaller and lower-power devices, capped near 30 FPS, paused while hidden, and still when reduced motion is requested.
- Honor `prefers-reduced-motion` for CSS and JavaScript. Reduced motion should not hide content or impair an interaction.

## Responsive behavior

- Content width is capped with `--content-width`; gutters tighten progressively on tablet and mobile.
- Desktop uses multi-column hero, search, cards, and trust content where the content remains readable.
- Tablet collapses the hero and search form before text or controls become cramped.
- Mobile uses a compact sticky header, an accessible disclosure menu, one-column search/results/trust layouts, and two-column service cards.
- Preserve comfortable touch targets, prevent horizontal overflow, and keep modal contents scrollable within the viewport.

## Accessibility

- Preserve semantic headings, form labels, button names, modal dialog relationships, and live feedback announcements.
- Ensure visible keyboard focus with `:focus-visible`, good text contrast, and keyboard-operable menus and dialogs.
- Keep decorative scene and illustration elements hidden from assistive technology.
- Never use color alone to convey state.
- Respect reduced-motion preferences, maintain usable layouts at zoomed/mobile widths, and do not disable browser form affordances without a replacement.

## Visual do's and don'ts

**Do**
- Use charcoal text, ivory surfaces, muted slate, forest green, sage, and restrained warm-stone accents.
- Use whitespace, type hierarchy, and alignment to establish polish.
- Keep local identity subtle through contour lines, natural tones, craftsmanship cues, and clear neighborhood-service language.
- Label all fictional content and keep production-only claims explicitly planned.

**Don't**
- Reintroduce the dark-neon sci-fi palette, heavy glows, excessive glass, or many simultaneous floating objects.
- Use generic green fills across every section or decorative landscape imagery that overwhelms product content.
- Invent workers, reviews, verification, availability, statistics, customer outcomes, or operational status.
- Add motion that runs constantly without purpose, or remove Three.js / reduced-motion support without an explicit product decision.
