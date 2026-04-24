# docs/

Two things live here:

- **The public website** (`index.html`, `install.html`, `policies.html`, `driving-patterns.html`, `reference.html`, and `assets/`) — served by GitHub Pages at https://renatodarrigo.github.io/claw-drive/.
- **Internal design artefacts** (`superpowers/specs/`, `superpowers/plans/`) — spec and plan markdown for each release. Not served by GH Pages in any meaningful way (they're markdown; GH Pages with Jekyll defaults would still serve them as raw files under `/superpowers/...`, which is fine — nobody will link to them).

## GH Pages setup (one-time, at public release)

1. Create the public repo at `github.com/renatodarrigo/claw-drive` and push `main`.
2. Settings → Pages → Build and deployment → Source = **Deploy from a branch** → Branch = **main**, Folder = **/docs** → Save.
3. First build takes ~1 minute. The Pages URL is shown in the same screen once built.

No GitHub Actions workflow is required. Every push to `main` that touches `docs/` triggers a rebuild automatically.

## Editing

Edit the `.html` files directly. No build step. Syntax highlighting is loaded from Prism via jsDelivr CDN.

Keep the top nav in sync across all five pages — each one inlines its own copy of the `<nav>` block.
