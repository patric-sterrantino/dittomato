# Dittomato — Claude Guidelines

## Versioning

**Always bump the version in `package.json` before publishing any change.**

The version is read at runtime by both tools:
- `harvest.js` reads it via IIFE at startup and prints it in the CLI header
- `index.html` reads it from the topbar version badge

Use semantic versioning (`MAJOR.MINOR.PATCH`):
- `PATCH` — bug fixes, copy tweaks
- `MINOR` — new features, new CLI flags, new UI sections
- `MAJOR` — breaking changes to the API, CLI interface, or file formats
