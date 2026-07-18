import fc from "fast-check";

export const PROPERTY_TEST_SEED = 0x0a17_0040;

const requestedSeed = Number.parseInt(process.env.AIYOKE_FAST_CHECK_SEED ?? "", 10);
fc.configureGlobal({
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : PROPERTY_TEST_SEED
});
