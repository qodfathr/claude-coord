# coord

A Claude Code mod that lets every Claude Code session on one machine find, message and coordinate with each other, including sessions logged in to **different Claude accounts** (different `CLAUDE_CONFIG_DIR`s) under the same OS user.

Claude Code's built-in cross-session messaging (`ListAgents` / `SendMessage`) only finds sessions that share a config directory. Run two accounts side by side and they cannot see each other. `coord` closes that gap with a shared folder, and adds exclusive claims on shared resources, so two agents don't deploy the same thing at once.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install coord --marketplace qodfathr/claude-coord
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). Install it under **each** Claude login on the machine that should take part, since every config directory keeps its own plugins.

## What agents get

| | |
|---|---|
| `coord_peers` | Live sessions on every login: name, id, login, busy/idle, working directory, claims |
| `coord_send` | Message a session by id or name, or `*` for all; delivered within ~2 s |
| `coord_claim` | Exclusive, expiring claim on a named resource, e.g. `pulumi:infra/prod` |
| `coord_release` | Release your claim |
| `ListAgents` | Native result unchanged, plus the sessions on other logins |
| `SendMessage` | A `to` that exactly names a session on another login is delivered through coord; everything else (subagents, teammates, Remote Control and cloud sessions) uses the native path |
| System prompt | A short section telling the agent to claim before acting on shared state and to treat peer messages as peers, not as the user |

And for you: `/coord` lists sessions and claims, `/coord name <name>` renames this session, `/coord read` delivers held messages. The status line shows `coord: <name> · N peers`.

## How it works

Everything lives in `~/.claude-coord/`:

- `peers/<session>.json`: rewritten every 5 s; a session silent for 20 s counts as gone.
- `inbox/<session>/`: one file per message, polled every 1.5 s. A message reaching a busy session joins its running turn; one reaching an idle session starts a turn.
- `claims/<resource>/`: created with `mkdir`, which is atomic, so exactly one session wins. A claim lapses at its TTL (default 60 min) or when its holder goes silent.

## Settings

| Option | Default | |
|---|---|---|
| `root` | `$HOME/.claude-coord` | Shared folder; every participating session must use the same one |
| `inbound` | `deliver` | `notify` shows a toast instead and waits for `/coord read` |

## Security

- Every process running as your OS user can write to the folder, so coord adds no trust boundary. Incoming messages are framed as coming from a peer session, never from the user, and carry no approval.
- A delivered message can start a turn in an idle session under that session's own permission mode. Set `inbound: notify` where that is not wanted.
- A routed `SendMessage` is still checked against your permission rules.

## Requirements

A Claude Code build with function-hook mods (built and tested on 2.1.294), on macOS or Linux (it uses `mkdir`, `mv` and `rm`).

## Development

```
claude --plugin-dir /path/to/claude-coord    # load from a checkout; saves hot-reload
claude plugin validate /path/to/claude-coord
claude plugin test /path/to/claude-coord
```
