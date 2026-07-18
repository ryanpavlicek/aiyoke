import { createGoLanguageLoader, go, goLanguageLoader } from "./go.js";
import {
  createJavaScriptLanguageLoader,
  javascript,
  javascriptLanguageLoader
} from "./javascript.js";
import { createPythonLanguageLoader, python, pythonLanguageLoader } from "./python.js";
import { createRustLanguageLoader, rust, rustLanguageLoader } from "./rust.js";
import {
  createTypeScriptLanguageLoader,
  typescript,
  typescriptLanguageLoader
} from "./typescript.js";

export {
  createGoLanguageLoader,
  createJavaScriptLanguageLoader,
  createPythonLanguageLoader,
  createRustLanguageLoader,
  createTypeScriptLanguageLoader,
  go,
  goLanguageLoader,
  javascript,
  javascriptLanguageLoader,
  python,
  pythonLanguageLoader,
  rust,
  rustLanguageLoader,
  typescript,
  typescriptLanguageLoader
};

export const languageLoaders = [
  pythonLanguageLoader,
  typescriptLanguageLoader,
  javascriptLanguageLoader,
  rustLanguageLoader,
  goLanguageLoader
] as const;

export const languageLoaderFactories = [
  createPythonLanguageLoader,
  createTypeScriptLanguageLoader,
  createJavaScriptLanguageLoader,
  createRustLanguageLoader,
  createGoLanguageLoader
] as const;
