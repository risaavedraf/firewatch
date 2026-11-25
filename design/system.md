# FireWatch design system — source-backed baseline (T1)

**What this is:** the T1 baseline of [`odd/tasks/v1-gentle-design.md`](../odd/tasks/v1-gentle-design.md), synced from the **active** frontend only. It records what the shipped product already uses so T2–T4 can design with real values instead of inventing a system. It is a capture, not a redesign.

**State:** baseline only. `design/system.html` is the system board; no direction board exists yet and T2–T4 are still pending. Nothing under `frontend/` was modified, and this baseline makes no change to behaviour, role policy, sign-in or authorization.

**Counted result:** the active token file declares **27** CSS custom properties — **14 palette**, **10 level**, **3 structure**. No other token file or `@theme` block exists in the active frontend.

## Sources

Only the active frontend was read. Paths are relative to the repository root.

| Path | What it contributed | Status |
| --- | --- | --- |
| [`frontend/src/styles/tokens.css`](../frontend/src/styles/tokens.css) | All 27 custom properties: forest palette, canvas/paper/ink/muted/line/soft, terracotta and gold, `--radius`, `--shadow`, `--font`, and the ten `--level-*` colours. Also `color-scheme: light`. | active, authoritative |
| [`frontend/src/styles/app.css`](../frontend/src/styles/app.css) | Shell and component rules, in-use type sizes and weights, padding/gap values, literal radii, component surfaces and borders, focus ring, breakpoints, reduced-motion rule. | active, authoritative |
| [`frontend/src/styles/auth.css`](../frontend/src/styles/auth.css) | The sign-in/sign-up layout: split hero, auth card, tabs, primary button, steps, status and privacy copy, auth breakpoints. | active, authoritative |
| [`frontend/src/app/routes.ts`](../frontend/src/app/routes.ts) | The eight route ids, hashes, labels, groups, titles and icons. | active, authoritative |
| [`frontend/src/components/Shell.tsx`](../frontend/src/components/Shell.tsx) | Shell landmarks, navigation grouping, gateway readiness card, session card, zone chip, update bar, skip link, footer. | active, authoritative |
| [`frontend/src/components/ui.tsx`](../frontend/src/components/ui.tsx) | Presentation primitives: `Icon`, `Chip`, `Metric`, `PanelHeading`, `DataList`, `StatusCopy`, `EmptyState`, `UnimplementedNote`, `UnimplementedBadge`. | active, authoritative |
| [`frontend/src/App.tsx`](../frontend/src/App.tsx), [`frontend/src/views/AuthView.tsx`](../frontend/src/views/AuthView.tsx) | The AUTH gate and the sign-in/sign-up screen. | active, authoritative |
| `frontend/src/views/*.tsx` | What each mounted screen is for; see [Routes](#routes-and-auth-purposes) below. | active, authoritative |
| `frontend/index.html` | `lang="es"`, `theme-color #173c3b`, and no font or external asset reference. | active, authoritative |
| `odd/urgent/rediseno-pagina/referencia-mockup/frontend/styles/tokens.css` and `.../gateway-web/proposal.css` | Historical snapshots. Only the directory entries were observed; their contents were **not** read and nothing here is taken from them. | excluded, **not authoritative** |

Why the snapshots are excluded: the user-approved scope for T1 says the sync must read and record active sources only, with no assumption taken from the withdrawn designs under `odd/urgent/rediseno-pagina/`. The current `tokens.css` comments already describe the ported palette, so the values below stand on the active file alone.

## Palette

Every row is one declared custom property. Value is copied from `tokens.css`; the last column names where it is actually used in the active styles.

| Token | Value | Source | In use |
| --- | --- | --- | --- |
| `--forest-950` | `#102c2d` | `frontend/src/styles/tokens.css` | Map selection stroke, auth panel heading. |
| `--forest-900` | `#173c3b` | `frontend/src/styles/tokens.css` | Sidebar surface, primary button, active nav label, toast, auth hero base. |
| `--forest-700` | `#285e56` | `frontend/src/styles/tokens.css` | Links, eyebrows, map labels, primary hover, selected-row accent, guard citations. |
| `--forest-500` | `#638579` | `frontend/src/styles/tokens.css` | Metric icons, zone-chip glyph, lock mark, auth accent. |
| `--canvas` | `#f5f5ef` | `frontend/src/styles/tokens.css` | Page background, auth page background. |
| `--paper` | `#fffefa` | `frontend/src/styles/tokens.css` | Panels, cards, topbar, inputs, button label on forest, toast text. |
| `--ink` | `#233b39` | `frontend/src/styles/tokens.css` | Body text, table values, data-list values. |
| `--muted` | `#5c6c65` | `frontend/src/styles/tokens.css` | Notes, captions, labels, secondary metadata. |
| `--line` | `#dde3da` | `frontend/src/styles/tokens.css` | Panel, card, topbar, footer and table borders; dividers. |
| `--soft` | `#eef1e9` | `frontend/src/styles/tokens.css` | Base chip, table selected row, secondary-button hover, auth tabs track. |
| `--terracotta` | `#a74d34` | `frontend/src/styles/tokens.css` | Attention metric value, auth link, auth error text, risk error text. |
| `--terracotta-soft` | `#f7e9e2` | `frontend/src/styles/tokens.css` | High/insufficient chip background, auth error surface. |
| `--gold` | `#85691e` | `frontend/src/styles/tokens.css` | Auth step number, gold accent text. |
| `--gold-soft` | `#f7f0d9` | `frontend/src/styles/tokens.css` | Medium/pending/queued/stale chip and admin tag background; warning banner. |

## Level palette

The level palette is part of the tokens because map fills, legend swatches and chips must not drift apart. Fill and line are both declared.

| Token | Value | Source | In use |
| --- | --- | --- | --- |
| `--level-low-fill` | `#84ab8e` | `frontend/src/styles/tokens.css` | Map fill for `bajo`, legend swatch `swatch-bajo`. |
| `--level-low-line` | `#5c8467` | `frontend/src/styles/tokens.css` | Stroke of the low fill and its legend swatch border. |
| `--level-medium-fill` | `#d0b756` | `frontend/src/styles/tokens.css` | Map fill for `medio`, legend swatch `swatch-medio`. |
| `--level-medium-line` | `#a99850` | `frontend/src/styles/tokens.css` | Stroke of the medium fill and its legend swatch border. |
| `--level-high-fill` | `#c77454` | `frontend/src/styles/tokens.css` | Map fill for `alto`, legend swatch `swatch-alto`. |
| `--level-high-line` | `#b36647` | `frontend/src/styles/tokens.css` | Stroke of the high fill and its legend swatch border. |
| `--level-unknown-fill` | `#c3cbcd` | `frontend/src/styles/tokens.css` | Map fill for `desconocido` (published, information-insufficient level). |
| `--level-unknown-line` | `#6b7a80` | `frontend/src/styles/tokens.css` | Stroke of the unknown fill and its legend swatch border. |
| `--level-neutral-fill` | `#e6ecea` | `frontend/src/styles/tokens.css` | Map fill when there is no published level at all. |
| `--level-neutral-line` | `#9fb3ab` | `frontend/src/styles/tokens.css` | Stroke of the neutral fill and its legend swatch border. |

The app also uses literal chip surfaces tied to the same meanings: high/insufficient `#f7e9e2` + `#9c472f`, medium/pending `#f7f0d9` + `#7f641e`, low/current `#e7f0e6` + `#396246`, candidate `#e3efef` + `#32686a`. Those are declared in `app.css`, not as tokens.

## Structure tokens

| Token | Value | Source | In use |
| --- | --- | --- | --- |
| `--radius` | `12px` | `frontend/src/styles/tokens.css` | Panels and metric cards only. |
| `--shadow` | `0 3px 14px rgb(24 52 40 / 3%)` | `frontend/src/styles/tokens.css` | Panels and metric cards. |
| `--font` | `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | `frontend/src/styles/tokens.css` | Body and all UI text; `main.tsx` imports it through the token file. |

## Typography

There is **no standalone type scale**: no font-size, line-height or weight token exists. The only typography token is `--font`. Sizes and weights are declared per selector in `app.css` and `auth.css`, with literals only.

**Font families actually in use:** the `--font` stack above; `Georgia, serif` for the brand mark glyph (`app.css`); and `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` for the permissions roles and guard citations (`app.css`). `code` uses the platform monospace default at 11 px.

**Inter is declared, not loaded.** No `@font-face`, `@import`, font package or font `<link>` exists in the active frontend or in `frontend/index.html`. The product therefore renders with the platform fallbacks of the stack. The standalone board ships no font file either and was not rendered with Inter.

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

## Component surfaces and borders declared as literals

These are not tokens, but they are real, in-use component values and the board renders them. Recording them keeps the board from introducing colours the product does not have.

| Value | Role | Source |
| --- | --- | --- |
| `#d7aa73` | Brand-mark background, auth kicker accent | `app.css` `.brand-mark`; `auth.css` `.auth-kicker` |
| `#f0eee0` | Active navigation background and border | `app.css` `.nav-link.is-active` |
| `#41625b` | Sidebar workspace/health-card border | `app.css` |
| `#36564e` | Workspace-mark background | `app.css` |
| `#90aaa0` | Navigation group label | `app.css` |
| `#c3d6cf` | Navigation link label | `app.css` |
| `#d5e1db` | Sidebar base text | `app.css` |
| `#f6fff9` | Brand strong and auth hero title | `app.css` `.brand strong`; `auth.css` |
| `#acbfb6` | Workspace subtitle text | `app.css` `.workspace small` |
| `#ebd8b4` | Workspace-mark glyph | `app.css` `.workspace-mark` |
| `#e7faf5` | Health head and session strong text | `app.css` |
| `#a5c8bf` | Health-card copy | `app.css` `.health-card p` |
| `#82aba2` | Session detail text | `app.css` `.session-card small` |
| `#a1b3ae` | Health dot, idle state | `app.css` `.health-dot` |
| `#b9cfc6` | Auth hero paragraph | `auth.css` `.auth-hero-copy > p` |
| `#9fbcb2` | Auth scope statement | `auth.css` `.auth-scope` |
| `#edf1f2` | Neutral tag and count-badge background | `app.css` |
| `#64747a` | Neutral tag text | `app.css` |
| `#f3f4ed` | Table header background | `app.css` th |
| `#edf0e7` | Table cell border | `app.css` td |
| `#f9faf4` | Table row hover | `app.css` tbody tr:hover |
| `#eef1ee` | Data-list row divider | `app.css` `.data-list > div` |
| `#eef2e8` | Map viewport background | `app.css` `.map-viewport` |
| `#d4dfd0` | Map viewport border | `app.css` `.map-viewport` |
| `#f8faf7` | Risk-state card background | `app.css` `.risk-state` |
| `#fcf6f0`, `#ead9ca` | Attention metric background and border | `app.css` `.metric-attention` |
| `#e8e9df`, `#a1b49d` | Factor bar track and fill | `app.css` `.factor-track` |
| `#e7f0e6`, `#396246` | Low/current chip surface and text | `app.css` `.chip-low` family |
| `#e3efef`, `#32686a` | Candidate/in-progress chip surface and text | `app.css` `.chip-candidate` family |
| `#e8f5ef`, `#236852`, `#2f9b70` | Dataset badge surface, text and dot | `app.css` `.dataset-badge` |
| `#faf7ee`, `#c8bda0`, `#7d6c3f` | Unimplemented marker and technical notice | `app.css` |
| `#f0dfb9`, `#705d35`, `#5f4717`, `#c69b48` | Warning banner border, text, strong text, icon border | `app.css` `.warning-banner` |
| `#dfe8d8`, `#eef3ea`, `#56705d` | Inline notice border, surface, text | `app.css` `.inline-notice` |
| `#ced8cb`, `#8a968b` | Input border and placeholder | `app.css` input |
| `#cf7d4f` | Focus ring (`outline: 3px solid`, offset `2px`) | `app.css` focus rules |
| `#0b2421`, `#bdd8d1`, `#a6e1d4` | Demonstration strip, still declared in `app.css` but no longer rendered by `Shell` | `app.css` `.demo-strip` |

## Component rules

The board reproduces these as samples. The rules are the active ones, not proposals.

- **Shell.** Skip link first; sticky sidebar `234px` on `--forest-900`; brand mark is a Georgia italic `F` on `#d7aa73`; grouped navigation (`Prevención`, `Información`, `Acceso`, `Coordinación`); workspace block; gateway readiness card with `role="status"` and an update button; session card with the single sign-out control, hidden while signed out. Topbar `--paper` with breadcrumbs, route title, zone chip. Update bar carries the settled-review sentence and the discreet synthetic-input notice. Footer carries the API scope sentence and the reset-filters button.
- **Buttons.** `.primary-button` / `.secondary-button` share min-height `34px`, `8px 11px`, `1px solid var(--line)`, radius `7px`, `10px/700`. Primary is `--forest-900` surface with `#fcfcf2` text, hover `--forest-700`; secondary is `--paper` with `--forest-700` text, hover `--soft`, min-height `29px`; text buttons are transparent with `--forest-700` and hover `--soft`; disabled is `opacity: .48` and `cursor: not-allowed`.
- **Chips.** Inline-flex, `4px 8px`, radius `5px`, `10px/550`, a 5 px dot, base `--soft` + `#65736b`. Tones: high/insufficient `--terracotta-soft`/`#9c472f`; medium/pending/queued/stale `--gold-soft`/`#7f641e`; low/current/reviewed/published/active/sufficient/closed `#e7f0e6`/`#396246`; candidate/in-progress `#e3efef`/`#32686a`. Inside `#actions`, chips and neutral tags are overridden to `--ink` for contrast.
- **Badges and tags.** `8px/850`, tracking `.06em`, radius `6px`, `5px 8px`: dataset badge, neutral tag, count badge, admin tag (`--gold-soft`/`#755a22`), small label (`--line` border, `--muted`, weight `600`).
- **Notices.** Warning banner (`--gold-soft`, `#f0dfb9` border, radius `10px`, `10px/1.65`); inline notice (`#eef3ea`, `#dfe8d8` border, radius `7px`, `11px`); unimplemented marker (dashed `#c8bda0`, `#faf7ee`, `8px/800`, uppercase `NO IMPLEMENTADO`); technical notice (same surface, `8px/800`, always visible, links to `#sources`).
- **Panels and cards.** `--paper`, `1px solid --line`, `--radius`, `--shadow`, overflow hidden; panel body `18px`; heading `20px 22px 17px` with eyebrow, title and optional badge. Emphasis comes from alignment and one surface, not from nesting cards.
- **Metrics.** Four-column grid (`16px` gap), `17px 19px 15px` padding, label `11px` muted with icon, value `25px/550`, note `10px` muted. The attention variant uses `#fcf6f0`/`#ead9ca` and terracotta value. Cards exist only where the number answers a decision.
- **Data lists.** Definition list with `8px 0` rows, `9px`, `--muted` label, `--ink/700` right-aligned value capped at `64%`, `#eef1ee` divider, no trailing border on the last row.
- **Tables.** Header `9px/550`, uppercase, tracking `.4px`, `--muted` on `#f3f4ed`, top and bottom `--line`; cells `10px`, `12px 14px`, `#edf0e7` bottom border; row hover `#f9faf4`; selected row `--soft` plus `inset 3px 0 0 --forest-700` on the first cell. Long identifiers wrap, never truncate. Tables scroll inside `.table-wrap` with the same 3 px focus ring.
- **Forms.** Inputs and selects `12px`, `9px 11px`, `1px solid #ced8cb`, radius `6px`, `--paper`, placeholder `#8a968b`; labels `10–11px` muted, or `9px/800` in scenario and map toolbars. `prefers-reduced-motion` removes transitions.
- **Map.** Viewport `#eef2e8` with `#d4dfd0` border, radius `9px`, min-height `298px`; level fills and strokes from the level tokens; selected zone stroke `--forest-950` at `3px`; keyboard focus on a zone uses a black dashed `5px` stroke; legend swatches `12px` radius `3px` with muted textual labels; map insets and source/attribution block beneath.
- **Risk panel.** Pill on `--soft`; state card on `#f8faf7` with `42px` symbol, `15px` strong and `8px` muted note; factor rows with a `57px` bar track (only when a real contribution exists). Failure and success text use the dark terracotta/forest literals, not raw red/green.
- **Health and session states.** `8px` dots: neutral, `#67c99a` ready, `#d77b67` down, always paired with the status sentence; session mark uses `#d2ad63`.
- **Toast.** Fixed bottom-right, `--forest-900` on `--paper`, radius `9px`, `12px`, `0 8px 30px rgb(16 44 45 / 19%)`, becomes visible with opacity/translate transition. Reduced motion removes it.
- **Auth screen.** Two-column grid on `--canvas`; forest hero with token-only gradients and contour lines drawn by gradients; paper card `min(420px, 100%)`, radius `16px`, padding `30px`; tabs `36px` with the selected tab on `--paper`; primary action `46px`; steps numbered on `--gold-soft` with `--gold`; error line on `--terracotta-soft`; privacy note under a `--line` divider. The screen renders no credential field at all.

## Risk presentation

Risk is never colour alone. The map legend carries text, and the level labels come from `frontend/src/domain/risk-level.ts` and `frontend/src/components/map/MapPanel.tsx`:

| Meaning | Fill / line tokens | Visible label | Source |
| --- | --- | --- | --- |
| Low | `--level-low-fill` / `--level-low-line` | `BAJO` | `MapPanel.tsx`, `risk-level.ts` |
| Medium | `--level-medium-fill` / `--level-medium-line` | `MEDIO` | `MapPanel.tsx`, `risk-level.ts` |
| High | `--level-high-fill` / `--level-high-line` | `ALTO` | `MapPanel.tsx`, `risk-level.ts` |
| Unclassified but published | `--level-unknown-fill` / `--level-unknown-line` | `INFORMACIÓN INSUFICIENTE` | `MapPanel.tsx`, `risk-level.ts` |
| No assessment | `--level-neutral-fill` / `--level-neutral-line` | `Sin evaluación para esta zona` | `MapPanel.tsx` |

Machine values are `bajo`, `medio`, `alto` and `desconocido`; anything else renders as `SIN CLASIFICAR`. `desconocido` is information-insufficient, not a severity, and the neutral fill is the absence of an assessment, not a low level.

## Measured contrast

Ratios below were computed from the declared hex values with the WCAG relative-luminance formula. They are measurements of the pairs shipped in the active styles, **not a certification** of WCAG AA conformance. Alpha surfaces and gradients, browser rendering, zoom and real content were not exercised; no browser or automated accessibility tool was run. Where a pair is below the applicable target, it is marked as a finding, not corrected here.

Text pairs (normal text target 4.5:1):

| Pair | Ratio | Read |
| --- | --- | --- |
| `--ink #233b39` on `--paper #fffefa` | 11.85:1 | meets 4.5:1 |
| `--ink #233b39` on `--canvas #f5f5ef` | 10.93:1 | meets 4.5:1 |
| `--muted #5c6c65` on `--paper #fffefa` | 5.49:1 | meets 4.5:1 |
| `--muted #5c6c65` on `--canvas #f5f5ef` | 5.07:1 | meets 4.5:1 |
| `--muted #5c6c65` on `--soft #eef1e9` | 4.86:1 | meets 4.5:1 |
| `--muted #5c6c65` on `#edf1f2` tag grey | 4.87:1 | meets 4.5:1 |
| `--muted #5c6c65` on `#eef2e8` map surface | 4.88:1 | meets 4.5:1 |
| `--forest-700 #285e56` on `--paper #fffefa` | 7.36:1 | meets 4.5:1 |
| `--paper #fffefa` on `--forest-900 #173c3b` | 11.92:1 | meets 4.5:1 |
| `#fcfcf2` primary label on `--forest-900 #173c3b` | 11.65:1 | meets 4.5:1 |
| `#c3d6cf` nav link on `--forest-900 #173c3b` | 7.93:1 | meets 4.5:1 |
| `#a8c2b7` brand tagline on `--forest-900 #173c3b` | 6.34:1 | meets 4.5:1 |
| `#7d6c3f` unimplemented notice on `#faf7ee` | 4.79:1 | meets 4.5:1 |

Status chips and tags (normal text target 4.5:1):

| Pair | Ratio | Read |
| --- | --- | --- |
| `#9c472f` on `--terracotta-soft #f7e9e2` | 5.28:1 | meets 4.5:1 |
| `#7f641e` on `--gold-soft #f7f0d9` | 4.92:1 | meets 4.5:1 |
| `#396246` on `#e7f0e6` | 5.98:1 | meets 4.5:1 |
| `#32686a` on `#e3efef` | 5.37:1 | meets 4.5:1 |
| `#65736b` base chip on `--soft #eef1e9` | 4.36:1 | **below 4.5:1** |
| `#64747a` neutral tag on `#edf1f2` | 4.27:1 | **below 4.5:1** |

Focus ring and risk marks (non-text target 3:1; fill vs fill is informational):

| Pair | Ratio | Read |
| --- | --- | --- |
| `#cf7d4f` focus ring on `--canvas #f5f5ef` | 2.86:1 | **below 3:1** |
| `#cf7d4f` focus ring on `--paper #fffefa` | 3.11:1 | meets 3:1 |
| `#cf7d4f` focus ring on `--forest-900 #173c3b` | 3.84:1 | meets 3:1 |
| `--forest-950 #102c2d` selection stroke on `--level-high-fill #c77454` | 4.26:1 | meets 3:1 |
| `--forest-950 #102c2d` selection stroke on `--level-low-fill #84ab8e` | 5.77:1 | meets 3:1 |
| `--level-high-fill #c77454` on `#eef2e8` map surface | 3.06:1 | meets 3:1 |
| `--level-low-fill #84ab8e` on `#eef2e8` map surface | 2.26:1 | **below 3:1** |
| `--level-medium-fill #d0b756` on `#eef2e8` map surface | 1.75:1 | **below 3:1** |
| `--level-unknown-fill #c3cbcd` on `#eef2e8` map surface | 1.45:1 | **below 3:1** |
| `--paper #fffefa` label on `--level-high-fill #c77454` | 3.44:1 | **below 4.5:1** |
| `--ink #233b39` label on `--level-high-fill #c77454` | 3.45:1 | **below 4.5:1** |
| `--paper #fffefa` label on `--level-medium-fill #d0b756` | 1.97:1 | **below 4.5:1** |
| `--ink #233b39` label on `--level-low-fill #84ab8e` | 4.67:1 | meets 4.5:1 |
| `--ink #233b39` label on `--level-medium-fill #d0b756` | 6.03:1 | meets 4.5:1 |
| `--ink #233b39` label on `--level-unknown-fill #c3cbcd` | 7.26:1 | meets 4.5:1 |
| `--ink #233b39` label on `--level-neutral-fill #e6ecea` | 9.99:1 | meets 4.5:1 |

Findings recorded, not fixed in T1:

1. The base `.chip` label is 4.36:1 at 10 px; `#actions` already overrides it to `--ink`, but other views keep the base value.
2. The neutral tag is 4.27:1 at 8 px; `#actions` overrides it too, other views do not.
3. The focus ring is 2.86:1 on `--canvas`, below the 3:1 non-text target; it passes on paper and on the sidebar.
4. All level fills except high are below 3:1 against the map surface, and the level strokes are 1.23–2.70:1 against their own fills. The legend therefore carries textual labels, and the board never relies on fill alone.
5. The high fill cannot carry normal-size text in either ink (3.45:1) or paper (3.44:1); labels sit beside the swatch, as the app's legend does.

## Routes and AUTH purposes

From `frontend/src/app/routes.ts`; eight routes in four navigation groups. The hash is the only router state, on purpose.

| Hash | Label (Spanish) | Group | View | Purpose |
| --- | --- | --- | --- | --- |
| `#overview` | Territorio | Prevención | `OverviewView.tsx` | Estado de la zona: consolidated metrics, the territorial map and the latest published batch with its evidence, validity and recommendations. |
| `#history` | Historial de lotes | Prevención | `HistoryView.tsx` | Published-batch rows for the selected zone only; search and data-status filters narrow those rows in memory. |
| `#actions` | Acciones preventivas | Prevención | `ActionsView.tsx` | Preventive actions: list, detail with history, creation, transitions, evidence, review and reassessment; this is also where the responsible selector (`V1-U-04`) is designed in T2. |
| `#sources` | Fuentes y servicios | Información | `SourcesView.tsx` | Scope declaration, provenance reproduced verbatim, restriction text, integrity line and service/pipeline status. |
| `#jobs` | Procesamiento | Información | `JobsView.tsx` | Request one synthetic batch for the selected zone, poll the job with bounded reads and correlate the published batch. |
| `#pending` | Aún no implementado | Información | `PendingView.tsx` | Inventory of the seven capabilities the backend cannot back; nothing is simulated. |
| `#session` | Sesión y permisos | Acceso | `SessionView.tsx` | Keycloak sign-in control plus the documentation matrix of which server-verified role may do what, and the role this token declares. |
| `#audit` | Registro de actividad | Coordinación | `AuditView.tsx` | Admin-only `/v1/audit` register with `actor_id`, `action`, `job_id`, `trace_id`, `occurred_at`; a 403 is rendered explicitly. |

Groups: Prevención 3, Información 3, Acceso 1, Coordinación 1. A hash nobody declared falls back to `#overview`, and the address bar is corrected.

**AUTH.** `App.tsx` shows `AuthView.tsx` instead of the workspace whenever there is no established session, and returns to it on logout, a refused callback or a 401. This is a presentation gate, not an authorization boundary: it asks whether a token exists, never which role it declares. `AuthView.tsx` is presented as `Iniciar sesión` / `Crear cuenta`, both the same Keycloak Authorization Code + PKCE round trip; `#registro` opens the sign-up tab directly; the Google option appears only when the build enables it. The screen renders no username, password or e-mail field — Keycloak is the only place a credential is typed — and it states that the realm, not the page, assigns roles and that the server verifies them on every request. The token stays in memory; no token is persisted and no cookie is sent. `SessionView.tsx` reuses the same sign-in control and adds the permission matrix; it deliberately has no role picker, because a page cannot grant a permission.

## Gaps and limits

- No standalone typography, spacing or z-index tokens exist; those values are literals documented above, not a scale to extend blindly.
- Future directions may use these existing tokens more expressively; they must not present values the active frontend does not declare as project tokens.
- Inter is declared but never loaded; any board or implementation check must use the system fallbacks.
- Contrast was computed from declared hex values only. Alpha surfaces, gradients, focus rendering, zoom and real content were not measured.
- No browser, screenshot or visual inspection was performed for this baseline. The board's layout was written from the declared rules and was not seen rendered.
- Historical snapshots under `odd/urgent/rediseno-pagina/referencia-mockup/` were not read and contribute nothing here.
- This baseline does not open the Gentle Design canvas, create a direction board or commit anything; those stay with the parent.

## Board

[`design/system.html`](system.html) is the 1440 px standalone board. It mirrors the 27 declared properties, renders the in-use type and spacing values, the radius and shadow samples, the core components and the 35 measured ratios, with Spanish visible labels and no external asset, font or script.
