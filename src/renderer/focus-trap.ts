// Modal focus management (spec §18, §19).
//
// A dialog must take focus, keep it while open, and hand it back to whatever
// opened it. This matters most for JAWS and NVDA: if the background stays in
// the accessibility tree, the virtual cursor wanders out of the dialog and
// reads the window underneath as though the dialog were not there.
//
// `aria-hidden` is applied to the *siblings* of the dialog rather than to
// anything containing it, so no focusable control is ever left inside an
// aria-hidden subtree (spec §7).

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

export interface FocusTrapHandle {
  release: () => void;
}

interface TrapOptions {
  /** Called when Escape is pressed. Omit for dialogs that cannot be dismissed. */
  onEscape?: () => void;
  /** Element to focus on open; defaults to the first focusable element. */
  initialFocus?: HTMLElement | null;
  /** Siblings hidden from assistive tech while the dialog is open. */
  inertRoots?: HTMLElement[];
}

/**
 * Traps keyboard focus inside `container` and returns a handle that restores
 * focus to the previously active element.
 */
export function trapFocus(container: HTMLElement, options: TrapOptions = {}): FocusTrapHandle {
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const hidden: HTMLElement[] = [];

  for (const root of options.inertRoots || []) {
    if (root && !root.contains(container)) {
      root.setAttribute('aria-hidden', 'true');
      hidden.push(root);
    }
  }

  function focusFirst() {
    const explicit = options.initialFocus;
    if (explicit && document.contains(explicit)) {
      explicit.focus();
      return;
    }
    const focusable = getFocusableElements(container);
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      // A dialog with no controls still needs to receive focus, otherwise the
      // reader keeps announcing the page behind it.
      if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
      container.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && options.onEscape) {
      e.preventDefault();
      e.stopPropagation();
      options.onEscape();
      return;
    }

    if (e.key !== 'Tab') return;

    const focusable = getFocusableElements(container);
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (e.shiftKey && (active === first || !container.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !container.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  document.addEventListener('keydown', onKeyDown, true);
  // Deferred so the dialog is laid out (and therefore focusable) first.
  window.setTimeout(focusFirst, 0);

  return {
    release() {
      document.removeEventListener('keydown', onKeyDown, true);
      for (const root of hidden) {
        root.removeAttribute('aria-hidden');
      }
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    }
  };
}
