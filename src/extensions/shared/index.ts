export {
  indexWorkspaceFiles,
  matchesPathOrBasename,
  normalizeWorkspacePath,
  type WorkspaceFileIndex
} from "./detection.js";
export { loaderFor } from "./loader.js";
export type { ArtifactOptions } from "./render.js";
export {
  artifact,
  assertUniqueModuleDefinitions,
  renderHooks,
  renderInstructions,
  renderMcpServers,
  renderSkill,
  sanitizeJson,
  sanitizeObject,
  stableJson,
  stableStrings,
  targetMatches,
  uniqueSkills,
  yamlFrontmatterScalar
} from "./render.js";
export type { TargetImplementation } from "./target.js";
export { descriptor, verifyArtifacts, verifyTarget } from "./target.js";
