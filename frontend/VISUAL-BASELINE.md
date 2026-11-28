# FireWatch frontend visual baseline

Use this document to audit the real frontend before changing styles. The committed prototype in `docs/pitch-g1-design` (`d651459`) is a reference for layout and hierarchy, not a reason to port fixtures or replace working product behavior.

Source: [tokens](src/styles/tokens.css), [workspace styles](src/styles/app.css), [product navigation](src/styles/product-nav.css), [sign-in styles](src/styles/auth.css), the [aerial workspace styles](src/styles/aerial-workspace.css), the [territorial coverage styles](src/styles/territorial-coverage.css) and the [decision workspace styles](src/styles/decision-workspace.css) at the local baseline `742e760`, plus the T1–T8 screen ports, and the T10–T14 design migration of 2026-11-27 (global aerial night palette, sidebar-free shell, compact entrance, interactive 3D aerial stage, dark-adapted workspaces). The inventory adapts the active-source sections of `design/system.md` from the prototype branch.

**The aerial night palette is global (T10, S8).** `tokens.css` declares the slate/ocean surfaces, the high-contrast ink and the aqua accent once in `:root`, with `color-scheme: dark`, and every stylesheet reads them. The former cream/forest defaults (`--canvas #f5f5ef`, `--paper #fffefa`, `--ink #233b39`) are retired, not aliased; the names `--forest-950/900/700/500` survive only as legacy aliases mapped to the dark tones. A `@media print` block re-points the same roles to black-on-white, so the two views that print keep their paper surfaces.

## Palette

Every row is one declared custom property. Value is copied from `tokens.css`; the last column names where it is actually used in the active styles.

| Token | Value | Source | In use |
| --- | --- | --- | --- |
| `--canvas` | `#0f1922` | [`tokens.css`](src/styles/tokens.css) | `body` page ground, `AuthView` page ground (the measured `rgb(15, 25, 34)`), print re-points it to `#ffffff`. |
| `--aerial-water` | `#152934` | [`tokens.css`](src/styles/tokens.css) | `#overview` console ground, the 3D stage floor, the sign-in hero, and `theme-color` in `index.html`. |
| `--paper` | `#17222b` | [`tokens.css`](src/styles/tokens.css) | Product bar, shell header, panels, cards, inputs, toast. |
| `--soft` | `#21313f` | [`tokens.css`](src/styles/tokens.css) | Base chip, selected table row, health and session cards, auth tab track. |
| `--surface-raised` | `#243341` | [`tokens.css`](src/styles/tokens.css) | Out-of-flow product-nav panel, aerial rail, map insets, pressed HUD controls. |
| `--ink` | `#f4f1eb` | [`tokens.css`](src/styles/tokens.css) | Body text, table values, data-list values, headings. |
| `--muted` | `#b8c8d2` | [`tokens.css`](src/styles/tokens.css) | Notes, captions, labels, secondary metadata. |
| `--line` | `#354b5c` | [`tokens.css`](src/styles/tokens.css) | Panel, card, topbar, footer and table borders; row dividers. |
| `--line-soft` | `#2a3a47` | [`tokens.css`](src/styles/tokens.css) | Quieter container separators inside a card. |
| `--edge` | `#647b8a` | [`tokens.css`](src/styles/tokens.css) | Control boundaries on `--canvas`, `--aerial-water` and `--paper`. |
| `--edge-strong` | `#6b8395` | [`tokens.css`](src/styles/tokens.css) | The same boundary where it is painted on `--surface-raised`, where `--edge` measures 2.92:1. |
| `--accent` | `#94dfda` | [`tokens.css`](src/styles/tokens.css) | Links, eyebrows, selected navigation, brand-mark fill, focus ring, map labels. |
| `--accent-ink` | `#0c1b24` | [`tokens.css`](src/styles/tokens.css) | The ink a **filled** accent control is labelled with; the light ink never goes on the accent. |
| `--focus` | `#94dfda` | [`tokens.css`](src/styles/tokens.css) | The single focus indicator, `3px` with offset `2px`, on every surface. |
| `--forest-950` | `#f4f1eb` | [`tokens.css`](src/styles/tokens.css) | Legacy alias — the old "darkest green", now the light ink for text on a dark surface. |
| `--forest-900` | `#17222b` | [`tokens.css`](src/styles/tokens.css) | Legacy alias — the retired column/button surface, now `--paper`. |
| `--forest-700` | `#94dfda` | [`tokens.css`](src/styles/tokens.css) | Legacy alias — the readable accent those sheets paint as text and links, now `--accent`. |
| `--forest-500` | `#b8c8d2` | [`tokens.css`](src/styles/tokens.css) | Legacy alias — secondary text and glyphs, now `--muted`. |
| `--terracotta` | `#f0a184` | [`tokens.css`](src/styles/tokens.css) | Attention metric value, auth link and error text, the attention card. |
| `--terracotta-soft` | `#3b2a24` | [`tokens.css`](src/styles/tokens.css) | Error and high-risk chip surfaces. |
| `--gold` | `#e5c87e` | [`tokens.css`](src/styles/tokens.css) | Auth step number, session mark, administrative note text. |
| `--gold-soft` | `#33301f` | [`tokens.css`](src/styles/tokens.css) | Medium/pending/queued/stale chip, admin tag and warning-banner surface. |
| `--danger` | `#f4b6a6` | [`tokens.css`](src/styles/tokens.css) | The semantic refusal tone; a word, never the only signal. |
| `--success` | `#8ee0b4` | [`tokens.css`](src/styles/tokens.css) | The semantic ready tone. |
| `--info-surface` / `--info-text` | `#1c333c` / `#a9dbe8` | [`tokens.css`](src/styles/tokens.css) | Informational note surface and its ink. |

## Level palette

The level palette is part of the tokens because map fills, legend swatches and chips must not drift apart. Each severity is a **family** of five roles: `fill` is the map shape and the legend swatch, `line` its outline, `ink` the text painted on that fill, and `surface`/`text` the chip, badge or status-row pair. T10 dark-adapted the families as a family rather than per view, so a chip cannot outlive the map it explains.

| Token | Value | Source | In use |
| --- | --- | --- | --- |
| `--level-low-fill` / `-line` / `-ink` / `-surface` / `-text` | `#72b1a1` / `#8fcbb8` / `#0c1b24` / `#1c3733` / `#a6e3d0` | [`tokens.css`](src/styles/tokens.css) | Map fill for `bajo`, legend swatch `swatch-bajo`, current chip. |
| `--level-medium-fill` / `-line` / `-ink` / `-surface` / `-text` | `#d7b16a` / `#e0c478` / `#0c1b24` / `#332c1b` / `#e8d29a` | [`tokens.css`](src/styles/tokens.css) | Map fill for `medio`, pending and queued chips, warning banner. |
| `--level-high-fill` / `-line` / `-ink` / `-surface` / `-text` | `#d97962` / `#e5988a` / `#0c1b24` / `#3a2420` / `#f4b6a6` | [`tokens.css`](src/styles/tokens.css) | Map fill for `alto`, high and insufficient chips. |
| `--level-extreme-fill` / `-line` / `-ink` / `-surface` / `-text` | `#d96f56` / `#f0a088` / `#0c1b24` / `#3d1f1a` / `#f2a894` | [`tokens.css`](src/styles/tokens.css) | The top severity role the palette reserves; the API serves no `extremo` level, and no view invents one. |
| `--level-unknown-fill` / `-line` / `-ink` / `-surface` / `-text` | `#c4cbd1` / `#dde3e7` / `#0c1b24` / `#2b3238` / `#d7dde2` | [`tokens.css`](src/styles/tokens.css) | Map fill for `desconocido` (published, information-insufficient level). |
| `--level-neutral-fill` / `-line` / `-ink` / `-surface` / `-text` | `#71879a` / `#8fa4b0` / `#0c1b24` / `#22303b` / `#c9d6de` | [`tokens.css`](src/styles/tokens.css) | Map fill when there is no published level at all; neutral tags and count badges. |

Every fill still clears 3:1 against the map floor: `alto` 4.91, `medio` 7.43, `bajo` 6.09, `desconocido` 9.16, neutral 4.03 on `--aerial-water #152934`. The retired literal chip surfaces (`#f7e9e2`, `#f7f0d9`, `#e7f0e6`, `#e3efef`) are gone: those chips read their family's `surface`/`text` pair now.

## Structure tokens

| Token | Value | Source | In use |
| --- | --- | --- | --- |
| `--radius` | `12px` | [`tokens.css`](src/styles/tokens.css) | Panels and metric cards only. |
| `--shadow` | `0 12px 28px rgb(0 0 0 / 34%)` | [`tokens.css`](src/styles/tokens.css) | Panels, metric cards, the auth card and the floating 3D HUD. |
| `--font` | `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | [`tokens.css`](src/styles/tokens.css) | Body and all UI text; `main.tsx` imports it through the token file. |

## Typography

There is **no standalone type scale**: no font-size, line-height or weight token exists. The only typography token is `--font`. Sizes and weights are declared per selector in `app.css` and `auth.css`, with literals only.

**Font families actually in use:** the `--font` stack above; `Georgia, serif` for the brand mark glyph (`app.css`); and `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` for the permissions roles and guard citations (`app.css`). `code` uses the platform monospace default at 11 px.

**Inter is declared, not loaded.** No `@font-face`, `@import`, font package or font `<link>` exists in the active frontend or in `frontend/index.html`. The product therefore renders with the platform fallbacks of the stack.

In-use sizes, with the role they carry:

| Role | Size / weight / line-height | Source |
| --- | --- | --- |
| Body | `14px` / default 400 / `1.5` | `app.css` body |
| Page title | `clamp(27px, 2.5vw, 37px)` / `600` / `1.18`, tracking `-1.2px` | `app.css` h1 |
| Header title | `18px` / inherits / tracking `-.5px`, `16px` at `≤720px` | `app.css` `.topbar h1` |
| Panel title | `15px` / `600`-family heading, tracking `-.3px` | `app.css` `.panel-heading h3, h2` |
| Section heading | `17px` / `600` / tracking `-.3px`; `24px` for `.intro-row h2` | `app.css` h2 |
| Subheading | `13px` / `650`; `11px` for h4 | `app.css` h3, h4 |
| Interface label | `12px` (product navigation links and items, inputs), `11px` (`small-label`, body-ish), `10px` (buttons, tables, chips, notes), `9px` (table headers, data lists), `8px` (badges, legend labels, technical notice) | `app.css`, `product-nav.css` |
| Smallest label | `7px` / `850` / tracking `.08em` for `.source-label` | `app.css` |
| Eyebrow / navigation group | `9px` / `800` / tracking `1.4–1.5px` / uppercase | `app.css` `.eyebrow`; `product-nav.css` `.product-nav__group-title`, `.product-nav__panel-title`, `.product-nav__where-label` |
| Metric value | `25px` / `550` / tracking `-.8px` / `1.1` | `app.css` `.metric > strong` |
| Auth hero title | `clamp(24px, 4.4dvh, 40px)` / heading / `1.08`, tracking `-.9px` — viewport-height fluid so the entrance stays one screen | `auth.css` `.auth-hero h1` |
| Auth card title | `clamp(19px, 2.2dvh, 23px)` / heading / tracking `-.5px` | `auth.css` `.auth-panel-body h2` |
| Auth lead / actions | `12.5–13px` / `650–700` / `1.45–1.55` | `auth.css` |

Weight range in the stylesheets is `500`, `550`, `600`, `650`, `700`, `800`, `850`; `550` and `850` are deliberate intermediate values, not the usual `400/500/700`. Line-height runs from `1.08` (auth hero) to `1.65` (banners and panel footnotes). Tracking runs from `-1.2px` to `1.6px`.

Distinct declaration counts, for future comparison: `app.css` has 20 distinct `font-size` values and `auth.css` has 15, including the fluid `clamp()`/dvh headings. There is no modular ratio to infer from them, and this baseline does not impose one.

## Spacing

There is **no spacing scale token**. All spacing is literal. The recurring values in the active styles are:

| Context | Values in use |
| --- | --- |
| Page gutters | `34px` horizontal for topbar, update bar, main and footer; `24px` at `≤1200px`; at `≤720px` the header drops to `14px`, the update bar to `16px` and main to `15px` |
| Shell | **No left column (T10/S7).** `.app-shell` is one flex column of `min-height: calc(100vh - var(--product-nav-h, 48px))`; the header is a wrapping row of `min-height: 56px` with `8px 34px` padding that carries the brand, the route, the territorial chip, the readiness card and the session control. At `≤720px` it stacks to `7px 14px` and the utility cluster becomes a two-column grid. Main `min(1500px, 100%)` with `27px 34px 35px` padding |
| Panels | Heading `20px 22px 17px`; body `18px` (`14px` at `≤720px`); `.padded` `22px` |
| Grids | `16px` metric/dashboard/lower gap; `22px` two/three-column and pipeline gap; `20px` job layout; `10px` map stage |
| Dense rows | `8px 0` data-list rows (`5px 0` compact); `11px 14px` table headers; `12px 14px` table cells; `10px 0` quality findings |
| Controls | `8px 11px` buttons, min-height `34px` (`29px` secondary); `9px 11px` inputs; navigation bar `0 10px` shortcuts at min-height `40px` and `3px 8px` panel items at min-height `32px` (`product-nav.css`); `5px 8px` chips and badges; `7px 11px` zone chip; header utility cards `4px 9px` with `36px` controls |
| Auth | Card padding `clamp(18px, 2.4dvh, 26px) clamp(17px, 2vw, 24px) clamp(15px, 2dvh, 20px)`; hero block padding `clamp(20px, 3.6dvh, 32px) clamp(18px, 4vw, 56px) clamp(16px, 2.6dvh, 26px)`; primary/Google min-height `46px`; tabs `40px`; disclosure summary `40px`, body capped at `min(34dvh, 300px)` |

Breakpoints: `1200px`, `1000px`, `720px` in `app.css`; `960px`, `600px` and `380px` in `auth.css`; `720px` and `480px` in `product-nav.css`; `1180px`/`900px` in `territorial-coverage.css`; `1279px` in `field-workspace.css`. The 3D stage floor is `clamp(440px, 62vh, 680px)`.

## Radius

`--radius: 12px` covers panels and metric cards. Everything else is a literal: `3px` legend swatches, `4px` factor track, `5px` chips/risk pills/text buttons, `6px` badges/icon buttons/inputs/technical notice, `7px` nav links/buttons/selects/auth tabs/HUD controls, `8px` skip link/map insets/header utility cards/zone chip, `9px` workspace/health card/map stage/brand mark/risk state/toast, `10px` warning banner/auth tabs track/auth primary and Google button/auth card (mobile)/HUD rows/3D stage frame, `14px` auth card, `50%` dots and step numbers.

## Shadows

`--shadow` (`0 12px 28px rgb(0 0 0 / 34%)`) is the only shadow token, and the palette is dark, so depth is carried by the surface steps (`--canvas` → `--paper` → `--surface-raised`) rather than by shadow. Literals in use: toast `0 8px 30px rgb(0 0 0 / 45%)`; auth selected tab `0 1px 3px rgb(0 0 0 / 28%)`; selected table row `inset 3px 0 0 var(--accent)`; floating 3D HUD rows `rgb(15 25 34 / 78%)` over `backdrop-filter: blur(6px)`.

## Source-level contrast

These ratios use WCAG 2.1 relative luminance for opaque sRGB pairs, computed from the values declared in `tokens.css`. Compare before rounding: 4.5:1 for ordinary text, and 3:1 for the listed focus rings, control boundaries and map shapes. A low ratio is an audit lead, not proof of a browser failure in every selector or state. The retired cream/forest rows are gone with the palette they described; the shipped pairs are:

| CSS use | Foreground | Background | Ratio | Threshold |
| --- | --- | --- | --- | --- |
| `--ink #f4f1eb` on `--canvas #0f1922` | `#f4f1eb` | `#0f1922` | 15.75:1 | Meets 4.5:1 |
| `--ink #f4f1eb` on `--aerial-water #152934` | `#f4f1eb` | `#152934` | 13.32:1 | Meets 4.5:1 |
| `--ink #f4f1eb` on `--paper #17222b` | `#f4f1eb` | `#17222b` | 14.33:1 | Meets 4.5:1 |
| `--ink #f4f1eb` on `--soft #21313f` | `#f4f1eb` | `#21313f` | 11.82:1 | Meets 4.5:1 |
| `--ink #f4f1eb` on `--surface-raised #243341` | `#f4f1eb` | `#243341` | 11.46:1 | Meets 4.5:1 |
| `--muted #b8c8d2` on `--canvas #0f1922` | `#b8c8d2` | `#0f1922` | 10.34:1 | Meets 4.5:1 |
| `--muted #b8c8d2` on `--paper #17222b` | `#b8c8d2` | `#17222b` | 9.41:1 | Meets 4.5:1 |
| `--muted #b8c8d2` on `--aerial-water #152934` | `#b8c8d2` | `#152934` | 8.74:1 | Meets 4.5:1 |
| `--muted #b8c8d2` on `--soft #21313f` | `#b8c8d2` | `#21313f` | 7.76:1 | Meets 4.5:1 |
| `--muted #b8c8d2` on `--surface-raised #243341` | `#b8c8d2` | `#243341` | 7.53:1 | Meets 4.5:1 |
| `--accent #94dfda` on `--paper #17222b` | `#94dfda` | `#17222b` | 10.63:1 | Meets 4.5:1 |
| `--accent #94dfda` on `--canvas #0f1922` | `#94dfda` | `#0f1922` | 11.69:1 | Meets 4.5:1 |
| `--accent #94dfda` on `--surface-raised #243341` | `#94dfda` | `#243341` | 8.51:1 | Meets 4.5:1 |
| `--accent-ink #0c1b24` on `--accent #94dfda` | `#0c1b24` | `#94dfda` | 11.54:1 | Meets 4.5:1 |
| `--ink #f4f1eb` on `--accent #94dfda` | `#f4f1eb` | `#94dfda` | 1.79:1 | **Below 4.5:1 — why `--accent-ink` exists**; the light ink is never painted on a filled accent control |
| `--focus #94dfda` ring on `--surface-raised` (worst surface) | `#94dfda` | `#243341` | 8.51:1 | Meets 3:1 |
| `--edge #647b8a` boundary on `--canvas` | `#647b8a` | `#0f1922` | 4.01:1 | Meets 3:1 |
| `--edge #647b8a` boundary on `--paper` | `#647b8a` | `#17222b` | 3.65:1 | Meets 3:1 |
| `--edge #647b8a` boundary on `--aerial-water` | `#647b8a` | `#152934` | 3.39:1 | Meets 3:1 |
| `--edge #647b8a` boundary on `--soft` | `#647b8a` | `#21313f` | 3.01:1 | Meets 3:1 |
| `--edge #647b8a` boundary on `--surface-raised` | `#647b8a` | `#243341` | 2.92:1 | **Below 3:1 — that surface uses `--edge-strong`** |
| `--edge-strong #6b8395` boundary on `--surface-raised` | `#6b8395` | `#243341` | 3.27:1 | Meets 3:1 |
| `--edge-strong #6b8395` on `--canvas` / `--paper` / `--aerial-water` | `#6b8395` | `#0f1922` / `#17222b` / `#152934` | 4.49 / 4.08 / 3.79:1 | Meets 3:1 |
| `--level-low-fill #72b1a1` on the map floor `#152934` | `#72b1a1` | `#152934` | 6.09:1 | Meets 3:1 |
| `--level-medium-fill #d7b16a` on the map floor | `#d7b16a` | `#152934` | 7.43:1 | Meets 3:1 |
| `--level-high-fill #d97962` on the map floor | `#d97962` | `#152934` | 4.91:1 | Meets 3:1 |
| `--level-extreme-fill #d96f56` on the map floor | `#d96f56` | `#152934` | 4.55:1 | Meets 3:1 |
| `--level-unknown-fill #c4cbd1` on the map floor | `#c4cbd1` | `#152934` | 9.16:1 | Meets 3:1 |
| `--level-neutral-fill #71879a` on the map floor | `#71879a` | `#152934` | 4.03:1 | Meets 3:1 |
| Level `ink` on its own `fill` (low / medium / high / extreme / unknown / neutral) | `#0c1b24` | family fill | 7.11 / 8.67 / 5.73 / 5.31 / 10.69 / 4.70:1 | Meets 4.5:1 |
| Level `text` on its own `surface` (low / medium / high / extreme / unknown / neutral) | family text | family surface | 8.83 / 9.31 / 8.32 / 7.67 / 9.49 / 9.11:1 | Meets 4.5:1 |
| Printed `--ink` / `--muted` / `--accent` / `--gold` / `--terracotta` on white | `#111` / `#333` / `#0b4f4a` / `#5b4712` / `#8a2f1c` | `#ffffff` | 18.88 / 12.63 / 9.41 / 9.70 / 8.60:1 | Meets 4.5:1 (print block) |

## Global product navigation (T1, palette T10)

[`src/components/ProductNav.tsx`](src/components/ProductNav.tsx) replaces the retired flat sidebar list with the approved canvas' arrangement: a thin horizontal bar above and outside the workspace (`.app-shell`), four always-present shortcuts (`#overview`, `#history`, `#actions`, `#executive`), a **Más destinos** disclosure whose panel is out of flow, and an **Estás en** line naming the open route. The other eleven routes are grouped by the navigation groups declared in [`src/app/routes.ts`](src/app/routes.ts), and every link is derived from `routes`. The component CSS is [`src/styles/product-nav.css`](src/styles/product-nav.css), scoped to `.product-nav`; `app.css` owns the bar's offset and the shell it sits above.

**S8 made the bar read the global roles.** Until T10 it was forest green on every route but the aerial one, which repainted it from `body:has(#overview)`; it is slate/aqua on every route now and declares no colour of its own. The panel stays **opaque** (`--surface-raised`): its labels are measured against the declared surface, not against whatever happens to be behind an overlay.

| Class | Role | Values |
| --- | --- | --- |
| `.product-nav` | Bar above the shell | `position: sticky`, `top: 0`, `min-height: var(--product-nav-h, 48px)` with a local `--product-nav-h: 48px` (the bar never sizes itself from the offset it publishes), `--paper` `#17222b`, `3px 16px`, bottom border `--line`; `ProductNav` publishes the measured box as `--product-nav-h` on `body` |
| `.product-nav__link` | Always-visible shortcut | visible word `Mapa`/`Historial`/`Acciones`/`Panel`; `aria-label` carries the route label; `12px/650`, min-height `40px`, `0 10px`, radius `7px`, `--muted` (9.41:1); the current row is a **filled accent chip** `--accent` with `--accent-ink` (11.54:1) |
| `.product-nav__summary` | Disclosure control | `button` with `aria-expanded`/`aria-controls`; `12px/650`, min-height `40px`, `0 11px`, boundary `--edge-strong` (4.08:1 on the bar), `--ink`; expanded is `--accent` text on `--soft` |
| `.product-nav__panel` | Out-of-flow menu | `position: absolute`, `top: calc(100% + 4px)`, `right: 16px`, `width: min(760px, calc(100% - 24px))`, `max-height: min(70dvh, 520px)`, `overflow-y: auto`, opaque `--surface-raised`, `1px --edge-strong`, `14px 16px`, radius `10px`, shadow `0 18px 40px rgb(0 0 0 / 45%)` |
| `.product-nav__item` | Grouped destination | `12px/500/1.35`, min-height `32px`, `3px 8px`, radius `5px`, `--ink` (11.46:1 on the panel); the current one is `--accent`, weight `700`, underlined (8.51:1) |
| `.product-nav__group-title`, `.product-nav__panel-title` | Navigation labels | `9px/800`, tracking `1.4px`, uppercase, `--muted` |
| `.product-nav__note` | Panel footnote | `10px/1.5`, `--muted`, top hairline `--line` |
| `.product-nav__where` | Current-location line | right-aligned `11px`, value `--ink`, label `--muted`; truncated with an ellipsis, never wrapped over the shortcuts |
| `.product-nav :is(a, button):focus-visible` | Focus ring | `3px` `--focus` `#94dfda`, offset `2px`; the bar's own controls use offset `0` so the ring stays inside the 48px bar |

**Layout after S7.** There is no sidebar to reserve: `.app-shell` is one flex column of `min-height: calc(100vh - var(--product-nav-h, 48px))` and the bar stays sticky at the page's zero offset. The `:root` `48px` is a fallback, because `ProductNav` publishes the bar's measured height into `--product-nav-h` on `body`; a wrapped bar therefore reserves its second row instead of leaving content under it, while the bar's own `min-height` stays `48px` and can return to one row. At `≤720px` the bar keeps `12px` of inline padding and the panel narrows to `calc(100% - 16px)`; below `480px` the bar wraps instead of scrolling horizontally — two rows at 320, 340 and 360 px and one row at 390 px (measured, T4 correction).

**Retired in T8.** The `.sidebar nav` rule was the last thing in `app.css` with no consumer, and its only reader was a source-gate assertion. T8 removed the rule and replaced the assertion with the active contract it stood in for: the bar stays sticky at the page's zero offset and reserves the height the shell subtracts, and the grouped menu stays out of flow, bounded to the viewport and scrollable inside itself (`scripts/check.mjs` §7). Measurements: [visual audit](VISUAL-AUDIT.md#t8--integrated-proof-and-the-retired-sidebar-rule-2026-11-27).

## Sidebar-free shell and header (T10, S7)

[`src/components/Shell.tsx`](src/components/Shell.tsx) has one column now — the workspace — and `main` takes the width the 234 px column used to take. **Nothing the column carried was dropped with it:** the brand, the territorial scope, the gateway readiness card and its refresh control, the session state and the only sign-out control moved into the header as one compact utility cluster, in that reading order and with their ids (`#readiness-status`, `#logout`), their live region and their labels intact. The brand is a mark, not a link: the home destination is the bar's first shortcut directly above. Tab order is skip link → bar shortcuts and disclosure → gateway refresh → sign out → the workspace.

| Selector | Role | Declared values |
| --- | --- | --- |
| `.app-shell` | Workspace column | `min-height: calc(100vh - var(--product-nav-h, 48px))`, `display: flex`; `.main-area` is `flex: 1; min-width: 0` |
| `.topbar` | Header row | `flex-wrap: wrap`, `space-between`, `gap: 8px 16px`, `min-height: 56px`, `8px 34px`, bottom `1px --line`, `--paper` |
| `.topbar-lead` / `.topbar-route` | Brand, route and scope | `gap: 14px`; the route block is a grid with a `1px --line` left rule and `14px` of padding |
| `.topbar h1` | Route title | `18px/600`, tracking `-.5px`, `--ink`, `overflow-wrap: anywhere` (`16px` at `≤720px`) |
| `.brand` / `.brand-mark` | Mark and wordmark | `32px` accent-filled square with an `--accent-ink` initial (radius `9px`), `15px/650` wordmark, `8px` uppercase tagline in `--muted` |
| `.zone-chip` | Territorial scope and selected zone | `4px 9px`, `1px --line`, radius `8px`, `--paper`; glyph `--accent`, label `8px --muted`, value `10px/700 --ink` |
| `.health-card` / `.health-head` / `.health-card p` | Gateway readiness | `4px 9px`, `--soft`, `1px --line`, radius `8px`; sentence `10px/1.35 --muted` capped at `260px`; dots `8px` — ready `#67c99a`, down `#d77b67`, unknown `--muted` |
| `.session-card` / `.session-card button` | Session and sign-out | `--soft` card with the gold `9px` mark, `10px/700` state and `8.5px` permission note; the button is a `36px` target with an `--edge-strong` boundary |
| `.status-action` | Readiness refresh | `min-height: 36px`, `4px 10px`, `1px --edge-strong`, radius `7px`, `--paper`; disabled is `progress` with `opacity: .6` |
| `body`, `main` | Ground and gutters | `body` `--canvas` `#0f1922`; `main` `min(1500px, 100%)` with `27px 34px 35px` |
| `@media (max-width: 720px)` | Phone header | `.app-shell` becomes `display: block`; `.topbar` `7px 14px`; `.topbar-utils` becomes a `1fr 1fr` grid so the readiness card and the session tablet take one row each |

The former demonstration strip is no longer a full-width headline: the honesty statement it carried is still made, as a discreet always-visible technical notice that leads to the data-status view, where the whole declaration lives.

## Compact entrance (T11, S5)

S5 — «es el inicio pero se vé cortado porque es muy grande por lo que hay que hacer scroll y eso mejor que no, algo más sencillo». [`src/views/AuthView.tsx`](src/views/AuthView.tsx) is one atmospheric column plus one card. On a desktop the page is **exactly one viewport** and does not scroll; below `960px` the flow is the document's and a phone scrolls naturally. The two long reference panels that used to sit under the card are the closed `<details class="auth-disclosure">` ("Contrato y estados del acceso"), which scrolls inside itself when opened. The PKCE/Keycloak round trip, the security boundaries and the session contracts are unchanged.

| Selector | Role | Declared values |
| --- | --- | --- |
| `.auth-page` | Page | `min-height: 100dvh`, one column, `--canvas` `#0f1922`, `--ink` |
| `@media (min-width: 960px) .auth-page` | One-viewport desktop | `height: 100dvh`, `max-height: 100dvh`, `overflow: hidden`, two columns `1.02fr / .98fr`; `.auth-hero` and `.auth-main` each `min-height: 0; overflow-y: auto; overscroll-behavior: contain`, so a short window scrolls a column, never the page |
| `.auth-hero` | Atmosphere | `--aerial-water`, two aqua radial gradients (`15%` and `8%` of `--accent`) plus a `44px` topographic grid and two contour rings drawn with gradients only — no font, tile or image is fetched |
| `.auth-main` / `.auth-main-stack` | Card column | `align-content: safe center`, `width: min(404px, 100%)`, `gap: 12px` |
| `.auth-card` | Card | `1px --line`, radius `14px`, `--paper`, `var(--shadow)`, fluid `dvh`-based padding |
| `.auth-tab` / `.auth-tab.is-selected` | Intent tabs | `40px` track on `--soft`, radius `7px`; the selected tab is a **filled accent tab** with `--accent-ink` (11.54:1) and `0 1px 3px rgb(0 0 0 / 28%)` |
| `.auth-primary` / `.auth-google` | The two real controls | `46px` minimum height; the primary is an accent fill with `--accent-ink` (hover: `--ink` fill), the Google button is `--surface-raised` on `--ink` with an `--edge-strong` boundary (hover: `--soft` with an `--accent` boundary) |
| `.auth-disclosure` / `.auth-disclosure-summary` | Closed reference block | `1px --line`, radius `10px`, `--paper`; the `summary` is a `40px` row with the marker suppressed and a `▾` at the inline end, which rotates when the block opens. The body is capped at `min(34dvh, 300px)` with its own scroll |
| `@media (max-width: 600px)` / `(max-width: 380px)` | Phone and narrow | hero and card padding tighten and the fact grid stacks. One column below `960px`, so a 390×844 phone measures `946` px of document — it scrolls by design |

## Aerial workspace and interactive 3D stage (T2, T12)

[`src/styles/aerial-workspace.css`](src/styles/aerial-workspace.css) composes `#overview` as the aerial workspace of the approved board ([`design/firewatch-v1-vuelo/01-vista-aerea.html`](../design/firewatch-v1-vuelo/01-vista-aerea.html)): the map is the canvas, [`AerialWorkstation`](src/components/territory/AerialWorkstation.tsx) is the work rail beside it, and the real published-batch card (`article.panel.risk-panel`, unchanged) is the reading below. Every selector is scoped to `#overview`, so no other route inherits the composition; `MapPanel`, the `ui` primitives, the store, the routes and the API are untouched.

**The palette is no longer declared here (T10).** Until T10 this file declared the board's slate/aqua roles on `body:has(#overview)` and re-coloured the product bar, the header, the update bar and the footer by hand, which is exactly why the map was the only dark screen. Those roles live in `tokens.css` `:root` now and every route reads them; what remains here is the composition, the elements only this route renders, and the air that lets the map reach the first fold.

| Selector | Role | Declared values |
| --- | --- | --- |
| `#overview` | Console | `padding: 12px 16px 18px`, `1px solid --edge`, `var(--radius)`, `--aerial-water`; intro row `margin-bottom: 6px`, `h2` `19px` |
| `#overview .aerial-workspace` | Composition grid | `minmax(0, 1fr) minmax(280px, 336px)`; areas `canvas`/`rail`, `result`/`rail`; `gap: 18px` |
| `#overview .aerial-canvas .map-stage` | One map track | a single `minmax(0, 1fr)` column; the map card is `12px` padding with an `--edge` border and no bottom margin |
| `#overview .map-viewport` / `.map-3d-stage` | Stage floor | `min-height: clamp(440px, 62vh, 680px)`, `--aerial-water`, `1px --edge`, radius `10px` / `9px`; `cursor: grab`, `touch-action: none` |
| `#overview .map-3d-canvas` | Canvas layer | `position: absolute; inset: 0`, `100% × 100%`, `pointer-events: none` — it is scenery below the vector layer |
| `#overview .map-3d .map-svg` | Accessible vector layer | absolutely positioned over the canvas at the same box; it receives pointer and keyboard, so every comuna stays a `role="button"` path with `aria-pressed` and its `<title>` |
| `#overview .map-3d .zone-*` | Choropleth and states | the `--level-*-fill` / `-line` tokens, unchanged. A read level is painted at `fill-opacity: .84`; `.zone-neutral` (`.34`) and `.level-desconocido` (`.22`) deliberately sink into the dark relief so no pale plate suggests a severity, and both carry an `--edge-strong` outline. `.zone-hovered` is a `1.8px --accent` stroke, `.zone-selected` a `3px` one, and `:focus-visible` a `3.5px` dashed `--focus` stroke — all measured on the ocean and on any level fill |
| `#overview .map-3d-hud` / `-row` | Floating controls | `top/right 10px`, rows of `4px` padding, `1px --edge-strong`, radius `10px`, `rgb(15 25 34 / 78%)` with `backdrop-filter: blur(6px)`, `var(--shadow)`; the row is `pointer-events: auto` so the stage can still be dragged elsewhere |
| `#overview .map-3d-hud button` | HUD control | `36 × 36` minimum, radius `7px`, `--paper` on `--ink`; pressed is `--accent` on `--surface-raised`; focus ring `2px --focus` inside the row |
| `#overview .map-3d-layers button` | Layer toggles | the same control pair; pressed state `--accent` |
| `#overview .map-3d-label` / `-beacon` | Names and selection mark | `--ink` labels with a `2.6px` `--aerial-water` halo; the beacon is a dashed `--accent` line with a `2px` water ring |
| `#overview .map-3d-attribution` | Honesty badge | `--muted` line and `8.5px` note; the text is `Relieve 3D ilustrativo · Límites oficiales SUBDERE/IGM` plus «El relieve y el sombreado son ilustrativos: no son un DEM ni una medición del terreno.» |
| `#overview .aerial-rail` | Workstation panel | `position: sticky`, `top: calc(var(--product-nav-h, 48px) + 16px)`, `--surface-raised`, `1px --edge`, `var(--radius)`, `var(--shadow)`, `padding: 16px`, `gap: 12px`; `static` below `1100px` |
| `#overview .aerial-block` / `> h4` | Rail section | `padding-top: 10px`, `1px --line-soft` top hairline, `gap: 8px`; label `10px/800` uppercase in `--accent` |
| `#overview .aerial-readings dt` / `dd` | Reading rows | `11px --muted`; `11px/700 --ink`, `max-width: 62%`, `overflow-wrap: anywhere` |
| `#overview .aerial-links a` | Rail link | `12px/700`, `--accent`, underlined, `min-height: 36px` (`40px` at `≤720px`) |

**The stage is interactive (T12, S6).** [`src/components/map/AerialMap3D.tsx`](src/components/map/AerialMap3D.tsx) pairs a Canvas 2D scene (Pacific bathymetry, graticule, luminous shoreline, depth-sorted extruded prisms, hillshading) with the SVG layer that already carried the accessible contract. **Both surfaces are projected from the same camera arithmetic** ([`projection.ts`](src/components/map/projection.ts)), so the choropleth cannot drift from the relief underneath it. Dragging pans; a horizontal drag with the orbit control changes bearing; the HUD tilts (`Vista 3D` / `2D Central`), zooms and focuses the selected comuna; and three layer toggles (`RELIEVE`, `NOMBRES`, `GRILLA`) work by keyboard. The root carries `data-projection-mode="3d"`, `data-camera-pitch`, `data-camera-bearing`, `data-camera-zoom`, `data-camera-focus` and `data-layers`.

Three honesty rules survive the upgrade: a comuna is painted with a risk colour **only** when the session read a canonical level for it; the relief, extrusion and hillshading are **illustrative** — derived from each polygon's real mean longitude and latitude — and the stage says so in `#map-3d-attribution`; and the island frames stay detached insets drawn with their own local camera, never positioned geographically against the continent. Everything is local (Canvas 2D and the served GeoJSON): no tiles, no CDN, no worker, no new dependency, so the page CSP (`'self'`) is untouched.

**Breakpoints.** `1100px` turns the two columns into one — `canvas`, `rail`, `result`, in document order — and releases the sticky rail. `720px` compacts the map into the phone's first screen: the header becomes the wrapping row described above, the canvas floor drops, the rail link target grows to `40px` and the logout keeps a `36px` target. `@media (prefers-reduced-motion: reduce)` turns off the route's transitions, animations and smooth scrolling.

**Copy rule.** The rail states only facts the views already published: the session's one inflight batch (`jobProgress`), the selected zone's label from the catalogue, the kind of answer the last read settled on, and how many comunas actually carry a read level. It never repeats the level (the card owns it), never infers progress, and links only to routes `src/app/routes.ts` declares. The prototype's per-comuna queue, camera poses, cut-off slider, mock sectors and coordinates have no served data and are not simulated.

## Dark-adapted workspaces (T13, S8)

The remaining workspace stylesheets were dark-adapted in place, without moving a rule or changing a selector: [`decision-workspace.css`](src/styles/decision-workspace.css), [`field-workspace.css`](src/styles/field-workspace.css), [`history-workspace.css`](src/styles/history-workspace.css), [`notifications.css`](src/styles/notifications.css), [`observations.css`](src/styles/observations.css), [`operations-workspace.css`](src/styles/operations-workspace.css) and [`territorial-coverage.css`](src/styles/territorial-coverage.css), plus [`InfrastructureMap.tsx`](src/components/map/InfrastructureMap.tsx) for the two SVG literals a stylesheet cannot reach.

The change is a **substitution of role references**, not a restyle: every `--paper`, `--soft`, `--line`, `--ink`, `--muted`, `--forest-700` and `--level-*` reference resolves to the same-named global token, so the geometry, the type scale and the spacing recorded in the T3–T7 sections below are unchanged. The literal accents those files had carried are gone: the retired card surface `#f8faf7`, the dashed mark `#c8d2c6`, the focus ring `#cf7d4f` and the pale map surface `#eef2e8` were replaced by `--paper`/`--soft`, `--line`, `--focus` and `--aerial-water`. Print readability is preserved by the `@media print` block in `tokens.css` and by each file's own print rules.

Two consequences worth knowing when auditing: both map surfaces sit on `--aerial-water` — the aerial stage on `#overview` and the coverage map on `#infrastructure` — so neither is the pale `#eef2e8` plate it used to be; and the focus indicator is the single `--focus` role, so no view can drift back to a terracotta ring.

## Territorial coverage board (T3)

[`src/styles/territorial-coverage.css`](src/styles/territorial-coverage.css) composes `#infrastructure` as the coverage board of the approved territorial artboards ([`04-cobertura-territorial.html`](../design/firewatch-v1-vuelo/04-cobertura-territorial.html) and [`21-lecturas-por-sector.html`](../design/firewatch-v1-vuelo/21-lecturas-por-sector.html)): the real catalogue map is the canvas, [`CoverageRail`](src/components/territory/CoverageRail.tsx) lists the comunas beside it, the per-type table keeps its shipped columns and the breakdown is unchanged, and two reading panels close the board. Every selector is scoped to `#infrastructure`, so no other route inherits the composition. `InfrastructureMap`, `TableWrap`, the `ui` primitives, the store, the routes and the API are untouched.

**No new palette; the palette is global (T13).** The file declares no colour tokens: it reads `--paper`, `--line`, `--muted`, `--ink`, `--soft`, `--forest-700`, `--forest-900`, `--radius` and the single focus role `--focus` from `tokens.css`. The retired literals it once carried (`#cf7d4f`, `#eef2e8`) are gone and the map floor is `--aerial-water`.

| Selector | Role | Declared values |
| --- | --- | --- |
| `#infrastructure .coverage-stage` | Stage grid | `grid-template-columns: minmax(0, 1fr) minmax(230px, 258px)`; `gap: 16px`; `align-items: start` |
| `#infrastructure .coverage-stage-head h3` | Stage title | `15px/650`, tracking `-.3px` — the shipped panel-title weight, not the lighter global `h3` |
| `#infrastructure .coverage-stage-note` | Granularity note | `max-width: 78ch`, `10px/1.6`, `--muted` |
| `#infrastructure .coverage-rail` | Commune rail | `display: grid`, `gap: 10px`, `padding-left: 16px`, `border-left: 1px solid --line`; no nested card surface |
| `#infrastructure .coverage-rail-head h3` | Rail title | `13px/700`, tracking `-.2px`; the count uses the shipped `.count-badge` |
| `#infrastructure .coverage-entry` | Commune button | `display: grid`, `gap: 5px`, `width: 100%`, `min-height: 44px`, `padding: 8px 9px`, radius `7px`, `font: inherit`, `text-align: left`; hover `--soft`; `aria-pressed="true"` adds `--soft` plus `inset 3px 0 0 --forest-700`; focus `outline: 3px solid var(--focus)`, offset `2px` |
| `#infrastructure .coverage-dots` | Coverage marks | `grid-template-columns: repeat(5, 1fr)`, `gap: 3px`; each dot `4px` high, radius `2px`; on `--forest-700`, off `--line`; decorative (`aria-hidden`) |
| `#infrastructure .coverage-figure` | Coverage figure | `9px/800`, `--forest-700`, `white-space: nowrap` |
| `#infrastructure .coverage-entry-types` | Declared types | `9px/1.45`, `--muted`, `overflow-wrap: anywhere` |
| `#infrastructure .infrastructure-zone-coverage` | Per-commune coverage line | `10px/1.55`, `600`, `--forest-700` |
| `#infrastructure .infrastructure-zone` | Drill-through target | `scroll-margin-top: calc(var(--product-nav-h, 48px) + 14px)`; `[data-active="true"]` paints `--soft`; focus ring as above |
| `#infrastructure .coverage-detail` | Reading row | `grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr)`, `gap: 18px`, `padding-top: 16px`, `border-top: 1px solid --line` |
| `#infrastructure .coverage-reading` | Distinction list | `dl` rows `132px minmax(0, 1fr)`; terms `10px/800 --ink`; descriptions `10px/1.55 --muted` |
| `#infrastructure .coverage-routes a` | Reading link | `11px/700`, `--forest-700`, underline offset `2px`, `min-height: 36px` (`44px` at `≤720px`); focus `outline: 3px solid var(--focus)`, offset `2px` |

**Breakpoints.** `1180px` folds the stage into one column — canvas first, rail below, in DOM order — because below that width the two columns would shrink the map; the rail's side border becomes a top border. `900px` makes the reading row one column. `720px` tightens the stage gap and gives rail buttons a `10px 8px` padding and the reading links a `44px` target. The four widths measured in Chromium (1440, 1280, 1024, 390) are recorded in the [visual audit](VISUAL-AUDIT.md#t3--territorial-coverage-board-2026-11-26).

**Print.** The board's print rules live in the same file: the rail and the reading-links column are hidden because in-page navigation does not print, the granularity panel stays in black on white, and the shipped `app.css` print block keeps owning the synthetic label, the formula, the table and the breakdown.

**Copy rule.** The rail states only facts the payload carries: each zone is a comuna by CUT code, and "cobertura" is the count of the five declared element types that comuna declares — never a percentage of territory, never a sector reading, never a risk level. A count of zero is described as the fixture declaring no element of that type, not as missing data. The board's sector rows, cut-off slider, environment descriptions and contextual priority are not simulated. Each rail control is a `button type="button"` with `aria-pressed` that moves focus to the commune's breakdown: the rail does not use `#` anchors because the hash is the router's state.

## Decision workspace (T4)

T4 ports the three decision boards — [`07-panel-ejecutivo.html`](../design/firewatch-v1-vuelo/07-panel-ejecutivo.html), [`08-comparar-sectores.html`](../design/firewatch-v1-vuelo/08-comparar-sectores.html) and [`09-notificaciones.html`](../design/firewatch-v1-vuelo/09-notificaciones.html) — to `#executive`, `#compare` and `#notifications`, and adds the real `#executive` route with the bar's fourth shortcut (`Panel ejecutivo`). The three screens share one stylesheet, [`src/styles/decision-workspace.css`](src/styles/decision-workspace.css), and its selectors are either scoped to a view id or to classes only these screens render (`.decision-*`, `.executive-panel`, `.compare-panel`).

**No new palette and no new scale (dark-adapted in T13).** The file declares colors only through the global tokens (`--paper`, `--line`, `--muted`, `--ink`, `--soft`, `--forest-700`, `--level-*`) plus the single focus role `--focus`; the dashed empty mark is `--edge-strong` and the card surface is `--surface-raised`. Type uses the in-use sizes (`9`, `10`, `11`, `15`, `16`, `24`, `25px`), spacing the 4px-derived values already in use (`8`, `12`, `16`, `18px`), radius `9px` and the existing `--radius`.

| Selector | Role | Declared values |
| --- | --- | --- |
| `.decision-head` / `.decision-head__chips` | Board view head | `align-items: flex-start` on the shipped `.intro-row`; chips `flex-wrap: wrap`, `gap: 6px`, `justify-content: flex-end` |
| `.decision-band` / `.decision-band__head` | Counts band (07) | `margin: 14px 0 4px`; head `display: grid`, `gap: 3px`; hint `max-width: 76ch`, `9px/1.6`, `--muted` |
| `.decision-summary` | Count cells | `grid-template-columns: repeat(4, minmax(0, 1fr))`, `gap: 8px`; two columns at `≤900px` |
| `.decision-summary__cell` | One level count | `padding: 12px 13px`, border `1px solid --line`, radius `9px`, surface `--paper` |
| `.decision-summary__label` | Level label | `9px/800`, tracking `.06em`, uppercase, `--muted`; a 6px mark repeats the level fill and line of the map legend |
| `.decision-summary__cell strong` | Count value | `25px/550`, tracking `-.8px`, `--ink` — the shipped metric value |
| `.decision-limits` / `.decision-limits__item` | Limits band (07) | `display: grid`, `gap: 8px`; each item `1px solid --line`, radius `9px`, `--paper`; `summary` `min-height: 44px`, `padding: 9px 12px`, marker suppressed, `▾` at the inline end; open item gets a bottom border |
| `.decision-limits__title` / `.decision-limits__item p` | Disclosure text | Title `11px/700 --ink`; body `10px/1.65 --muted`, `padding: 10px 12px 12px` |
| `.decision-links` | Related readings (07) | `padding: 16px 18px 18px`, `1px solid --line`, `--radius`, `--paper`, `--shadow`; links `11px/700 --forest-700`, `min-height: 24px`; notes `10px/1.6 --muted` |
| `.compare-layout` | Comparator split (08) | `grid-template-columns: minmax(0, 360px) minmax(0, 1fr)`, `gap: 16px`, `align-items: start`; one column at `≤1000px`; child panels lose their bottom margin |
| `.executive-panel > .panel-heading`, `.compare-panel > .panel-heading` | Panel head alignment | `padding: 0 0 12px`: the primitive keeps its rhythm and drops the side padding the panel modifier already supplies, as the notification panel already did. At `≤560px` the executive head stacks (title, then its rule tag) |
| `.notification-empty*` ([`notifications.css`](src/styles/notifications.css)) | Notification empty card (09) | Card `display: grid`, `justify-items: start`, `gap: 8px`, `padding: 24px 22px 26px`, dashed `--edge-strong`, radius `10px`, `--surface-raised`; 58px dashed mark; eyebrow `9px/800`; title `16px/650`; copy and two points `10px/1.65 --muted`, `max-width: 68ch` |

**What the boards carry that the product does not.** The three boards are built on mock sectors, an invented alert preview and per-level filtering. The service publishes comuna-level aggregates (`code = CUT`), stored alert rows and one summary per cutoff, so T4 ports the hierarchy and drops the mock data: the counts band is a reading without a filter control, the comparator keeps its real catalogue picker and granularity selects instead of the board's sector buttons, the notification centre keeps the real read and states the empty page in the board's card shape, and the executive view links to the screens that hold the detail instead of rendering a sector table. The copy states the comuna granularity where the board shows sectors.

**Routes.** The router now declares fifteen hashes in the same four groups; `#executive` sits in `Prevención` beside `#overview` because it reads the same catalogue, and the bar's four shortcuts are `Mapa`, `Historial`, `Acciones` and `Panel`. The three shortcuts T1 shipped keep their place and their accessible names.

**Verifier correction.** The limits band's D-B statement now reads `Definición acordada · D-B` in both consumers, because `odd/tasks/pm-01-executive-panel.md` records the definition as resolved and the server applies it; the rule and its explanation are unchanged. The notification empty card is state-dependent: a first empty page states the register is empty, and a later cursor page states that this page is empty and offers `Anterior`. Both are pinned by public DOM tests. The narrow bar reflow and its measured offset are recorded in the [visual audit](VISUAL-AUDIT.md#t4-correction--verifier-blockers-2026-11-26).

## History, export and model data (T5)

T5 ports the board set's traceability, delivery and model-data screens —
[`05-historial-de-lotes.html`](../design/firewatch-v1-vuelo/05-historial-de-lotes.html),
[`12-exportacion-csv.html`](../design/firewatch-v1-vuelo/12-exportacion-csv.html) and
[`20-datos-del-modelo.html`](../design/firewatch-v1-vuelo/20-datos-del-modelo.html) — into the routes the
product has. No route was added: the history board and its real CSV delivery live in `#history`, and board 20's
status-first hierarchy lands in the model panel `#overview` already renders. The new stylesheet is
[`src/styles/history-workspace.css`](src/styles/history-workspace.css) and its selectors are all scoped to
`#history` or `#overview .model-panel`. The level mark is
[`src/components/history/HistoryLevelMark.tsx`](src/components/history/HistoryLevelMark.tsx), which reuses the
domain's `levelLabel` and the shipped `--level-*` tokens.

**No new palette and no new scale (dark-adapted in T13).** The file declares colors only through the global tokens (`--paper`,
`--line`, `--muted`, `--ink`, `--soft`, `--forest-700`, `--level-*-line`) plus the single focus role
`--focus`, the empty-card surface `--surface-raised` and the `--edge-strong` dashed mark the notification card already
uses. Type stays in the in-use sizes (`9`, `10`, `11`, `13`, `15` px) and spacing in the values already in use.

| Selector | Role | Declared values |
| --- | --- | --- |
| `#history .history-head` / `.history-head-intro` | View head (05) | `align-items: flex-start`; intro measure `78ch`, lede `74ch` at `11px/1.55`; count badge stays the shipped `.count-badge` |
| `#history .history-panel > .panel-heading` | Panel head (05) | `padding: 0 0 12px`: the panel modifier already carries 18 px of padding, so the title aligns with the body instead of being inset by the primitive's `20px 22px 17px` |
| `#history .history-scope-bar` | Toolbar (05) | bottom `1px solid --line`, `12px` padding below, `12px` margin below |
| `#history .history-scope-bar .filter-label`, `#history .filter-bar .filter-label` | Field labels | `9px/800`, tracking `.06em`, uppercase, `--muted` (the board's toolbar label treatment) |
| `#history .history-scope-bar select` | Scope / granularity | `min-width: 156px`, `11px` — the shipped select styling |
| `#history .history-panel table` | Rows table (05) | `min-width: 560px` inside the shipped `.table-wrap` scroll region |
| `.history-level` / `.history-level-dot` | Level mark (05) | `10px/700`, `--ink`, `gap: 6px`; dot `6px` with `--level-high-line`, `--level-medium-line`, `--level-low-line`, `--level-unknown-line`, `--level-neutral-line`; the word is the claim, the dot is decorative |
| `#history .empty-state` | Status line (05) | `10px 2px 12px`, left aligned, `line-height: 1.6` |
| `#history .history-empty-card` | Empty card (05) | grid, `justify-items: start`, `gap: 6px`, `20px 20px 22px`, dashed `1px --edge-strong`, radius `10px`, `--surface-raised`; `strong` `15px/650 --ink`; copy `10px/1.65 --muted`, `68ch`; the reset keeps `34px` |
| `#history .history-series-zone` / `.history-bucket` | Every-zone series (05) | block `13px 15px 9px`; head bottom border `#eef1ee`; interval rows `7px 0`, start column `min-width: 168px` (released at `≤560px`) |
| `#history .history-export` | Delivery block (12) | `display: grid`, `gap: 10px`, `margin-top: 18px`, top border from the shipped rule |
| `#history .history-export-title` | Delivery title | `13px/650`, tracking `-.2px`, `--ink` |
| `#history .history-export .data-list` | Document facts | `max-width: 640px` so each label stays near its value; `dd code` `9px` |
| `#history .history-export-actions` / `.history-export-hint` | Download row | flex wrap, `gap: 8px 14px`; button `min-height: 34px`; hint `9px/1.6 --muted` |
| `#overview .model-panel > .panel-heading` | Model panel head (20) | `padding: 0 0 12px`, same alignment as the history panel |
| `#overview .model-panel .model-scope` | Scope block (20) | top `1px solid --line`, `12px` padding above, `10px` margin below |
| `#overview .model-panel .model-scope h4` | Scope title | `11px/800`, tracking `.04em`, uppercase, `--ink` |
| `#overview .model-panel .model-scope ul` | Scope items | `10px/1.6 --muted`, `86ch`, `strong` in `--ink`, `code` in `--forest-700` |

**Breakpoints.** `560px` stacks the history head (title, lede, count), the delivery head and the model-panel head,
and releases the interval start column; the two `560px` blocks are the only responsive rules in the file.

**The rows table keeps five served columns.** `Solicitado`, `Publicado`, `Nivel`, `Estado` and `Lote` are five
different facts of the row `/v1/risk/history` returns, and the level is the domain's own label
(`levelLabel`), never a colour-only mark. Both instants are printed exactly as served — no locale, no rounding —
because that granularity is the contract's. At phone width the five columns do not fit, so the table keeps the
shipped `.table-wrap` scroll region instead of dropping or truncating a column; the page itself never scrolls
horizontally (measured in the [audit](VISUAL-AUDIT.md#t5--history-export-and-model-data-2026-11-26)).

**The export block is not a preview.** Board 12 illustrates a document its prototype could not produce. The
product produces it: `/v1/risk/history.csv` is read for the selected zone and the served bytes are saved under
`risk-history-<zona>.csv`. The block therefore names the real route, the exact zone scope (`sin la búsqueda ni el
filtro de estado de la tabla`), the file name `saveHistoryCsv` really uses and the per-row provenance; it renders
no sample table, no proposed column list and no raw CSV text. A zone with no history is stated as an export of
the header alone, never as a level under test.

**What board 20 carries that the product does not.** The board documents seven variables with units, source
groups, three contract mismatches and the historical-access situation. The registry serves none of that as
metadata: `GET /v1/models` returns version rows with `kind`, `params_hash`, `approved_at`, `metrics` and `active`,
and `domain/model.ts` reads only the one active version and its declared synthetic mark. The model panel therefore
keeps the board's status-first hierarchy — heading, status sentence, the two version facts, then
`Qué sí y qué no hace esta ficha` — and names the absence instead of drawing an inventory, a source table or a
fixture row. No score, no operational claim and no control was added.

**Also left out, deliberately.** Board 05's shared cutoff, its `Relación con el corte` column, its batch timeline
and its period/zone selects have no served equivalent (the zone comes from the shell, the read window is the
route's own 100-row window, and no cutoff concept exists), so they are absent rather than simulated. The board's
task links were not ported either: the history panel changes no route.

## Prevention, simulation and observations (T6)

T6 ports the board set's prevention, simulation and field screens —
[`06-acciones-preventivas.html`](../design/firewatch-v1-vuelo/06-acciones-preventivas.html),
[`10-simulacion-contrafactual.html`](../design/firewatch-v1-vuelo/10-simulacion-contrafactual.html) and
[`11-observaciones-de-campo.html`](../design/firewatch-v1-vuelo/11-observaciones-de-campo.html) — into the routes
the product already has: `#actions`, `#simulator` and `#observations`. No route, backend, auth, shared store,
domain contract, `app.css` rule or dependency changed. The new stylesheet is
[`src/styles/field-workspace.css`](src/styles/field-workspace.css), every selector scoped to one of the three view
ids, and the one new component is
[`src/components/field-work/FieldStateCard.tsx`](src/components/field-work/FieldStateCard.tsx).

**No new palette and no new scale.** The file declares colours only through the existing tokens (`--paper`,
`--canvas`, `--line`, `--muted`, `--ink`, `--soft`, `--forest-700`), plus three literals the product already uses:
the single focus role `--focus`, the empty-card surface `--surface-raised` with an `--edge-strong` dashed mark.
The error tone reuses the shipped `--terracotta-soft` family (`#fdf6ef` surface, `#e0c9b6` border, `#9c472f`
eyebrow) and the filtered tone keeps `--paper` because it is the only card that carries a control. Type stays in
the in-use sizes (8, 9, 10, 11, 13px) and spacing in the 4px-derived values already in use.

| Selector | Role | Declared values |
| --- | --- | --- |
| `.field-state` (scoped to the three ids) | Designed state card (06/10/11) | grid, `justify-items: start`, `gap: 4px`, `14px 16px 16px`, dashed `1px --edge`, radius `9px`, `--soft`; `strong` `13px/650 --ink`; body `10px/1.6` capped at `78ch`; the eyebrow keeps the shipped rule |
| `.field-state-error` | Refusal tone | solid `#e0c9b6`, `#fdf6ef`; eyebrow `#9c472f` |
| `.field-state-filtered` | Filter tone (carries the reset) | `--paper` fill, so the shipped focus ring keeps its `3.11:1` |
| `#actions .actions-workbench` | Workbench (06) | `1.25fr / 1fr`, `16px` gap, `align-items: start`; single column when the detail is absent or below `1280px` |
| `#actions .actions-panel > .panel-heading` (and detail/create) | Panel heads | `padding: 0 0 10px` so the title aligns with the body the panel modifier already pads |
| `#actions .actions-lede` | View lede (06) | `max-width: 76ch`, `11px/1.6` |
| `#actions .actions-filters-label` / `.actions-filters` | Queue toolbar (06) | eyebrow above the form; bottom `1px solid --line`, `12px` padding and margin below |
| `#actions .actions-detail-id` | Identity strip (06) | flex wrap, `gap: 8px 12px`, `10px`; the chip keeps the shipped tone rules, the identifier `650`, the deadline `strong` in `--ink` |
| `#actions .actions-description` | Description block (06) | `10px 12px`, `1px solid --line`, radius `8px`, `--soft`; label `9px/800` uppercase, text `10px/1.6 --ink` |
| `#actions #action-detail-fields` | Facts grid (06) | `repeat(2, minmax(0, 1fr))`, `gap: 8px 14px`; label `9px/800` uppercase `--muted`, value `10px/650 --ink` left-aligned; one column at `≤560px` |
| `#actions .actions-fieldset` / `-body` | Alta groups (06) | fieldset spans the form (`grid-column: 1 / -1`), `1px solid --line`, radius `9px`, legend `9px/800 --forest-700`; the body keeps the shipped two-column control grid and stacks at `≤720px`; a textarea spans the group |
| `#simulator .simulator-factors-eyebrow` / `#simulator-factors-note` | Factor block (10) | eyebrow above the before/after table, note below it at the shipped `9px/1.6` |
| `#simulator .row-flag` | Substituted mark (10) | own line under the variable name, `4px` radius, `--soft`/`--forest-700`, `8px/850` uppercase |
| `#observations .observation-type` | Record type mark (11) | inline-flex, `min-height: 22px`, `2px 7px`, `1px solid --line`, radius `5px`, `--soft`/`--ink`, `9px/800` uppercase |
| `#observations .observation-zone strong` | Record subject (11) | `11px/650 --ink`; the record head keeps the date at the right |
| textareas (scoped to the three ids) | Focus ring | `3px solid var(--focus)`, offset `2px` — the shipped rule lists `input`/`select`/`a`/`[tabindex]` but not `textarea` |

**Breakpoints.** `1279px` stacks the workbench (measured: below it the seven-column queue no longer fits its own
min-content), `720px` stacks each alta group and keeps the shipped form collapse, `560px` stacks the facts grid.
The simulator and observation layouts keep their shipped `1000px` collapse.

**The queue is a table, and the board's queue is a card list.** Board 06 can run two columns from 1000px because
its queue is a button list. The production queue is a seven-column `<table>`, so the pair only sits side by side
where the table still fits: measured at 1440 the list region is `715` px (no internal scroll) and at 1280 it is
`626` px, exactly its own min-content. Below 1280 the view keeps the shipped full-width list and stacks the detail
under it, which is the only arrangement measured to avoid a horizontal scrollbar on the primary surface.

**What the boards carry that the product does not.** Board 06's task switch (`Revisar` / `Preparar` / `Estados
planificados`) is a prototype affordance: the production page keeps the list, the detail and the alta available at
the same time, so no region is hidden behind a mode. Its `Estados planificados` panel previews `candidate`,
`in_progress`, `reviewed` and `closed`, which the contract does not declare and no mapping exists for, so it was
not ported. The illustrative queue, the four invented actions, the people, the `Nivel al corte`/`Cobertura` context
facts, the `Prioridad contextual`, the recommendation catalogue and the PDF zone sheet (board 13) have no served
equivalent in these views and were not drawn. The alta is one form with one submit: a two-step wizard would hide
half the fields and change a flow that already writes through the server.

**What was added instead, from real data.** The selected action's identity strip (state, identifier, deadline) and
description; the two-column fact grid; the alta's two native groups; the substitution the simulator actually sent
and the before→after level; the `Sustituida` mark on exactly the variables that travelled; the factor block's note
that the service publishes no per-variable recommendation; and the observation record's type mark and emphasized
zone. Board 10's factor table also carries a recommendation column and a contribution bar; the service returns
neither a recommendation mapping nor a bar scale for the counterfactual, so only the value and `aporte` the rule
returned are shown.

## Access and operations (T7)

T7 ports boards 14–19 —
[`14-acceso.html`](../design/firewatch-v1-vuelo/14-acceso.html),
[`15-fuentes-y-servicios.html`](../design/firewatch-v1-vuelo/15-fuentes-y-servicios.html),
[`16-procesamiento.html`](../design/firewatch-v1-vuelo/16-procesamiento.html),
[`17-sesion-y-permisos.html`](../design/firewatch-v1-vuelo/17-sesion-y-permisos.html),
[`18-registro-de-actividad.html`](../design/firewatch-v1-vuelo/18-registro-de-actividad.html) and
[`19-aun-no-implementado.html`](../design/firewatch-v1-vuelo/19-aun-no-implementado.html) — into the seven screens
the product already has: the AUTH gate ([`src/views/AuthView.tsx`](src/views/AuthView.tsx)), `#sources`,
`#status`, `#jobs`, `#session`, `#audit` and `#pending`. No route, backend call, auth step, role decision,
protocol, token lifetime, store, domain contract, `Shell.tsx`, `ui.tsx`, `routes.ts`, `app.css` rule or dependency
changed; the views keep every id they exposed. The new stylesheet is
[`src/styles/operations-workspace.css`](src/styles/operations-workspace.css), imported by the six workspace views,
plus the auth-page rules appended to the existing [`src/styles/auth.css`](src/styles/auth.css). The one new component
file is [`src/components/operations/OperationsPrimitives.tsx`](src/components/operations/OperationsPrimitives.tsx)
(`OperationsViewHead`, `OperationsSteps`, `OperationsStateList`) — placement only; no component decides a state.

**No new palette and no new scale (dark-adapted in T13).** Colours come from the global tokens (`--paper`, `--soft`, `--line`,
`--muted`, `--ink`, `--gold`, `--forest-700`, `--radius`, `--shadow`) plus the muted label role `--muted` for
the auth chip and the single focus role `--focus` (not re-declared: no new control was added). Type stays in the
in-use sizes (9, 10, 11, 15, 21–24px) and spacing in the existing 4px-derived values.

| Selector | Role | Declared values |
| --- | --- | --- |
| `.ops-view-head` | Head (14–19) | flex wrap, `gap: 10px 22px`, `14px 18px 15px`, `1px solid --line`, `var(--radius)`, `--paper`, `var(--shadow)`; title `clamp(22px, 2.2vw, 24px)/600`, tracking `-.9px`; lede `78ch` max, `11px/1.6 --muted` |
| `#jobs`, `#audit`, `#pending` head | In-card head | no surface, `0 0 12px`, bottom `1px solid --line` — the panel modifier already pads, so the head is the panel's own |
| `.ops-chip` | Scope chip | `4px 8px`, `1px solid --line`, radius `5px`, `--soft` on `--ink`, `9px/700` |
| `.ops-layout` / `.ops-stack` / `.ops-side` | Two columns | `minmax(0, 1fr) 340px`, `gap: 16px`, `align-items: start`; columns are grids with `16px` gap and no double panel margin |
| `.ops-block` | Steps or legend card | `15px 17px 16px`, `1px solid --line`, `var(--radius)`, `--paper`, `var(--shadow)`; title `15px/650` |
| `.ops-step` | Numbered step (16/17) | `26px` marker column, `9px 0` rows, `1px solid --line` dividers; number `24px` circle `--soft`/`--forest-700` `9px/800` |
| `.ops-states` | State vocabulary (16/18) | full-width rows, label `10px/700 --ink`, detail `9px/1.5 --muted`; two columns only inside `#audit` where the rows are short |
| `#sources .ops-side .data-list` | Side facts (15) | the same `dl` stated as rows: one column, `8px 0`, left-aligned value at `100%` — at 340px a right-aligned value broke into one or two words per line |
| `.auth-chips` / `.auth-chip` | Entrance state (14) | flex wrap, `6px` gap, `4px 8px`, `1px solid --edge`, radius `6px`, `--muted` on `--paper` |
| `.auth-facts-panel` / `.auth-facts` | Contract panel (14) | `18px 20px 20px`, `1px solid --line`, `var(--radius)`, `--paper`; fact grid `minmax(96px, 38%)`, label `9px/700 --muted`, value `10px/600 --ink` |
| `.auth-state-list` | Entrance states (14) | list rows `7px 0` with `1px solid --line`; label `10px/700 --ink`, detail `--muted` |

**Breakpoints.** `1200px` collapses `.ops-layout` to one column and lets `.ops-side` reflow by available width
(`auto-fit`), so a side column with a single block keeps the full width instead of painting half an empty row;
`760px` makes the side a single column and tightens the head and block padding; `420px` drops the head title to
21px and stacks the auth fact grid. The auth gate keeps its shipped `900px` and `420px` breakpoints; the two
reference panels move under the card instead of becoming a third column, and at `≤900px` the state-chip row gives
back its vertical space (`4px` margin, `3px 7px` padding) so the primary action stays inside a 844 px viewport
(measured `794–840`; base `771–817`).

**The register's legend is below its table, not beside it.** Board 18 gives the legend a side column. The register
is an eight-column table: measured at 1440, a 340px side column left it `744` px wide with a `833` px scroll width;
full width it is `1100` px with no internal scroll. The legend is the same list, stated under the table.

**The permission matrix takes the main column.** Board 17 gives the matrix the wider column. It also fixes a
measured defect: at the shipped `lower-grid` ratio the matrix had `389` px for a `520` px minimum and scrolled
horizontally at 1440. In the main column it is `744` px at 1440 and `730` px at 1024, both without internal scroll;
at 390 it keeps its named, focusable scroll region.

**What the boards carry that the product does not.** Board 14's simulated Keycloak opener and its "ilustrative
session" are not ported: the screen only states the round trip it really observes. Board 15's record selection,
quality findings and "incorporate" action have no endpoint. Board 16's illustrative queue and its publish,
advance and reevaluate controls are not ported (no endpoint; the view keeps its "not implemented" note). Board
17's role picker was already refused and stays refused; its "no sign-out" list is stated as what this view does not
do, not as a control. Board 18's per-event selection and detail panel need fields the endpoint no longer lacks but
that this view does not offer as a control. Board 19's prototype links are not ported: no control may imply the
capability exists. The theme toggle, the mockup session stamp, the focus/cutoff facts and the seven-row count are
board-only; the inventory renders its own five rows.

**What was added instead, from real data.** The entrance's state chip, derived from the real session state; the
auth contract and state blocks, whose every sentence already exists in the shipped copy; the five-state legend,
built from `STATE_LABELS`/`STATE_REASONS`; the four real steps of the jobs contract, including the "deadline is not
a publication" rule; the four verification steps and the four stated limits; the register's four response branches;
the inventory's real count (`NOT_IMPLEMENTED.length`); and the source side facts stated as rows at 340px.

## Measured in a browser (T14, 2026-11-27)

The shipped migration was measured in the real installed **Chrome** (headless, `--remote-debugging-port=0`, throwaway profile) against the production bundle served on `http://localhost:4173`, with the gateway (`:18085`) and the identity provider (`:18086`) answered by fixtures — a fixture session, no real credential, gateway or Keycloak. Everything below is a measurement, not a token pair.

**Unauthenticated `AuthView`.**

| Viewport | `scrollHeight` / `innerHeight` | `scrollWidth` / `innerWidth` | `body` background | `details.auth-disclosure` | console + page errors |
| --- | --- | --- | --- | --- | --- |
| 1273×797 | `797` / `797` — no vertical scroll | `1273` / `1273` | `rgb(15, 25, 34)` (`#0f1922`) | present, `open=false` | `0` |
| 1440×900 | `900` / `900` — no vertical scroll | `1440` / `1440` | `rgb(15, 25, 34)` | present, `open=false` | `0` |
| 390×844 | `946` / `844` — the documented phone flow | `375` / `390` — no horizontal scroll | `rgb(15, 25, 34)` | present, `open=false` | `0` |

**Authenticated workspace routes** (fixture session, `document.querySelector('.sidebar') === null` on every route and viewport, `#readiness-status` and `#logout` visible and reachable on all eight samples).

| Route | Viewport | `scrollWidth` / `innerWidth` | Cream surfaces (`#f5f5ef`, `#fffefa`, `#eef1e9`, `#f8faf7`) | Stage |
| --- | --- | --- | --- | --- |
| `#overview` | 1273×797 | `1258` / `1273` | `0` | canvas `774 × 494`, `data-projection-mode="3d"`, `38` comuna options, `38` shapes, pitch `0.9076` |
| `#overview` | 390×844 | `375` / `390` | `0` | canvas `299 × 340`, `data-projection-mode="3d"`, `38` comuna options |
| `#history` | 1273×797 | `1258` / `1273` | `0` | dark table + CSV delivery block, level mark `ALTO` |
| `#actions` | 1273×797 | `1258` / `1273` | `0` | — |
| `#infrastructure` | 1273×797 | `1258` / `1273` | `0` | — |
| `#history` / `#actions` / `#infrastructure` | 390×844 | `375` / `390` | `0` | — |

`body` computed `rgb(15, 25, 34)` on all eight samples, and the workspace console computed `rgb(21, 41, 52)` (`--aerial-water`) on `#overview`. Screenshots: `fw-t14-login.png`, `fw-t14-overview-3d.png`, `fw-t14-history-dark.png` (in the session's `TEMP`, not committed).

**Not claimed.** The fixtures served a 38-feature catalogue, one published batch per comuna and an empty infrastructure catalogue, so the 3D stage painted the dark topographic plate for comunas without a *read* level (the honest state: a colour is only painted when the session read a canonical level). No axe run, no browser zoom, no text-spacing override, no assistive technology and no real Keycloak round trip were performed, and the live Docker sandbox was reached only for the bundle it serves.

### Public sign-in baseline (historical — retired palette)

The paragraph below records the pre-T10 sign-in measurement and describes the **retired** cream/forest palette (`#fffefa`, `#173c3b`, terracotta ring `rgb(207, 125, 79)`). It is kept as history; the shipped entrance is the dark one measured above.

Chromium rendered the then-current sign-in screen at 1280×720 and 390×844 with HTTP 200, no horizontal overflow and no uncaught page errors. The first Tab focused **Iniciar sesión** and exposed a solid `rgb(207, 125, 79)` outline. The selected tab and auth card computed to `#fffefa`, with selected text `#173c3b` (11.92:1). Screenshots: `tmp/g1-browser-baseline/auth-1280.png` and `tmp/g1-browser-baseline/auth-390.png` (ignored, relative to the worktree).

The gateway and identity endpoints did not respond during that setup. The run did not sign in or exercise workspace routes, gradient contrast, the full tab order or assistive technology. This is not a WCAG conformance report.

## What still needs a browser

- Resolve inherited backgrounds, disabled and focus states, and route-specific overrides in the rendered views. The T14 samples above cover the body, `main` and view backgrounds and every element's computed `background-color` against the four retired cream literals; per-selector foreground/background pairs inside a card were not enumerated.
- Sign-in hero gradients and translucent surfaces are measured from rendered pixels, not from token pairs: see "Mixed surfaces" in the [visual audit](VISUAL-AUDIT.md). The lowest legitimate text sample there is 5.07:1; the only sub-threshold value is a decorative `aria-hidden` glyph.
- The T1 product navigation was measured in Chromium at 1440×900, 1024×720 and 390×800 under an intercepted local fixture; see ["T1 — global product navigation"](VISUAL-AUDIT.md#t1--global-product-navigation-2026-11-26-corrected). Its axe rule subset, text-spacing override and assistive-technology pass were not run.
- The T4 decision screens were measured in an isolated Chromium against fixtures built from the real components at 1440×900, 1280×900, 1024×768 and 390×844; see ["T4 — decision workspace"](VISUAL-AUDIT.md#t4--decision-workspace-2026-11-26).
- The 3D stage's pointer gestures (pan, orbit, tilt, zoom) and its three layer toggles were exercised by the component tests and by the worker's browser runs, not by the T14 viewport/contrast/interaction sweep; the sweep asserted the stage's projection mode, canvas pixels, catalogue length and badge.
- Browser zoom, text-spacing overrides, axe and assistive technology remain unrun for T10–T14. The live authenticated application against a real Keycloak realm was not exercised.
