import type { ScanOptions } from "../types";
import { scanDocument, type ScanResult } from "./scanner";

export interface DOMStabilityResult {
  stable: boolean;
  timedOut: boolean;
  mutations: number;
  waitedMs: number;
  reason: "domcontentloaded" | "quiet-window" | "max-wait";
}

export interface StabilityOptions {
  quietWindowMs?: number;
  maxWaitMs?: number;
}

function positiveMilliseconds(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** Wait for DOMContentLoaded and a debounced mutation quiet window. */
export function waitForDomStability(
  document: Document,
  options: StabilityOptions = {},
): Promise<DOMStabilityResult> {
  const quietWindowMs = positiveMilliseconds(options.quietWindowMs, 120);
  const maxWaitMs = Math.max(
    quietWindowMs,
    positiveMilliseconds(options.maxWaitMs, 2500),
  );
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let mutationCount = 0;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let maxTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let loaded = document.readyState !== "loading";
    let observer: MutationObserver | undefined;

    const finish = (
      timedOut: boolean,
      reason: DOMStabilityResult["reason"],
    ): void => {
      if (settled) return;
      settled = true;
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      if (maxTimer !== undefined) clearTimeout(maxTimer);
      observer?.disconnect();
      document.removeEventListener("DOMContentLoaded", onLoaded);
      resolve({
        stable: !timedOut,
        timedOut,
        mutations: mutationCount,
        waitedMs: Date.now() - startedAt,
        reason,
      });
    };

    const scheduleQuiet = (): void => {
      if (!loaded) return;
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      quietTimer = setTimeout(
        () => finish(false, "quiet-window"),
        quietWindowMs,
      );
    };

    const onLoaded = (): void => {
      loaded = true;
      scheduleQuiet();
    };

    document.addEventListener("DOMContentLoaded", onLoaded, { once: true });
    const MutationObserverConstructor =
      document.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (MutationObserverConstructor) {
      observer = new MutationObserverConstructor(() => {
        mutationCount += 1;
        scheduleQuiet();
      });
      const target = document.documentElement ?? document;
      observer.observe(target, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    maxTimer = setTimeout(() => finish(true, "max-wait"), maxWaitMs);
    if (loaded) scheduleQuiet();
  });
}

export const waitForStableDom = waitForDomStability;

export async function scanDocumentWhenStable(
  document: Document,
  options: ScanOptions = {},
): Promise<ScanResult> {
  await waitForDomStability(document, options);
  return scanDocument(document, options);
}
