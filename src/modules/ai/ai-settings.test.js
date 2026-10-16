import assert from 'node:assert/strict'
import test from 'node:test'
import { describeAI, describeTest } from './ai-settings.js'

test('a test that worked says how long the answer took, to one decimal', () => {
  assert.equal(describeTest({ ok: true, seconds: 2.3 }), 'Answered in 2.3 s')
  assert.equal(describeTest({ ok: true, seconds: 9 }), 'Answered in 9.0 s')
})

test('a test that failed shows the server\'s own plain message', () => {
  assert.equal(describeTest({ ok: false, error: 'The model service refused the request (HTTP 401).' }), 'The model service refused the request (HTTP 401).')
  assert.equal(describeTest(null), 'The test did not work.')
})

test('Claude Code is reported as found or not found', () => {
  assert.match(describeAI({ provider: 'claude-code', claudeCodeFound: true }).claudeNote, /installed here/)
  assert.match(describeAI({ provider: 'claude-code', claudeCodeFound: false }).claudeNote, /was not found/)
})

test('an unknown saved provider falls back to Claude Code', () => {
  assert.equal(describeAI({ provider: 'gemini' }).provider, 'claude-code')
  assert.equal(describeAI({ provider: 'azure' }).provider, 'azure')
})
