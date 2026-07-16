import type { ExtensionLoader } from "../../extension-sdk/index.js";
import { goRuntimeLoader } from "./go.js";
import { javascriptRuntimeLoader } from "./javascript.js";
import { pythonRuntimeLoader } from "./python.js";
import { rustRuntimeLoader } from "./rust.js";
import { typescriptRuntimeLoader } from "./typescript.js";

export {
  createGoRuntimeLoader,
  goRuntime,
  goRuntimeLoader
} from "./go.js";
export {
  createJavaScriptRuntimeLoader,
  javascriptRuntime,
  javascriptRuntimeLoader
} from "./javascript.js";
export {
  createPythonRuntimeLoader,
  pythonRuntime,
  pythonRuntimeLoader
} from "./python.js";
export {
  createRustRuntimeLoader,
  rustRuntime,
  rustRuntimeLoader
} from "./rust.js";
export {
  createTypeScriptRuntimeLoader,
  typescriptRuntime,
  typescriptRuntimeLoader
} from "./typescript.js";

export const runtimeLoaders: readonly ExtensionLoader[] = [
  goRuntimeLoader,
  javascriptRuntimeLoader,
  pythonRuntimeLoader,
  rustRuntimeLoader,
  typescriptRuntimeLoader
];
