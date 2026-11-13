// Records a new Quick Search shortcut from the next key combination pressed:
// in Ayarlar › Genel, and on the setup screen, where a review of 0.4.3 asked
// for the shortcut to be shown and changeable before MetinBul starts taking it
// over in every other program.
import { announceAlways } from '../announcer.js';

// Maps a browser KeyboardEvent to an Electron accelerator key token. Returns
// null while only modifier keys are held (waiting for the actual key).
export function keyEventToAcceleratorToken(e: KeyboardEvent): string | null {
  const key = e.key;
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) return null;
  if (key === ' ') return 'Space';
  const named: Record<string, string> = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Escape: 'Escape', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete',
    Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown'
  };
  if (named[key]) return named[key];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  if (/^[0-9]$/.test(key)) return key;
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
  return null;
}

const isMac = () => /Mac/.test(navigator.platform);

/**
 * Turns `button` into "press a combination" until a key is pressed or Escape;
 * then sets the shortcut and calls `finished` with what to tell the user.
 * Returns a function that stops recording.
 */
export function recordShortcut(button: HTMLButtonElement, finished: (message: string | null) => Promise<void> | void): () => void {
  button.textContent = 'Bir tuş kombinasyonuna basın… (Esc ile iptal)';
  button.disabled = true;
  // Key capture is global while recording, so the state is announced --
  // otherwise Tab appears to stop working with no reason given.
  announceAlways('Kısayol kaydediliyor. Bir tuş kombinasyonuna basın. İptal etmek için Escape tuşuna basın.');

  const captureHandler = async (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      cleanup();
      await finished('Kısayol değiştirme iptal edildi.');
      return;
    }

    const keyToken = keyEventToAcceleratorToken(e);
    if (!keyToken) return; // still only modifiers held down

    const modifiers: string[] = [];
    if (e.ctrlKey) modifiers.push('Control');
    // "Command" means nothing to Electron on Windows: the Windows key is "Super".
    if (e.metaKey) modifiers.push(isMac() ? 'Command' : 'Super');
    if (e.altKey) modifiers.push('Alt');
    if (e.shiftKey) modifiers.push('Shift');

    cleanup();

    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      await finished(isMac()
        ? 'Kısayolda Ctrl, ⌘ ya da ⌥ tuşlarından en az biri olmalı.'
        : 'Kısayolda Ctrl ya da Alt tuşlarından en az biri olmalı.');
      return;
    }

    const accelerator = [...modifiers, keyToken].join('+');
    const result = await window.api.setQuickSearchShortcut(accelerator);
    if (result.success) {
      const current = await window.api.getQuickSearchShortcut();
      await finished(`Hızlı Arama kısayolu: ${current.display || accelerator}.`);
    } else {
      await finished(result.error || 'Kısayol ayarlanamadı.');
    }
  };

  function cleanup() {
    window.removeEventListener('keydown', captureHandler, true);
  }

  window.addEventListener('keydown', captureHandler, true);
  return cleanup;
}
