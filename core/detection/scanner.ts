import type { BlockedCapability, PageIdentity, ScanOptions } from "../types";
import { documentUrl, safeUrlOrigin } from "../dom/utils";
import { discoverDocument, discoverDocumentSubtrees } from "../dom/traverse";
import type { DiscoverySnapshot, TraversalRoot } from "../dom/types";
import { inferCapabilityRecords, inferCapabilities } from "./infer";
import type { ScanResult } from "./types";

export type { ScanResult } from "./types";

function pageIdentity(document: Document): PageIdentity {
  const url = documentUrl(document);
  let title = "";
  try {
    title = document.title || "";
  } catch {
    title = "";
  }
  let hostname = "";
  try {
    hostname = url ? new URL(url).hostname : "";
  } catch {
    hostname = "";
  }
  return { url, title, origin: safeUrlOrigin(document), hostname };
}

export function snapshotDocument(
  document: Document,
  options: ScanOptions = {},
): DiscoverySnapshot {
  return discoverDocument(document, {
    includeFrames: options.includeFrames ?? true,
    includeShadowDom: options.includeShadowDom ?? true,
  });
}

export function scanDocument(
  document: Document,
  options: ScanOptions = {},
): ScanResult {
  return scanSnapshot(document, snapshotDocument(document, options));
}

/** Scan only bounded roots; callers merge the result into the canonical graph. */
export function scanDocumentSubtrees(
  document: Document,
  roots: readonly TraversalRoot[],
  options: ScanOptions = {},
): ScanResult {
  const snapshot = discoverDocumentSubtrees(document, roots, {
    includeFrames: options.includeFrames ?? true,
    includeShadowDom: options.includeShadowDom ?? true,
  });
  return scanSnapshot(document, snapshot);
}

function scanSnapshot(
  document: Document,
  snapshot: DiscoverySnapshot,
): ScanResult {
  const records = inferCapabilityRecords(snapshot);
  const generatedAt = Date.now();
  const capabilityElements = new Map(
    records.map(({ capability, element }) => [capability.id, element]),
  );
  return {
    capabilities: records.map(({ capability }) => capability),
    capabilityElements,
    blocked: snapshot.blocked,
    blockedElements: snapshot.blockedElements,
    page: pageIdentity(document),
    scannedRoots: snapshot.rootsScanned,
    scannedAt: generatedAt,
    documentsScanned: snapshot.documentsScanned,
    elementsScanned: snapshot.elementsScanned,
    generatedAt,
  };
}

export { inferCapabilities };
