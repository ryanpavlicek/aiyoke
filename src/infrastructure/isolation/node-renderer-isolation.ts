import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extensionArtifactPath } from "../../application/artifact-policy.js";
import { isShareableWorkspacePath } from "../../application/workspace-snapshot-policy.js";
import {
  type ArtifactIntent,
  canonicalJson,
  compareCodePoints,
  safeRelativePath
} from "../../core/index.js";
import {
  type AiyokeExtension,
  type ExtensionLoader,
  type IsolatedRendererResult,
  type IsolatedRenderInvocation,
  type IsolatedSignedExtensionOptions,
  RENDERER_ISOLATION_PROTOCOL_VERSION,
  type RuntimeTemplateExtension,
  type TargetExtension,
  type WorkspaceSnapshot
} from "../../extension-sdk/index.js";
import {
  digestExtensionPackage,
  verifySignedExtensionPackage
} from "../discovery/node-signed-discovery.js";

const WORKER_ARGUMENT = "--aiyoke-internal-renderer-child=1";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_INPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_WORKSPACE_FILES = 2_000;
const DEFAULT_MAX_ARTIFACTS = 512;
const DEFAULT_MEMORY_MB = 128;
let workerKeepAlive: ReturnType<typeof setInterval> | undefined;

interface ResolvedLimits {
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxWorkspaceFiles: number;
  readonly maxArtifacts: number;
  readonly memoryMb: number;
}

interface SerializedWorkspace {
  readonly root: string;
  readonly files: readonly string[];
  readonly contents: readonly (readonly [string, string])[];
}

type WireInvocation =
  | {
      readonly kind: "target-render";
      readonly context: Omit<
        Extract<IsolatedRenderInvocation, { kind: "target-render" }>["context"],
        "workspace"
      > & {
        readonly workspace: SerializedWorkspace;
      };
    }
  | {
      readonly kind: "runtime-render";
      readonly context: Omit<
        Extract<IsolatedRenderInvocation, { kind: "runtime-render" }>["context"],
        "workspace"
      > & {
        readonly workspace: SerializedWorkspace;
      };
    };

interface WorkerRequest {
  readonly protocolVersion: typeof RENDERER_ISOLATION_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly packageRoot: string;
  readonly entrypointPath: string;
  readonly exportName: string;
  readonly descriptor: ExtensionLoader["descriptor"];
  readonly contentDigest: string;
  readonly maxPackageBytes?: number;
  readonly maxPackageFiles?: number;
  readonly maxOutputBytes: number;
  readonly maxArtifacts: number;
  readonly invocation: WireInvocation;
}

type WorkerResponse =
  | {
      readonly protocolVersion: typeof RENDERER_ISOLATION_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly kind: "rendered";
      readonly artifacts: readonly ArtifactIntent[];
    }
  | {
      readonly protocolVersion: typeof RENDERER_ISOLATION_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly kind: "failed";
      readonly reason:
        | "output-limit"
        | "protocol-failed"
        | "package-failed"
        | "module-failed"
        | "load-failed"
        | "render-failed"
        | "artifacts-failed";
    };

function diagnostic(options: IsolatedSignedExtensionOptions, stage: string, reason: string): void {
  try {
    options.diagnostics?.emit({ boundary: "isolation", stage, reason });
  } catch {
    // Diagnostics are opt-in and never alter isolation decisions.
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an object.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key))) {
    throw new TypeError("Object contains an unsupported field.");
  }
}

function validateArtifacts(
  value: unknown,
  maxArtifacts: number,
  lockFile: string
): readonly ArtifactIntent[] {
  if (!Array.isArray(value) || value.length > maxArtifacts) {
    throw new RangeError("Renderer returned an invalid artifact count.");
  }
  const paths = new Set<string>();
  return value.map((candidate) => {
    const artifact = record(candidate);
    const ownership = artifact.ownership;
    const keys = ["path", "content", "source", "executable", "ownership"];
    if (ownership === "managed-section") keys.push("markers");
    exactKeys(artifact, keys);
    if (
      typeof artifact.path !== "string" ||
      typeof artifact.content !== "string" ||
      typeof artifact.source !== "string" ||
      artifact.source.length === 0 ||
      typeof artifact.executable !== "boolean" ||
      !["generated", "managed-section", "user-owned"].includes(String(ownership))
    ) {
      throw new TypeError("Renderer returned an invalid artifact.");
    }
    const path = extensionArtifactPath(artifact.path, lockFile);
    if (paths.has(path)) throw new TypeError("Renderer returned duplicate artifact paths.");
    paths.add(path);
    const base = {
      path,
      content: artifact.content,
      source: artifact.source,
      executable: artifact.executable
    };
    if (ownership === "managed-section") {
      const markers = record(artifact.markers);
      exactKeys(markers, ["start", "end"]);
      if (
        typeof markers.start !== "string" ||
        markers.start.length === 0 ||
        markers.start.includes("\n") ||
        markers.start.includes("\r") ||
        typeof markers.end !== "string" ||
        markers.end.length === 0 ||
        markers.end.includes("\n") ||
        markers.end.includes("\r") ||
        markers.start === markers.end ||
        artifact.content.includes(markers.start) ||
        artifact.content.includes(markers.end)
      ) {
        throw new TypeError("Renderer returned invalid managed-section markers.");
      }
      return { ...base, ownership, markers: { start: markers.start, end: markers.end } };
    }
    return { ...base, ownership } as ArtifactIntent;
  });
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

function resolveLimits(options: IsolatedSignedExtensionOptions): ResolvedLimits {
  const limits = options.limits;
  const memoryMb = positiveInteger(limits?.memoryMb, DEFAULT_MEMORY_MB, "memoryMb");
  if (memoryMb < 16 || memoryMb > 4_096) {
    throw new RangeError("memoryMb must be between 16 and 4096.");
  }
  return {
    timeoutMs: positiveInteger(limits?.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs"),
    maxInputBytes: positiveInteger(limits?.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, "maxInputBytes"),
    maxOutputBytes: positiveInteger(
      limits?.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes"
    ),
    maxWorkspaceFiles: positiveInteger(
      limits?.maxWorkspaceFiles,
      DEFAULT_MAX_WORKSPACE_FILES,
      "maxWorkspaceFiles"
    ),
    maxArtifacts: positiveInteger(limits?.maxArtifacts, DEFAULT_MAX_ARTIFACTS, "maxArtifacts"),
    memoryMb
  };
}

async function serializeWorkspace(
  workspace: WorkspaceSnapshot,
  limits: ResolvedLimits
): Promise<SerializedWorkspace> {
  const files = workspace.files
    .map(safeRelativePath)
    .filter(isShareableWorkspacePath)
    .sort(compareCodePoints);
  if (files.length > limits.maxWorkspaceFiles) {
    throw new RangeError("Workspace file count exceeds the isolation input limit.");
  }
  if (new Set(files).size !== files.length) {
    throw new TypeError("Workspace file list contains duplicates.");
  }
  const contents: Array<readonly [string, string]> = [];
  let bytes = 0;
  for (const path of files) {
    const content = await workspace.read(path);
    if (content === undefined)
      throw new TypeError("Workspace snapshot is internally inconsistent.");
    bytes += Buffer.byteLength(path, "utf8") + Buffer.byteLength(content, "utf8");
    if (bytes > limits.maxInputBytes) {
      throw new RangeError("Workspace content exceeds the isolation input limit.");
    }
    contents.push([path, content]);
  }
  return { root: workspace.root, files, contents };
}

async function wireInvocation(
  invocation: IsolatedRenderInvocation,
  limits: ResolvedLimits
): Promise<WireInvocation> {
  const workspace = await serializeWorkspace(invocation.context.workspace, limits);
  if (invocation.kind === "target-render") {
    const { workspace: _workspace, ...context } = invocation.context;
    return { kind: invocation.kind, context: { ...context, workspace } };
  }
  const { workspace: _workspace, ...context } = invocation.context;
  return { kind: invocation.kind, context: { ...context, workspace } };
}

function reconstructedWorkspace(serialized: SerializedWorkspace): WorkspaceSnapshot {
  const contents = new Map(serialized.contents);
  return {
    root: serialized.root,
    files: serialized.files,
    async read(path) {
      return contents.get(safeRelativePath(path));
    },
    async exists(path) {
      return contents.has(safeRelativePath(path));
    }
  };
}

function isLoader(value: unknown): value is ExtensionLoader {
  if (value === null || typeof value !== "object") return false;
  const loader = value as Partial<ExtensionLoader>;
  return loader.descriptor !== undefined && typeof loader.load === "function";
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function sendWorkerResponse(response: WorkerResponse, maxOutputBytes: number): void {
  if (workerKeepAlive !== undefined) {
    clearInterval(workerKeepAlive);
    workerKeepAlive = undefined;
  }
  let payload = JSON.stringify(response);
  if (Buffer.byteLength(payload, "utf8") > maxOutputBytes) {
    payload = JSON.stringify({
      protocolVersion: RENDERER_ISOLATION_PROTOCOL_VERSION,
      requestId: response.requestId,
      kind: "failed",
      reason: "output-limit"
    } satisfies WorkerResponse);
  }
  process.send?.(payload, () => process.disconnect());
}

async function runRendererChild(): Promise<void> {
  workerKeepAlive = setInterval(() => undefined, 1_000);
  process.once("message", async (message: unknown) => {
    let request: WorkerRequest | undefined;
    let stage = "protocol" as "protocol" | "package" | "module" | "load" | "render" | "artifacts";
    try {
      if (typeof message !== "string") throw new TypeError("Invalid protocol message.");
      request = JSON.parse(message) as WorkerRequest;
      if (
        request.protocolVersion !== RENDERER_ISOLATION_PROTOCOL_VERSION ||
        typeof request.requestId !== "string" ||
        request.requestId.length === 0
      ) {
        throw new TypeError("Invalid protocol version.");
      }
      stage = "package";
      const digest = await digestExtensionPackage(request.packageRoot, {
        ...(request.maxPackageBytes === undefined ? {} : { maxBytes: request.maxPackageBytes }),
        ...(request.maxPackageFiles === undefined ? {} : { maxFiles: request.maxPackageFiles })
      });
      if (digest !== request.contentDigest) throw new TypeError("Package changed before render.");
      const entrypointMetadata = await lstat(request.entrypointPath);
      if (entrypointMetadata.isSymbolicLink() || !entrypointMetadata.isFile()) {
        throw new TypeError("Entrypoint is invalid.");
      }
      const entrypoint = await realpath(request.entrypointPath);
      const url = pathToFileURL(entrypoint);
      url.searchParams.set("aiyoke-isolated-content", digest);
      stage = "module";
      const module = (await import(url.href)) as Readonly<Record<string, unknown>>;
      const loader = module[request.exportName];
      if (
        !isLoader(loader) ||
        canonicalJson(loader.descriptor) !== canonicalJson(request.descriptor)
      ) {
        throw new TypeError("Loader does not match the signed descriptor.");
      }
      stage = "load";
      const extension: AiyokeExtension = await loader.load();
      if (canonicalJson(extension.descriptor) !== canonicalJson(request.descriptor)) {
        throw new TypeError("Extension does not match the signed descriptor.");
      }
      const workspace = reconstructedWorkspace(request.invocation.context.workspace);
      let artifacts: readonly ArtifactIntent[];
      stage = "render";
      if (request.invocation.kind === "target-render") {
        if (extension.descriptor.kind !== "target") throw new TypeError("Renderer kind mismatch.");
        artifacts = await (extension as TargetExtension).render({
          ...request.invocation.context,
          workspace
        });
      } else {
        if (extension.descriptor.kind !== "runtime") throw new TypeError("Renderer kind mismatch.");
        artifacts = await (extension as RuntimeTemplateExtension).render({
          ...request.invocation.context,
          workspace
        });
      }
      stage = "artifacts";
      sendWorkerResponse(
        {
          protocolVersion: RENDERER_ISOLATION_PROTOCOL_VERSION,
          requestId: request.requestId,
          kind: "rendered",
          artifacts: validateArtifacts(
            artifacts,
            request.maxArtifacts,
            request.invocation.context.spec.generation.lockFile
          )
        },
        request.maxOutputBytes
      );
    } catch {
      sendWorkerResponse(
        {
          protocolVersion: RENDERER_ISOLATION_PROTOCOL_VERSION,
          requestId: request?.requestId ?? "invalid",
          kind: "failed",
          reason: `${stage}-failed`
        },
        request?.maxOutputBytes ?? 1024
      );
    }
  });
}

async function runWorker(
  request: WorkerRequest,
  limits: ResolvedLimits,
  signal: AbortSignal | undefined
): Promise<WorkerResponse | "cancelled" | "timeout" | "protocol"> {
  if (signal?.aborted) return "cancelled";
  const modulePath = fileURLToPath(import.meta.url);
  const loaderArguments = modulePath.endsWith(".ts")
    ? ["--import", import.meta.resolve("tsx")]
    : [];
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${limits.memoryMb}`, ...loaderArguments, modulePath, WORKER_ARGUMENT],
    {
      cwd: request.packageRoot,
      env: minimalEnvironment(),
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true
    }
  );
  return new Promise((resolve) => {
    let settled = false;
    let diagnosticBytes = 0;
    const finish = (result: WorkerResponse | "cancelled" | "timeout" | "protocol") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(result);
        return;
      }
      const fallback = setTimeout(() => resolve(result), 2_000);
      const forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 500);
      child.once("exit", () => {
        clearTimeout(fallback);
        clearTimeout(forceKill);
        setTimeout(() => resolve(result), 250);
      });
      if (child.connected) child.disconnect();
      if (!child.killed) child.kill("SIGTERM");
    };
    const cancel = () => finish("cancelled");
    const timer = setTimeout(() => finish("timeout"), limits.timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      diagnosticBytes += chunk.byteLength;
      if (diagnosticBytes > 64 * 1024) finish("protocol");
    });
    child.once("error", () => finish("protocol"));
    child.once("exit", () => finish("protocol"));
    child.once("message", (message: unknown) => {
      try {
        if (
          typeof message !== "string" ||
          Buffer.byteLength(message, "utf8") > limits.maxOutputBytes
        ) {
          finish("protocol");
          return;
        }
        const parsed = JSON.parse(message) as WorkerResponse;
        if (
          parsed.protocolVersion !== RENDERER_ISOLATION_PROTOCOL_VERSION ||
          parsed.requestId !== request.requestId ||
          !["rendered", "failed"].includes(parsed.kind)
        ) {
          finish("protocol");
          return;
        }
        if (parsed.kind === "rendered") {
          validateArtifacts(
            parsed.artifacts,
            limits.maxArtifacts,
            request.invocation.context.spec.generation.lockFile
          );
        }
        finish(parsed);
      } catch {
        finish("protocol");
      }
    });
    signal?.addEventListener("abort", cancel, { once: true });
    child.send(JSON.stringify(request), (error) => {
      if (error) finish("protocol");
    });
  });
}

export async function renderSignedExtensionIsolated(
  options: IsolatedSignedExtensionOptions
): Promise<IsolatedRendererResult> {
  let limits: ResolvedLimits;
  try {
    limits = resolveLimits(options);
  } catch {
    diagnostic(options, "limits", "isolation-input-limit");
    return {
      kind: "rejected",
      reason: "isolation-input-limit",
      message: "Renderer isolation limits are invalid."
    };
  }
  const verification = await verifySignedExtensionPackage(options);
  if (verification.kind !== "verified") return verification;
  const expectedKind = options.invocation.kind === "target-render" ? "target" : "runtime";
  if (verification.manifest.extension.kind !== expectedKind) {
    return {
      kind: "rejected",
      reason: "renderer-kind-mismatch",
      message: "Signed extension kind does not match the requested renderer operation.",
      manifestDigest: verification.manifestDigest
    };
  }
  let invocation: WireInvocation;
  try {
    invocation = await wireInvocation(options.invocation, limits);
  } catch {
    diagnostic(options, "input-serialization", "isolation-input-limit");
    return {
      kind: "rejected",
      reason: "isolation-input-limit",
      message: "Renderer isolation input is invalid or exceeds its limit.",
      manifestDigest: verification.manifestDigest
    };
  }
  const request: WorkerRequest = {
    protocolVersion: RENDERER_ISOLATION_PROTOCOL_VERSION,
    requestId: randomUUID(),
    packageRoot: verification.packageRoot,
    entrypointPath: verification.entrypointPath,
    exportName: verification.manifest.package.exportName,
    descriptor: verification.manifest.extension,
    contentDigest: verification.contentDigest,
    ...(options.maxPackageBytes === undefined ? {} : { maxPackageBytes: options.maxPackageBytes }),
    ...(options.maxPackageFiles === undefined ? {} : { maxPackageFiles: options.maxPackageFiles }),
    maxOutputBytes: limits.maxOutputBytes,
    maxArtifacts: limits.maxArtifacts,
    invocation
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > limits.maxInputBytes) {
    return {
      kind: "rejected",
      reason: "isolation-input-limit",
      message: "Renderer isolation request exceeds its input limit.",
      manifestDigest: verification.manifestDigest
    };
  }
  const response = await runWorker(request, limits, options.signal);
  if (response === "cancelled") {
    diagnostic(options, "process", "isolation-cancelled");
    return {
      kind: "rejected",
      reason: "isolation-cancelled",
      message: "Isolated renderer was cancelled.",
      manifestDigest: verification.manifestDigest
    };
  }
  if (response === "timeout") {
    diagnostic(options, "process", "isolation-timeout");
    return {
      kind: "rejected",
      reason: "isolation-timeout",
      message: "Isolated renderer exceeded its deadline.",
      manifestDigest: verification.manifestDigest
    };
  }
  if (response === "protocol") {
    diagnostic(options, "protocol", "isolation-protocol");
    return {
      kind: "rejected",
      reason: "isolation-protocol",
      message: "Isolated renderer violated the process protocol.",
      manifestDigest: verification.manifestDigest
    };
  }
  if (response.kind === "failed") {
    diagnostic(options, "renderer", response.reason);
    return {
      kind: "rejected",
      reason: response.reason === "output-limit" ? "isolation-output-limit" : "isolation-failed",
      message:
        response.reason === "output-limit"
          ? "Isolated renderer output exceeds its limit."
          : "Isolated renderer failed.",
      manifestDigest: verification.manifestDigest
    };
  }
  return {
    kind: "rendered",
    artifacts: response.artifacts,
    manifest: verification.manifest,
    manifestDigest: verification.manifestDigest,
    contentDigest: verification.contentDigest
  };
}

if (process.argv.includes(WORKER_ARGUMENT)) {
  void runRendererChild().catch(() => {
    process.exitCode = 1;
  });
}
