import type {
  BlockedCapability,
  Capability,
  PageIdentity,
  ScanOptions,
} from "../types";

export interface ScanResult {
  page: PageIdentity;
  capabilities: Capability[];
  /** Internal index; DOM nodes never cross the extension bridge. */
  capabilityElements: Map<string, Element>;
  blocked: BlockedCapability[];
  blockedElements: Map<string, Element>;
  scannedRoots: number;
  scannedAt: number;
  documentsScanned: number;
  elementsScanned: number;
  generatedAt: number;
}

export type { ScanOptions };
