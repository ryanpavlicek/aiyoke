import { createHash } from "node:crypto";
import type { HashPort } from "../../application/index.js";

export class Sha256Hash implements HashPort {
  digest(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}
