# saymend-voice

English | [繁體中文](README_tw.md)

Use [Saymend](https://github.com/eugenechen0514/saymend) as voice input for Claude Code, and have replies read aloud, forming a loop of "speak → send to Claude Code → hear the reply".

## Two ways to use it

The mod's code runs on the machine where Claude Code runs. The microphone, the speakers and Saymend are always on the Mac in front of you. Whether those are the same machine decides which scenario applies.

| | Scenario 1: local | Scenario 2: remote |
| --- | --- | --- |
| Where Claude Code runs | Your Mac | A host you reach over SSH (Linux works too) |
| Dictation | The mod runs the `saymend` CLI directly | The mod runs a client on the remote host, which goes back over SSH to run the `saymend` CLI on the Mac |
| Reading aloud | Claude Code speaks with the system voice | The mod runs a client on the remote host, which goes back over SSH to speak with `say` on the Mac |
| Extra setup | None | Run `saymend-remote` on the Mac (see below) |

```
local    Claude Code (mod) ──▶ saymend CLI ──▶ Saymend.app

remote   Claude Code (mod) ──▶ client ══ SSH ══▶ saymend-remote ──▶ saymend CLI, say
         └──── remote host ────┘              └──────────── your Mac ────────────┘
```

Both scenarios use the same mod and the same commands. The only difference is two settings: `/saymend bin` and `/saymend speaker`.

If all you need is to dictate text into a remote terminal, you do not need this mod: Saymend's hotkey dictation types into the focused window on the Mac, and an SSH terminal receives that too.

## Installation

In a Claude Code session, enter (for the remote scenario, install it in Claude Code **on the remote host**):

```
/plugin install saymend-voice --marketplace eugenechen0514/claude-code-mods
```

For other ways to install, see the [marketplace README](../../README.md).

## Scenario 1: local

Requirements:

- macOS.
- Saymend.app running, in a version that includes the local control interface.
- The `saymend` CLI on your `PATH` (Saymend's `Scripts/make-app.sh` creates a symlink at `~/.local/bin/saymend`).

Once the mod is installed it works with no further setup. The mod talks to Saymend only through the `saymend` CLI; the contract is in `docs/control-interface.md` in the Saymend repo.

## Scenario 2: remote

> This scenario is experimental.

Requirements:

- Mac: everything in scenario 1, plus `python3` and `ssh` access to the remote host.
- Remote host: `python3` (3.8 or later), an `sshd` that allows forwarding (the default), and this mod installed in Claude Code.

Steps:

1. On the Mac, get `saymend-remote` (a single file that uses only the Python standard library):

   ```
   curl -fsSL https://raw.githubusercontent.com/eugenechen0514/claude-code-mods/main/mods/saymend-voice/remote/saymend_remote.py -o ~/.local/bin/saymend-remote
   chmod +x ~/.local/bin/saymend-remote
   ```

2. On the Mac, run this in a terminal window and leave it open:

   ```
   saymend-remote connect user@host
   ```

   Hosts are written the way `ssh` takes them, and you can name several. It puts the client in `~/.saymend-remote/` on the remote host, then sets up SSH forwarding, and reconnects by itself when the connection drops.

3. Once connected it prints two commands. Run them once in Claude Code on the remote host (the settings are kept):

   ```
   /saymend bin /home/user/.saymend-remote/bin/saymend
   /saymend speaker /home/user/.saymend-remote/bin/say
   ```

4. In Claude Code on the remote host, enter `/saymend status`. When the last line shows Saymend's state (for example `idle`), the path works.

After that, each time you want to use it you only need step 2 on the Mac. While the bridge is not running, `/saymend` on the remote host reports that it cannot reach the Mac (the message is in Chinese).

When you no longer need it, restore the settings and remove the files on the remote host:

```
/saymend bin default
/saymend speaker default
```

```
saymend-remote uninstall user@host
```

### Security

`saymend-remote` lets a remote host make your Mac open its microphone and play sound. Know its limits first:

- **Connect only to hosts you trust, and not with an account several people share.** While the bridge is running, any program that runs under your account on the remote host (and that host's root) can ask the Mac to dictate an utterance and receive the text, and can make the Mac's speakers talk.
- Dictation is always visible: Saymend shows its floating bar while recording, and Esc cancels it.
- The bridge accepts only fixed requests: `saymend` with `status`, `dictate`, `stop`, `cancel`, `events` or `--version` (arguments are checked against an allowlist), and reading text aloud with `say`. It runs nothing else for the remote host.
- The sockets on the Mac and on the remote host can be reached only by your account (mode 0600, in a 0700 folder). No TCP port is opened on the remote host.
- The bridge window logs only the command name, the number of characters read aloud, and the exit code. It does not log what you said or what was read.
- When you stop the bridge (Ctrl-C) or the SSH connection drops, a dictation in progress is cancelled and the microphone closes at once.

### Known limits

- Barge-in (`bargein`) reacts one SSH round trip later than it does locally.
- `saymend-remote connect` opens three SSH connections each time it connects. If your SSH asks for a password or a code every time, set up a key or `ControlMaster` first.

## Commands

| Command | What it does |
| --- | --- |
| `/listen` | Dictate one utterance and send it as soon as you pause |
| `/listen edit` | Dictate and only fill the prompt box, without sending |
| `/saymend`, `/saymend listen [edit]` | The same as `/listen [edit]`; `/saymend` with no arguments dictates and sends |
| `/saymend off` | Turn voice off in this session (default) |
| `/saymend speak` | In this session, read each reply aloud when it finishes |
| `/saymend loop` | In this session, after reading a reply, listen automatically and send what you say; say 「停止語音」 ("stop voice") to end the loop |
| `/saymend autospeak <on\|off>` | Start every session in `speak` (off by default: a new session starts in `off`) |
| `/saymend stop` | Stop the current reading and listening |
| `/saymend status` | Show the current mode and settings |
| `/saymend pause <seconds>` | How long a pause counts as finished speaking (0.5–10, default 1.5) |
| `/saymend max <seconds>` | The longest a single utterance can run (10–3600, default 120) |
| `/saymend bargein <on\|off>` | Barge-in: keep the microphone open while reading, and stop reading when you start speaking (headphones required) |
| `/saymend polish <on\|off>` | Polish the text with the LLM configured in Saymend before sending |
| `/saymend pin <on\|off>` | Keep the status on the status line while idle too (on by default; when off it is shown only while reading, listening or hotkey dictation) |
| `/saymend voice <name\|default>` | Choose the system voice used for reading (in the remote scenario, a voice on the Mac) |
| `/saymend bin <path\|default>` | Set the path to the `saymend` CLI; in the remote scenario, point it at the client |
| `/saymend speaker <command\|default>` | Hand reading to this command; in the remote scenario, point it at the client. `default` returns to this machine's system voice |

The voice mode (`off`, `speak`, `loop`) applies only to the session where you set it: turning reading on in one session does not make other open sessions, or sessions you start later, read aloud. After the mod is updated and you run `/reload-plugins`, the session keeps its mode.

To have every session read aloud, turn on `/saymend autospeak on`: sessions you start afterwards begin in `speak`, other sessions that are already open follow after `/reload-plugins`, and any one session can still turn it off with `/saymend off`. `loop` cannot be a starting mode, because sessions open at the same time would compete for the same microphone.

The other settings (`autospeak`, `pause`, `max`, `bargein`, `polish`, `pin`, `voice`, `bin`, `speaker`) are kept in the mod's own store, shared by every session on the machine, and persist across sessions. Each machine keeps its own, so local and remote settings do not affect each other.

A `speaker` command has the same interface as macOS `say`: `<command> [-v voice]`, with the text to read on stdin; the process is ended when reading is interrupted.

## Status line

While idle, the status line keeps one line that tells you whether Saymend can be reached and what **the session in front of you** will do (the text is in Chinese):

```
Saymend 待命｜這個 session：不朗讀
Saymend 待命｜這個 session：朗讀
Saymend 待命｜這個 session：朗讀＋聆聽｜共 2 個 session 開著 loop
Saymend 未連線｜這個 session：不朗讀
```

- 「不朗讀」 (does not read), 「朗讀」 (reads) and 「朗讀＋聆聽」 (reads and listens) stand for `off`, `speak` and `loop`. 「待命」 is idle and 「未連線」 is not connected.
- When another session also has `loop` on, a count follows. Saymend takes one dictation at a time, so with two sessions in `loop` what you say goes only to the one that opened the microphone first; keep `loop` on in one session at a time. `/saymend loop` also warns you on the spot when another session already has it on.
- Saymend does the counting, so local and remote sessions are counted together. This needs a Saymend version that supports `events --presence`; with an older version the count is not shown and everything else works as before.
- A non-interactive session (for example `claude -p`) does not connect to Saymend just for this line.
- To stop keeping the line, use `/saymend pin off`.

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
python3 -m unittest discover -s mods/saymend-voice/remote -p 'test_*.py'
```

The third line tests `remote/saymend_remote.py`: fake `saymend` and `say` programs stand in for the real ones, nothing goes over SSH, and no microphone is opened and no sound is played.
