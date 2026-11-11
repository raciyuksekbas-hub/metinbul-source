// Central screen-reader announcement channel (spec §10).
//
// Every surface announces through `announce()` rather than minting its own
// aria-live node. Two permanent regions are used -- one polite, one
// assertive -- because a live region that is created (or moved) at the moment
// it gains text is unreliable in NVDA and JAWS: the reader has to be
// observing the node before the mutation happens.
//
// Re-announcing identical text is a no-op unless forced, which keeps the
// per-keystroke search loop from spamming JAWS/NVDA with the same sentence.

import type { AnnouncementPriority } from '../shared/a11y-text.js';

const POLITE_ID = 'a11y-live-polite';
const ASSERTIVE_ID = 'a11y-live-assertive';

let lastPolite = '';
let lastAssertive = '';
let clearTimer: any = null;

function getRegion(priority: AnnouncementPriority): HTMLElement | null {
  const id = priority === 'assertive' ? ASSERTIVE_ID : POLITE_ID;
  return document.getElementById(id);
}

/**
 * Speaks `message` through the shared live region.
 *
 * `polite` (the default) queues behind whatever the reader is saying and is
 * correct for search status, result counts and setting changes. `assertive`
 * interrupts and is reserved for genuine errors (spec §10).
 */
export function announce(message: string, priority: AnnouncementPriority = 'polite'): void {
  const text = (message || '').trim();
  if (!text) return;

  const region = getRegion(priority);
  if (!region) return;

  if (priority === 'assertive') {
    if (text === lastAssertive) return;
    lastAssertive = text;
  } else {
    if (text === lastPolite) return;
    lastPolite = text;
  }

  // Clearing first guarantees a text change even when the previous message
  // was similar; without it some readers coalesce the two updates.
  region.textContent = '';
  window.setTimeout(() => {
    region.textContent = text;
  }, 30);

  if (clearTimer) window.clearTimeout(clearTimer);
  clearTimer = window.setTimeout(() => {
    lastPolite = '';
    lastAssertive = '';
  }, 4000);
}

/**
 * Forces an announcement even if the text is unchanged -- used when the same
 * sentence is genuinely new information (e.g. re-running an identical search
 * that again finds nothing).
 */
export function announceAlways(message: string, priority: AnnouncementPriority = 'polite'): void {
  if (priority === 'assertive') lastAssertive = '';
  else lastPolite = '';
  announce(message, priority);
}

/** Drops any pending repeat-suppression state (used when a view resets). */
export function resetAnnouncer(): void {
  lastPolite = '';
  lastAssertive = '';
}
