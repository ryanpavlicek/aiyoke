import type { WorkspaceSnapshot } from "../extension-sdk/index.js";

export interface WorkspacePort extends WorkspaceSnapshot {
  writeAtomic(path: string, content: string, executable: boolean): Promise<void>;
}

export interface HashPort {
  digest(value: string): string;
}
