# 🍅 Dittomato

A two-part tool for managing Ditto UI strings:

- **Browser app** (`index.html`) — search, edit, and translate Ditto components with Magic Translate powered by Claude
- **CLI** (`harvest.js`) — scan React JSX/TSX files for hardcoded strings, match them against Ditto, and replace them with `<Ditto />` components

---

## Install

```bash
git clone https://github.com/your-username/dittomato.git
cd dittomato
npm install -g .
```

## API key

Dittomato needs your Ditto API key. It looks for it in a `.env` file, walking up the directory tree from wherever you run it.

Create `~/.env` for global use:

```
DITTO_API_KEY=your_key_here
```

Or add a `.env` at the root of a specific project — that takes precedence.

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
| `--push` | Push unmatched strings to Ditto as new components |
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
- **➕ NEW** — strings with no match in Ditto, with a suggested component ID

### 2. Push new strings to Ditto

From the **What's next?** menu, choose `[p]`:

```
What's next?
──────────────────────────────────────────────────────────────
  [p]  Push 5 new strings to Ditto
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

---

## Headroom — context compression for agents

Dittomato depends on [`headroom-ai`](https://github.com/headroomlabs-ai/headroom), a context-compression layer that shrinks the messages sent to an LLM. It's wired up **for the AI agents that work on this repo** (Claude Code, etc.) — the shipped tools (`harvest.js` and the browser app) don't call it.

The `headroom-ai` npm package is only a *client*: it forwards messages to a Headroom **proxy** and returns the compressed result (with `fallback: true`, it returns them uncompressed if no proxy is running). The `proxy` and `wrap` commands themselves ship with Headroom's Python/Docker distribution, not the npm package:

```bash
pip install "headroom-ai[all]"
# or: docker pull ghcr.io/chopratejas/headroom:latest
```

Then either run a local proxy and point your tooling at it:

```bash
npm run headroom:proxy                       # headroom proxy --port 8787
export ANTHROPIC_BASE_URL=http://localhost:8787
```

…or wrap an agent directly:

```bash
npm run headroom:wrap                        # headroom wrap claude
```

Use the **local proxy**, not Headroom Cloud — it keeps your repo context on your machine and only forwards the normal provider call.

> The `headroom-ai` dependency in `package.json` is reserved for a future in-tool LLM step (e.g. compressing a request before `harvest.js` or the browser app calls Claude). Until such a call exists, it isn't imported anywhere in the source.
