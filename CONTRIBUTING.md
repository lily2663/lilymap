# Contributing to LilyMap

LilyMap is a local-first manager for Hugo projects using the Lily theme contract.

Run the manager during development with `npm run start`. Before opening a pull request, run:

```powershell
npm run check
npm test
npm run build
```

Keep the management API loopback-only. Never add token values, private article sources, personal blog content, or machine-specific paths to fixtures, screenshots, issues, or commits.

Changes to configuration fields must preserve unknown values in user files. Protocol changes must update the versioned protocol document and schema in `lily-epitaph`, add compatibility coverage, and bump the protocol major identifier for breaking changes. `npm run protocol:check` requires `LILY_TEST_THEME_PATH` to point to the paired theme checkout.
