export interface BuiltinDiagnosticBase {
  readonly code: string;
  readonly summary: string;
  readonly remediation: string;
  readonly stability: "stable";
}

export interface BuiltinErrorDiagnostic extends BuiltinDiagnosticBase {
  readonly channel: "error";
}

export interface BuiltinFindingDiagnostic extends BuiltinDiagnosticBase {
  readonly channel: "finding";
  readonly defaultSeverity: "info" | "warning" | "error";
}

/**
 * Machine-readable documentation for diagnostics emitted by Aiyoke itself.
 * Extensions may emit additional finding codes outside this closed built-in catalog.
 */
export type BuiltinDiagnosticDefinition = BuiltinErrorDiagnostic | BuiltinFindingDiagnostic;
