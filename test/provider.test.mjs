import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { provider } from '../source/provider.mjs'

async function listen(t) {
  const source = provider().listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve, reject) => source.close(error => error ? reject(error) : resolve())))
  await once(source, 'listening')
  return 'http://127.0.0.1:' + source.address().port
}

function post(root, endpoint, value) {
  return fetch(root + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) })
}

test('探头域更正和已接退款独立生效', async t => {
  const root = await listen(t)
  const choices = async () => (await (await fetch(root + '/cold/files')).json())
  assert.equal((await choices())[0].zone, 'N')
  await post(root, '/lab?stage=remapped')
  assert.deepEqual((await choices()).map(row => row.zone), ['S', 'N'])
  const block = Buffer.from(await (await fetch(root + '/cold/read?file=b')).arrayBuffer())
  assert.equal(block.readInt16LE(16), 82)
  assert.equal(block.readUInt8(18), 0)
  const lines = await (await fetch(root + '/refunds/lines?ticket=R')).json()
  assert.equal(lines[0].state, 'accepted')
})
