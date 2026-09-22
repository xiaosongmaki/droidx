# droidx

[![npm version](https://img.shields.io/npm/v/droidx.svg)](https://www.npmjs.com/package/droidx)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A small macOS CLI for switching between **Factory Droid** API-key profiles.

`droidx` stores profile names in `~/.config/droidx/profiles.json` and keeps the actual API keys in the **macOS Keychain** via [`keytar`](https://github.com/nicedoc/keytar). Keys never touch disk or environment variables outside the child `droid` process.

## Install

```bash
npm install -g droidx
```

> **Requirements:** macOS · Node.js ≥ 20 · Factory Droid CLI (`droid`) installed

## Usage

### Run Droid (auto-select best profile)

Just run `droidx` — it automatically picks the profile with the most remaining quota:

```bash
droidx
droidx -- droid exec "review this code"
droidx --dry-run   # show which profile would be picked
```

### Run Droid with a specific profile

```bash
droidx run personal
droidx run work -- droid exec "review this code"
```

### Add a profile

The API key is entered interactively and never echoed:

```bash
droidx add personal
droidx add work
```

### List profiles

```bash
droidx list        # or: droidx ls
```

### Check quota status

```bash
droidx status
```

### Remove a profile

```bash
droidx remove work  # or: droidx rm work
```

## Security

- API keys are stored in **macOS Keychain**, not on disk.
- Keys are injected only into the child `droid` process via the `FACTORY_API_KEY` environment variable.
- Only the `droid` command is allowed — arbitrary commands cannot be launched.
- Never pass API keys as command-line arguments.

## Development

```bash
git clone https://github.com/xiaosongmaki/droidx.git
cd droidx
npm install
npm run build
npm link          # makes `droidx` available globally
```

## Publishing

Publishing to npm is automated via GitHub Actions. To release a new version:

```bash
npm version patch  # or minor / major
git push --follow-tags
```

Then [create a GitHub Release](https://github.com/xiaosongmaki/droidx/releases/new) from the new tag — the workflow will build and publish to npm automatically.

## License

[MIT](LICENSE) © xiaosongmaki
