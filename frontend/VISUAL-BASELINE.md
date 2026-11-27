# FireWatch frontend visual baseline

Use this document to audit the real frontend before changing styles. The committed prototype in `docs/pitch-g1-design` (`d651459`) is a reference for layout and hierarchy, not a reason to port fixtures or replace working product behavior.

Source: [tokens](src/styles/tokens.css), [workspace styles](src/styles/app.css), [product navigation](src/styles/product-nav.css), [sign-in styles](src/styles/auth.css), the [aerial workspace styles](src/styles/aerial-workspace.css), the [territorial coverage styles](src/styles/territorial-coverage.css) and the [decision workspace styles](src/styles/decision-workspace.css) at the local baseline `742e760`, plus the T1 navigation change, the T2 aerial workspace, the T3 coverage board and the T4 decision workspace on 2026-11-26. The inventory adapts the active-source sections of `design/system.md` from the prototype branch; it does not adopt its experimental aerial palette.

## Palette

Every row is one declared custom property. Value is copied from `tokens.css`; the last column names where it is actually used in the active styles.

| Token | Value | Source | In use |
| --- | --- | --- | --- |
| `--forest-950` | `#102c2d` | [`tokens.css`](src/styles/tokens.css) | Map selection stroke, auth panel heading. |
| `--forest-900` | `#173c3b` | [`tokens.css`](src/styles/tokens.css) | Sidebar surface, primary button, active nav label, toast, auth hero base. |
| `--forest-700` | `#285e56` | [`tokens.css`](src/styles/tokens.css) | Links, eyebrows, map labels, primary hover, selected-row accent, guard citations. |
| `--forest-500` | `#638579` | [`tokens.css`](src/styles/tokens.css) | Metric icons, zone-chip glyph, lock mark, auth accent. |
| `--canvas` | `#f5f5ef` | [`tokens.css`](src/styles/tokens.css) | Page background, auth page background. |
| `--paper` | `#fffefa` | [`tokens.css`](src/styles/tokens.css) | Panels, cards, topbar, inputs, button label on forest, toast text. |
| `--ink` | `#233b39` | [`tokens.css`](src/styles/tokens.css) | Body text, table values, data-list values. |
| `--muted` | `#5c6c65` | [`tokens.css`](src/styles/tokens.css) | Notes, captions, labels, secondary metadata. |
| `--line` | `#dde3da` | [`tokens.css`](src/styles/tokens.css) | Panel, card, topbar, footer and table borders; dividers. |
| `--soft` | `#eef1e9` | [`tokens.css`](src/styles/tokens.css) | Base chip, table selected row, secondary-button hover, auth tabs track. |
| `--terracotta` | `#a74d34` | [`tokens.css`](src/styles/tokens.css) | Attention metric value, auth link, auth error text, risk error text. |
| `--terracotta-soft` | `#f7e9e2` | [`tokens.css`](src/styles/tokens.css) | High/insufficient chip background, auth error surface. |
| `--gold` | `#85691e` | [`tokens.css`](src/styles/tokens.css) | Auth step number, gold accent text. |
| `--gold-soft` | `#f7f0d9` | [`tokens.css`](src/styles/tokens.css) | Medium/pending/queued/stale chip and admin tag background; warning banner. |

## Level palette

The level palette is part of the tokens because map fills, legend swatches and chips must not drift apart. Fill and line are both declared.

| Token | Value | Source | In use |
| --- | --- | --- | --- |
| `--level-low-fill` | `#84ab8e` | [`tokens.css`](src/styles/tokens.css) | Map fill for `bajo`, legend swatch `swatch-bajo`. |
| `--level-low-line` | `#5c8467` | [`tokens.css`](src/styles/tokens.css) | Stroke of the low fill and its legend swatch border. |
| `--level-medium-fill` | `#d0b756` | [`tokens.css`](src/styles/tokens.css) | Map fill for `medio`, legend swatch `swatch-medio`. |
| `--level-medium-line` | `#a99850` | [`tokens.css`](src/styles/tokens.css) | Stroke of the medium fill and its legend swatch border. |
| `--level-high-fill` | `#c77454` | [`tokens.css`](src/styles/tokens.css) | Map fill for `alto`, legend swatch `swatch-alto`. |
| `--level-high-line` | `#b36647` | [`tokens.css`](src/styles/tokens.css) | Stroke of the high fill and its legend swatch border. |
| `--level-unknown-fill` | `#c3cbcd` | [`tokens.css`](src/styles/tokens.css) | Map fill for `desconocido` (published, information-insufficient level). |
| `--level-unknown-line` | `#6b7a80` | [`tokens.css`](src/styles/tokens.css) | Stroke of the unknown fill and its legend swatch border. |
| `--level-neutral-fill` | `#e6ecea` | [`tokens.css`](src/styles/tokens.css) | Map fill when there is no published level at all. |
| `--level-neutral-line` | `#9fb3ab` | [`tokens.css`](src/styles/tokens.css) | Stroke of the neutral fill and its legend swatch border. |

The app also uses literal chip surfaces tied to the same meanings: high/insufficient `#f7e9e2` + `#9c472f`, medium/pending `#f7f0d9` + `#7f641e`, low/current `#e7f0e6` + `#396246`, candidate `#e3efef` + `#32686a`. Those are declared in `app.css`, not as tokens.

## Structure tokens

| Token | Value | Source | In use |
| --- | --- | --- | --- |
| `--radius` | `12px` | [`tokens.css`](src/styles/tokens.css) | Panels and metric cards only. |
| `--shadow` | `0 3px 14px rgb(24 52 40 / 3%)` | [`tokens.css`](src/styles/tokens.css) | Panels, metric cards and the auth card. |
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
| Topbar title | `20px` / inherits / tracking `-.6px` | `app.css` `.topbar h1` |
| Panel title | `15px` / `600`-family heading, tracking `-.3px` | `app.css` `.panel-heading h3, h2` |
| Section heading | `17px` / `600` / tracking `-.3px`; `24px` for `.intro-row h2` | `app.css` h2 |
| Subheading | `13px` / `650`; `11px` for h4 | `app.css` h3, h4 |
| Interface label | `12px` (product navigation links and items, inputs), `11px` (`small-label`, body-ish), `10px` (buttons, tables, chips, notes), `9px` (table headers, data lists, sidebar meta), `8px` (badges, legend labels, technical notice) | `app.css`, `product-nav.css` |
| Smallest label | `7px` / `850` / tracking `.08em` for `.source-label` | `app.css` |
| Eyebrow / navigation group | `9px` / `800` / tracking `1.4–1.5px` / uppercase | `app.css` `.eyebrow`; `product-nav.css` `.product-nav__group-title`, `.product-nav__panel-title`, `.product-nav__where-label` |
| Metric value | `25px` / `550` / tracking `-.8px` / `1.1` | `app.css` `.metric > strong` |
| Auth hero title | `clamp(30px, 3.4vw, 46px)` / heading / `1.08`, tracking `-1.6px` | `auth.css` `.auth-hero h1` |
| Auth card title | `23px` / heading / tracking `-.8px` | `auth.css` `.auth-panel-body h2` |
| Auth lead / actions | `13px` / `650–700` / `1.5–1.55` | `auth.css` |

Weight range in the stylesheets is `500`, `550`, `600`, `650`, `700`, `800`, `850`; `550` and `850` are deliberate intermediate values, not the usual `400/500/700`. Line-height runs from `1.08` (auth hero) to `1.65` (banners and panel footnotes). Tracking runs from `-1.6px` to `1.6px`.

Distinct declaration counts, for future comparison: `app.css` has 17 distinct `font-size` values and `auth.css` has 10, including the two fluid `clamp()` headings. There is no modular ratio to infer from them, and this baseline does not impose one.

## Spacing

There is **no spacing scale token**. All spacing is literal. The recurring values in the active styles are:

| Context | Values in use |
| --- | --- |
| Page gutters | `34px` horizontal for topbar, update bar, main and footer; `24px` at `≤1200px`; `16px/15px` at `≤720px` |
| Shell | Sidebar `234px` (`208px` at `≤1200px`), min-height `560px`, sticky `100vh`; topbar min-height `75px`; main `min(1500px, 100%)` with `27px 34px 35px` padding |
| Panels | Heading `20px 22px 17px`; body `18px` (`14px` at `≤720px`); `.padded` `22px` |
| Grids | `16px` metric/dashboard/lower gap; `22px` two/three-column and pipeline gap; `20px` job layout; `10px` map stage |
| Dense rows | `8px 0` data-list rows (`5px 0` compact); `11px 14px` table headers; `12px 14px` table cells; `10px 0` quality findings |
| Controls | `8px 11px` buttons, min-height `34px` (`29px` secondary); `9px 11px` inputs; navigation bar `0 10px` shortcuts at min-height `40px` and `3px 8px` panel items at min-height `32px` (`product-nav.css`); `5px 8px` chips and badges; `7px 11px` zone chip |
| Auth | Card padding `30px 30px 24px`; hero `44px clamp(28px, 5vw, 72px) 36px`; primary/Google min-height `46px`; tabs `36px`; steps gap `10px` |

Breakpoints: `1200px`, `1000px`, `720px` in `app.css`; `900px` and `420px` in `auth.css`; `720px` and `480px` in `product-nav.css`. The map viewport drops from `298px` min-height to `250px` and then `220px`.

## Radius

`--radius: 12px` covers panels and metric cards. Everything else is a literal: `3px` legend swatches, `4px` factor track, `5px` chips/risk pills/text buttons, `6px` badges/icon buttons/inputs/technical notice, `7px` nav links/buttons/selects/auth tabs, `8px` skip link/map insets/auth error, `9px` workspace/health card/map viewport/risk state/zone chip/toast, `10px` warning banner/auth tabs track/auth primary and Google button/auth features, `11px` brand mark, `14px` auth card at `≤420px`, `16px` auth card, `50%` dots and step numbers.

## Shadows

`--shadow` is the only shadow token. Literals in use: auth card `0 18px 50px rgb(16 44 45 / 8%), var(--shadow)`; toast `0 8px 30px rgb(16 44 45 / 19%)`; auth selected tab `0 1px 3px rgb(16 44 45 / 12%)`; selected table row `inset 3px 0 0 var(--forest-700)`.

## Source-level contrast

These ratios use WCAG relative luminance for opaque sRGB pairs. Compare before rounding: 4.5:1 for ordinary text, and 3:1 for the listed focus and map boundaries. A low ratio is an audit lead, not proof of a browser failure in every selector or state.

| CSS use | Foreground | Background | Ratio | Threshold |
| --- | --- | --- | --- | --- |
| `--ink #233b39` on `--paper #fffefa` | `#233b39` | `#fffefa` | 11.85:1 | Meets 4.5:1 |
| `--ink #233b39` on `--canvas #f5f5ef` | `#233b39` | `#f5f5ef` | 10.93:1 | Meets 4.5:1 |
| `--muted #5c6c65` on `--paper #fffefa` | `#5c6c65` | `#fffefa` | 5.49:1 | Meets 4.5:1 |
| `--muted #5c6c65` on `--canvas #f5f5ef` | `#5c6c65` | `#f5f5ef` | 5.07:1 | Meets 4.5:1 |
| `--muted #5c6c65` on `--soft #eef1e9` | `#5c6c65` | `#eef1e9` | 4.86:1 | Meets 4.5:1 |
| `--muted #5c6c65` on `#edf1f2` tag grey | `#5c6c65` | `#edf1f2` | 4.87:1 | Meets 4.5:1 |
| `--muted #5c6c65` on `#eef2e8` map surface | `#5c6c65` | `#eef2e8` | 4.88:1 | Meets 4.5:1 |
| `--forest-700 #285e56` on `--paper #fffefa` | `#285e56` | `#fffefa` | 7.36:1 | Meets 4.5:1 |
| `--paper #fffefa` on `--forest-900 #173c3b` | `#fffefa` | `#173c3b` | 11.92:1 | Meets 4.5:1 |
| `#c3d6cf` bar shortcut on `--forest-900 #173c3b` | `#c3d6cf` | `#173c3b` | 7.93:1 | Meets 4.5:1 |
| `#c3d6cf` panel item on `#1e4241` | `#c3d6cf` | `#1e4241` | 7.24:1 | Meets 4.5:1 |
| `#a5c8bf` bar labels on `--forest-900 #173c3b` | `#a5c8bf` | `#173c3b` | 6.65:1 | Meets 4.5:1 |
| `#a5c8bf` panel labels and note on `#1e4241` | `#a5c8bf` | `#1e4241` | 6.08:1 | Meets 4.5:1 |
| `#f0eee0` current panel item on `#1e4241` | `#f0eee0` | `#1e4241` | 9.43:1 | Meets 4.5:1 |
| `#d7aa73` navigation focus ring on the bar | `#d7aa73` | `#173c3b` | 5.66:1 | Meets 3:1 |
| `#d7aa73` navigation focus ring on the panel | `#d7aa73` | `#1e4241` | 5.17:1 | Meets 3:1 |
| `#90aaa0` disclosure boundary on the bar | `#90aaa0` | `#173c3b` | 4.84:1 | Meets 3:1 |
| `#90aaa0` former label on the opaque panel | `#90aaa0` | `#1e4241` | 4.42:1 | **Below 4.5:1 — corrected to `#a5c8bf`** |
| `#e7faf5` disclosure summary and current-location value on `--forest-900 #173c3b` | `#e7faf5` | `#173c3b` | 11.11:1 | Meets 4.5:1 |
| `#a5c8bf` disclosure note on `--forest-900 #173c3b` | `#a5c8bf` | `#173c3b` | 6.65:1 | Meets 4.5:1 |
| `#f0eee0` current grouped item on `--forest-900 #173c3b` | `#f0eee0` | `#173c3b` | 10.32:1 | Meets 4.5:1 |
| `#90aaa0` disclosure control boundary on `--forest-900 #173c3b` | `#90aaa0` | `#173c3b` | 4.84:1 | Meets 3:1 |
| `#d7aa73` navigation focus ring on `--forest-900 #173c3b` | `#d7aa73` | `#173c3b` | 5.66:1 | Meets 3:1 |
| `#a8c2b7` brand tagline on `--forest-900 #173c3b` | `#a8c2b7` | `#173c3b` | 6.34:1 | Meets 4.5:1 |
| `#7d6c3f` unimplemented notice on `#faf7ee` | `#7d6c3f` | `#faf7ee` | 4.79:1 | Meets 4.5:1 |
| `#9c472f` on `--terracotta-soft #f7e9e2` | `#9c472f` | `#f7e9e2` | 5.28:1 | Meets 4.5:1 |
| `#7f641e` on `--gold-soft #f7f0d9` | `#7f641e` | `#f7f0d9` | 4.92:1 | Meets 4.5:1 |
| `#396246` on `#e7f0e6` | `#396246` | `#e7f0e6` | 5.98:1 | Meets 4.5:1 |
| `#32686a` on `#e3efef` | `#32686a` | `#e3efef` | 5.37:1 | Meets 4.5:1 |
| `#65736b` base chip on `--soft #eef1e9` | `#65736b` | `#eef1e9` | 4.36:1 | Below 4.5:1 |
| `#64747a` neutral tag on `#edf1f2` | `#64747a` | `#edf1f2` | 4.27:1 | Below 4.5:1 |
| `#cf7d4f` focus ring on `--canvas #f5f5ef` | `#cf7d4f` | `#f5f5ef` | 2.86:1 | Below 3:1 |
| `#cf7d4f` focus ring on `--paper #fffefa` | `#cf7d4f` | `#fffefa` | 3.11:1 | Meets 3:1 |
| `#cf7d4f` focus ring on `--forest-900 #173c3b` | `#cf7d4f` | `#173c3b` | 3.84:1 | Meets 3:1 |
| `--forest-950 #102c2d` selection stroke on `--level-high-fill #c77454` | `#102c2d` | `#c77454` | 4.26:1 | Meets 3:1 |
| `--forest-950 #102c2d` selection stroke on `--level-low-fill #84ab8e` | `#102c2d` | `#84ab8e` | 5.77:1 | Meets 3:1 |
| `--level-high-fill #c77454` on `#eef2e8` map surface | `#c77454` | `#eef2e8` | 3.06:1 | Meets 3:1 |
| `--level-low-fill #84ab8e` on `#eef2e8` map surface | `#84ab8e` | `#eef2e8` | 2.26:1 | Below 3:1 |
| `--level-medium-fill #d0b756` on `#eef2e8` map surface | `#d0b756` | `#eef2e8` | 1.75:1 | Below 3:1 |
| `--level-unknown-fill #c3cbcd` on `#eef2e8` map surface | `#c3cbcd` | `#eef2e8` | 1.45:1 | Below 3:1 |
| Table header | `#5c6c65` | `#f3f4ed` | 5.01:1 | Meets 4.5:1 |
| Body text on selected row | `#233b39` | `#eef1e9` | 10.47:1 | Meets 4.5:1 |
| Primary hover | `#fcfcf2` | `#285e56` | 7.20:1 | Meets 4.5:1 |
| Nav hover | `#effdf9` | `#254d47` | 9.00:1 | Meets 4.5:1 |
| Selected nav label | `#173c3b` | `#f0eee0` | 10.32:1 | Meets 4.5:1 |
| Dataset badge | `#236852` | `#e8f5ef` | 5.90:1 | Meets 4.5:1 |
| Count badge | `#52646b` | `#edf1f2` | 5.44:1 | Meets 4.5:1 |
| Admin tag | `#755a22` | `#f7f0d9` | 5.68:1 | Meets 4.5:1 |
| Warning banner | `#705d35` | `#f7f0d9` | 5.57:1 | Meets 4.5:1 |
| Warning title | `#5f4717` | `#f7f0d9` | 7.67:1 | Meets 4.5:1 |
| Inline notice | `#56705d` | `#eef3ea` | 4.82:1 | Meets 4.5:1 |
| Attention metric | `#a74d34` | `#fcf6f0` | 5.22:1 | Meets 4.5:1 |
| Technical notice hover | `#7d6c3f` | `#f4efe0` | 4.47:1 | Below 4.5:1 |
| Search placeholder | `#8a968b` | `#fffefa` | 3.05:1 | Below 4.5:1 |
| Table row index on paper | `#879787` | `#fffefa` | 3.06:1 | Below 4.5:1 |
| Auth tab | `#5c6c65` | `#eef1e9` | 4.86:1 | Meets 4.5:1 |
| Selected auth tab | `#173c3b` | `#fffefa` | 11.92:1 | Meets 4.5:1 |
| Auth panel title | `#102c2d` | `#fffefa` | 14.65:1 | Meets 4.5:1 |
| Auth step number | `#85691e` | `#f7f0d9` | 4.56:1 | Meets 4.5:1 |
| Google label | `#1f1f1f` | `#ffffff` | 16.48:1 | Meets 4.5:1 |
| Google label on hover | `#1f1f1f` | `#f7f8f5` | 15.46:1 | Meets 4.5:1 |
| Auth link | `#a74d34` | `#fffefa` | 5.54:1 | Meets 4.5:1 |
| Auth status error | `#a74d34` | `#f7e9e2` | 4.72:1 | Meets 4.5:1 |
| Map low boundary against map surface | `#5c8467` | `#eef2e8` | 3.74:1 | Meets 3:1 |
| Map low selection stroke against fill | `#102c2d` | `#84ab8e` | 5.77:1 | Meets 3:1 |
| Map medium boundary against map surface | `#a99850` | `#eef2e8` | 2.54:1 | Below 3:1 |
| Map medium selection stroke against fill | `#102c2d` | `#d0b756` | 7.46:1 | Meets 3:1 |
| Map high boundary against map surface | `#b36647` | `#eef2e8` | 3.77:1 | Meets 3:1 |
| Map high selection stroke against fill | `#102c2d` | `#c77454` | 4.26:1 | Meets 3:1 |
| Map unknown boundary against map surface | `#6b7a80` | `#eef2e8` | 3.92:1 | Meets 3:1 |
| Map unknown selection stroke against fill | `#102c2d` | `#c3cbcd` | 8.97:1 | Meets 3:1 |
| Map neutral boundary against map surface | `#9fb3ab` | `#eef2e8` | 1.95:1 | Below 3:1 |
| Map neutral selection stroke against fill | `#102c2d` | `#e6ecea` | 12.36:1 | Meets 3:1 |

## Global product navigation (T1)

[`src/components/ProductNav.tsx`](src/components/ProductNav.tsx) replaces the flat sidebar list with the approved canvas' arrangement: a thin horizontal bar above and outside the workspace (`.app-shell`), three always-present shortcuts (`#overview`, `#history`, `#actions`), a **Más destinos** disclosure whose panel is out of flow, and an **Estás en** line naming the open route. The other eleven routes are grouped by the navigation groups declared in [`src/app/routes.ts`](src/app/routes.ts). Every link is derived from `routes`; the canvas' fourth shortcut (Panel ejecutivo) is deferred to T4 because no route serves it yet. The component CSS is [`src/styles/product-nav.css`](src/styles/product-nav.css), scoped to `.product-nav`; `app.css` owns the bar's offset and the shell it sits above.

| Class | Role | Values |
| --- | --- | --- |
| `.product-nav` | Bar above the shell | `position: sticky`, `top: 0`, `min-height: var(--product-nav-h, 48px)` with a local `--product-nav-h: 48px` (the bar never sizes itself from the offset it publishes), `--forest-900`, `3px 16px`, bottom border `#41625b`; `ProductNav` publishes the measured box as `--product-nav-h` on `body` |
| `.product-nav__link` | Always-visible shortcut | visible word `Mapa`/`Historial`/`Acciones`; `aria-label` carries the route label; `12px/1.3`, min-height `40px`, `0 10px`, radius `7px`, `#c3d6cf`; current row `#f0eee0` with `--forest-900` text |
| `.product-nav__summary` | Disclosure control | `button` with `aria-expanded`/`aria-controls`; `12px/650`, min-height `40px`, border `#90aaa0`, `#e7faf5`; expanded `#effdf9` on `#254d47` |
| `.product-nav__panel` | Out-of-flow menu | `position: absolute`, `top: calc(100% + 4px)`, `right: 16px`, `width: min(760px, calc(100% - 24px))`, `max-height: min(70dvh, 520px)`, `overflow-y: auto`, opaque `#1e4241`, `14px 16px`, radius `10px` |
| `.product-nav__item` | Grouped destination | `12px/1.35`, min-height `32px`, `3px 8px`, radius `5px`, `#c3d6cf`; current `#f0eee0`, underlined |
| `.product-nav__group-title`, `.product-nav__panel-title` | Navigation labels | `9px/800`, tracking `1.4px`, uppercase, `#a5c8bf` |
| `.product-nav__note` | Panel footnote | `10px/1.5`, `#a5c8bf` |
| `.product-nav__where` | Current-location line | right-aligned `11px`, value `#e7faf5`, label `#a5c8bf`; visually hidden but still announced below `560px` |
| `.product-nav :is(a, button):focus-visible` | Focus ring | `3px` `#d7aa73`, offset `2px`; bar controls use offset `0` so the ring stays inside the 48px bar |

The panel is opaque instead of translucent: it overlays the light workspace, so its labels are measured against the declared `#1e4241` rather than against whatever happens to be behind it. Layout: `.app-shell` and `.sidebar` reserve `calc(100vh - var(--product-nav-h, 48px))`, and the sidebar sticks at `top: var(--product-nav-h, 48px)`. The `:root` value is a `48px` fallback: `ProductNav` publishes the bar's measured height into `--product-nav-h` on `body`, so a wrapped bar reserves the second row instead of leaving content under it, while the bar's own `min-height` stays `48px` and can return to one row (T4 correction). At `≤720px` the sidebar becomes static and the panel narrows to `calc(100% - 16px)`; at `≤480px` the bar wraps instead of scrolling horizontally — with the T4 shortcuts that is two rows at 320, 340 and 360 px and one row at 390 px (measured).

**Known follow-up.** `scripts/check.mjs` still asserts the old `.sidebar nav` declaration set, and that script is outside this unit's edit surface. The rule remains in `app.css` with no rendered consumer; the gate and the rule should be retired together in a follow-up.

## Aerial workspace (T2)

[`src/styles/aerial-workspace.css`](src/styles/aerial-workspace.css) composes `#overview` as the aerial workspace of the approved board ([`design/firewatch-v1-vuelo/01-vista-aerea.html`](../design/firewatch-v1-vuelo/01-vista-aerea.html)): the map is the canvas, [`AerialWorkstation`](src/components/territory/AerialWorkstation.tsx) is the work rail beside it, and the real published-batch card (`article.panel.risk-panel`, unchanged) is the reading below. Every selector is scoped to `#overview`, so no other route inherits the composition. `MapPanel`, the `ui` primitives, the store, the routes and the API are untouched; the map keeps its owned behaviour and only receives more surface.

**No new palette.** The file declares no colour tokens: it uses `--paper`, `--line`, `--muted`, `--ink`, `--forest-700`, `--forest-900`, `--canvas`, `--radius`, `--shadow` and the shipped focus ring literal `#cf7d4f`. The design board's aerial palette (`design/system.md`, “Aerial prototype palette — experimental, not shipped”) is deliberately not adopted, and the map surface stays `#eef2e8` because a deeper tint pushed the `alto` fill from 3.06:1 to 2.96:1 against its own surface.

| Selector | Role | Declared values |
| --- | --- | --- |
| `#overview .aerial-workspace` | Composition grid | `grid-template-columns: minmax(0, 1fr) minmax(288px, 320px)`; areas `canvas`/`rail`, `result`/`rail`; `gap: 16px`; `margin-bottom: 20px` |
| `#overview .aerial-canvas` | Map column | `grid-area: canvas`; the map card carries no bottom margin of its own |
| `#overview .aerial-canvas .map-stage` | One map track | `minmax(0, 1fr) minmax(0, 190px)`, and a single `minmax(0, 1fr)` track while `.map-insets` is empty (`:has(.map-insets:empty)`) |
| `#overview .aerial-canvas .map-viewport`, `.map-svg` | Canvas surface | `min-height: 440px`, unchanged `#eef2e8` fill; `360px` at `≤1100px`, `260px` at `≤720px` |
| `#overview .aerial-result` | Reading column | `grid-area: result`; the risk card keeps its own padding and drops only `margin-bottom` |
| `#overview .aerial-rail` | Workstation panel | `position: sticky`, `top: calc(var(--product-nav-h, 48px) + 16px)`, `--paper`, `1px solid var(--line)`, `var(--radius)`, `var(--shadow)`, `padding: 16px`, `gap: 10px`; `static` below `1100px` |
| `#overview .aerial-block` | Rail section | `padding-top: 10px`, `1px solid var(--line)` top border, `gap: 8px` |
| `#overview .aerial-rail > h3` / `.aerial-block > h4` | Rail headings | `15px/650`, tracking `-.3px`; `11px/800` in `--ink` |
| `#overview .aerial-state` / `.aerial-note` | State and note | `11px/1.5` `--ink`; `10px/1.55` `--muted` |
| `#overview .aerial-readings dt` / `dd` | Reading rows | `10px` `--muted`; `10px/700` `--ink`, `max-width: 62%`, `overflow-wrap: anywhere` |
| `#overview .aerial-links a` | Rail link | `11px/700`, `--forest-700`, underline, offset `2px`, `min-height: 36px` (`40px` at `≤720px`); focus `outline: 3px solid #cf7d4f`, offset `2px` |

**Breakpoints.** `1100px` turns the two columns into one — `canvas`, `rail`, `result`, in that document order — and releases the sticky rail. `720px` tightens the gap, drops the canvas to `260px` and gives the rail links a `40px` target. The four widths measured in Chromium (1440, 1280, 1024, 390) are recorded in the [visual audit](VISUAL-AUDIT.md#t2--aerial-workspace-2026-11-26).

**Copy rule.** The rail states only facts the views already published: the session's one inflight batch (`jobProgress`), the selected zone's label from the catalogue, the kind of answer the last read settled on, and how many comunas actually carry a read level. It never repeats the level (the card owns it), never infers progress, and links only to routes `src/app/routes.ts` declares. The prototype's per-comuna queue, camera poses, cut-off slider, mock sectors and coordinates have no served data and are not simulated.

## Territorial coverage board (T3)

[`src/styles/territorial-coverage.css`](src/styles/territorial-coverage.css) composes `#infrastructure` as the coverage board of the approved territorial artboards ([`04-cobertura-territorial.html`](../design/firewatch-v1-vuelo/04-cobertura-territorial.html) and [`21-lecturas-por-sector.html`](../design/firewatch-v1-vuelo/21-lecturas-por-sector.html)): the real catalogue map is the canvas, [`CoverageRail`](src/components/territory/CoverageRail.tsx) lists the comunas beside it, the per-type table keeps its shipped columns and the breakdown is unchanged, and two reading panels close the board. Every selector is scoped to `#infrastructure`, so no other route inherits the composition. `InfrastructureMap`, `TableWrap`, the `ui` primitives, the store, the routes and the API are untouched.

**No new palette.** The file declares no colour tokens: it uses `--paper`, `--line`, `--muted`, `--ink`, `--soft`, `--forest-700`, `--forest-900`, `--radius` and the shipped focus ring literal `#cf7d4f`. The board's aerial palette (`design/system.md`, “Aerial prototype palette — experimental, not shipped”) is deliberately not adopted, and the map keeps its `#eef2e8` surface.

| Selector | Role | Declared values |
| --- | --- | --- |
| `#infrastructure .coverage-stage` | Stage grid | `grid-template-columns: minmax(0, 1fr) minmax(230px, 258px)`; `gap: 16px`; `align-items: start` |
| `#infrastructure .coverage-stage-head h3` | Stage title | `15px/650`, tracking `-.3px` — the shipped panel-title weight, not the lighter global `h3` |
| `#infrastructure .coverage-stage-note` | Granularity note | `max-width: 78ch`, `10px/1.6`, `--muted` |
| `#infrastructure .coverage-rail` | Commune rail | `display: grid`, `gap: 10px`, `padding-left: 16px`, `border-left: 1px solid --line`; no nested card surface |
| `#infrastructure .coverage-rail-head h3` | Rail title | `13px/700`, tracking `-.2px`; the count uses the shipped `.count-badge` |
| `#infrastructure .coverage-entry` | Commune button | `display: grid`, `gap: 5px`, `width: 100%`, `min-height: 44px`, `padding: 8px 9px`, radius `7px`, `font: inherit`, `text-align: left`; hover `--soft`; `aria-pressed="true"` adds `--soft` plus `inset 3px 0 0 --forest-700`; focus `outline: 3px solid #cf7d4f`, offset `2px` |
| `#infrastructure .coverage-dots` | Coverage marks | `grid-template-columns: repeat(5, 1fr)`, `gap: 3px`; each dot `4px` high, radius `2px`; on `--forest-700`, off `--line`; decorative (`aria-hidden`) |
| `#infrastructure .coverage-figure` | Coverage figure | `9px/800`, `--forest-700`, `white-space: nowrap` |
| `#infrastructure .coverage-entry-types` | Declared types | `9px/1.45`, `--muted`, `overflow-wrap: anywhere` |
| `#infrastructure .infrastructure-zone-coverage` | Per-commune coverage line | `10px/1.55`, `600`, `--forest-700` |
| `#infrastructure .infrastructure-zone` | Drill-through target | `scroll-margin-top: calc(var(--product-nav-h, 48px) + 14px)`; `[data-active="true"]` paints `--soft`; focus ring as above |
| `#infrastructure .coverage-detail` | Reading row | `grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr)`, `gap: 18px`, `padding-top: 16px`, `border-top: 1px solid --line` |
| `#infrastructure .coverage-reading` | Distinction list | `dl` rows `132px minmax(0, 1fr)`; terms `10px/800 --ink`; descriptions `10px/1.55 --muted` |
| `#infrastructure .coverage-routes a` | Reading link | `11px/700`, `--forest-700`, underline offset `2px`, `min-height: 36px` (`44px` at `≤720px`); focus `outline: 3px solid #cf7d4f`, offset `2px` |

**Breakpoints.** `1180px` folds the stage into one column — canvas first, rail below, in DOM order — because below that width the two columns would shrink the map; the rail's side border becomes a top border. `900px` makes the reading row one column. `720px` tightens the stage gap and gives rail buttons a `10px 8px` padding and the reading links a `44px` target. The four widths measured in Chromium (1440, 1280, 1024, 390) are recorded in the [visual audit](VISUAL-AUDIT.md#t3--territorial-coverage-board-2026-11-26).

**Print.** The board's print rules live in the same file: the rail and the reading-links column are hidden because in-page navigation does not print, the granularity panel stays in black on white, and the shipped `app.css` print block keeps owning the synthetic label, the formula, the table and the breakdown.

**Copy rule.** The rail states only facts the payload carries: each zone is a comuna by CUT code, and "cobertura" is the count of the five declared element types that comuna declares — never a percentage of territory, never a sector reading, never a risk level. A count of zero is described as the fixture declaring no element of that type, not as missing data. The board's sector rows, cut-off slider, environment descriptions and contextual priority are not simulated. Each rail control is a `button type="button"` with `aria-pressed` that moves focus to the commune's breakdown: the rail does not use `#` anchors because the hash is the router's state.

## Decision workspace (T4)

T4 ports the three decision boards — [`07-panel-ejecutivo.html`](../design/firewatch-v1-vuelo/07-panel-ejecutivo.html), [`08-comparar-sectores.html`](../design/firewatch-v1-vuelo/08-comparar-sectores.html) and [`09-notificaciones.html`](../design/firewatch-v1-vuelo/09-notificaciones.html) — to `#executive`, `#compare` and `#notifications`, and adds the real `#executive` route with the bar's fourth shortcut (`Panel ejecutivo`). The three screens share one stylesheet, [`src/styles/decision-workspace.css`](src/styles/decision-workspace.css), and its selectors are either scoped to a view id or to classes only these screens render (`.decision-*`, `.executive-panel`, `.compare-panel`).

**No new palette and no new scale.** The file declares colors only through the existing tokens (`--paper`, `--line`, `--muted`, `--ink`, `--soft`, `--forest-700`, `--level-*`) plus the shipped focus ring literal `#cf7d4f`; the dashed empty mark uses `#c8d2c6` and the card surface keeps the shipped `#f8faf7`. Type uses the in-use sizes (`9`, `10`, `11`, `15`, `16`, `24`, `25px`), spacing the 4px-derived values already in use (`8`, `12`, `16`, `18px`), radius `9px` and the existing `--radius`.

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
| `.notification-empty*` ([`notifications.css`](src/styles/notifications.css)) | Notification empty card (09) | Card `display: grid`, `justify-items: start`, `gap: 8px`, `padding: 24px 22px 26px`, dashed `--line`, radius `9px`, `#f8faf7`; 58px dashed mark; eyebrow `9px/800`; title `16px/650`; copy and two points `10px/1.65 --muted`, `max-width: 68ch` |

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

**No new palette and no new scale.** The file declares colors only through the existing tokens (`--paper`,
`--line`, `--muted`, `--ink`, `--soft`, `--forest-700`, `--level-*-line`) plus the shipped focus-ring literal
`#cf7d4f`, the shipped empty-card surface `#f8faf7` and the `#c8d2c6` dashed mark the notification card already
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
| `#history .history-empty-card` | Empty card (05) | grid, `justify-items: start`, `gap: 6px`, `20px 20px 22px`, dashed `1px #c8d2c6`, radius `9px`, `#f8faf7`; `strong` `15px/650 --ink`; copy `10px/1.65 --muted`, `68ch`; the reset keeps `34px` |
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
the focus ring `#cf7d4f`, the empty-card surface `#f8faf7` and the notification card's dashed mark `#c8d2c6`.
The error tone reuses the shipped `--terracotta-soft` family (`#fdf6ef` surface, `#e0c9b6` border, `#9c472f`
eyebrow) and the filtered tone keeps `--paper` because it is the only card that carries a control. Type stays in
the in-use sizes (8, 9, 10, 11, 13px) and spacing in the 4px-derived values already in use.

| Selector | Role | Declared values |
| --- | --- | --- |
| `.field-state` (scoped to the three ids) | Designed state card (06/10/11) | grid, `justify-items: start`, `gap: 4px`, `14px 16px 16px`, dashed `1px #c8d2c6`, radius `9px`, `#f8faf7`; `strong` `13px/650 --ink`; body `10px/1.6` capped at `78ch`; the eyebrow keeps the shipped rule |
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
| textareas (scoped to the three ids) | Focus ring | `3px solid #cf7d4f`, offset `2px` — the shipped rule lists `input`/`select`/`a`/`[tabindex]` but not `textarea` |

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

## What still needs a browser

- Resolve inherited backgrounds, disabled and focus states, and route-specific overrides in the rendered views. For example, Actions already overrides some chip and tag colors, so their base ratios do not describe every view.
- Sign-in hero gradients and translucent sidebar surfaces are now measured from rendered pixels, not from token pairs: see "Mixed surfaces" in the [visual audit](VISUAL-AUDIT.md). The lowest legitimate text sample is 5.07:1; the only sub-threshold value is a decorative `aria-hidden` glyph.
- The corrected T1 product navigation was measured in Chromium 158 (headless) at 1440×900, 1024×720 and 390×800 under an intercepted local fixture; see ["T1 — global product navigation"](VISUAL-AUDIT.md#t1--global-product-navigation-2026-11-26-corrected). Its axe rule subset, text-spacing override and assistive-technology pass were not run for this change.
- Capture the eight production views before restyling, then verify the same states and viewports after changes. Include keyboard focus, zoom and data loading, empty and error states where applicable.
- The T4 decision screens were measured in an isolated Chromium against fixtures built from the real components at 1440×900, 1280×900, 1024×768 and 390×844; see ["T4 — decision workspace"](VISUAL-AUDIT.md#t4--decision-workspace-2026-11-26). The live authenticated application, the axe subset, browser zoom, text-spacing overrides and assistive technology were not run for T4.

### Public sign-in baseline

Chromium rendered the locally built sign-in screen at 1280×720 and 390×844 with HTTP 200, no horizontal overflow and no uncaught page errors. The first Tab focused **Iniciar sesión** and exposed a solid `rgb(207, 125, 79)` outline. The selected tab and auth card computed to `#fffefa`, with selected text `#173c3b` (11.92:1). Screenshots: `tmp/g1-browser-baseline/auth-1280.png` and `tmp/g1-browser-baseline/auth-390.png` (ignored, relative to the worktree).

The gateway and identity endpoints did not respond during setup. The run did not sign in or exercise workspace routes, gradient contrast, the full tab order or assistive technology. This is not a WCAG conformance report. No application behavior or palette was changed.
