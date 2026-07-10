# 🍅 Dittomato

A two-part tool for managing UI strings, backed by **Firebase (Cloud Firestore)**:

- **Browser app** (`index.html`) — search, edit, and translate strings with Magic Translate powered by Claude
- **CLI** (`harvest.js`) — scan React JSX/TSX files for hardcoded strings, match them against the store, and replace them with `<Ditto />` components

---

## Architecture: chunked Firestore index

All strings live in a **handful of aggregate documents**, not one doc per string:

- `strings/meta` — `{ chunks, splits, totalEntries, variants, schema }`
- `strings/index_0 … index_N` — each a `{ key: entry }` map, ~500 KB, sorted by key
- `strings/variables` — the variables catalog
- `changelog/…` — one auto-id doc per change

An **entry** is `{ base, de, fr, …: string | {form:text}, _master?, name? }` — a variant value is a plain string, or a map of plural forms. Folders in the browse tree are derived from the dotted key.

The app loads all chunks into memory once (**~N reads per load**, not 20k), searches/opens entirely in memory, and on save writes **only the changed field** (`update(FieldPath(key, variant), …)` — one write op, no cross-key clobber) plus a changelog entry. This keeps usage far inside the Firestore free tier.

The data model + chunk routing (`chunkIndexForKey`, `packEntries`, `entriesFromFlatMaps`) live in [`firestore-rest.js`](firestore-rest.js), shared by the app (browser), `migrate.js`, and `harvest.js`.

---

## Migrating from Ditto

1. `npm install` (pulls `firebase-admin`).
2. Create a Firebase project, enable **Cloud Firestore**, and publish [`firestore.rules`](firestore.rules).
3. Put your Firebase **service-account** JSON at the repo root as `serviceAccount.json` (git-ignored).
4. Fill in `.env` (see [`.env.example`](.env.example)).
5. Run the migration:
   ```bash
   node migrate.js --dry-run     # build + print the chunk plan, write nothing
   node migrate.js               # migrate from the Ditto API
   node migrate.js --from-json   # …or migrate from the local src/ditto/*.json
   ```
   It folds plural `id_<form>` keys into plural maps, drops Ditto's duplicate `-original` snapshots, writes a local `strings-backup.json` first, then batch-writes the chunks + `meta` + `variables`.
6. Open `index.html`, paste your Firebase **web config** JSON (`{"projectId":"…","apiKey":"…"}`) into the **API keys** panel (stored in your browser only), and verify the banner shows `✅ N strings loaded (K reads)`.
7. Cancel your Ditto subscription 🍅

**Maintenance:** `node migrate.js --rebalance` re-packs chunks if one grows near the 1 MiB limit; `node migrate.js --purge-old` deletes the inert pre-v2 `components` docs once you're confident.

---

## Users & access control

The editor uses **Google sign-in** (restricted to `vialytics.de`) with three roles enforced by Firestore security rules:

| Role | Access |
|---|---|
| `viewer` | read only — browse, search, view (edit/delete/rename UI hidden, textareas locked) |
| `editor` | read + write + delete + rename |
| `admin`  | editor **+ manage users** (the in-app **Users** panel) |

Roles live in **`acl/{email}`** docs (`{ role: "viewer" | "editor" | "admin" }`). A signed-in user with no acl doc has no access — they can tap **Request access** on the sign-in screen, which files an `access_requests/{email}` doc for an admin to approve.

### Managing users in the app (admins)

Admins get a **Users** button in the top bar that opens a panel to:
- **approve / deny** pending access requests (approve as viewer or editor),
- **change** anyone's role (viewer / editor / admin),
- **add** a user by email, or **remove** one.

No one needs to open the Firebase console for day-to-day user management. Clients can read only their **own** acl doc and can't write acl unless they're an admin (rules enforced) — so there's no self-escalation.

### Setup (one-time)

1. Firebase console → **Authentication** → enable **Google**; under **Settings → Authorized domains** add wherever you host the app (+ `localhost`).
2. **Bootstrap the first admin** (before publishing the rules, so you don't lock yourself out): create `acl/<you>@vialytics.de` with `role: admin` — Firestore console → `acl` collection → add document (ID = email, field `role` = `admin`), or `node set-role.js <you>@vialytics.de admin` (needs `serviceAccount.json`).
3. Publish the updated [`firestore.rules`](firestore.rules).
4. From then on, manage everyone else from the **Users** panel in the app.

`set-role.js` still works from the CLI: `node set-role.js <email> <viewer|editor|admin|remove>` · `node set-role.js --list`.

> The rules are the real enforcement (a viewer physically cannot write, a non-admin cannot touch acl); the app UI just mirrors that.

---

## Exporting JSON for other apps

`node build-json.js` (aka `npm run build-json`) reads the Firestore index and writes flat i18next JSON to `dist/`:

- `dist/base.json`, `dist/de.json`, `dist/fr.json` — one flat map per locale, plurals unfolded to `id_one` / `id_other`
- `dist/strings.json` — combined `{ base, de, fr }`
- `dist/variables.json`

Read-only (web apiKey, no service account). Point your other web apps at these files (copy them in, publish them, or wire it into their build). `--out <dir>` changes the output location.

---

## Install

```bash
git clone https://github.com/your-username/dittomato.git
cd dittomato
npm install -g .
```

## Configuration

The CLI reads Firebase config from a `.env` file (walking up the directory tree from where you run it, then `~/.env`), plus a `serviceAccount.json`:

```
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccount.json
```

The browser app instead takes your Firebase **web config** in its API-keys panel (stored in localStorage). See [`.env.example`](.env.example).

---

## CLI usage

```bash
dittomato [path] [options]
```

`path` can be a file, a folder (scanned recursively), or omitted to scan the current directory.

```bash
dittomato                        # scan current directory
dittomato src/                   # scan a folder
dittomato src/screens/Home.tsx   # scan a single file
```

### Options

| Flag | Description |
|---|---|
| `--push` | Push unmatched strings to Firestore as new strings |
| `--yes` | Skip all confirmation prompts (CI mode) |
| `--ext jsx,tsx` | File extensions to scan (default: `jsx,tsx`) |
| `--ignore stories,e2e` | Extra folder names to skip |
| `--import-from path` | Override the path used in `import { Ditto } from '...'` |
| `--no-color` | Disable colored output (useful when piping) |

---

## What it scans

Dittomato extracts strings from two places in each file:

**JSX text nodes** — readable text between tags:
```jsx
<p>Welcome back</p>
```

**String props** — a comprehensive set of copy-carrying prop names:

| Category | Props |
|---|---|
| Core | `label`, `text`, `title`, `description`, `caption`, `message` |
| Input | `placeholder`, `helperText`, `hint`, `legend` |
| Buttons | `buttonText`, `confirmText`, `confirmLabel`, `cancelText`, `cancelLabel`, `submitText`, `saveText`, `actionText` |
| States | `emptyText`, `emptyMessage`, `noDataText`, `noResultsText`, `noRowsLabel`, `loadingText` |
| Feedback | `successMessage`, `errorMessage`, `warningMessage`, `infoMessage`, `errorText` |
| Structure | `header`, `subheader`, `subtitle` |
| Lists | `primaryText`, `secondaryText` |
| Data grid | `headerName` |
| Images | `alt` |
| Accessibility | `aria-label`, `aria-description`, `aria-placeholder` |

**Skipped automatically:** test files (`*.test.*`, `*.spec.*`, `*.stories.*`), mock/dummy files, type declarations (`.d.ts`), and strings that look like code identifiers, URLs, hex colors, or TypeScript type annotations.

---

## Typical workflow

### 1. Scan and review

```bash
dittomato src/
```

This fetches your Ditto components and shows three sections:

- **✅ MATCHED** — strings already in Ditto, with their component IDs
- **🔍 NEAR MATCH** — strings not in Ditto by exact text, but a similar component exists (different capitalisation, punctuation, etc.) — you choose whether to link them or treat them as new
- **➕ NEW** — strings with no match in the store, with a suggested component ID

### 2. Push new strings to Firestore

From the **What's next?** menu, choose `[p]`:

```
What's next?
──────────────────────────────────────────────────────────────
  [p]  Push 5 new strings to Firestore
  [w]  Replace strings in source files with Ditto components
  [q]  Quit
```

You'll review each string before it's pushed:

```
Reviewing 5 new strings before push
──────────────────────────────────────────────────────────────
  ↵ push as-is   s skip   a push all   q stop   e edit string   or type a new ID to rename

(1/5)  src/components/Menu.tsx:42
  String  "export xls"
  ID      menu.export-xls
  > ↵
  → pushing as "menu.export-xls"
```

At the `>` prompt:
- **Enter** — push as-is
- **`s`** — skip this string
- **`a`** — push all remaining without reviewing
- **`q`** — stop here, push only what you've already accepted
- **`e`** — edit the string text (re-checks for Ditto matches after editing)
- **Any other text** — use it as the component ID instead of the suggestion

### 3. Replace strings in source files

From the **What's next?** menu, choose `[w]`. For every matched or pushed string, Dittomato rewrites the source file in place.

**ReactNode props** (e.g. `label`, `text`, `title`) get a `<Ditto />` component:
```jsx
// before
<Button label="Save changes" />

// after
import { Ditto } from '../lib/ditto';
<Button label={<Ditto componentId="dashboard.save-changes" />} />
```

**String-only props** (`aria-label`, `placeholder`, `alt`, `title`, `aria-description`, `aria-placeholder`) get a `useDittoWrapper` hook instead, since those attributes only accept plain strings:
```jsx
// before
<input placeholder="Search…" aria-label="Search field" />

// after
import { Ditto, useDittoWrapper } from '../lib/ditto';
const searchPlaceholderText = useDittoWrapper({ componentId: 'search.placeholder' });
const searchFieldText = useDittoWrapper({ componentId: 'search.aria-label' });
<input placeholder={searchPlaceholderText} aria-label={searchFieldText} />
```

If no `import { Ditto }` is found in the scanned files, Dittomato will ask you to provide the import path once.

---

## CI / automated push

Use `--push --yes` to push without any prompts — all suggested IDs are accepted as-is:

```bash
dittomato src/ --push --yes
```

---

## How component IDs are suggested

When a string has no Ditto match, an ID is generated from the filename + the string:

```
src/components/SettingsPanel.tsx  +  "Save changes"
→  settingspanel.save-changes
```

You can rename it during the push review.

---

## Matching logic

Dittomato uses three levels of matching to avoid creating duplicates:

1. **Exact text** — `"export xls"` matches a component whose text is `"export xls"`
2. **Normalised text** — `"export xls"` matches `"Export XLS"` (case and punctuation ignored)
3. **Component ID** — `"exportxls"` matches an existing component whose developer ID is `exportxls`

Near matches are shown interactively so you can confirm before anything is pushed.
