# Catalog signing

Status: planned, after Queryeer Desktop 0.24. Tracked in queryeer-desktop#234 (Queryeer's side) and #14 (this repository's side).

## Why

Readers check each plugin ZIP against the sha256 and size in the [catalog](plugin-catalog.md). The catalog and the ZIPs come from the same place, this repository's Pages site and releases, so the hash proves the ZIP wasn't corrupted, not who published it. Anyone who can change both can swap a ZIP and its hash together, and Queryeer's release bundles that ZIP into signed installers. Plugins run with the user's privileges and can reach database credentials.

Signing the catalog makes Queryeer trust a plugin only if its catalog entry was signed by a key Queryeer already ships with. Signing proves who published a plugin, not that it is safe; sandboxing plugins is out of scope.

Where the catalog is read:

- **Queryeer Desktop's release** reads it to pick the plugins it bundles. Since 0.24 this is the only reader.
- **The marketplace** will read it in the app (not built yet); it uses the same verification.

## Keys

- **Algorithm:** Ed25519. `node:crypto` signs and verifies it, so neither side needs a new dependency.
- **Two key pairs from the start, each with a key id** (for example `catalog-2026-1` and `catalog-2026-2`):
  - **Primary:** its private key is kept in the password manager and in this repository as a secret of the `catalog-signing` environment. CI signs with it.
  - **Backup:** its private key is kept offline in the password manager only, never in CI.
  - Queryeer ships both public keys. If the primary key leaks, the catalog can be signed with the backup at once, without waiting for an app release.
- **Generate:**
  ```bash
  openssl genpkey -algorithm ed25519 -out catalog-2026-1.pem
  openssl pkey -in catalog-2026-1.pem -pubout -out catalog-2026-1.pub.pem
  ```
  The private PEM goes to the password manager (and, for the primary, the environment secret). Delete the local files afterwards. The public PEM, with its key id, goes to Queryeer.

### The `catalog-signing` environment

- Settings → Environments → `catalog-signing`:
  - required reviewer: the maintainer;
  - deployment branches: `master` only;
  - secrets: `CATALOG_SIGNING_KEY` (the primary private PEM) and `CATALOG_SIGNING_KEY_ID`.
- Only the job that signs uses the environment. Without the reviewer gate the signature proves no more than "this repository's CI built it", since anyone who can push a workflow change could get anything signed. With it, every catalog publish waits for the maintainer's approval. Plugin releases are rare, so the approval costs little.
- Don't reuse this environment for npm or Maven publishing. npm's trusted publishers name their own workflow and environment and aren't affected by this one.

## Signing

- **What is signed:** the exact bytes of `catalog/list.json`, after it is generated.
- **Published next to it:** `catalog/list.json.sig`:
  ```json
  { "keyId": "catalog-2026-1", "algorithm": "ed25519", "signature": "<base64>" }
  ```
- **Where:** the build job of [publish-catalog.yml](../.github/workflows/publish-catalog.yml), which already builds the catalog in a job separate from the Pages deploy. Only the build job takes the `catalog-signing` environment and the key.
  - The dispatch from `release-plugin.yml` then waits for approval before the catalog changes.
  - Never sign for pull requests or forks.
- **Verify after the deploy:** a CI step downloads the published `list.json` and `list.json.sig` and verifies them with the public keys, so a bad publish fails visibly.
- **ZIPs:** each catalog entry keeps the ZIP's sha256 and size, so the catalog signature covers the ZIPs too. ZIPs are immutable: fixing one means publishing a new version.
- **No `expiresAt`:** an expiring catalog needs a scheduled re-sign, and a scheduled job can't pass the reviewer gate. A monotonic `generation` may come later for rollback protection; for release-time bundling, the release review below is enough.

## Queryeer Desktop

- **A verifier module** (for example `src/main/plugins/catalog-signature.ts`):
  - holds both public keys by key id;
  - verifies `list.json.sig` over the exact bytes of `list.json` before anything in it is parsed or trusted.
- **`bundle-plugins.mjs`:**
  - fetches `list.json.sig` along with the catalog;
  - a release fails when the signature is missing, invalid or from an unknown key;
  - local packaging may opt out, like `QUERYEER_SKIP_BUNDLED_PLUGINS`, and a release refuses the opt-out.
- **`readSource`:**
  - https only for remote sources (`file:` and local paths stay for local use and tests);
  - downloads are capped: a ZIP at the catalog's `size`, the catalog at a fixed limit.
- **Release review:** the bundled-plugins job summary marks which plugins changed since the previous release's lock.
- **Tests:**
  - a valid signature, the rotated (backup) key;
  - a tampered catalog, the wrong key, an unknown key id, a missing signature.

### Installing a ZIP by hand (with the marketplace work)

The app hashes the ZIP and looks up its id and version in the signed catalog:

| Outcome | When | What the app does |
|---|---|---|
| Verified | id, version and sha256 match a signed catalog entry | Installs; where it was downloaded from doesn't matter |
| Mismatch | id and version are in the catalog, the sha256 differs | Blocks the install: the file was changed |
| Unverified | not in the catalog (third-party plugin, dev build), or the catalog can't be fetched (offline) | Shows "Unverified source" with the id and sha256; installs only after the user confirms |

- **Offline verification:** a detached `.sig` per ZIP, signed with the same keys, would let the app verify without the catalog. Add it only if offline installs turn out to matter.
- **Third-party publishers:** whether the maintainer signs them after review, or publishers get their own keys endorsed by ours (TUF-style delegation), is decided with the marketplace design.

## Rotation and revocation

- **Planned rotation:**
  1. Ship the new public key in a Queryeer release.
  2. Once that release is out, sign with the new key.
  3. Remove the old public key in a later release.
- **Primary key leaked:**
  1. Replace the environment secret with the backup key and republish the catalog.
  2. Release Queryeer without the leaked public key and with a new backup key.
  3. Make a new backup key pair and keep it offline.
- **Older Queryeer versions** keep trusting the keys they shipped with. Since only the release build reads the catalog until the marketplace exists, that matters only from the marketplace on.

## Also in #234 (no signing needed)

- **Pin GitHub Actions to commit SHAs** in both repositories, with Dependabot for actions. The third-party `softprops/action-gh-release` matters most.
- **Least-privilege permissions** per job.
- **Extraction limits** in Queryeer:
  - entry count, total and per-entry uncompressed size;
  - reject symlinks, special entries, and absolute or drive-letter names;
  - verify before extracting, stage, then swap.

## Order

1. **This repository:**
   - the two key pairs and the `catalog-signing` environment;
   - signing in `publish-catalog.yml`, plus the verify step;
   - this document's runbook, checked against the real setup.
2. **Queryeer:** the verifier in `bundle-plugins.mjs`, and `readSource` hardening.
3. **Both:** action pinning and permissions, plus extraction limits.
4. **The marketplace:** the same verifier in the app, the manual-install outcomes above, and the third-party trust model.
