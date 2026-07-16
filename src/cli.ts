#!/usr/bin/env node

import { runCli } from "./interfaces/cli/index.js";

process.exitCode = await runCli();
