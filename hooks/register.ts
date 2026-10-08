import type { EngineInterface, Register } from 'claude-code'

import {
  type Claim,
  type Message,
  type Peer,
  HEARTBEAT_MS,
  MAX_MESSAGE_CHARS,
  MAX_TTL_MINUTES,
  POLL_MS,

  defaultName,
  describeClaims,
  describePeers,
  GUIDE,
  frameMessage,
  isClaimHeld,
  isLive,
  loginOf,
  parseJson,
  resolveTarget,
  slugOf,
} from './lib'

const TOOL_PEERS = 'mcp__coord__coord_peers'
const TOOL_SEND = 'mcp__coord__coord_send'
const TOOL_CLAIM = 'mcp__coord__coord_claim'
const TOOL_RELEASE = 'mcp__coord__coord_release'

/** A presence file this old is deleted by whichever session sees it next. */
const PRUNE_MS = 10 * 60_000
/** A claim folder with no owner.json this long was left by a session that died mid-claim. */
const ORPHAN_CLAIM_MS = 30_000

type Self = { id: string; name: string; login: string; cwd: string; startedAt: number }

let inbound: 'deliver' | 'notify' = 'deliver'
let root = ''
let self: Self | undefined
// Held by the host, so a hot reload mid-turn keeps it; a module variable would reset to idle.
const BUSY = { plugin: 'coord', key: 'busy' } as const
let isPolling = false
const toasted = new Set<string>()

function run($: EngineInterface, argv: string[]) {
  return $.process.run(argv, { timeoutMs: 10_000 })
}
function log($: EngineInterface, text: string) {
  $.ui.log(`coord: ${text}`, { to: 'debug' })
}

// Readers never see a half-written file: write a dot-named temp beside it, then rename.
async function writeAtomic($: EngineInterface, path: string, text: string) {
  const cut = path.lastIndexOf('/')
  const tmp = `${path.slice(0, cut)}/.${path.slice(cut + 1)}.${Math.random().toString(36).slice(2)}.tmp`
  await $.fs.write(tmp, text)
  const moved = await run($, ['mv', '-f', tmp, path])
  if (moved.exitCode !== 0) throw new Error(`mv ${tmp}: ${moved.stderr.trim()}`)
}

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  const text = await $.fs.read(path).catch(() => undefined)
  return typeof text === 'string' ? parseJson<T>(text) : undefined
}

async function listNames($: EngineInterface, dir: string) {
  const entries = await $.fs.list(dir).catch(() => [])
  return entries.filter(entry => !entry.name.startsWith('.'))
}

async function livePeers($: EngineInterface): Promise<Peer[]> {
  const now = await $.clock.now()
  const peers: Peer[] = []
  for (const entry of await listNames($, `${root}/peers`)) {
    if (!entry.name.endsWith('.json')) continue
    const path = `${root}/peers/${entry.name}`
    const peer = await readJson<Peer>($, path)
    if (peer === undefined) continue
    if (isLive(peer, now)) peers.push(peer)
    else if (now - peer.updatedAt > PRUNE_MS) await run($, ['rm', '-f', path])
  }
  return peers.sort((a, b) => a.name.localeCompare(b.name))
}

async function allClaims($: EngineInterface): Promise<Claim[]> {
  const claims: Claim[] = []
  for (const entry of await listNames($, `${root}/claims`)) {
    if (entry.kind !== 'dir') continue
    const claim = await readJson<Claim>($, `${root}/claims/${entry.name}/owner.json`)
    if (claim !== undefined) claims.push(claim)
  }
  return claims
}

async function heldClaims($: EngineInterface, peers: readonly Peer[]) {
  const now = await $.clock.now()
  const live = new Set(peers.map(p => p.id))
  return (await allClaims($)).filter(c => isClaimHeld(c, live, now))
}

// A /clear keeps the process but changes the session id with no session.start,
// so every heartbeat re-reads the id and moves this session's files when it changed.
async function ensureSelf($: EngineInterface): Promise<Self> {
  const id = await $.session.id()
  if (self?.id === id) return self
  if (self !== undefined) await leave($, self)
  const login = loginOf(await $.env.get('CLAUDE_CONFIG_DIR'))
  const cwd = await $.session.cwd()
  const stored = await $.store.get(`name:${id}`)
  const name = typeof stored === 'string' ? stored : defaultName(login, cwd, id)
  self = { id, name, login, cwd, startedAt: (await $.session.usage()).startedAt }
  await run($, ['mkdir', '-p', `${root}/peers`, `${root}/claims`, `${root}/inbox/${id}`])
  return self
}

async function isBusy($: EngineInterface) {
  return (await $.state.get(BUSY)).value === true
}

async function heartbeat($: EngineInterface) {
  const me = await ensureSelf($)
  const peer: Peer = { ...me, status: (await isBusy($)) ? 'busy' : 'idle', updatedAt: await $.clock.now() }
  await writeAtomic($, `${root}/peers/${me.id}.json`, JSON.stringify(peer))
  const others = (await livePeers($)).filter(p => p.id !== me.id).length
  $.ui.status(`coord: ${me.name} · ${others} peer${others === 1 ? '' : 's'}`)
}

async function leave($: EngineInterface, me: Self) {
  for (const claim of await allClaims($)) {
    if (claim.ownerId === me.id) await run($, ['rm', '-rf', `${root}/claims/${slugOf(claim.resource)}`])
  }
  await run($, ['rm', '-rf', `${root}/peers/${me.id}.json`, `${root}/inbox/${me.id}`])
}

async function deliver($: EngineInterface, message: Message) {
  const text = frameMessage(message)
  if (await isBusy($)) {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } else {
    void $.prompt.submit({ text })
  }
  $.ui.toast(`coord: message from ${message.fromName}`)
}

async function pollInbox($: EngineInterface, force: boolean) {
  if (isPolling || self === undefined) return 0
  isPolling = true
  let count = 0
  try {
    const dir = `${root}/inbox/${self.id}`
    const files = (await listNames($, dir)).filter(entry => entry.name.endsWith('.json'))
    files.sort((a, b) => a.name.localeCompare(b.name))
    for (const file of files) {
      const path = `${dir}/${file.name}`
      if (inbound === 'notify' && !force) {
        if (toasted.has(file.name)) continue
        toasted.add(file.name)
        const held = await readJson<Message>($, path)
        $.ui.toast(`coord: message from ${held?.fromName ?? 'a peer'} — /coord read to deliver`)
        continue
      }
      const message = await readJson<Message>($, path)
      await run($, ['rm', '-f', path])
      toasted.delete(file.name)
      if (message === undefined) continue
      await deliver($, message)
      count += 1
    }
  } finally {
    isPolling = false
  }
  return count
}

async function send($: EngineInterface, to: string, text: string) {
  const me = await ensureSelf($)
  if (text.trim() === '') return 'Not sent: `message` is empty.'
  if (text.length > MAX_MESSAGE_CHARS) return `Not sent: the message is over ${MAX_MESSAGE_CHARS} characters.`
  const target = resolveTarget(to, await livePeers($), me.id)
  if ('error' in target) return `Not sent: ${target.error}`
  const sentAt = await $.clock.now()
  const message: Message = { fromId: me.id, fromName: me.name, fromLogin: me.login, text, sentAt }
  for (const peer of target.peers) {
    const stamp = `${String(sentAt).padStart(15, '0')}-${Math.random().toString(36).slice(2, 8)}`
    await run($, ['mkdir', '-p', `${root}/inbox/${peer.id}`])
    await writeAtomic($, `${root}/inbox/${peer.id}/${stamp}.json`, JSON.stringify(message))
  }
  return `Sent to ${target.peers.map(p => `${p.name} [${p.id}]`).join(', ')}.`
}

async function claim($: EngineInterface, resource: string, note: string, ttlMinutes: number) {
  const me = await ensureSelf($)
  const slug = slugOf(resource)
  if (slug === '') return 'Not claimed: `resource` has no usable characters.'
  const ttl = Math.min(Math.max(1, Math.round(ttlMinutes)), MAX_TTL_MINUTES)
  const dir = `${root}/claims/${slug}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = await $.clock.now()
    const record: Claim = {
      resource, ownerId: me.id, ownerName: me.name, ownerLogin: me.login,
      note, claimedAt: now, expiresAt: now + ttl * 60_000,
    }
    // mkdir is atomic: exactly one session creates the folder.
    if ((await run($, ['mkdir', dir])).exitCode === 0) {
      await writeAtomic($, `${dir}/owner.json`, JSON.stringify(record))
      return `Claimed "${resource}" for ${ttl} minutes. Release it with coord_release when done.`
    }
    const current = await readJson<Claim>($, `${dir}/owner.json`)
    if (current === undefined) {
      const stat = await $.fs.stat(dir).catch(() => undefined)
      if (stat !== undefined && now - stat.mtimeMs < ORPHAN_CLAIM_MS) {
        return `Not claimed: another session is claiming "${resource}" right now; check coord_peers and retry.`
      }
    } else if (current.ownerId === me.id) {
      await writeAtomic($, `${dir}/owner.json`, JSON.stringify({ ...record, claimedAt: current.claimedAt }))
      return `Renewed "${resource}" for ${ttl} minutes.`
    } else {
      const live = new Set((await livePeers($)).map(p => p.id))
      if (isClaimHeld(current, live, now)) {
        const left = Math.round((current.expiresAt - now) / 60_000)
        const why = current.note ? ` (${current.note})` : ''
        return `Not claimed: "${resource}" is held by ${current.ownerName} [${current.ownerId}]${why}, ${left}m left. Coordinate with coord_send.`
      }
    }
    await run($, ['rm', '-rf', dir])
  }
  return `Not claimed: "${resource}" changed hands while claiming; retry.`
}

async function release($: EngineInterface, resource: string) {
  const me = await ensureSelf($)
  const dir = `${root}/claims/${slugOf(resource)}`
  const current = await readJson<Claim>($, `${dir}/owner.json`)
  if (current === undefined) return `"${resource}" is not claimed.`
  if (current.ownerId !== me.id) {
    return `Not released: "${resource}" is held by ${current.ownerName} [${current.ownerId}], not this session.`
  }
  await run($, ['rm', '-rf', dir])
  return `Released "${resource}".`
}

// The native ListAgents/SendMessage reach only this login's sessions; these find
// the peers they cannot, and only those, so subagents, teammates and same-login
// sessions keep the native path.
async function otherLoginPeers($: EngineInterface) {
  const me = await ensureSelf($)
  return (await livePeers($)).filter(p => p.id !== me.id && p.login !== me.login)
}

async function crossLoginTarget($: EngineInterface, to: string) {
  const me = await ensureSelf($)
  const wanted = to.replace(/\s*\[[0-9a-f]+\]\s*$/i, '').trim()
  const peers = (await livePeers($)).filter(p => p.id !== me.id)
  if (peers.some(p => p.login === me.login && p.name === wanted)) return undefined
  // Exact id or name only: a looser match could capture a name the native
  // SendMessage would have delivered (a subagent, a Remote Control or cloud session).
  const matches = peers.filter(p => p.login !== me.login && (p.id === wanted || p.name === wanted))
  return matches.length === 1 ? matches[0] : undefined
}

function asText(value: unknown) {
  return typeof value === 'string' ? value : ''
}

export const register: Register = (on, options) => {
  inbound = options.inbound === 'notify' ? 'notify' : 'deliver'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    root = (typeof options.root === 'string' && options.root) || `${(await $.env.get('HOME')) ?? '/tmp'}/.claude-coord`

    await $.tool.register({
      name: 'coord_peers',
      description:
        'Lists the Claude Code sessions on this machine under every login (via the coord mod), with their ' +
        'status, working directory and the shared resources each one has claimed. Use it before shared ' +
        'actions (deploys, image pushes, stack updates, migrations) and to find a session to message.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'coord_send',
      description:
        'Sends a message to another Claude Code session on this machine, under any login. It reaches that ' +
        'session within seconds. `to` is a session id or name from coord_peers, or "*" for every other session.',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, message: { type: 'string' } },
        required: ['to', 'message'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'coord_claim',
      description:
        'Claims a shared resource exclusively across every session on this machine before acting on it, ' +
        'e.g. "gcp:artifact-registry/api-image", "pulumi:infra/prod", "aws:staging/api". ' +
        'Refused with the holder named when another live session holds it. Claims lapse after ttl_minutes ' +
        '(default 60) or when the holder exits. Calling again on your own claim renews it.',
      inputSchema: {
        type: 'object',
        properties: {
          resource: { type: 'string' },
          note: { type: 'string', description: 'What you are doing with it, shown to other sessions.' },
          ttl_minutes: { type: 'number' },
        },
        required: ['resource'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'coord_release',
      description: 'Releases a resource this session claimed with coord_claim.',
      inputSchema: { type: 'object', properties: { resource: { type: 'string' } }, required: ['resource'] },
      isDeferred: false,
    })
    await $.command.register({
      name: 'coord',
      description: 'Coordination across logins: list sessions and claims; `read` delivers held messages; `name <name>` renames this session',
      argumentHint: '[read | name <name>]',
    })

    await heartbeat($).catch(error => log($, `heartbeat: ${String(error)}`))
    $.clock.every(HEARTBEAT_MS, () => {
      heartbeat($).catch(error => log($, `heartbeat: ${String(error)}`))
    })
    $.clock.every(POLL_MS, () => {
      pollInbox($, false).catch(error => log($, `inbox: ${String(error)}`))
    })
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'coord:guide', text: GUIDE, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (self !== undefined) await leave($, self).catch(error => log($, `leave: ${String(error)}`))
    self = undefined
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await $.state.set(BUSY, true)
    void heartbeat($).catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await $.state.set(BUSY, false)
      void heartbeat($).catch(() => undefined)
    }
    return next(e)
  })

  on('tool.call', { tool: 'ListAgents' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const others = await otherLoginPeers($).catch(() => [])
    if (others.length === 0) return ran
    const now = await $.clock.now()
    const claims = await heldClaims($, await livePeers($)).catch(() => [])
    const section =
      `Sessions under other Claude logins on this machine (coord mod, ${root}): SendMessage to one of ` +
      `these names is delivered through the coord mod; notify_when_idle does not reach them.\n` +
      describePeers(others, claims, '', now)
    return { ...ran, context: [...(ran.context ?? []), section] }
  })

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const peer = await crossLoginTarget($, String(e.to)).catch(() => undefined)
    if (peer === undefined) return next(e)
    const { tool, tool_use_id: _id, agentId: _agent, ...input } = e
    const check = await $.tool.check({ tool, input })
    if (check.decision === 'deny') return { deny: `SendMessage is denied here: ${check.reason ?? 'permission rule'}` }
    const sent = await send($, peer.id, e.message ?? '')
    const idle = e.notify_when_idle ? ' notify_when_idle is not supported across logins; ask the peer to message back.' : ''
    // SendMessage's output is an object; a plain string fails the engine's check.
    const message = `${peer.name} runs under login ${peer.login}, so this went through the coord mod. ${sent}${idle}`
    return { result: { success: sent.startsWith('Sent'), message } }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'coord: routing SendMessage failed; retry or use coord_send.' }))

  on('tool.call', { tool: TOOL_PEERS }, async $ => {
    const me = await ensureSelf($)
    const peers = await livePeers($)
    const claims = await heldClaims($, peers)
    const now = await $.clock.now()
    return { result: `${describePeers(peers, claims, me.id, now)}\n\nClaims:\n${describeClaims(claims, now)}` }
  })

  on('tool.call', { tool: TOOL_SEND }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    return { result: await send($, asText(input.to), asText(input.message)) }
  })

  on('tool.call', { tool: TOOL_CLAIM }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const ttl = typeof input.ttl_minutes === 'number' && Number.isFinite(input.ttl_minutes) ? input.ttl_minutes : 60
    return { result: await claim($, asText(input.resource), asText(input.note), ttl) }
  })

  on('tool.call', { tool: TOOL_RELEASE }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    return { result: await release($, asText(input.resource)) }
  })

  on('command.run', { command: 'coord' }, async ($, e) => {
    const me = await ensureSelf($)
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'read') {
      const count = await pollInbox($, true)
      return { text: count > 0 ? `Delivered ${count} held message(s).` : 'No held messages.' }
    }
    if (verb === 'name') {
      const name = rest.join(' ').trim()
      if (name === '') return { text: `This session is ${me.name}.` }
      me.name = name.slice(0, 64)
      await $.store.set(`name:${me.id}`, me.name)
      await heartbeat($)
      return { text: `This session is now ${me.name}.` }
    }
    const peers = await livePeers($)
    const claims = await heldClaims($, peers)
    const now = await $.clock.now()
    return {
      text: `Coordination folder: ${root} · inbound: ${inbound}\n\nSessions:\n${describePeers(peers, claims, me.id, now)}\n\nClaims:\n${describeClaims(claims, now)}`,
    }
  })
}

