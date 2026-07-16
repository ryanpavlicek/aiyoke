#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionId } from "../dist/core/index.js";
import { AiyokeEngine } from "../dist/engine/index.js";

if (process.env.AIYOKE_LIVE_PROVIDER_TESTS !== "1") {
  process.stdout.write(
    "Live provider smoke skipped; set AIYOKE_LIVE_PROVIDER_TESTS=1 to opt in.\n"
  );
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), "aiyoke-live-provider-"));
try {
  const engine = await AiyokeEngine.open(root);
  await engine.initialize({
    languages: [extensionId("javascript")],
    frameworks: [],
    targetAdapters: [extensionId("openrouter")]
  });
  await engine.apply();

  const runtimeDirectory = join(root, "aiyoke-runtime", "javascript");
  const runtime = await import(pathToFileURL(join(runtimeDirectory, "runtime.js")).href);
  const provider = await import(
    pathToFileURL(join(runtimeDirectory, "providers", "responses.js")).href
  );
  const registry = new runtime.AdapterRegistry();
  let upstream = {};
  const fetchPort = async (...arguments_) => {
    const response = await fetch(...arguments_);
    const payload = await response
      .clone()
      .json()
      .catch(() => ({}));
    upstream = {
      httpStatus: response.status,
      status: typeof payload.status === "string" ? payload.status : undefined,
      errorCode:
        typeof payload.error?.code === "string" || typeof payload.error?.code === "number"
          ? String(payload.error.code)
          : undefined,
      errorType: typeof payload.error?.type === "string" ? payload.error.type : undefined
    };
    return response;
  };
  const adapter = provider.registerResponsesAdapter(
    registry,
    "live-openrouter",
    provider.responsesAdapterConfig(
      "openrouter",
      process.env.AIYOKE_LIVE_OPENROUTER_MODEL ?? "openrouter/free",
      { maxResponseBytes: 1024 * 1024 }
    ),
    (environmentVariable) => process.env[environmentVariable],
    fetchPort
  );
  const signal = AbortSignal.timeout(60_000);
  const result = await adapter.invoke(
    {
      id: "live-smoke",
      route: "live-openrouter",
      promptVersion: "live-smoke-v1",
      input: { input: "Reply with exactly OK." },
      inputTokens: 6,
      maxOutputTokens: 32,
      metadata: { test: "live-smoke" }
    },
    signal
  );
  if (result.kind !== "success") {
    throw new Error(
      `Live OpenRouter smoke failed with ${result.failure.providerCode ?? result.failure.kind}: ${result.failure.message}` +
        ` Upstream metadata: ${JSON.stringify(upstream)}.`
    );
  }
  if (registry.get("live-openrouter") !== adapter) {
    throw new Error("Live OpenRouter adapter was not registered.");
  }
  if (typeof result.value?.text !== "string" || result.value.text.trim().length === 0) {
    throw new Error("Live OpenRouter smoke returned no text.");
  }
  process.stdout.write(
    `Live OpenRouter smoke passed (${result.usage.inputTokens} input, ${result.usage.outputTokens} output tokens).\n`
  );
} finally {
  const temporary = resolve(tmpdir());
  const fixture = resolve(root);
  if (
    (fixture.startsWith(`${temporary}\\`) || fixture.startsWith(`${temporary}/`)) &&
    basename(fixture).startsWith("aiyoke-live-provider-")
  ) {
    await rm(fixture, { recursive: true, force: true });
  }
}
