"""Contract tests for the FireWatch Keycloak login theme (T15, S10-S11).

The identity provider hosts its own pages, so the aerial night palette that
``frontend/src/styles/tokens.css`` declares for the application has to be
restated here as plain CSS custom properties. These tests are the guardrail for
the four things that can silently regress:

1. the CSS-only ``keycloak.v2`` contract, kept in step with the pitch overlay's
   ConfigMap (exactly four files, no FreeMarker template, no image, no font);
2. the palette itself: the aerial night slate/aqua roles must be present and the
   retired forest/cream literals must never come back;
3. measured WCAG 2.1 contrast - relative luminance computed here, from the
   values the stylesheet actually declares, not from a comment;
4. offline/CSP safety and a compact ``100dvh`` desktop layout that never locks
   scrolling on ``html``/``body``, so a taller flow still scrolls on a phone.

Run with::

    python -B -m pytest backend/scripts/test_keycloak_theme.py
"""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LOGIN_DIR = REPO / "backend/deploy/local/keycloak-themes/firewatch/login"
THEME_ROOT = REPO / "backend/deploy/local/keycloak-themes/firewatch"
CSS_PATH = LOGIN_DIR / "resources/css/firewatch.css"
PROPERTIES_PATH = LOGIN_DIR / "theme.properties"
MESSAGES_ES = LOGIN_DIR / "messages/messages_es.properties"
MESSAGES_EN = LOGIN_DIR / "messages/messages_en.properties"
KUSTOMIZATION = REPO / "backend/deploy/k8s/overlays/pitch/kustomization.yaml"
UP_SH = REPO / "backend/deploy/k8s/overlays/pitch/up.sh"
DOCS = REPO / "backend/docs/keycloak-realm-setup.md"

# The exact four files the pitch overlay can carry. The overlay rebuilds the
# directory layout with ConfigMap `items`, so adding a fifth file (a template,
# an image, a font) would silently not reach the cluster.
THEME_FILES = {
    "theme.properties",
    "messages/messages_es.properties",
    "messages/messages_en.properties",
    "resources/css/firewatch.css",
}

# The aerial night roles, as literal hex. These are the same values
# `frontend/src/styles/tokens.css` declares; a `var()` chain would hide the
# measured value from the contrast arithmetic below.
AERIAL_NIGHT_TOKENS = {
    "--fw-canvas": "#0f1922",
    "--fw-water": "#152934",
    "--fw-paper": "#17222b",
    "--fw-soft": "#21313f",
    "--fw-raised": "#243341",
    "--fw-ink": "#f4f1eb",
    "--fw-muted": "#b8c8d2",
    "--fw-line": "#354b5c",
    "--fw-line-soft": "#2a3a47",
    "--fw-edge": "#647b8a",
    "--fw-edge-strong": "#6b8395",
    "--fw-accent": "#94dfda",
    "--fw-accent-ink": "#0c1b24",
    "--fw-focus": "#94dfda",
    "--fw-danger": "#f0a184",
    "--fw-danger-soft": "#3b2a24",
}

SURFACE_TOKENS = ("--fw-canvas", "--fw-water", "--fw-paper", "--fw-soft", "--fw-raised")

# Retired forest/cream literals from the previous skin, plus the pale PatternFly
# fallbacks the old sheet painted by hand (`#fff` surfaces, the boxed language
# chip, the social button). None of them may survive the migration.
LEGACY_LITERALS = (
    "#102c2d",
    "#173c3b",
    "#285e56",
    "#638579",
    "#f5f5ef",
    "#fffefa",
    "#233b39",
    "#5c6c65",
    "#dde3da",
    "#c9d1c8",
    "#eef1e9",
    "#a74d34",
    "#f7e9e2",
    "#d7aa73",
    "#cf7d4f",
    "#d5e1db",
    "#f6fff9",
    "#9fbcb2",
    "#f7f8f5",
    "#1f1f1f",
    "rgb(215 170 115",
    "rgb(99 133 121",
    "rgb(16 44 45",
    "rgb(40 94 86",
)

# PatternFly v5 markup the parent's templates render (checked against Keycloak
# 26.5.7) plus the classic `#kc-*` ids. Each one is a surface that could bleed
# a pale PatternFly default back into the page.
REQUIRED_HOOKS = (
    ".pf-v5-c-login",
    ".pf-v5-c-login__container",
    ".pf-v5-c-login__main",
    ".pf-v5-c-login__main-header",
    ".pf-v5-c-login__main-body",
    ".pf-v5-c-login__main-footer",
    "span.pf-v5-c-form-control",
    ".pf-v5-c-form__label-text",
    ".pf-v5-c-input-group",
    ".pf-v5-c-button.pf-m-control",
    ".pf-v5-c-button.pf-m-primary",
    ".pf-v5-c-alert",
    ".pf-v5-c-check",
    ".pf-v5-c-helper-text",
    ":-webkit-autofill",
    ":focus-visible",
    "#kc-header",
    "#kc-header-wrapper",
    "#kc-page-title",
    "#kc-form-login",
    "#kc-login",
    "#kc-info",
    "#kc-registration",
    "#kc-error-message",
    "#kc-social-providers",
    "#login-select-toggle",
)


def hex_to_rgb(value: str) -> tuple[float, float, float]:
    text = value.strip().lstrip("#")
    if len(text) != 6:
        raise AssertionError(f"not a six-digit hex colour: {value!r}")
    return tuple(float(int(text[index:index + 2], 16)) for index in (0, 2, 4))  # type: ignore[return-value]


def relative_luminance(value: str) -> float:
    """WCAG 2.1 relative luminance of an sRGB hex colour."""

    def channel(raw: float) -> float:
        scaled = raw / 255
        return scaled / 12.92 if scaled <= 0.03928 else ((scaled + 0.055) / 1.055) ** 2.4

    red, green, blue = hex_to_rgb(value)
    return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)


def contrast_ratio(first: str, second: str) -> float:
    """WCAG 2.1 contrast ratio, always >= 1."""

    high, low = sorted((relative_luminance(first), relative_luminance(second)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def read_text(path: Path) -> str:
    assert path.is_file(), f"missing required file: {path.relative_to(REPO)}"
    return path.read_text(encoding="utf-8")


def css_text() -> str:
    return read_text(CSS_PATH)


def strip_comments(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)


def rule_blocks(css: str) -> list[tuple[str, str]]:
    """Innermost `selector { declarations }` pairs, at-rule preambles removed."""

    blocks: list[tuple[str, str]] = []
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", strip_comments(css)):
        raw_selector = match.group(1).split("}")[-1]
        lines = [
            line.strip()
            for line in raw_selector.splitlines()
            if line.strip() and not line.strip().startswith("@")
        ]
        selector = " ".join(lines)
        if selector:
            blocks.append((selector, match.group(2)))
    return blocks


def declarations_for(css: str, fragment: str) -> str:
    return "\n".join(body for selector, body in rule_blocks(css) if fragment in selector)


def root_tokens(css: str) -> dict[str, str]:
    tokens: dict[str, str] = {}
    for selector, body in rule_blocks(css):
        if selector != ":root":
            continue
        for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", body):
            tokens[name.strip()] = value.strip()
    return tokens


# ── 1. The CSS-only four-file `keycloak.v2` contract ─────────────────────────


def test_theme_directory_is_exactly_the_four_css_only_files() -> None:
    files = {
        path.relative_to(LOGIN_DIR).as_posix()
        for path in LOGIN_DIR.rglob("*")
        if path.is_file()
    }
    assert files == THEME_FILES, f"unexpected theme files: {sorted(files ^ THEME_FILES)}"
    assert not list(THEME_ROOT.rglob("*.ftl")), "no FreeMarker template may be overridden"
    assert not list(THEME_ROOT.rglob("*.woff*")), "no font may be bundled or referenced"
    assert not list(THEME_ROOT.rglob("*.png")), "no image may be bundled"
    assert not list(THEME_ROOT.rglob("*.svg")), "no image may be bundled"


def test_theme_properties_extend_keycloak_v2_without_templates() -> None:
    properties = read_text(PROPERTIES_PATH)
    pairs = dict(
        line.split("=", 1)
        for line in properties.splitlines()
        if "=" in line and not line.lstrip().startswith("#")
    )
    assert pairs["parent"] == "keycloak.v2"
    assert pairs["styles"] == "css/styles.css css/firewatch.css"
    assert pairs["darkMode"] == "false", (
        "the skin is unconditionally dark; the parent's OS-driven dark variant "
        "would add a second, conflicting token set"
    )
    assert "es" in pairs["locales"] and "en" in pairs["locales"]
    assert "template" not in "".join(pairs).lower()


def test_pitch_overlay_mounts_exactly_the_four_theme_files() -> None:
    kustomization = read_text(KUSTOMIZATION)
    mounted = set(re.findall(r"path:\s*(login/[^\s}]+)", kustomization))
    assert mounted == {f"login/{name}" for name in THEME_FILES}, (
        f"pitch ConfigMap items drifted from the theme: {sorted(mounted)}"
    )
    up = read_text(UP_SH)
    carried = set(re.findall(r"--from-file=([\w.]+)=", up))
    assert carried == {name.rsplit("/", 1)[-1] for name in THEME_FILES}, (
        f"up.sh ConfigMap keys drifted from the theme: {sorted(carried)}"
    )


# ── 2. Aerial night palette replaces the forest/cream one ────────────────────


def test_aerial_night_tokens_replace_the_legacy_palette() -> None:
    css = css_text()
    tokens = root_tokens(css)

    for name, expected in AERIAL_NIGHT_TOKENS.items():
        assert tokens.get(name, "").lower() == expected, (
            f"{name} must be the aerial night literal {expected}, found {tokens.get(name)!r}"
        )

    assert re.search(r"color-scheme\s*:\s*dark", css), "native widgets/autofill need a dark color-scheme"

    lowered = css.lower()
    survivors = [literal for literal in LEGACY_LITERALS if literal in lowered]
    assert not survivors, f"retired forest/cream literals came back: {survivors}"
    assert "#fff" not in lowered and "#ffffff" not in lowered, (
        "no pale/white surface literal may survive; the palette is aerial night"
    )


def test_legacy_pale_surfaces_are_gone_from_every_declared_surface() -> None:
    tokens = root_tokens(css_text())
    for name in SURFACE_TOKENS:
        luminance = relative_luminance(tokens[name])
        assert luminance < 0.10, (
            f"{name} {tokens[name]} has relative luminance {luminance:.3f}; "
            "a dark aerial night surface must stay under 0.10"
        )


def test_patternfly_v5_and_kc_hooks_are_all_overridden() -> None:
    css = css_text()
    missing = [hook for hook in REQUIRED_HOOKS if hook not in css]
    assert not missing, f"PatternFly v5 / #kc-* hooks not restyled: {missing}"


def test_alert_states_use_the_dark_danger_roles() -> None:
    css = css_text()
    alert = declarations_for(css, ".pf-v5-c-alert")
    assert alert, "the alert surface must be styled so no pale PatternFly band bleeds through"
    assert "var(--fw-danger-soft)" in alert
    helper = declarations_for(css, ".pf-v5-c-helper-text")
    assert "var(--fw-danger)" in helper, "inline credential errors must use the dark danger text role"


# ── 3. Measured WCAG 2.1 contrast ───────────────────────────────────────────


def test_body_and_label_text_meets_wcag_aa() -> None:
    tokens = root_tokens(css_text())
    failures = []
    for ink in ("--fw-ink", "--fw-muted"):
        for surface in SURFACE_TOKENS:
            ratio = contrast_ratio(tokens[ink], tokens[surface])
            if ratio < 4.5:
                failures.append(f"{ink} on {surface}: {ratio:.2f}")
    assert not failures, f"body/label text below 4.5:1: {failures}"


def test_accent_link_and_filled_control_contrast() -> None:
    tokens = root_tokens(css_text())
    failures = []
    for surface in ("--fw-canvas", "--fw-water", "--fw-paper", "--fw-soft"):
        ratio = contrast_ratio(tokens["--fw-accent"], tokens[surface])
        if ratio < 4.5:
            failures.append(f"--fw-accent on {surface}: {ratio:.2f}")
    filled = contrast_ratio(tokens["--fw-accent-ink"], tokens["--fw-accent"])
    if filled < 4.5:
        failures.append(f"--fw-accent-ink on --fw-accent: {filled:.2f}")
    assert not failures, f"accent text/label below 4.5:1: {failures}"
    # The light ink is deliberately never painted on the accent fill.
    assert contrast_ratio(tokens["--fw-ink"], tokens["--fw-accent"]) < 4.5


def test_ui_boundaries_and_focus_rings_meet_three_to_one() -> None:
    tokens = root_tokens(css_text())
    failures = []
    # `--fw-edge` measures 2.92 on `--fw-raised`, one step under the 3:1
    # non-text minimum, so a boundary painted on the raised role uses the
    # documented one-step correction `--fw-edge-strong` instead.
    edge_surfaces = {
        "--fw-edge": ("--fw-canvas", "--fw-water", "--fw-paper", "--fw-soft"),
        "--fw-edge-strong": (
            "--fw-canvas", "--fw-water", "--fw-paper", "--fw-soft", "--fw-raised",
        ),
        "--fw-focus": ("--fw-canvas", "--fw-water", "--fw-paper", "--fw-soft", "--fw-raised"),
    }
    for edge, surfaces in edge_surfaces.items():
        for surface in surfaces:
            ratio = contrast_ratio(tokens[edge], tokens[surface])
            if ratio < 3.0:
                failures.append(f"{edge} on {surface}: {ratio:.2f}")
    assert not failures, f"UI boundaries/focus rings below 3:1: {failures}"


def test_danger_copy_meets_wcag_aa_on_its_own_surface() -> None:
    tokens = root_tokens(css_text())
    for surface in ("--fw-paper", "--fw-danger-soft", "--fw-canvas"):
        ratio = contrast_ratio(tokens["--fw-danger"], tokens[surface])
        assert ratio >= 4.5, f"--fw-danger on {surface}: {ratio:.2f}"


# ── 4. Offline, CSP-safe, compact and scroll-safe ───────────────────────────


def test_stylesheet_loads_nothing_from_another_origin() -> None:
    css = css_text()
    assert "@import" not in css, "an @import would need a CSP exception"
    assert "@font-face" not in css, "the theme uses the system font stack, never a bundled font"
    assert not re.search(r"url\(\s*['\"]?(?:https?:)?//", css, re.IGNORECASE), (
        "no external url() may be referenced"
    )


def test_compact_desktop_layout_uses_100dvh_without_locking_scroll() -> None:
    css = css_text()
    assert "100dvh" in css, "the desktop composition is measured in dynamic viewport units"

    login = declarations_for(css, ".pf-v5-c-login")
    assert "min-height: 100dvh" in login, (
        "the login page must be a 100dvh box; taller flows then scroll naturally"
    )

    banned = re.compile(r"overflow(?:-[xy])?\s*:\s*(?:hidden|clip)")
    for selector, body in rule_blocks(css):
        targets = {part.strip() for part in selector.split(",")}
        if targets & {"html", "body", "#keycloak-bg", "html body"}:
            assert not banned.search(body), (
                f"{selector} locks scrolling; html/body must stay scrollable so phone "
                "viewports and taller identity flows are never clipped"
            )

    assert "@media (prefers-reduced-motion: reduce)" in css
    assert "@media (max-width" in css, "a narrow-screen layout must reflow the two columns"


def test_inputs_and_submit_button_keep_44px_touch_targets() -> None:
    css = css_text()
    control = declarations_for(css, "span.pf-v5-c-form-control")
    assert re.search(r"min-height:\s*(?:4[4-9]|[5-9]\d)px", control), (
        "text inputs must keep a >= 44px touch target"
    )
    submit = declarations_for(css, ".pf-v5-c-button.pf-m-primary")
    assert re.search(r"min-height:\s*(?:4[4-9]|[5-9]\d)px", submit), (
        "the primary action must keep a >= 44px touch target"
    )
    reveal = declarations_for(css, ".pf-v5-c-button.pf-m-control")
    assert re.search(r"min-height:\s*(?:4[4-9]|[5-9]\d)px", reveal), (
        "the password reveal control must keep a >= 44px touch target"
    )


def test_focus_indicator_is_visible_on_every_interactive_hook() -> None:
    css = css_text()
    focus = declarations_for(css, ":focus-visible")
    assert "outline: 3px solid var(--fw-focus)" in focus, (
        "every focusable control needs a 3px aerial night focus ring"
    )
    assert "outline-offset: 2px" in focus


# ── 5. Copy and documentation follow the same design ────────────────────────


def test_message_bundles_keep_the_spanish_and_english_keys() -> None:
    # Every other string comes from Keycloak's own bundle; these are the
    # overrides the theme really ships and the ones the page's copy depends on.
    required = {
        MESSAGES_ES: {
            "loginTitle", "loginAccountTitle", "doLogIn", "doRegister",
            "noAccount", "backToLogin", "usernameOrEmail", "registerTitle",
            "identity-provider-login-label",
        },
        MESSAGES_EN: {"loginTitle", "loginAccountTitle", "registerTitle", "identity-provider-login-label"},
    }
    for path, expected in required.items():
        body = read_text(path)
        keys = [
            line.split("=", 1)[0].strip()
            for line in body.splitlines()
            if "=" in line and not line.lstrip().startswith("#")
        ]
        assert len(keys) == len(set(keys)), f"duplicate message keys in {path.name}"
        assert expected <= set(keys), f"{path.name} lost keys: {expected - set(keys)}"
    spanish = read_text(MESSAGES_ES)
    assert "Iniciar sesión" in spanish
    assert "Volver a iniciar sesión" in spanish


def test_docs_describe_the_aerial_night_theme() -> None:
    docs = read_text(DOCS)
    for expected in (
        "aerial night",
        "keycloak.v2",
        "css/firewatch.css",
        "messages_es.properties",
        "test_keycloak_theme.py",
        "WCAG",
        "100dvh",
    ):
        assert expected in docs, f"the theme documentation must mention {expected!r}"
    lowered = docs.lower()
    assert "cream" not in lowered or "retired" in lowered, (
        "the docs must not present the retired cream palette as current"
    )


# ── 5. Focus cascade for submit controls ───────────────────────────────────
# The registration page renders its primary action as
# `<input type="submit" class="pf-v5-c-button pf-m-primary">`, not as a
# `<button>`. A generic `input:focus-visible` inset rule outranks
# `.pf-v5-c-button:focus-visible`, and an aqua ring drawn inside an aqua fill
# measures 1:1 — not a focus indicator. These tests resolve the cascade for the
# real submit elements instead of trusting a selector to exist somewhere.

FOCUS_CHAINS = {
    "login #kc-login": [
        {"tag": "html", "id": None, "classes": set(), "attrs": {}},
        {"tag": "body", "id": "keycloak-bg", "classes": set(), "attrs": {}},
        {"tag": "div", "id": None, "classes": {"pf-v5-c-login"}, "attrs": {}},
        {"tag": "main", "id": None, "classes": {"pf-v5-c-login__main"}, "attrs": {}},
        {"tag": "div", "id": None, "classes": {"pf-v5-c-login__main-body"}, "attrs": {}},
        {"tag": "div", "id": "kc-form", "classes": set(), "attrs": {}},
        {"tag": "form", "id": "kc-form-login", "classes": {"pf-v5-c-form"}, "attrs": {}},
        {"tag": "div", "id": None, "classes": {"pf-v5-c-form__group"}, "attrs": {}},
        {"tag": "div", "id": None, "classes": {"pf-v5-c-form__actions"}, "attrs": {}},
        {"tag": "button", "id": "kc-login", "classes": {"pf-v5-c-button", "pf-m-primary"}, "attrs": {"type": "submit"}},
    ],
    "registration submit input": [
        {"tag": "html", "id": None, "classes": set(), "attrs": {}},
        {"tag": "body", "id": "keycloak-bg", "classes": set(), "attrs": {}},
        {"tag": "div", "id": None, "classes": {"pf-v5-c-login"}, "attrs": {}},
        {"tag": "main", "id": None, "classes": {"pf-v5-c-login__main"}, "attrs": {}},
        {"tag": "div", "id": None, "classes": {"pf-v5-c-login__main-body"}, "attrs": {}},
        {"tag": "div", "id": "kc-form", "classes": set(), "attrs": {}},
        {"tag": "form", "id": "kc-register-form", "classes": {"pf-v5-c-form"}, "attrs": {}},
        {"tag": "div", "id": "kc-form-buttons", "classes": set(), "attrs": {}},
        {"tag": "input", "id": None, "classes": {"pf-v5-c-button", "pf-m-primary"}, "attrs": {"type": "submit"}},
    ],
    "registration first name input": [
        {"tag": "html", "id": None, "classes": set(), "attrs": {}},
        {"tag": "body", "id": "keycloak-bg", "classes": set(), "attrs": {}},
        {"tag": "div", "id": None, "classes": {"pf-v5-c-login"}, "attrs": {}},
        {"tag": "main", "id": None, "classes": {"pf-v5-c-login__main"}, "attrs": {}},
        {"tag": "div", "id": None, "classes": {"pf-v5-c-login__main-body"}, "attrs": {}},
        {"tag": "form", "id": "kc-register-form", "classes": {"pf-v5-c-form"}, "attrs": {}},
        {"tag": "div", "id": None, "classes": {"pf-v5-c-form__group"}, "attrs": {}},
        {"tag": "span", "id": None, "classes": {"pf-v5-c-form-control"}, "attrs": {}},
        {"tag": "input", "id": "firstName", "classes": {"pf-v5-c-form-control"}, "attrs": {"type": "text"}},
    ],
}

_COMPOUND_FRAGMENT = re.compile(
    r"#[\w-]+|\.[\w-]+|\[[^\]]+\]|:not\([^)]*\)|::[\w-]+|:[\w-]+(?:\([^)]*\))?|[a-zA-Z][\w-]*"
)


def split_selector_list(selector_list: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    current: list[str] = []
    for char in selector_list:
        if char in "([":
            depth += 1
        elif char in ")]":
            depth -= 1
        if char == "," and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    parts.append("".join(current).strip())
    return [part for part in parts if part]


def split_complex_selector(selector: str) -> list[tuple[str | None, str]]:
    """Parse a complex selector into (relation_to_left, compound) pairs."""

    compounds: list[tuple[str | None, str]] = []
    relation: str | None = None
    current: list[str] = []
    index = 0
    text = selector.strip()
    while index < len(text):
        char = text[index]
        if char in ">+~":
            if current:
                compounds.append((relation, "".join(current).strip()))
            current = []
            relation = char
            index += 1
            while index < len(text) and text[index] == " ":
                index += 1
        elif char == " ":
            if current:
                compounds.append((relation, "".join(current).strip()))
            current = []
            relation = " "
            index += 1
        else:
            current.append(char)
            index += 1
    if current:
        compounds.append((relation, "".join(current).strip()))
    return compounds


def match_compound(spec: str, node: dict) -> tuple[bool, bool]:
    """Return (matches, fully_understood) for one compound selector."""

    matched = True
    known = True
    for fragment in _COMPOUND_FRAGMENT.findall(spec):
        if fragment.startswith("#"):
            if node["id"] != fragment[1:]:
                matched = False
        elif fragment.startswith("."):
            if fragment[1:] not in node["classes"]:
                matched = False
        elif fragment.startswith("["):
            name, _, value = fragment[1:-1].partition("=")
            value = value.strip('"')
            if name not in node["attrs"] or (value and node["attrs"][name] != value):
                matched = False
        elif fragment.startswith(":not("):
            inner_matched, inner_known = match_compound(fragment[5:-1], node)
            if not inner_known:
                known = False
            elif inner_matched:
                matched = False
        elif fragment.startswith("::"):
            known = False
        elif fragment.startswith(":"):
            if fragment != ":focus-visible":
                known = False
        elif node["tag"] != fragment:
            matched = False
        if not matched:
            break
    return matched, known


def matches_chain(compounds: list[tuple[str | None, str]], chain: list[dict]) -> tuple[bool, bool]:
    if not compounds or not chain:
        return False, True
    index = len(chain) - 1
    matched, known = match_compound(compounds[-1][1], chain[index])
    if not matched:
        return False, known
    for position in range(len(compounds) - 1, 0, -1):
        relation = compounds[position][0]
        spec = compounds[position - 1][1]
        if relation == ">":
            index -= 1
            if index < 0:
                return False, known
            matched, inner_known = match_compound(spec, chain[index])
            known = known and inner_known
            if not matched:
                return False, known
        else:
            found = False
            probe = index - 1
            while probe >= 0:
                matched, inner_known = match_compound(spec, chain[probe])
                if matched:
                    index = probe
                    found = True
                    break
                if not inner_known:
                    known = False
                probe -= 1
            if not found:
                return False, known
    return True, known


def selector_specificity(selector: str) -> tuple[int, int, int]:
    ids = len(re.findall(r"#[\w-]+", selector))
    classes = (
        len(re.findall(r"\.[\w-]+", selector))
        + len(re.findall(r"\[[^\]]+\]", selector))
        + len(re.findall(r"(?<!:):(?!:)[\w-]+", selector))
        - len(re.findall(r":not\(", selector))
    )
    elements = len(re.findall(r"(?:^|[\s>+~])([a-zA-Z][\w-]*)", selector))
    return ids, classes, elements


def focus_cascade(chain: list[dict]) -> list[dict]:
    """Focus rules that match the chain, with their cascade keys."""

    matched: list[dict] = []
    for order, (selector_list, body) in enumerate(rule_blocks(css_text())):
        declarations = {
            name: value.strip() for name, value in re.findall(r"([\w-]+)\s*:\s*([^;]+);", body)
        }
        if "outline" not in "".join(declarations):
            continue
        for selector in split_selector_list(selector_list):
            if ":focus-visible" not in selector:
                continue
            hit, known = matches_chain(split_complex_selector(selector), chain)
            if hit and known:
                matched.append(
                    {
                        "selector": selector,
                        "order": order,
                        "specificity": selector_specificity(selector),
                        "declarations": declarations,
                    }
                )
    return matched



def cascade_value(rules: list[dict], property_name: str) -> str | None:
    winner = None
    for rule in sorted(rules, key=lambda item: (item["specificity"], item["order"])):
        if property_name in rule["declarations"]:
            winner = rule["declarations"][property_name]
    return winner


def resolve_role(value: str, roles: dict[str, str]) -> str:
    match = re.fullmatch(r"var\((--[\w-]+)\)", value.strip())
    return roles[match.group(1)].lower() if match else value.strip().lower()


def effective_focus_ring(chain: list[dict]) -> dict:
    roles = root_tokens(css_text())
    rules = focus_cascade(chain)
    ring: dict[str, object] = {"width": None, "style": None, "color": None}
    shorthand = cascade_value(rules, "outline")
    if shorthand:
        parts = shorthand.split()
        ring["width"] = next((part for part in parts if re.fullmatch(r"\d+(?:\.\d+)?px", part)), None)
        ring["style"] = next((part for part in parts if part in {"solid", "dashed", "dotted", "double"}), None)
        ring["color"] = next(
            (part for part in parts if part.startswith(("var(", "#"))), None
        )
    for longhand, key in (
        ("outline-width", "width"),
        ("outline-style", "style"),
        ("outline-color", "color"),
    ):
        value = cascade_value(rules, longhand)
        if value:
            ring[key] = value
    ring["offset"] = cascade_value(rules, "outline-offset")
    ring["color"] = resolve_role(str(ring["color"]), roles) if ring["color"] else None
    return ring


def test_primary_submit_focus_ring_is_outward_and_high_contrast() -> None:
    roles = root_tokens(css_text())
    for name in ("login #kc-login", "registration submit input"):
        ring = effective_focus_ring(FOCUS_CHAINS[name])
        assert ring["style"] == "solid", f"{name}: no solid focus outline wins the cascade ({ring})"
        width = re.fullmatch(r"(\d+(?:\.\d+)?)px", str(ring["width"]))
        assert width and float(width.group(1)) >= 2, f"{name}: outline thinner than 2px ({ring['width']})"
        offset = re.fullmatch(r"(-?\d+(?:\.\d+)?)px", str(ring["offset"]))
        assert offset, f"{name}: no measurable outline-offset ({ring['offset']})"
        assert float(offset.group(1)) >= 2, (
            f"{name}: outline-offset {ring['offset']} is not an outward ring; an inset aqua ring "
            "over the aqua fill measures 1:1"
        )
        assert ring["color"] == roles["--fw-focus"], f"{name}: ring is {ring['color']}, not the focus role"
        for surface in ("--fw-paper", "--fw-raised"):
            ratio = contrast_ratio(str(ring["color"]), roles[surface])
            assert ratio >= 3.0, f"{name}: focus ring on {surface} is {ratio:.2f}:1, below 3:1"


def test_text_field_focus_ring_still_exists() -> None:
    ring = effective_focus_ring(FOCUS_CHAINS["registration first name input"])
    assert ring["style"] == "solid", f"text field has no focus outline ({ring})"
    width = re.fullmatch(r"(\d+(?:\.\d+)?)px", str(ring["width"]))
    assert width and float(width.group(1)) >= 2, f"text field outline thinner than 2px ({ring['width']})"


def test_no_generic_input_focus_rule_can_capture_a_submit_button() -> None:
    unguarded: list[str] = []
    for selector_list, body in rule_blocks(css_text()):
        if "outline-offset" not in body:
            continue
        for selector in split_selector_list(selector_list):
            if ":focus-visible" not in selector:
                continue
            compounds = split_complex_selector(selector)
            if not compounds or not compounds[-1][1].startswith("input"):
                continue
            last = compounds[-1][1]
            # Acceptable: explicitly scoped to a text field (class or wrapper)
            # with a :not() guard, or explicitly naming the primary CTA markup.
            text_field = ":not(" in last or ".pf-v5-c-form-control" in last
            inside_field = any("pf-v5-c-form-control" in spec for _, spec in compounds[:-1])
            primary_cta = any(
                marker in last for marker in ("pf-m-primary", "#kc-login", '[type="submit"]')
            )
            if not text_field and not inside_field and not primary_cta:
                unguarded.append(selector)
    assert not unguarded, (
        "a generic input focus rule can still capture <input type=submit>; scope it to text "
        f"fields or exclude buttons explicitly: {unguarded}"
    )


def test_test_module_has_no_trailing_whitespace_or_mixed_line_endings() -> None:
    raw = Path(__file__).read_bytes()
    crlf = raw.count(b"\r\n")
    without_crlf = raw.replace(b"\r\n", b"")
    assert b"\r" not in without_crlf, "a lone carriage return is a line-ending defect"
    assert not (crlf and b"\n" in without_crlf), "CRLF and LF endings are mixed in this module"
    text = raw.decode("utf-8")
    offenders = [number for number, line in enumerate(text.splitlines(), 1) if line != line.rstrip()]
    assert not offenders, f"trailing whitespace on lines {offenders}"
    assert text.endswith(("\n", "\r\n")) and not text.endswith(("\n\n", "\r\n\r\n"))
