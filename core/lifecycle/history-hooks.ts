export type HistoryNavigationType =
  "pushState" | "replaceState" | "popstate" | "hashchange";

export interface HistoryNavigationEvent {
  type: HistoryNavigationType;
  url: string;
}

export type HistoryNavigationListener = (event: HistoryNavigationEvent) => void;

type HistoryStateMethod = (...args: never[]) => void;

/**
 * Observe SPA navigation without taking ownership of the History API.
 * The original methods are called first and restored only if our wrappers are
 * still installed, so another library can safely wrap history after us.
 */
export function installHistoryNavigationHooks(
  targetWindow: Window | undefined,
  listener: HistoryNavigationListener,
): () => void {
  if (targetWindow === undefined || targetWindow.history === undefined) {
    return () => undefined;
  }

  const history = targetWindow.history;
  const restorers: Array<() => void> = [];

  for (const methodName of ["pushState", "replaceState"] as const) {
    const original = history[methodName] as unknown as HistoryStateMethod;
    const wrapped = ((...args: never[]) => {
      const result = original.apply(history, args);
      listener({ type: methodName, url: targetWindow.location.href });
      return result;
    }) as unknown as History[typeof methodName];

    try {
      history[methodName] = wrapped;
      restorers.push(() => {
        if (history[methodName] === wrapped) {
          history[methodName] =
            original as unknown as History[typeof methodName];
        }
      });
    } catch {
      // Some host environments expose a non-writable History method. The
      // popstate/hashchange hooks below still provide useful coverage.
    }
  }

  const onPopState = (): void => {
    listener({ type: "popstate", url: targetWindow.location.href });
  };
  const onHashChange = (): void => {
    listener({ type: "hashchange", url: targetWindow.location.href });
  };

  targetWindow.addEventListener("popstate", onPopState);
  targetWindow.addEventListener("hashchange", onHashChange);

  return () => {
    targetWindow.removeEventListener("popstate", onPopState);
    targetWindow.removeEventListener("hashchange", onHashChange);
    for (const restore of restorers.reverse()) restore();
  };
}
