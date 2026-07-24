# xneog

**Your coding agent lives in a daemon — not in your terminal window.**

`xneog` is the terminal client for **xneog-agentd**, a session daemon for agentic coding.
Start a session in your terminal, close the laptop, and keep driving the same session from
the xNeog iOS app — approvals arrive as push notifications on your phone, with full diffs.

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
xneog login            # point the CLI at your xneog-agentd (BYOK, macOS Keychain supported)
xneog                  # resume (or start) a session in the current directory
xneog ls               # list sessions — AI titles, engines, pending approvals
xneog new . --engine grok            # sandboxed Grok session (Seatbelt jail)
xneog new . --profile edit           # edits auto-approved, Bash still asks
xneog import <claude-session-id>     # migrate an existing Claude Code session
```

Inside a session: `/` shows the command menu · `"""` opens a multiline block ·
`y/n/a/e` answers approval requests (with colored diffs) · `/tasks` shows
subagents & workflows with per-phase progress · `/q` detaches (session keeps living).

## Permission profiles

- **safe** (default) — every side effect asks for approval
- **edit** — file edits go through, shell commands still ask
- **full** — *does not exist, on purpose.* The approval queue is enforced server-side;
  there is no bypass flag to leak.

## Architecture

```
terminal (xneog)  ──┐
iOS / macOS app   ──┼──►  xneog-agentd  ──►  engines: claude · grok (jailed) · api
future clients    ──┘     sessions · approvals · SSE replay · transcripts
```

The protocol is documented in [PROTOCOL.md](./PROTOCOL.md) — curated events, replay
cursors, approval queue, engine registry. Any client that speaks it sees the same sessions.

## Status

**Beta.** The CLI (this repo) is MIT-licensed. The daemon (`xneog-agentd`) is in closed
beta — self-host access and hosted gateway keys (metered tiers) are rolling out.
Get in touch: [xneog.com](https://xneog.com)

## License

MIT © xNeog
