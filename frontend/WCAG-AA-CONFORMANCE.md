# FireWatch WCAG 2.1 AA criterion report

Unit V1-D-04. The eight production views are Overview, History, Actions, Sources, Jobs, Pending, Session and Audit, plus the public sign-in screen. This report lists every WCAG 2.1 A and AA criterion that applies to them, the tool and version that decided it, the date, and the verdict.

**This is not a conformance statement.** It records what was measured, what was only sampled, and what remains unevaluated. A criterion is `Meets` only where a deterministic check covered it and no failure was observed; everything else is qualified.

## Environment

| Item | Value |
| --- | --- |
| Baseline | `742e760` (`origin/dev`), branch `feat/g1-production-frontend` |
| Date | 2026-11-25 |
| Environment | Disposable Compose project `firewatch-g1-audit` (gateway 18380, identity 18381, static web 14375), real admin session through the local Keycloak realm |
| Viewports | 1280×720, 390×844; 320×800 for reflow; 640 CSS px for 200% zoom |
| Verification assets | Ignored scratch under `tmp/g1-browser-baseline/`; no repository dependency was added for any of them |

## Tools

| Tool | Version | Date | Decides |
| --- | --- | --- | --- |
| axe-core | 4.10.3 | 2026-11-25 | Automated rule subset `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`; 16 scans (eight views × two widths) |
| Chromium | 149.0.7827.55 | 2026-11-25 | Rendered evidence: contrast, focus, keyboard, zoom, reflow, accessibility tree |
| Rendered-pixel backdrop probe (`FW_MIXED_SURFACES`) | Repo harness, ignored | 2026-11-25 | 1.4.3 on composited and gradient surfaces; 93 samples |
| @guidepup/virtual-screen-reader | 0.28.0 | 2026-11-25 | Document-order exposure and dynamic announcements |
| Manual source review | — | 2026-11-25 | Token arithmetic, `aria-hidden` judgement, document metadata |

The rendered-pixel probe validates itself against independent arithmetic: it reproduces the documented active-navigation label at 10.32:1, table header at 5.01:1, neutral tag at 4.87:1 (10.51:1 in Actions), sign-in button at 11.65:1 and selected auth tab at 11.92:1.

## Perceivable

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 1.1.1 Non-text Content (A) | Partly met | 16 accessibility-tree snapshots exposed no unnamed control in the sampled roles; decorative glyphs (`.session-mark`, `.lock-mark`, `.zone-chip` glyph) carry `aria-hidden="true"`. Icon-only controls were not exhaustively enumerated. |
| 1.2.1–1.2.5 Time-based Media (A/AA) | Not applicable | No prerecorded audio or video, no captions, no audio description. |
| 1.3.1 Info and Relationships (A) | Partly met | One `main` and one `navigation` landmark per route; heading hierarchy corrected to h1→h2→h3; tables use `th` with a caption. axe leaves `th-has-data-cells` *incomplete* on `#actions-table` because the sampled state had no data rows. Two structural defects remain: the shell footer exposes `contentinfo` nested inside `main`, and the History result count is a bare number with no accessible name. |
| 1.3.2 Meaningful Sequence (A) | Meets (sampled) | Territory leads with the map in both rendered and DOM order, asserted by a public DOM test; reading order recorded by the virtual-screen-reader pass. |
| 1.3.3 Sensory Characteristics (A) | Not evaluated | Instruction copy was not reviewed for reliance on shape, size or position. |
| 1.3.4 Orientation (AA) | Not evaluated | Neither viewport tested locks orientation; both portrait and landscape layouts were rendered at the audited widths. |
| 1.3.5 Identify Input Purpose (AA) | Partly met | Every audited input has a visible label; no `autocomplete` token audit was performed. |
| 1.4.1 Use of Color (A) | Partly met | Risk levels, statuses and action states pair colour with text. Map fills encode level and the level is also stated in the risk card; the legend and inset text were not reviewed for colour-only reliance. |
| 1.4.3 Contrast (Minimum) (AA) | Meets (sampled) | axe-core 4.10.3: zero violations across eight views at two widths. Rendered-pixel probe: 93 samples over the sign-in gradients, translucent sidebar surfaces, tags, table headers, eyebrows and navigation; every text surface meets 4.5:1, or 3:1 for large text. The single sub-threshold sample is the decorative `aria-hidden` `⌑` at 4.03:1. |
| 1.4.4 Resize Text (AA) | Partly met | Chromium tab zoom at 200% (1280→640 CSS px) passed on all eight routes. Text-only resizing — the actual 1.4.4 condition — was not tested; zoom is a proxy. |
| 1.4.5 Images of Text (AA) | Meets (sampled) | No raster text in the shell or the audited views; the brand mark is a text glyph, and headings are real text. |
| 1.4.10 Reflow (AA) | Meets (sampled) | At 320 CSS px all eight routes measured a 320 px document scroll width, and at 200% zoom a 640 px width. Pending, Session and Audit expose one internal horizontal scroller each, reachable with Tab and movable with ArrowRight. |
| 1.4.11 Non-text Contrast (AA) | Partly met | Focus indicators pass (5.11:1, 44 instances). Several map boundaries and fills are documented below 3:1 against the map surface: medium fill 1.75:1, neutral fill 1.45:1, low fill 2.26:1, unknown fill 1.45:1, medium boundary 2.54:1, neutral boundary 1.95:1. Whether a fill is "required to identify" the level in context is a product judgement this pass does not settle. |
| 1.4.12 Text Spacing (AA) | Not evaluated | No text-spacing override test was run. |
| 1.4.13 Content on Hover or Focus (AA) | Not evaluated | No dismissable or hoverable overlay content was tested. |

## Operable

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 2.1.1 Keyboard (A) | Partly met | Verified: primary navigation (8 routes, Tab+Enter), skip link, History search/status/reset, Territory map shapes (Enter and Space), table scrollers, create-form validation. Not verified: every control on every view. |
| 2.1.2 No Keyboard Trap (A) | Meets (sampled) | Tab cycles completed in each audited route without trapping focus; the skip link always returns to the top of the shell. |
| 2.1.4 Character Key Shortcuts (A) | Not evaluated | No single-character shortcut is known, but the binding surface was not enumerated. |
| 2.2.1 Timing Adjustable (A) | Not evaluated | Session and token expiry behaviour was not exercised. |
| 2.2.2 Pause, Stop, Hide (A) | Partly met | The navigation background animation was removed to keep menu labels readable mid-route-change. No other auto-moving or auto-updating content was audited. |
| 2.3.1 Three Flashes or Below Threshold (A) | Not applicable | No flashing content. |
| 2.4.1 Bypass Blocks (A) | Meets (sampled) | **Saltar al contenido** focuses the visible `main` without changing the route, in 16 of 16 route/width samples. |
| 2.4.2 Page Titled (A) | Meets (source) | `index.html` declares `FireWatch \| Centro de monitoreo`; `App.tsx:47` sets `${route.title} \| FireWatch` per route and `AuthView.tsx:95` for the public screens. |
| 2.4.3 Focus Order (A) | Partly met | Skip link, primary navigation and the History workflow preserve a sensible order. Full route-by-route focus order was not asserted. |
| 2.4.4 Link Purpose (A) | Partly met | Navigation labels are textual and `aria-current` settles per route. In-page link purpose was not reviewed. |
| 2.4.5 Multiple Ways (AA) | Not evaluated | No second navigation mechanism (search, sitemap) exists; whether the inventory views require one is a product decision. |
| 2.4.6 Headings and Labels (AA) | Meets (sampled) | No skipped heading levels in the four previously affected views; the Actions detail exposes a level-2 title with five level-3 subsections; section labels are text. |
| 2.4.7 Focus Visible (AA) | Meets (sampled) | 44 measured focus indicators at 5.11:1 with a solid outline, including the canvas overrides. Settled and mid-transition menu states both keep a solid outline. |
| 2.5.1 Pointer Gestures (A) | Not evaluated | No multi-point or path gesture exists in the audited views; the map was operated by keyboard only. |
| 2.5.2 Pointer Cancellation (A) | Not evaluated | Pointer down/up behaviour was not tested. |
| 2.5.3 Label in Name (A) | Not evaluated | Accessible names were compared to visible labels only for unnamed-control detection, not for containment. |
| 2.5.4 Motion Actuation (A) | Not applicable | No device-motion or user-motion input. |

## Understandable

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 3.1.1 Language of Page (A) | Meets (source) | `index.html:2` declares `<html lang="es">`; no route overrides it. |
| 3.1.2 Language of Parts (AA) | Not applicable | No passage in a language other than the page language was identified in the audited views. |
| 3.2.1 On Focus (A) | Meets (sampled) | Focusing a map shape does not change the selection; activation requires Enter or Space. Focusing the skip link does not navigate. |
| 3.2.2 On Input (A) | Partly met | The History query filters results and the status selector does not change the total; native validation returns focus to the invalid field without submitting. Other form controls were not exercised. |
| 3.2.3 Consistent Navigation (AA) | Meets (sampled) | The same eight destinations appear in the same order on every authenticated route, with a settled `aria-current`. |
| 3.2.4 Consistent Identification (AA) | Partly met | Repeated controls reuse the same labels across views; no systematic comparison was run. |
| 3.3.1 Error Identification (A) | Meets (sampled) | Submitting the create form with an empty title returned focus to the field and exposed the browser's validation message, with zero requests sent. |
| 3.3.2 Labels or Instructions (A) | Partly met | Audited create-form fields have visible labels; the directory-unavailable state shows the failure and a retry action. Instruction copy on the remaining views was not reviewed. |
| 3.3.3 Error Suggestion (AA) | Not evaluated | Server-rejection copy was not collected across the error states. |
| 3.3.4 Error Prevention (AA) | Not evaluated | No confirmation or reversal path was tested for lifecycle transitions. |

## Robust

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| 4.1.1 Parsing (A) | Meets (sampled) | axe-core reports no parsing, duplicate-id or ARIA misuse violation in 16 scans. Obsolete in WCAG 2.2. |
| 4.1.2 Name, Role, Value (A) | Meets (sampled) | 16 accessibility-tree snapshots: one named `main`, one named `navigation`, no unnamed control among the sampled roles; axe-core zero violations. Custom controls expose `role="button"` with `aria-pressed` and a name. |
| 4.1.3 Status Messages (AA) | Meets (sampled) | The filtered-result count in History exposes itself as `role="status" aria-live="polite"`; with one row and a non-matching query the virtual reader logged `polite: 0 de 1` at 1280×720 and 390×844 while focus stayed put, and the harness reported no unannounced change. The same pattern already covers shell readiness, map progress, Actions notices and Audit status copy. Only the History filter change was exercised as a dynamic announcement. |

## Open findings from the reader pass

Three defects were found by reading the live accessibility tree, not by automated rules:

1. **4.1.3 — the History result count was not announced.** Filtering from one row to none changed the count from `1 de 1` to `0 de 1` with no live region and no focus change, so a reader user received no confirmation that the action emptied the table. **Fixed and verified:** the view now exposes the count as a status message, matching the `role="status" aria-live="polite"` convention the shell, map, Actions and Audit views already use, and the reader logs `polite: 0 de 1` at both widths.
2. **Landmark nesting.** The shell footer renders `contentinfo` inside `main`, which is not a valid landmark structure and makes the footer part of the main region for navigation.
3. **Unlabelled count.** The History count badge speaks only its bare number, so its meaning depends on visual position rather than on an accessible name.

Items 2 and 3 are recorded, not fixed: neither is a 4.1.3 status-message failure, and both need a decision on the shared shell markup rather than a local edit.

## What blocks a conformance claim

1. **State coverage.** Population, empty, loading, error and partial-failure states were sampled, not enumerated. The audit stack had no published lot for several runs and no data rows in the actions table.
2. **No assistive technology.** A DOM virtual screen reader shows what the accessibility tree exposes and what a mutation announces; it is not NVDA, JAWS, VoiceOver or TalkBack.
3. **Text-only resize and text spacing** (1.4.4, 1.4.12) were approximated with browser zoom at 200%, which is a different condition.
4. **Map non-text contrast** (1.4.11) has documented sub-3:1 fill and boundary pairs whose essential-or-decorative status is a product decision.
5. **Hover, focus and disabled states** were measured where a probe existed, not for every control.

## How to reproduce

Every row above is backed by an ignored probe in `tmp/g1-browser-baseline/workspace-audit.mjs`, gated by an `FW_*` environment variable (`FW_AXE_AUDIT`, `FW_MIXED_SURFACES`, `FW_VIRTUAL_READER`, `FW_KEYBOARD_NAV`, `FW_SKIP_AUDIT`, `FW_REFLOW_AUDIT`, `FW_BROWSER_ZOOM`, `FW_ZOOM_TABLES`, `FW_STRUCTURE_AUDIT`, `FW_FOCUS_GATE`, `FW_NAV_CONTRAST`, `FW_HISTORY_KEYBOARD`, `FW_MAP_KEYBOARD`, `FW_POPULATED`). Reports land beside it as `axe-*.json`, `mixed-surfaces.json` and `vo-audit/virtual-reader.json`. The probes need a disposable Compose stack and a Chromium build; they are deliberately not part of the repository test suite.
