import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

import { navigationGroups, routes, type RouteDefinition, type ViewId } from '../app/routes';

// T1 — the global product navigation, ported from the approved canvas bar
// (`design/firewatch-v1-vuelo/product-navigation.mjs`). One component, one source
// of truth: every destination is a real route, every href comes from `routes`, and
// the menu groups are the declared navigation groups, so the navigation cannot
// drift from the router.
//
// The canvas keeps four shortcuts in a thin bar outside the workspace, and the
// application now serves all four destinations. The visible labels are the
// canvas' short words; the accessible name is the route's full label, and it
// always starts with the visible word (WCAG 2.5.3). The three the bar already
// carried keep their place: T4 appends the executive panel's shortcut, so the
// earlier destinations do not move under the reader.
const SHORTCUTS: readonly { id: ViewId; label: string; name?: string }[] = [
  { id: 'overview', label: 'Mapa', name: 'Mapa · Territorio' },
  { id: 'history', label: 'Historial' },
  { id: 'actions', label: 'Acciones' },
  { id: 'executive', label: 'Panel' },
];

const shortcuts = SHORTCUTS.flatMap(shortcut => {
  const route = routes.find(candidate => candidate.id === shortcut.id);
  return route === undefined ? [] : [{ ...shortcut, route }];
});

const shortcutIds = new Set(shortcuts.map(shortcut => shortcut.route.id));

// Everything else, grouped by the grouping the router already declares, in the
// declared order. Empty groups are dropped rather than rendered as a heading with
// no destination.
const groups = navigationGroups
  .map(group => ({ group, entries: routes.filter(candidate => candidate.group === group && !shortcutIds.has(candidate.id)) }))
  .filter(candidate => candidate.entries.length > 0);

// The panel id is stable: the application mounts one shell, and `aria-controls`
// has to resolve whether the panel is open or hidden.
const PANEL_ID = 'product-nav-panel';

// A modified or non-primary activation belongs to the browser: it opens the
// destination elsewhere (a new tab, window or download) and leaves this document
// exactly where it was. The menu must not treat it as a same-tab selection.
function opensElsewhere(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

// Stable, unique per rendered navigation; an accented group name cannot produce
// an invalid fragment.
function groupId(group: string): string {
  const slug = group
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `product-nav-group-${slug === '' ? 'grupo' : slug}`;
}

export function ProductNav({ route }: { route: RouteDefinition }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);
  const navRef = useRef<HTMLElement>(null);
  // The route this component last rendered, and whether the last navigation was
  // chosen from this menu. Together they decide when a route change reveals the
  // new current grouped destination and when it must not reopen a menu the reader
  // closed.
  const lastRouteId = useRef(route.id);
  const selectedFromMenu = useRef(false);

  const activeInDisclosure = groups.some(group => group.entries.some(entry => entry.id === route.id));

  // The bar is sticky and in flow, and every rule that reserves it reads
  // `--product-nav-h`: the shell's height, the sticky sidebar top, the aerial rail
  // offset and the coverage view's `scroll-margin-top`. Below 390px the shortcuts
  // and the disclosure wrap onto a second row, so a fixed 48px would reserve less
  // than the bar paints and a focused commune breakdown would land under it. The
  // bar publishes the box it actually occupies, keeps the stylesheet's 48px until
  // it can measure, and re-measures when the viewport or the box changes.
  //
  // The property is written on `body`, not on `:root`, and the bar shadows it with
  // its own 48px (`product-nav.css`): the reserved offset must follow a wrapped bar
  // without the bar sizing itself from the value it publishes.
  useEffect(() => {
    const node = navRef.current;
    if (node === null) return undefined;
    const scope = document.body;
    const publish = (): void => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      // Nothing to measure (jsdom, or a hidden document): keep the fallback
      // instead of reserving zero and letting the bar cover content.
      if (height <= 0) return;
      scope.style.setProperty('--product-nav-h', `${height}px`);
    };
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(node);
    window.addEventListener('resize', publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', publish);
      scope.style.removeProperty('--product-nav-h');
    };
  }, []);

  useEffect(() => {
    if (lastRouteId.current === route.id) return;
    lastRouteId.current = route.id;
    const fromMenu = selectedFromMenu.current;
    selectedFromMenu.current = false;
    // Back/Forward (or any hash change the menu did not cause) reveals the new
    // current grouped destination. Choosing it from the menu closes the menu.
    setOpen(fromMenu ? false : activeInDisclosure);
  }, [route.id, activeInDisclosure]);

  useEffect(() => {
    if (!open) return;
    // The panel is a bounded scroll region: reveal the current destination inside
    // it without moving focus or scrolling the page.
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, route.id]);

  return (
    <nav className="product-nav" ref={navRef} aria-label="Navegación del producto FireWatch">
      <ul className="product-nav__shortcuts">
        {shortcuts.map(shortcut => {
          const active = shortcut.route.id === route.id;
          return (
            <li key={shortcut.route.id}>
              <a
                id={`nav-${shortcut.route.id}`}
                className="product-nav__link"
                href={shortcut.route.hash}
                aria-label={shortcut.name ?? shortcut.route.label}
                aria-current={active ? 'page' : undefined}
              >
                {shortcut.label}
              </a>
            </li>
          );
        })}
      </ul>

      <button
        ref={buttonRef}
        type="button"
        className="product-nav__summary"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => setOpen(value => !value)}
      >
        <span>Más destinos</span>
        <span className="product-nav__chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      <div className="product-nav__panel" id={PANEL_ID} ref={panelRef} hidden={!open}>
        <p className="product-nav__panel-title">Otras pantallas del producto</p>
        <div className="product-nav__groups">
          {groups.map(group => {
            const titleId = groupId(group.group);
            return (
              <div className="product-nav__group" key={group.group}>
                <p className="product-nav__group-title" id={titleId}>
                  {group.group}
                </p>
                <ul className="product-nav__list" aria-labelledby={titleId}>
                  {group.entries.map(entry => {
                    const active = entry.id === route.id;
                    return (
                      <li key={entry.id}>
                        <a
                          id={`nav-${entry.id}`}
                          ref={active ? activeRef : undefined}
                          className="product-nav__item"
                          href={entry.hash}
                          aria-current={active ? 'page' : undefined}
                          onClick={event => {
                            // Modified and non-primary activations belong to the
                            // browser: they must not arm the selection flag or
                            // close this tab's panel, or a later Back/Forward
                            // would look like a menu selection and hide the new
                            // current destination.
                            if (opensElsewhere(event)) return;
                            // A plain menu selection is not a history change:
                            // closing the panel keeps the destination unobscured.
                            // Selecting the open route again does not arm the
                            // flag, so a later Back/Forward still reveals it.
                            if (entry.hash !== route.hash) selectedFromMenu.current = true;
                            setOpen(false);
                          }}
                        >
                          {entry.label}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
        <p className="product-nav__note">Los accesos directos siguen visibles en la barra.</p>
      </div>

      <p className="product-nav__where" aria-live="polite">
        <span className="product-nav__where-label">Estás en</span> <strong>{route.label}</strong>
      </p>
    </nav>
  );
}
