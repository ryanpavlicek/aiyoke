# External hello target

This directory is a complete extension package outside Aiyoke's built-in source
tree. `package/index.mjs` exports only the public `ExtensionLoader` shape. The
checked-in manifest is a publishing template: copy it, replace the publisher key
ID, calculate the deterministic package digest, and sign the canonical payload
with an Ed25519 private key. Never commit the private key.

The repository integration suite imports the package as a consumer would, runs
the public compatibility kit, creates a signed manifest with an ephemeral test
key, and renders it through the bounded child-process adapter. This keeps the
example executable while ensuring no test key can be mistaken for publisher
trust.
