# 🍅 Dittomato

A saucy two-part tool for managing Ditto UI strings:

- **Browser app** (`index.html`) — search, edit, and translate Ditto components with Magic Translate powered by Claude
- **CLI** (`harvest.js`) — scan React JSX/TSX files, match strings against Ditto, and push new ones

---

## Browser app

Open `index.html` directly or host on GitHub Pages. Enter your Ditto and Anthropic API keys and start editing.

---

## CLI — Install globally

```bash
git clone https://github.com/your-username/dittomato.git
cd dittomato
npm install -g .
```

Add your Ditto API key to `~/.env` for global use across all projects:

```
DITTO_API_KEY=your_key_here
```

Or add a `.env` file per project — Dittomato walks up the directory tree to find it.

---

## CLI — Usage

```bash
# Scan a single file
dittomato src/screens/MyScreen.jsx

# Scan a folder recursively
dittomato src/

# Scan the entire repo
dittomato .

# JSX only (default includes tsx)
dittomato src/ --ext jsx

# Skip additional folders
dittomato src/ --ignore stories,e2e

# Push unmatched strings to Ditto
dittomato src/ --push

# Push without confirmation prompt (CI)
dittomato src/ --push --yes

# No colors (CI / pipe to file)
dittomato src/ --no-color
```

---

## Full workflow

```bash
# 1. Scan your prototype and preview results
dittomato src/

# 2. Review harvest-report.json or read the terminal output

# 3. Push new strings to Ditto
dittomato src/ --push

# 4. Open the Dittomato browser app to add translations
#    https://your-username.github.io/dittomato
```

---

## harvest-report.json

Written to the current working directory after every run. Contains matched strings with their Ditto developer IDs, unmatched strings with suggested IDs, and (after `--push`) a record of what was created.
