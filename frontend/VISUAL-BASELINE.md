# FireWatch frontend visual baseline

Use this document to audit the real frontend before changing styles. The committed prototype in `docs/pitch-g1-design` (`d651459`) is a reference for layout and hierarchy, not a reason to port fixtures or replace working product behavior.

Source: [tokens](src/styles/tokens.css), [workspace styles](src/styles/app.css), and [sign-in styles](src/styles/auth.css) at the local baseline `742e760`. The inventory adapts the active-source sections of `design/system.md` from the prototype branch; it does not adopt its experimental aerial palette.

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
| Interface label | `12px` (`nav-link`, inputs), `11px` (`small-label`, body-ish), `10px` (buttons, tables, chips, notes), `9px` (table headers, data lists, sidebar meta), `8px` (badges, legend labels, technical notice) | `app.css` |
| Smallest label | `7px` / `850` / tracking `.08em` for `.source-label` | `app.css` |
| Eyebrow / nav group | `9px` / `800` / tracking `1.4–1.5px` / uppercase | `app.css` `.eyebrow`, `.nav-group` |
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
| Controls | `8px 11px` buttons, min-height `34px` (`29px` secondary); `9px 11px` inputs; `11px 13px` nav links; `5px 8px` chips and badges; `7px 11px` zone chip |
| Auth | Card padding `30px 30px 24px`; hero `44px clamp(28px, 5vw, 72px) 36px`; primary/Google min-height `46px`; tabs `36px`; steps gap `10px` |

Breakpoints: `1200px`, `1000px`, `720px` in `app.css`; `900px` and `420px` in `auth.css`. The map viewport drops from `298px` min-height to `250px` and then `220px`.

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
| `#c3d6cf` nav link on `--forest-900 #173c3b` | `#c3d6cf` | `#173c3b` | 7.93:1 | Meets 4.5:1 |
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

## What still needs a browser

- Resolve inherited backgrounds, disabled and focus states, and route-specific overrides in the rendered views. For example, Actions already overrides some chip and tag colors, so their base ratios do not describe every view.
- Sign-in hero gradients and translucent sidebar surfaces are now measured from rendered pixels, not from token pairs: see "Mixed surfaces" in the [visual audit](VISUAL-AUDIT.md). The lowest legitimate text sample is 5.07:1; the only sub-threshold value is a decorative `aria-hidden` glyph.
- Capture the eight production views before restyling, then verify the same states and viewports after changes. Include keyboard focus, zoom and data loading, empty and error states where applicable.

### Public sign-in baseline

Chromium rendered the locally built sign-in screen at 1280×720 and 390×844 with HTTP 200, no horizontal overflow and no uncaught page errors. The first Tab focused **Iniciar sesión** and exposed a solid `rgb(207, 125, 79)` outline. The selected tab and auth card computed to `#fffefa`, with selected text `#173c3b` (11.92:1). Screenshots: `tmp/g1-browser-baseline/auth-1280.png` and `tmp/g1-browser-baseline/auth-390.png` (ignored, relative to the worktree).

The gateway and identity endpoints did not respond during setup. The run did not sign in or exercise workspace routes, gradient contrast, the full tab order or assistive technology. This is not a WCAG conformance report. No application behavior or palette was changed.
