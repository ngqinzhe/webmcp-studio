import type { CapabilityGraph, GraphDiff } from "../types";
import {
  DomStabilizer,
  type DomStabilizerOptions,
  type StableDomListener,
  type StabilizedDomEvent,
} from "./dom-stabilizer";
import { diffGraphs } from "../graph/capability-graph";

export interface LifecycleScanContext extends StabilizedDomEvent {}

export type CapabilityScanCallback = (
  context: LifecycleScanContext,
) =>
  | CapabilityGraph
  | null
  | undefined
  | Promise<CapabilityGraph | null | undefined>;

export interface GraphLifecycleEvent {
  context: LifecycleScanContext;
  previous: CapabilityGraph | null;
  graph: CapabilityGraph;
  diff: GraphDiff;
}

export interface LifecycleErrorContext {
  context: LifecycleScanContext;
  error: unknown;
}

export interface LifecycleControllerOptions {
  scan: CapabilityScanCallback;
  onGraphChange?: (event: GraphLifecycleEvent) => void | Promise<void>;
  onError?: (context: LifecycleErrorContext) => void;
  stabilizer?: DomStabilizer;
  stabilizerOptions?: DomStabilizerOptions;
}

/**
 * Connect a stable-DOM source to graph rescans and graph diffs. The controller
 * does not scan DOM nodes itself, which lets content scripts incrementally scan
 * `affectedSubtrees` and reserve full scans for lifecycle boundaries.
 */
export class LifecycleController {
  private readonly scan: CapabilityScanCallback;
  private readonly graphListener:
    ((event: GraphLifecycleEvent) => void | Promise<void>) | undefined;
  private readonly errorListener:
    ((context: LifecycleErrorContext) => void) | undefined;
  private readonly stabilizer: DomStabilizer;
  private removeStableListener: (() => void) | null = null;

  private currentGraph: CapabilityGraph | null = null;
  private scanVersion = 0;
  private idle: Promise<void> = Promise.resolve();
  private readonly rescanWaiters = new Set<() => void>();

  public constructor(options: LifecycleControllerOptions) {
    this.scan = options.scan;
    this.graphListener = options.onGraphChange;
    this.errorListener = options.onError;
    this.stabilizer =
      options.stabilizer ?? new DomStabilizer(options.stabilizerOptions);
    this.subscribeToStabilizer();
  }

  public get graph(): CapabilityGraph | null {
    return this.currentGraph;
  }

  public get domStabilizer(): DomStabilizer {
    return this.stabilizer;
  }

  public start(): this {
    if (this.removeStableListener === null) this.subscribeToStabilizer();
    this.stabilizer.start();
    return this;
  }

  public stop(): void {
    this.scanVersion += 1;
    this.removeStableListener?.();
    this.removeStableListener = null;
    this.stabilizer.stop();
    for (const resolve of this.rescanWaiters) resolve();
    this.rescanWaiters.clear();
  }

  public rescan(): Promise<void> {
    const completion = new Promise<void>((resolve) => {
      this.rescanWaiters.add(resolve);
    });
    this.idle = Promise.all([this.idle, completion]).then(() => undefined);
    this.stabilizer.requestRescan();
    return completion;
  }

  /** Wait until scans already dispatched by the controller have settled. */
  public waitForIdle(): Promise<void> {
    return this.idle;
  }

  private subscribeToStabilizer(): void {
    const listener: StableDomListener = (event) => this.handleStable(event);
    this.removeStableListener = this.stabilizer.addListener(listener);
  }

  private readonly handleStable = (
    context: LifecycleScanContext,
  ): Promise<void> => {
    const version = ++this.scanVersion;
    const work = Promise.resolve()
      .then(() => this.scan(context))
      .then(async (graph) => {
        // A newer stable event has already started. Do not allow a slower scan
        // from an older DOM snapshot to overwrite the newer graph.
        if (version !== this.scanVersion || graph == null) return;

        const previous = this.currentGraph;
        const diff = diffGraphs(previous, graph);
        this.currentGraph = graph;
        await this.graphListener?.({ context, previous, graph, diff });
      })
      .catch((error: unknown) => {
        this.errorListener?.({ context, error });
      })
      .finally(() => {
        for (const resolve of this.rescanWaiters) resolve();
        this.rescanWaiters.clear();
      });

    this.idle = Promise.all([this.idle, work]).then(() => undefined);
    return work;
  };
}

/** Alias matching the noun used by content-script integrations. */
export const GraphLifecycleController = LifecycleController;
