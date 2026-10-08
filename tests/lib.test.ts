import { describe, expect, test } from 'claude-code/testing'

import { type Claim, type Peer, STALE_MS, frameMessage, isClaimHeld, isLive, loginOf, resolveTarget, slugOf } from '../hooks/lib'

const NOW = 1_000_000_000
const peer = (id: string, name: string, login: string): Peer => ({
  id, name, login, cwd: '/home/dev/project', status: 'idle', startedAt: NOW - 60_000, updatedAt: NOW,
})
const PEERS = [peer('aaaa1111', 'builder', '001'), peer('bbbb2222', 'deployer', '002'), peer('cccc3333', 'twin', '002'), peer('dddd4444', 'twin', 'auto-001')]

describe('loginOf', () => {
  test('maps config dirs to login labels', () => {
    expect(loginOf('/home/dev/.claude-002')).toBe('002')
    expect(loginOf('/home/dev/.claude-auto-001/')).toBe('auto-001')
    expect(loginOf('/home/dev/.claude')).toBe('default')
    expect(loginOf(undefined)).toBe('default')
  })
})

describe('resolveTarget', () => {
  test('finds a peer by name, id and id prefix, never itself', () => {
    expect(resolveTarget('deployer', PEERS, 'aaaa1111')).toEqual({ peers: [PEERS[1]] })
    expect(resolveTarget('cccc3333', PEERS, 'aaaa1111')).toEqual({ peers: [PEERS[2]] })
    expect(resolveTarget('bbbb', PEERS, 'aaaa1111')).toEqual({ peers: [PEERS[1]] })
    expect('error' in resolveTarget('builder', PEERS, 'aaaa1111')).toBe(true)
  })
  test('refuses an ambiguous name and broadcasts on *', () => {
    const twin = resolveTarget('twin', PEERS, 'aaaa1111')
    expect('error' in twin && twin.error.includes('cccc3333') && twin.error.includes('dddd4444')).toBe(true)
    expect(resolveTarget('*', PEERS, 'aaaa1111')).toEqual({ peers: PEERS.slice(1) })
  })
})

describe('liveness and claims', () => {
  test('a peer past STALE_MS is gone and its claims lapse', () => {
    const stale = { ...PEERS[1]!, updatedAt: NOW - STALE_MS - 1 }
    expect(isLive(PEERS[1]!, NOW)).toBe(true)
    expect(isLive(stale, NOW)).toBe(false)
    const claim: Claim = {
      resource: 'gcp:deploy', ownerId: 'bbbb2222', ownerName: 'deployer', ownerLogin: '002',
      note: '', claimedAt: NOW, expiresAt: NOW + 60_000,
    }
    expect(isClaimHeld(claim, new Set(['bbbb2222']), NOW)).toBe(true)
    expect(isClaimHeld(claim, new Set(), NOW)).toBe(false)
    expect(isClaimHeld(claim, new Set(['bbbb2222']), NOW + 60_001)).toBe(false)
  })
  test('resource slugs are one safe path segment', () => {
    expect(slugOf('GCP: artifact-registry/api-image')).toBe('gcp_artifact-registry_api-image')
    expect(slugOf('../../etc')).toBe('etc')
    expect(slugOf('  ')).toBe('')
  })
})

test('an incoming message is framed as a peer, not the user', () => {
  const text = frameMessage({ fromId: 'bbbb2222', fromName: 'deployer', fromLogin: '002', text: 'image pushed', sentAt: NOW })
  expect(text.includes('<coord-message from="deployer" login="002" session="bbbb2222">')).toBe(true)
  expect(text.includes('not from your user')).toBe(true)
})
