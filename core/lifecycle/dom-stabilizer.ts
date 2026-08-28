import {
  installHistoryNavigationHooks,
  type HistoryNavigationEvent,
  type HistoryNavigationType,
} from "./history-hooks";

export type StabilizationReason =
  "initial" | "mutation" | "navigation" | "manual";

export interface StabilizedDomEvent {
  reason: StabilizationReason;
  fullScan: boolean;
  affectedSubtrees: Node[];
  mutations: MutationRecord[];
  url: string;
  timestamp: number;
  navigationType?: HistoryNavigationType;
}

export type StableDomListener = (event: StabilizedDomEvent) => unknown;

export interface DomStabilizerErrorContext {
  event: StabilizedDomEvent;
  error: unknown;
}

export interface DomStabilizerScheduler {
  now: () => number;
  setTimeout: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface DomStabilizerOptions {
  document?: Document;
  window?: Window;
  root?: Node;
  /** Time with no relevant mutations before a batch is emitted. */
  quietWindowMs?: number;
  /** Maximum time a batch may remain open while a page keeps mutating. */
  maxWaitMs?: number;
  /** Optional additional debounce floor for mutation batches. */
  mutationDebounceMs?: number;
  observeAttributes?: boolean;
  attributeFilter?: string[];
  observeCharacterData?: boolean;
  scheduler?: DomStabilizerScheduler;
  onStable?: StableDomListener;
  onError?: (context: DomStabilizerErrorContext) => void;
}

interface PendingBatch {
  reason: StabilizationReason;
  fullScan: boolean;
  affectedSubtrees: Node[];
  mutations: MutationRecord[];
  navigationType?: HistoryNavigationType;
  startedAt: number;
}

interface PreReadyMutations {
  records: MutationRecord[];
  affectedSubtrees: Node[];
}

const FULL_SCAN_REASONS = new Set<StabilizationReason>([
  "initial",
  "navigation",
  "manual",
]);

const DEFAULT_QUIET_WINDOW_MS = 100;
const DEFAULT_MAX_WAIT_MS = 2_000;

/**
 * Debounces DOM activity into stable scan opportunities. It intentionally
 * knows nothing about capability discovery: callers receive subtree hints and
 * decide whether/how to scan them.
 */
export class DomStabilizer {
  private readonly document: Document;
  private readonly targetWindow: Window | undefined;
  private readonly root: Node;
  private readonly quietWindowMs: number;
  private readonly maxWaitMs: number;
  private readonly quietDelayMs: number;
  private readonly observeAttributes: boolean;
  private readonly attributeFilter: string[] | undefined;
  private readonly observeCharacterData: boolean;
  private readonly scheduler: DomStabilizerScheduler;
  private readonly listeners = new Set<StableDomListener>();
  private readonly errorListener:
    ((context: DomStabilizerErrorContext) => void) | undefined;
  private readonly observer: MutationObserver | undefined;

  private started = false;
  private domReady = false;
  private pending: PendingBatch | null = null;
  private preReady: PreReadyMutations = { records: [], affectedSubtrees: [] };
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private maxTimer: ReturnType<typeof setTimeout> | undefined;
  private restoreHistory: (() => void) | undefined;
  private readonly stabilityWaiters = new Set<
    (event: StabilizedDomEvent) => void
  >();

  public constructor(options: DomStabilizerOptions = {}) {
    const document =
      options.document ??
      options.root?.ownerDocument ??
      (typeof globalThis.document === "object"
        ? globalThis.document
        : undefined);
    if (document === undefined) {
      throw new Error("DomStabilizer requires a Document");
    }

    this.document = document;
    this.targetWindow =
      options.window ??
      document.defaultView ??
      (typeof globalThis.window === "object" ? globalThis.window : undefined);
    this.root = options.root ?? document;
    this.quietWindowMs = normalizeDelay(
      options.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS,
    );
    this.maxWaitMs = normalizeDelay(options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    this.quietDelayMs = Math.max(
      this.quietWindowMs,
      normalizeDelay(options.mutationDebounceMs ?? 0),
    );
    this.observeAttributes = options.observeAttributes ?? true;
    this.attributeFilter = options.attributeFilter
      ? [...options.attributeFilter]
      : undefined;
    this.observeCharacterData = options.observeCharacterData ?? false;
    this.scheduler = options.scheduler ?? {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle),
    };
    this.errorListener = options.onError;

    if (options.onStable !== undefined) this.listeners.add(options.onStable);

    const windowWithMutationObserver = this.targetWindow as
      (Window & { MutationObserver?: typeof MutationObserver }) | undefined;
    const mutationObserverConstructor =
      windowWithMutationObserver?.MutationObserver ??
      (typeof globalThis.MutationObserver === "function"
        ? globalThis.MutationObserver
        : undefined);
    if (mutationObserverConstructor !== undefined) {
      this.observer = new mutationObserverConstructor(
        (records: MutationRecord[]) => {
          this.handleMutations(records);
        },
      );
    }
  }

  public get isStarted(): boolean {
    return this.started;
  }

  public get isDomReady(): boolean {
    return this.domReady;
  }

  public addListener(listener: StableDomListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public start(): this {
    if (this.started) return this;
    this.started = true;

    this.document.addEventListener(
      "DOMContentLoaded",
      this.handleDomContentLoaded,
    );
    this.observe();
    this.restoreHistory = installHistoryNavigationHooks(
      this.targetWindow,
      this.handleNavigation,
    );

    if (this.document.readyState === "loading") {
      this.domReady = false;
    } else {
      this.domReady = true;
      this.beginBatch("initial", [this.root]);
    }

    return this;
  }

  public stop(): void {
    if (!this.started) return;
    this.started = false;
    this.document.removeEventListener(
      "DOMContentLoaded",
      this.handleDomContentLoaded,
    );
    this.observer?.disconnect();
    this.restoreHistory?.();
    this.restoreHistory = undefined;
    this.clearTimers();
    this.pending = null;
    this.preReady = { records: [], affectedSubtrees: [] };
  }

  /** Request an intentional full scan, normally used by an inspector. */
  public requestRescan(): void {
    if (!this.started) this.start();
    if (!this.domReady) return;
    this.beginBatch("manual", [this.root]);
  }

  /** Flush a pending batch immediately; useful for tests and explicit rescans. */
  public flush(): Promise<void> {
    return this.flushPending();
  }

  /** Resolve on the next emitted stable batch. */
  public waitForNextStability(): Promise<StabilizedDomEvent> {
    return new Promise((resolve) => {
      this.stabilityWaiters.add(resolve);
    });
  }

  private readonly handleDomContentLoaded = (): void => {
    if (!this.started || this.domReady) return;
    this.domReady = true;
    const preReady = this.preReady;
    this.preReady = { records: [], affectedSubtrees: [] };
    this.beginBatch(
      "initial",
      [this.root],
      preReady.records,
      preReady.affectedSubtrees,
    );
  };

  private readonly handleNavigation = (event: HistoryNavigationEvent): void => {
    if (!this.started || !this.domReady) return;
    this.beginBatch("navigation", [this.root], [], [], event.type);
  };

  private observe(): void {
    if (this.observer === undefined) return;

    const config: MutationObserverInit = {
      childList: true,
      subtree: true,
      ...(this.observeAttributes ? { attributes: true } : {}),
      ...(this.observeCharacterData ? { characterData: true } : {}),
      ...(this.attributeFilter === undefined
        ? {}
        : { attributeFilter: [...this.attributeFilter] }),
    };
    this.observer.observe(this.root, config);
  }

  private handleMutations(records: MutationRecord[]): void {
    if (!this.started || records.length === 0) return;

    const affectedSubtrees = collectAffectedSubtrees(records);
    if (!this.domReady) {
      this.preReady.records.push(...records);
      mergeNodes(this.preReady.affectedSubtrees, affectedSubtrees);
      return;
    }

    this.beginBatch("mutation", affectedSubtrees, records);
  }

  private beginBatch(
    reason: StabilizationReason,
    affectedSubtrees: readonly Node[],
    mutations: readonly MutationRecord[] = [],
    additionalSubtrees: readonly Node[] = [],
    navigationType?: HistoryNavigationType,
  ): void {
    const now = this.scheduler.now();
    if (this.pending === null) {
      this.pending = {
        reason,
        fullScan: FULL_SCAN_REASONS.has(reason),
        affectedSubtrees: [],
        mutations: [],
        startedAt: now,
      };
      this.scheduleMaxTimer();
    } else {
      this.pending.reason = mergeReason(this.pending.reason, reason);
      this.pending.fullScan =
        this.pending.fullScan || FULL_SCAN_REASONS.has(reason);
    }

    mergeNodes(this.pending.affectedSubtrees, affectedSubtrees);
    mergeNodes(this.pending.affectedSubtrees, additionalSubtrees);
    this.pending.mutations.push(...mutations);
    if (navigationType !== undefined) {
      this.pending.navigationType = navigationType;
    }

    this.scheduleQuietTimer();
  }

  private scheduleQuietTimer(): void {
    this.clearQuietTimer();
    if (this.pending === null) return;
    this.quietTimer = this.scheduler.setTimeout(() => {
      void this.flushPending();
    }, this.quietDelayMs);
  }

  private scheduleMaxTimer(): void {
    this.clearMaxTimer();
    if (this.pending === null) return;
    this.maxTimer = this.scheduler.setTimeout(() => {
      void this.flushPending();
    }, this.maxWaitMs);
  }

  private flushPending(): Promise<void> {
    if (this.pending === null) return Promise.resolve();

    const pending = this.pending;
    this.pending = null;
    this.clearTimers();
    const event: StabilizedDomEvent = {
      reason: pending.reason,
      fullScan: pending.fullScan,
      affectedSubtrees: [...pending.affectedSubtrees],
      mutations: [...pending.mutations],
      url:
        this.targetWindow?.location.href ?? this.document.location?.href ?? "",
      timestamp: this.scheduler.now(),
      ...(pending.navigationType === undefined
        ? {}
        : { navigationType: pending.navigationType }),
    };

    for (const resolve of this.stabilityWaiters) resolve(event);
    this.stabilityWaiters.clear();

    const listenerPromises = [...this.listeners].map((listener) =>
      Promise.resolve().then(() => listener(event)),
    );
    return Promise.all(listenerPromises).then(
      () => undefined,
      (error: unknown) => {
        this.reportError({ event, error });
      },
    );
  }

  private clearTimers(): void {
    this.clearQuietTimer();
    this.clearMaxTimer();
  }

  private clearQuietTimer(): void {
    if (this.quietTimer === undefined) return;
    this.scheduler.clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
  }

  private clearMaxTimer(): void {
    if (this.maxTimer === undefined) return;
    this.scheduler.clearTimeout(this.maxTimer);
    this.maxTimer = undefined;
  }

  private reportError(context: DomStabilizerErrorContext): void {
    this.errorListener?.(context);
  }
}

/** Alternate spelling for callers that prefer the acronym to be capitalized. */
export const DOMStabilizer = DomStabilizer;

function normalizeDelay(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function mergeReason(
  current: StabilizationReason,
  incoming: StabilizationReason,
): StabilizationReason {
  if (FULL_SCAN_REASONS.has(incoming)) return incoming;
  if (FULL_SCAN_REASONS.has(current)) return current;
  return incoming;
}

function collectAffectedSubtrees(records: readonly MutationRecord[]): Node[] {
  const nodes: Node[] = [];
  for (const record of records) {
    mergeNodes(nodes, [record.target]);
  }
  return nodes;
}

/** Keep only the smallest set of roots that covers all changed subtrees. */
function mergeNodes(target: Node[], candidates: readonly Node[]): void {
  for (const candidate of candidates) {
    if (target.some((existing) => containsNode(existing, candidate))) continue;
    for (let index = target.length - 1; index >= 0; index -= 1) {
      const existing = target[index];
      if (existing !== undefined && containsNode(candidate, existing)) {
        target.splice(index, 1);
      }
    }
    target.push(candidate);
  }
}

function containsNode(ancestor: Node, descendant: Node): boolean {
  if (ancestor === descendant) return true;
  try {
    return ancestor.contains(descendant);
  } catch {
    return false;
  }
}
