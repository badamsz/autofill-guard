# Autofill Guard

[![CI](https://github.com/badamsz/autofill-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/badamsz/autofill-guard/actions/workflows/ci.yml)

Prevent autofill on designated sites. Autofill Guard is a Manifest V3 extension for Chrome, Edge and other Chromium browsers. On the sites you list, it stops the browser from **saving or suggesting** form data, and it can be managed centrally by enterprise policy.

| Blocks | How |
|---|---|
| Single-field autocomplete (previously typed values) | Forces `autocomplete="off"` on every form and field on listed sites. No native policy covers this. |
| Addresses, contact info, payment cards | Uses the browser's native per-site autofill setting where available, with a fallback for browsers without it. |
| Password manager (optional) | Suppresses save prompts and discourages filling. |

Extension ID: **`pfojbgpchchehdkfmjeblbbilmnaljoj`**. It is fixed by the `key` in `extension/manifest.json`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works and why.

## Policy

| Key | Type | Default | Meaning |
|---|---|---|---|
| `MandatorySites` | list | — | Always blocked; users can't remove these. |
| `RecommendedSites` | list | — | Blocked by default; users can switch individual entries off. |
| `AllowUserSites` | bool | `true` | Users may add their own sites. |
| `AllowDisablingRecommended` | bool | `true` | If `false`, recommended sites behave like mandatory ones. |
| `BlockAutocomplete` | bool | `true` | Single-field autocomplete. Setting it by policy locks it. |
| `BlockAutofill` | bool | `true` | Addresses, contact info and cards. Locked when set. |
| `BlockPasswords` | bool | `false` | Password manager. Locked when set. |
| `ShowBadge` | bool | `true` | Toolbar dot on blocked sites. Locked when set. |

Site entries:

| Entry | Matches |
|---|---|
| `example.com` | That domain and all its subdomains |
| `=login.example.com` | That exact host only |
| `https://example.com` | That scheme only |
| `10.0.0.5`, `intranet` | Exactly that address or name |

Ports and paths are ignored.

Templates in [`policy/`](policy) are generated from `extension/schema.json` (`npm run templates`):

- **Windows:** `windows/AutofillGuard.admx` and `en-US/AutofillGuard.adml`, for Group Policy or Intune ADMX import, with Chrome, Edge and Vivaldi sections. Example `.reg` files are included too.
- **Linux:** `linux/*.json`, for each browser's managed policy directory.
- **macOS:** `macos/*.mobileconfig`, one profile per browser.

[`policy/README.md`](policy/README.md) lists every policy location and whether it's documented by the vendor, tested, or untested. Vivaldi is tested on macOS; its Windows and Linux locations are untested.

Where you can, layer the native `AutofillSettings` policy (Chrome, and Edge 154+) and Edge's `PasswordManagerBlocklist` on top. Only the extension covers single-field autocomplete.

## Deployment

1. **Pilot:** open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select `extension/`.
2. **Force-install (self-hosted):** each release publishes `autofill-guard-<v>.crx` and `updates.xml`. Host both at the URL set in the `CRX_BASE_URL` repository variable, then set:
   ```
   ExtensionInstallForcelist = pfojbgpchchehdkfmjeblbbilmnaljoj;<CRX_BASE_URL>/updates.xml
   ```
   This repository is private, so browsers can't download from its release pages. Copy the release assets to an internal web server, or another public location, and point `CRX_BASE_URL` there. On Windows, off-store force-installs only work on domain-joined or management-enrolled devices.
3. **Store:** upload `autofill-guard-<v>-store.zip` (which has no `key`). The store assigns a new ID, so regenerate the templates with `python3 tools/gen_policy_templates.py <store-id>`.

## Development

Requires Node 22.13 or later, and Python 3 for template generation.

```sh
npm ci
npm run lint
npm run test:unit
npx playwright install chromium
sudo mkdir -p /etc/opt/chrome_for_testing/policies/managed
sudo cp tests/fixtures/policy.json /etc/opt/chrome_for_testing/policies/managed/
npm run test:e2e
npm run build              # dist/; signs the CRX if signing/key.pem or CRX_PRIVATE_KEY is present
```

The e2e suite runs a real Chromium with a real managed policy. It submits forms and reads Chromium's own `Web Data` database to prove that values typed on blocked sites aren't saved. It also includes a canary that fails if a Chromium update stops honouring `autocomplete="off"`.

## Releasing

One-time setup:
- Secret `CRX_PRIVATE_KEY`: `gh secret set CRX_PRIVATE_KEY < key.pem`
- Variable `CRX_BASE_URL`: `gh variable set CRX_BASE_URL --body https://<host>/autofill-guard`

For each release:
1. Bump `version` in `extension/manifest.json` and merge.
2. `git tag v1.2.3 && git push origin v1.2.3`

The release workflow reruns CI, builds signed artifacts, and creates a GitHub release with the zips, the CRX, `updates.xml` and `SHA256SUMS`. It fails if the tag doesn't match the manifest version, or if the key doesn't match the manifest's ID.

To rotate the signing key: `npm run keygen`. This **changes the extension ID**; update your policies and the secret afterwards.

## Dependencies

Renovate runs weekly (Monday mornings, Eastern):
- GitHub Actions are pinned to digests and grouped into one PR.
- Minor and patch updates to Actions and to the build tooling (`crx3`, `yazl`) automerge once CI passes.
- Playwright updates are never automerged, because they change the Chromium version the tests and canary run against.
- Node major updates wait for approval on the Dependency Dashboard.

## Layout

```
extension/   the extension (load this folder)
policy/      generated policy templates (CI fails if stale)
scripts/     build, keygen, lint
tools/       template generator, icon renderer
tests/       unit/, e2e/, fixtures/
docs/        ARCHITECTURE.md
```
