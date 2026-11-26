# saymend-voice

English | [繁體中文](README_tw.md)

Use [Saymend](https://github.com/eugenechen0514/saymend) as voice input for Claude Code, and read replies aloud with macOS `say`, forming a loop of "speak → send to Claude Code → hear the reply".

## Installation

In a Claude Code session in the terminal, enter:

```
/plugin install saymend-voice --marketplace eugenechen0514/claude-code-mods
```

For other ways to install, see the [marketplace README](../../README.md).

## Requirements

- macOS (replies are read aloud with the system `say`).
- Saymend.app running, in a version that includes the local control interface.
- The `saymend` CLI on your `PATH` (Saymend's `Scripts/make-app.sh` creates a symlink at `~/.local/bin/saymend`).

The mod talks to Saymend only through the `saymend` CLI; the contract is in `docs/control-interface.md` in the Saymend repo.

## Commands

| Command | What it does |
| --- | --- |
| `/listen` | Dictate one utterance and send it as soon as you pause |
| `/listen edit` | Dictate and only fill the prompt box, without sending |
| `/saymend off` | Turn voice off (default) |
| `/saymend speak` | Read each reply aloud when it finishes |
| `/saymend loop` | After reading a reply, listen automatically and send what you say; say 「停止語音」 ("stop voice") to end the loop |
| `/saymend stop` | Stop the current reading and listening |
| `/saymend status` | Show the current mode and settings |
| `/saymend pause <seconds>` | How long a pause counts as finished speaking (0.5–10, default 1.5) |
| `/saymend max <seconds>` | The longest a single utterance can run (10–3600, default 120) |
| `/saymend bargein <on\|off>` | Barge-in: keep the microphone open while reading, and stop reading when you start speaking (headphones required) |
| `/saymend polish <on\|off>` | Polish the text with the LLM configured in Saymend before sending |
| `/saymend voice <name\|default>` | Choose the system voice used for reading |
| `/saymend bin <path\|default>` | Set the path to the `saymend` CLI |

Settings are kept in the mod's own store and persist across sessions.

## Behavior

- Before reading, code, tables, link URLs and markdown markup are removed; text over 600 characters is cut at the end of a sentence.
- Reading stops as soon as you start dictating (with the Saymend hotkey or the CLI).
- While listening, Esc is taken by Saymend to cancel this listening, and Claude Code does not receive it; pressing the Saymend hotkey finalizes and sends early.
- Dictation is not polished by an LLM by default: only local ASR plus Simplified-to-Traditional conversion and vocabulary post-processing. Turning `polish` on uses the provider configured in Saymend.
- Barge-in is only suitable with headphones; otherwise the speaker's sound is taken as someone speaking.
- While `speak` or `loop` is on, each prompt carries a note (visible only to the model) asking it not to run `say` or other sound-making commands itself, so a spoken completion notice required by your own instructions (for example in `CLAUDE.md`) does not double up with the reading.

## Development

At the repository root, run:

```
claude plugin validate mods/saymend-voice
claude plugin test mods/saymend-voice
```
