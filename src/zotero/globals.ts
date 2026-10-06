// The bootstrap sandbox lacks most DOM globals. Timers come from Timer.sys.mjs; DOM classes
// (AbortController, crypto) are borrowed from the main window when first needed.

export const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs") as {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number | undefined) => void;
};

function win(): any {
  return Zotero.getMainWindow() ?? (Services as any).appShell.hiddenDOMWindow;
}

export function newAbortController(): AbortController {
  return new (win().AbortController)();
}

export function subtleCrypto(): SubtleCrypto {
  return win().crypto.subtle;
}

export function newTextDecoder(): TextDecoder {
  return new (win().TextDecoder)("utf-8");
}

/** fetch of the main window (the sandbox has none). */
export function hostFetch(input: string, init?: RequestInit): Promise<Response> {
  return win().fetch(input, init);
}
