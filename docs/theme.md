# Theme — Visual Design System

> **Vina's design language**: Editorial confidence. Refined, slightly literary, with a sharp electric pulse. This isn't a corporate dashboard — it's a power tool for someone serious about their career. Think _The Economist_ meets a quality terminal app.

This document is the source of truth for visual design tokens. Every component reads from CSS variables — no hardcoded hex, no inline colours, no ad-hoc spacing.

## 1. Aesthetic Direction

- **Editorial, not enterprise.** Generous whitespace. Strong vertical rhythm. Type leads the design
- **Warm neutrals, not cold grays.** Cream and ink, not white and slate
- **One sharp accent.** Electric lime — used sparingly. Marks action, progress, success
- **Amber for caution.** Warmth, not alarm
- **Subtle texture.** Faint grain on backgrounds. Not flat

## 2. Colour Tokens

Tokens live in `packages/web/src/theme/tokens.css`. Components consume them via `var(--token-name)`.

```css
:root {
  /* Surfaces — warm, slightly off-white */
  --color-surface-base: #f7f4ed; /* page background */
  --color-surface-raised: #ffffff; /* cards, panels */
  --color-surface-sunken: #efebe2; /* inputs, code blocks */
  --color-surface-overlay: rgba(20, 18, 14, 0.04);

  /* Ink — text and primary lines */
  --color-ink-primary: #14120e; /* headings, body */
  --color-ink-secondary: #45403a; /* meta, captions */
  --color-ink-muted: #8a857b; /* placeholders, disabled */
  --color-ink-inverse: #f7f4ed; /* on-dark text */

  /* Accent — electric lime, the Vina signature */
  --color-accent: #c8f031;
  --color-accent-hover: #b8e024;
  --color-accent-pressed: #a6ce1c;
  --color-accent-soft: #eaf9a8;
  --color-on-accent: #14120e; /* text on accent */

  /* Semantic */
  --color-success: #5c8a3a;
  --color-success-soft: #e5edd9;
  --color-warning: #c77a2c; /* amber */
  --color-warning-soft: #f4e5d0;
  --color-danger: #b8412c;
  --color-danger-soft: #f2d9d2;
  --color-info: #3a6b8a;
  --color-info-soft: #d8e5ec;

  /* Borders */
  --color-border-subtle: #e5dfd2;
  --color-border-default: #d4ccbc;
  --color-border-strong: #14120e;
}

[data-theme='dark'] {
  --color-surface-base: #0f0e0b;
  --color-surface-raised: #1a1814;
  --color-surface-sunken: #08070a;
  --color-surface-overlay: rgba(247, 244, 237, 0.06);

  --color-ink-primary: #f2eee3;
  --color-ink-secondary: #b8b2a3;
  --color-ink-muted: #6b665c;
  --color-ink-inverse: #14120e;

  --color-accent: #d4f542;
  --color-accent-hover: #c8f031;
  --color-accent-pressed: #b8e024;
  --color-accent-soft: #2a331a;

  --color-success: #8ab35a;
  --color-success-soft: #1f2a18;
  --color-warning: #e09548;
  --color-warning-soft: #2a1f12;
  --color-danger: #d66952;
  --color-danger-soft: #2a1612;
  --color-info: #6b9dbe;
  --color-info-soft: #12222a;

  --color-border-subtle: #2a2722;
  --color-border-default: #3d3830;
  --color-border-strong: #f2eee3;
}
```

### Match-score colour scale

The match score has its own visual scale; it does not reuse the semantic palette wholesale because the gradient between values matters.

| Score  | Token reference   | Effect                                                   |
| ------ | ----------------- | -------------------------------------------------------- |
| 0–49   | `--color-danger`  | Discouraging                                             |
| 50–69  | `--color-warning` | Worth a look                                             |
| 70–84  | `--color-success` | Strong fit                                               |
| 85–100 | `--color-accent`  | Top of the pile (the only score colour using the accent) |

## 3. Typography

Two distinctive type families. **No Inter, no Roboto, no system stack as primary.**

```css
:root {
  /* Display — editorial serif with personality */
  --font-display: 'Fraunces', 'Iowan Old Style', Georgia, serif;

  /* Body — confident, technical sans */
  --font-body: 'Geist', 'IBM Plex Sans', system-ui, sans-serif;

  /* Mono — for terminal output, status badges, code */
  --font-mono: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;

  /* Type scale — major-third (1.25x) */
  --text-2xs: 0.6875rem; /* 11px — labels, tags */
  --text-xs: 0.8125rem; /* 13px — meta, captions */
  --text-sm: 0.9375rem; /* 15px — secondary body */
  --text-base: 1.0625rem; /* 17px — primary body */
  --text-lg: 1.3125rem; /* 21px */
  --text-xl: 1.625rem; /* 26px */
  --text-2xl: 2.0625rem; /* 33px */
  --text-3xl: 2.5625rem; /* 41px — page headings */
  --text-display: 3.5rem; /* 56px — hero */

  /* Weights — Fraunces variable, Geist 400/500/600 */
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semi: 600;
  --weight-display: 480; /* Fraunces, slight optical weight */

  /* Line heights */
  --leading-tight: 1.15; /* display headings */
  --leading-snug: 1.3;
  --leading-normal: 1.55;
  --leading-relaxed: 1.75; /* long-form body */

  /* Tracking */
  --tracking-tight: -0.02em;
  --tracking-normal: 0;
  --tracking-wide: 0.04em; /* small caps, labels */
  --tracking-mono: -0.01em;
}
```

### Typographic rules

- Page titles: Fraunces, `--text-3xl`, `--weight-display`, `--tracking-tight`
- Section headings: Fraunces, `--text-xl`, `--weight-display`
- Body: Geist, `--text-base`, `--leading-normal`
- Meta and captions: Geist, `--text-xs`, `--color-ink-secondary`, `--tracking-wide`, uppercase
- Status badges, job IDs, timestamps: JetBrains Mono, `--text-2xs`

Fonts are loaded via `@fontsource/fraunces`, `@fontsource/geist`, `@fontsource/jetbrains-mono`. We self-host — no Google Fonts at runtime.

## 4. Spacing, Radius, Elevation

```css
:root {
  /* Spacing scale — 4px base */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;
  --space-9: 96px;
  --space-10: 128px;

  /* Radius — restrained, mostly square with one signature curve */
  --radius-none: 0;
  --radius-sm: 2px; /* inputs, badges */
  --radius-md: 4px; /* cards, buttons */
  --radius-lg: 8px; /* modals, panels */
  --radius-pill: 999px; /* tags, status pills */

  /* Elevation — soft, warm shadows, never gray-blue */
  --shadow-xs: 0 1px 2px rgba(20, 18, 14, 0.04);
  --shadow-sm: 0 2px 4px rgba(20, 18, 14, 0.06), 0 1px 2px rgba(20, 18, 14, 0.04);
  --shadow-md: 0 4px 12px rgba(20, 18, 14, 0.08), 0 2px 4px rgba(20, 18, 14, 0.04);
  --shadow-lg: 0 12px 32px rgba(20, 18, 14, 0.12), 0 4px 8px rgba(20, 18, 14, 0.06);
  --shadow-accent: 0 0 0 3px var(--color-accent-soft); /* focus ring */
}
```

## 5. Motion

```css
:root {
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ease-in-out: cubic-bezier(0.6, 0, 0.4, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

  --duration-fast: 120ms;
  --duration-normal: 200ms;
  --duration-slow: 400ms;
}
```

### Motion rules

- Hover transitions: `--duration-fast`, `--ease-out`
- Panel slides, modals: `--duration-normal`, `--ease-out`
- Status changes (job applied, alert resolved): `--duration-slow`, `--ease-spring`
- Reduced motion respected via `@media (prefers-reduced-motion)`

## 6. Component Conventions

- **Buttons**: Primary uses `--color-accent` with `--color-on-accent` text. Secondary is bordered with `--color-border-strong`. Tertiary is text-only with hover underline
- **Cards**: `--color-surface-raised` background, `--color-border-subtle` 1px border, `--shadow-xs`. No drop-shadow stacking
- **Inputs**: `--color-surface-sunken` background, `--color-border-default` border, `--shadow-accent` ring on focus
- **Status pills**: `--radius-pill`, mono font, `--text-2xs`, uppercase, `--tracking-wide`. Colour from semantic tokens
- **Tables (Jobs / Applications)**: No alternating row colours. Use `--color-border-subtle` row dividers. Sticky header with `--color-surface-base` background

## 7. Atmospheric Details

- **Grain texture** on `--color-surface-base`: subtle SVG noise overlay at 3% opacity
- **Page transitions**: 8px upward fade-in, staggered children at 30ms intervals
- **Empty states**: Editorial — a short Fraunces line in `--color-ink-muted`, never a generic illustration
- **Loading**: Single thin progress line at top of viewport in `--color-accent`. No spinners on full page

## 8. Forbidden

- ❌ Inter, Roboto, Arial, system-ui as primary fonts
- ❌ Purple gradients, especially on white
- ❌ Box shadows with blue or gray tints
- ❌ Hardcoded hex values inside components
- ❌ Border-radius above 12px on anything except pills
- ❌ Multiple accent colours competing
- ❌ Generic stock illustrations

## 9. Tailwind Integration

Tailwind is configured to expose every token as a utility:

```ts
// tailwind.config.ts
export default {
  theme: {
    extend: {
      colors: {
        'surface-base': 'var(--color-surface-base)',
        'surface-raised': 'var(--color-surface-raised)',
        'surface-sunken': 'var(--color-surface-sunken)',
        'ink-primary': 'var(--color-ink-primary)',
        'ink-secondary': 'var(--color-ink-secondary)',
        'ink-muted': 'var(--color-ink-muted)',
        accent: 'var(--color-accent)',
        'accent-soft': 'var(--color-accent-soft)',
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        danger: 'var(--color-danger)',
        info: 'var(--color-info)',
      },
      fontFamily: {
        display: 'var(--font-display)',
        body: 'var(--font-body)',
        mono: 'var(--font-mono)',
      },
      // spacing, radius, shadow, etc. mapped likewise
    },
  },
};
```

This way, `bg-surface-base text-ink-primary font-display` reads from variables and respects dark mode automatically via the `[data-theme="dark"]` selector.

## 10. Dark Mode

- Toggle in the topbar (sun/moon icon)
- Persisted in `ui-store` (Zustand) and applied by toggling `data-theme="dark"` on `<html>`
- Fonts and structural tokens (spacing, radius, motion) do not change between modes — only colours
