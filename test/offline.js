// Testes sem servidor: carregamento, chat, memória, controle HTTP.
process.env.VAULT_DIR = require('path').join(__dirname, '..', 'data', 'test-vault')
process.env.CONTROL_PORT = '3099'
const assert = require('assert')
const fs = require('fs')
const results = []
const t = async (name, fn) => { try { await fn(); results.push(['ok', name]) } catch (e) { results.push(['FALHOU', name + ' — ' + e.message]) } }

;(async () => {
  await t('minecraft-data 26.2', () => assert.strictEqual(require('minecraft-data')('26.2').version.version, 776))
  await t('módulos carregam', () => { require('../src/agent'); require('../src/controller') })

  const chat = require('../src/chat')
  const players = { Joao: {}, NapoLtz: {} }
  await t('parse chat padrão', () => assert.deepStrictEqual(chat.parse('<Joao> napo oq vc ta fazendo', players, 'NapoLtz'), { from: 'Joao', text: 'napo oq vc ta fazendo', whisper: false }))
  await t('parse chat com rank', () => assert.strictEqual(chat.parse('[VIP] Joao » eae napo', players, 'NapoLtz').from, 'Joao'))
  await t('parse whisper', () => assert.strictEqual(chat.parse('[Joao -> eu] vem ca', players, 'NapoLtz').whisper, true))
  await t('ignora sistema', () => assert.strictEqual(chat.parse('O servidor reinicia em 5 minutos', players, 'NapoLtz'), null))
  await t('sanitize minúsculas/emoji', () => assert.strictEqual(chat.sanitize('To Indo! 😀'), 'to indo'))
  await t('sanitize bloqueia segredo', () => assert.strictEqual(chat.sanitize('minha senha é x'), null))
  const reply = (msg) => { const c = { activity: 'pegando madeira', greet: 'eae', hasItem: () => false }; for (const [re, fn] of chat.rules) { const m = msg.match(re); if (m) return fn(c, m) } return null }
  await t('regra: o que ta fazendo', () => assert.strictEqual(reply('oq vc ta fazendo'), 'to pegando madeira'))
  await t('regra: vem ca', () => assert.strictEqual(reply('vem ca'), 'pera ai'))
  await t('regra: tem ferro', () => assert.strictEqual(reply('vc tem ferro'), 'n tenho'))

  const sc = (text, extra = {}) => chat.score({ from: 'Keova18', text, whisper: false }, { others: ['Keova18'], aliases: ['napoltz', 'napo'], sinceTalk: 1e9, greetedRecently: false, dist: null, ...extra })
  await t('score: só 2 online, oi é comigo', () => { const r = sc('oi'); assert.ok(r.to === 100 && r.reply) })
  await t('score: opa depois de cumprimentar não responde', () => assert.strictEqual(sc('opa', { greetedRecently: true }).reply, false))
  await t('score: kkk não responde', () => assert.strictEqual(sc('kkkk').reply, false))
  await t('score: pergunta com vários online sem nome não é comigo', () => assert.strictEqual(sc('alguem tem ferro?', { others: ['Keova18', 'Ana', 'Bob'] }).reply, false))
  await t('score: nome + pergunta com vários online responde', () => assert.ok(sc('napo vc tem ferro?', { others: ['Keova18', 'Ana', 'Bob'] }).reply))
  await t('score: cita outro jogador não é comigo', () => assert.strictEqual(sc('ana vem ca', { others: ['Keova18', 'Ana', 'Bob'], sinceTalk: 30000 }).reply, false))

  const memory = require('../src/memory')
  await t('memória salva/recupera', () => {
    memory.state.goal = 'teste'
    memory.save(true)
    const again = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'data', 'state.json'), 'utf8'))
    assert.strictEqual(again.goal, 'teste')
    memory.state.goal = ''
    memory.save(true)
  })
  await t('vault escreve', () => {
    memory.history('teste offline')
    assert.ok(memory.readNote(`Histórico/${new Date().toISOString().slice(0, 10)}.md`).includes('teste offline'))
  })

  const { Controller } = require('../src/controller')
  const ctl = new Controller('emeralds')
  ctl.running = false
  const srv = require('../src/control').start(ctl, () => null, () => {})
  await new Promise(r => setTimeout(r, 300))
  await t('controle /status', async () => assert.strictEqual((await (await fetch('http://127.0.0.1:3099/status')).json()).online, false))
  await t('controle /pause', async () => { await fetch('http://127.0.0.1:3099/pause', { method: 'POST' }); assert.strictEqual(memory.state.paused, true); await fetch('http://127.0.0.1:3099/resume', { method: 'POST' }); assert.strictEqual(memory.state.paused, false) })
  srv.close()
  fs.rmSync(process.env.VAULT_DIR, { recursive: true, force: true })
  for (const [s, n] of results) console.log(s.padEnd(7), n)
  process.exit(results.some(r => r[0] !== 'ok') ? 1 : 0)
})()
