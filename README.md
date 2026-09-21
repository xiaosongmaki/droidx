# droidx

A small macOS CLI for switching between Factory Droid API-key profiles.

`droidx` stores profile names in `~/.config/droidx/profiles.json` and stores
the actual Factory API keys in macOS Keychain through `keytar`. API keys are
never written to this repository.

## Requirements

- macOS
- Node.js 20 or newer
- Factory Droid CLI installed as `droid`
- A Factory API key for each account or service account

## Install for development

```bash
npm install
npm run build
npm link
```

## Usage

Add a profile. The API key is entered without being displayed:

```bash
droidx add personal
droidx add work
```

List profiles:

```bash
droidx list
```

Run Droid with a selected profile:

```bash
droidx run personal
droidx run work -- droid exec "review this code"
```

Remove a profile:

```bash
droidx remove work
```

## Security notes

- Do not put Factory API keys in this repository.
- Do not pass API keys as command-line arguments.
- `droidx` injects `FACTORY_API_KEY` only into the child `droid` process.
- The current version only allows launching `droid`, not arbitrary commands.

## Current scope

This first version switches Factory API-key authentication. It does not modify
Droid's internal OAuth files and does not switch BYOK provider keys.
