# claude-code-mods

English | [繁體中文](README_tw.md)

A marketplace of Claude Code mods (plugins). Each mod lives in its own folder under `mods/`, and its documentation is in that folder's README.

## Mods

| Mod | Description |
| --- | --- |
| [`saymend-voice`](./mods/saymend-voice/README.md) | Use Saymend for local voice input and read Claude's replies aloud with the system voice |

## Installation

In a Claude Code session in the terminal, enter (replace `<mod>` with a name from the table above):

```
/plugin install <mod> --marketplace eugenechen0514/claude-code-mods
```

Then press `y` to add this marketplace and choose an installation scope (the user scope applies to every session you start afterwards).

You can also install from a shell:

```
claude plugin install <mod> --marketplace eugenechen0514/claude-code-mods
```

In the desktop app (where `/plugin` is not available): click + next to the prompt box, choose Plugins, add the marketplace `eugenechen0514/claude-code-mods`, then add the plugin.

This is a private repository: only people who can read it on GitHub and whose machine already has github.com git credentials (an SSH key, or `gh auth setup-git` after `gh auth login`) can install from it. No login prompt appears during installation.

## Adding a mod

1. Put the mod's files and READMEs in `mods/<mod>/` (English `README.md`, Traditional Chinese `README_tw.md`).
2. Add an entry to `plugins` in `.claude-plugin/marketplace.json`, with `source` pointing to `./mods/<mod>`.
3. Add a row to the table above.
4. Run `claude plugin validate .` at the repository root to check it.
