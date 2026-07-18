import type { WorkspaceSnapshot } from "../extension-sdk/index.js";

export interface WorkspacePort extends WorkspaceSnapshot {
  writeAtomic(path: string, content: string, executable: boolean): Promise<void>;
  writeBatchAtomic(writes: readonly WorkspaceWrite[]): Promise<void>;
}

export interface WorkspaceWrite {
  readonly path: string;
  readonly content: string;
  readonly executable: boolean;
  readonly previous: string | undefined;
}

export interface HashPort {
  digest(value: string): string;
}
