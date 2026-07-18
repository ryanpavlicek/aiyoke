export interface ArchitectureResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
  readonly files: readonly string[];
}

export interface ArchitectureViolation {
  readonly file: string;
  readonly fromLayer: string;
  readonly toLayer: string;
  readonly specifier: string;
  readonly reason: string;
}

export function extractStaticImports(source: string, fileName?: string): readonly string[];
export function extractDynamicImports(source: string, fileName?: string): readonly string[];
export function checkArchitecture(options?: {
  readonly root?: string;
  readonly srcRoot?: string;
}): Omit<ArchitectureResult, "violations"> & {
  readonly violations: readonly ArchitectureViolation[];
};
