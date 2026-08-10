# xneog

**Your coding agent lives in a daemon — not in your terminal window.**

`xneog` is the terminal client for **xneog-agentd**, a session daemon for agentic coding.
Sign in to your xNeog account and the **same sessions** follow you across the terminal, the
web app and the iOS app — approvals arrive as push notifications, with full diffs. Sessions
run on the daemon (your Mac or your cloud box), so closing the laptop doesn't kill the work.

```
$ cd ~/my-project
$ xneog
```

## Install

```sh
curl -fsSL https://cli.xneog.com/install.sh | sh
```

or, with Node.js ≥ 20 already installed:

```sh
npm install -g github:gomes007-alt/xneog-cli
```

## Why another CLI?

| | claude / kimi / grok | xneog |
|---|---|---|
| Session lives in | the terminal process | a daemon on your Mac |
| Close the terminal | session dies or detaches | session keeps running |
| Drive from phone | mirror/remote view | same session, same protocol, native app |
| Tool approval | in the terminal | terminal **or** push notification with diff |
| Engines | one vendor | Claude (first-party) · Grok (sandboxed) · Claude API (metered) |
| Untrusted engines | — | Seatbelt jail: engine sees **only** its workspace |

## Quickstart

```sh
xneog login            # opens your browser, you sign in (Google/Apple), the terminal
                       # receives the credential by itself — no code to copy/paste
xneog                  # NEW clean session here (like `claude`)
xneog --continue       # resume the most recent session instead
xneog ls               # list your sessions — AI titles, engines, pending approvals
xneog logout           # drop this terminal's credential
```

Other ways in, if you run your own daemon: `xneog login --code XXXX` (paste a pairing code
from the web app) or `xneog login maquina` / `--keychain` (bring-your-own-key, stored in the
macOS Keychain).

```sh
xneog new . --engine grok            # sandboxed Grok session (Seatbelt jail)
xneog new . --profile edit           # edits auto-approved, Bash still asks
xneog import <claude-session-id>     # migrate an existing Claude Code session
xneog -p "text"                      # headless turn into this directory's live session
xneog doctor                         # credential, daemon reachability, protocol, PATH
```

Inside a session, typing `/` pops a **live two-column menu** that filters as you type
(Tab completes):

| command | what it does |
|---|---|
| `/init` | the agent explores the folder and writes `XNEOG.md` — the project context it reads in every future session |
| `/compact` | summarizes the history and keeps going (lighter and cheaper) |
| `/cost` | turns, tokens and US$ spent in this terminal session — measured, never estimated |
| `/model` `/mode` | switch model / permission mode live |
| `/tasks` `/stop` | subagents & workflows with per-phase progress · cancel the current turn |
| `/conta` `/login` | which credential is in use · connect this terminal to your account |
| `"""` | multiline block (or end a line with `\`) · `y/n/a/e` answers approvals · `/q` detaches |

Responses **stream** with markdown rendered in place, and every turn ends with the model,
token counts and the real cost of that turn.

## XNEOG.md

Drop an `XNEOG.md` in a project (or run `/init`) and the agent reads it before acting —
what the project is, how to run and test it, conventions, known traps. It ships inside the
cached prompt prefix, so the context costs ~10% after the first turn.

## Permission profiles

- **safe** (default) — every side effect asks for approval
- **edit** — file edits go through, shell commands still ask
- **auto** — the daemon approves everything itself, **per session**, with a full audit
  trail (`by:"auto"`); revocable live with `/mode default`
- a global bypass flag still *does not exist, on purpose* — the queue always runs
  server-side, even in auto.

## Architecture

```
terminal (xneog)  ──┐
iOS / macOS app   ──┼──►  xneog-agentd  ──►  engines: claude · grok (jailed) · api
future clients    ──┘     sessions · approvals · SSE replay · transcripts
```

The protocol is documented in [PROTOCOL.md](./PROTOCOL.md) — curated events, replay
cursors, approval queue, engine registry. Any client that speaks it sees the same sessions.

## Accounts and isolation

Signing in with Google/Apple provisions a **tenant** of your own on the daemon: your sessions
live in an isolated workspace, with per-tenant caps on live sessions and pending approvals.
A member never gets owner capabilities, and shell access only exists where the host can
sandbox it (Seatbelt on macOS) — elsewhere the tool is not even offered, instead of failing
after a pointless approval wait.

## Status

**Beta.** The CLI (this repo) is MIT-licensed. The daemon (`xneog-agentd`) is in closed
beta — self-host access and hosted gateway keys (metered tiers) are rolling out.
Get in touch: [xneog.com](https://xneog.com)

## License

MIT © xNeog
