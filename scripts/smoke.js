// Teste curto de protocolo: entra, espera spawn/chunks, lê mensagens do servidor e sai. Sem /login.
const { fixResourcePack } = require('../src/compat')
const mineflayer = require('mineflayer')
const name = process.argv[2] || 'NapoProbe'
const bot = mineflayer.createBot({ host: process.env.MC_HOST || 'caiosujinho.jogar.io', username: name, auth: 'offline', version: '26.2' })
fixResourcePack(bot._client)
const out = { messages: [] }
require('../src/auth').attach(bot._client, (r) => { out.fatal = r; bot.quit() })
bot.on('messagestr', (m, pos) => out.messages.push(`[${pos}] ${m.replace(/§./g, '')}`.slice(0, 160)))
bot.once('spawn', async () => {
  await bot.waitForChunksToLoad().catch(() => {})
  const p = bot.entity.position
  const below = bot.blockAt(p.offset(0, -1, 0))
  out.spawn = { pos: p.floored().toString(), dim: bot.game.dimension, gameMode: bot.game.gameMode, health: bot.health, food: bot.food, below: below?.name }
  out.players = Object.keys(bot.players)
  out.entities = Object.values(bot.entities).slice(0, 15).map(e => e.name)
  out.blocksNear = [...new Set(bot.findBlocks({ matching: b => b.name !== 'air', maxDistance: 8, count: 200 }).map(v => bot.blockAt(v)?.name))].slice(0, 20)
})
bot.on('kicked', r => { out.kicked = String(typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 300) })
bot.on('error', e => { out.error = e.message })
setTimeout(() => { bot.quit(); setTimeout(() => { console.log(JSON.stringify(out, null, 1)); process.exit(0) }, 500) }, 20000)
