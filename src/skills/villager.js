const { sleep, count, withTimeout, StepError } = require('./util')
const nav = require('./nav')
const craft = require('./craft')
const memory = require('../memory')
const log = require('../log')

const PROFESSIONS = ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith']

// Lê a profissão do metadata do aldeão (formato varia entre versões).
function profession (entity) {
  for (const m of entity.metadata || []) {
    if (m && typeof m === 'object' && ('villagerProfession' in m || 'profession' in m)) {
      const p = m.villagerProfession ?? m.profession
      if (typeof p === 'number') return PROFESSIONS[p] || String(p)
      return String(p).replace('minecraft:', '')
    }
  }
  return 'unknown'
}

const villagers = (bot, r = 64) => Object.values(bot.entities)
  .filter(e => e.name === 'villager' && e.position.distanceTo(bot.entity.position) < r)
  .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))

function remember (e, data) {
  const s = memory.state
  const id = e.uuid || String(e.id)
  s.villagers[id] = { ...(s.villagers[id] || {}), x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z), profession: profession(e), seen: Date.now(), ...data }
  memory.save()
  return s.villagers[id]
}

async function openTrades (bot, e) {
  await nav.goto(bot, new nav.goals.GoalFollow(e, 2), { timeout: 30000 }).catch(() => {})
  if (e.position.distanceTo(bot.entity.position) > 4) await nav.goto(bot, nav.near(e.position, 2), { timeout: 20000 })
  await bot.lookAt(e.position.offset(0, 1.5, 0), true)
  return withTimeout(bot.openVillager(e), 8000, 'trade_open_failed')
}

const isStickTrade = (t) => t.inputItem1?.name === 'stick' && t.outputItem?.name === 'emerald'

// Vende gravetos para todos os flecheiros próximos. Retorna esmeraldas ganhas.
async function sellSticks (bot, { signal } = {}) {
  let earned = 0
  const list = villagers(bot, 64).filter(e => ['fletcher', 'unknown'].includes(profession(e)))
  for (const e of list) {
    if (signal?.aborted) throw new StepError('aborted')
    if (count(bot, 'stick') < 32) break
    const known = memory.state.villagers[e.uuid || String(e.id)]
    if (known?.noStickTrade && Date.now() - known.seen < 20 * 60000) continue
    let win
    try { win = await openTrades(bot, e) } catch (err) { log.warn('trade open', err.message); continue }
    try {
      const idx = win.trades.findIndex(isStickTrade)
      if (idx < 0) { remember(e, { noStickTrade: true }); continue }
      const t = win.trades[idx]
      remember(e, { fletcher: true, noStickTrade: false })
      memory.addPlace('flecheiro', e.position, bot.game.dimension, 'aldeão que compra graveto')
      if (t.tradeDisabled) { remember(e, { soldOutAt: Date.now() }); continue }
      const per = t.inputItem1.count
      const left = Math.max(0, (t.maximumNbTradeUses || 16) - (t.nbTradeUses || 0))
      const times = Math.min(left, Math.floor(count(bot, 'stick') / per))
      if (times <= 0) continue
      const before = count(bot, 'emerald')
      await bot.trade(win, idx, times)
      await sleep(400)
      const got = count(bot, 'emerald') - before
      earned += got
      memory.state.stats.emeraldsEarned += got
      memory.state.stats.sticksTraded += got * per
      memory.save()
      log.info(`trade: +${got} esmeraldas (${per} gravetos cada)`)
      if (got > 0 && !memory.state.stats.firstTrade) {
        memory.state.stats.firstTrade = new Date().toISOString()
        memory.history(`primeira troca: ${got} esmeraldas com flecheiro`)
        memory.knowledge('Negociações', `flecheiro compra ${per} gravetos por 1 esmeralda (até ${t.maximumNbTradeUses} usos antes de reabastecer)`)
      }
    } finally { win.close() }
  }
  return earned
}

// Venda genérica: qualquer aldeão (até r blocos) que compre `item` por esmeralda. Usa tudo que der
// (respeitando o limite de usos da troca). Retorna esmeraldas ganhas.
async function sell (bot, item, { signal, r = 64, keep = 0 } = {}) {
  let earned = 0
  for (const e of villagers(bot, r)) {
    if (signal?.aborted) throw new StepError('aborted')
    if (count(bot, item) - keep <= 0) break
    const known = memory.state.villagers[e.uuid || String(e.id)]
    if (known?.[`no_${item}`] && Date.now() - known.seen < 30 * 60000) continue
    let win
    try { win = await openTrades(bot, e) } catch (err) { log.warn('trade open', err.message); continue }
    try {
      const idx = win.trades.findIndex(t => t.inputItem1?.name === item && t.outputItem?.name === 'emerald')
      if (idx < 0) { remember(e, { [`no_${item}`]: true }); continue }
      const t = win.trades[idx]
      remember(e, { [`no_${item}`]: false, [`buys_${item}`]: t.inputItem1.count })
      if (t.tradeDisabled) { remember(e, { soldOutAt: Date.now() }); continue }
      const per = t.inputItem1.count
      const left = Math.max(0, (t.maximumNbTradeUses || 16) - (t.nbTradeUses || 0))
      const times = Math.min(left, Math.floor((count(bot, item) - keep) / per))
      if (times <= 0) continue
      const before = count(bot, 'emerald')
      await bot.trade(win, idx, times)
      await sleep(400)
      const got = count(bot, 'emerald') - before
      earned += got
      memory.state.stats.emeraldsEarned += got
      memory.save()
      log.info(`trade: +${got} esmeraldas (${per} ${item} cada, ${profession(e)})`)
      if (got > 0) memory.knowledge('Negociações', `${profession(e)} compra ${per} ${item} por 1 esmeralda (até ${t.maximumNbTradeUses} usos)`)
    } finally { win.close() }
  }
  return earned
}

// Transforma um aldeão desempregado em flecheiro colocando uma mesa de flechas perto dele.
async function makeFletcher (bot, { signal } = {}) {
  const jobless = villagers(bot, 48).find(e => ['none', 'unknown'].includes(profession(e)))
  if (!jobless) throw new StepError('no_jobless', 'nenhum aldeão desempregado')
  if (!count(bot, 'fletching_table')) {
    if (count(bot, 'flint') < 2) await getFlint(bot, signal)
    await craft.craft(bot, 'fletching_table', 1)
  }
  await nav.goto(bot, nav.near(jobless.position, 2), { timeout: 30000, signal })
  await craft.placeNear(bot, 'fletching_table')
  memory.addPlace('mesa de flechas', bot.entity.position, bot.game.dimension, 'colocada por mim para criar flecheiro')
  for (let i = 0; i < 30; i++) {
    await sleep(2000)
    if (profession(jobless) === 'fletcher') { memory.history('criei um flecheiro com mesa de flechas'); return jobless }
  }
  throw new StepError('no_claim', 'aldeão não pegou a mesa de flechas')
}

async function getFlint (bot, signal) {
  const gather = require('./gather')
  for (let i = 0; i < 40 && count(bot, 'flint') < 2; i++) {
    if (signal?.aborted) throw new StepError('aborted')
    await gather.gather(bot, { blockTest: /^gravel$/, itemTest: /^(gravel|flint)$/, target: count(bot, /^(gravel|flint)$/) + 1, label: 'cascalho', signal })
    // Recoloca e quebra cascalho até dropar sílex.
    while (count(bot, 'gravel') > 0 && count(bot, 'flint') < 2) {
      const b = await craft.placeNear(bot, 'gravel')
      await bot.dig(b)
      await sleep(400)
      const drop = Object.values(bot.entities).find(e => e.name === 'item' && e.position.distanceTo(b.position) < 3)
      if (drop) await nav.goto(bot, nav.near(drop.position, 0), { timeout: 5000 }).catch(() => {})
    }
  }
  if (count(bot, 'flint') < 2) throw new StepError('no_flint')
}

// Detecta aldeia: aldeões ou sino visíveis.
function villageHere (bot) {
  const vs = villagers(bot, 80)
  const bell = bot.findBlock({ matching: bot.registry.blocksByName.bell?.id, maxDistance: 64 })
  return (vs.length >= 2 || bell) ? (bell?.position || vs[0].position) : null
}

// Pares de aldeões adultos a ≤ maxGap blocos um do outro (candidatos ao procriador).
function pairs (bot, maxGap = 3.5, radius = 64) {
  const vs = villagers(bot, radius).filter(v => v.onGround !== false)
  const out = []
  for (let i = 0; i < vs.length; i++) {
    for (let j = i + 1; j < vs.length; j++) {
      const d = vs[i].position.distanceTo(vs[j].position)
      if (d <= maxGap && Math.abs(vs[i].position.y - vs[j].position.y) < 0.6) out.push([vs[i], vs[j], d])
    }
  }
  return out.sort((a, b) => a[2] - b[2])
}

// Prende um aldeão numa cela 1x1 (4 lados, 2 de altura) enquanto ele está parado. Retorna as posições da cela.
async function trap (bot, v, { wallItem = 'wall' } = {}) {
  const build = require('./build')
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!v.isValid) throw new StepError('villager_gone', 'aldeão sumiu')
    const p = v.position.floored()
    // chega perto (2-3 blocos) sem ficar em cima das posições da cela
    if (bot.entity.position.distanceTo(v.position) > 3.2) {
      await nav.goto(bot, new nav.goals.GoalNear(p.x + 2, p.y, p.z + 2, 1), { timeout: 20000 }).catch(() => {})
    }
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const cells = []
    for (const dy of [0, 1]) for (const [dx, dz] of sides) cells.push(p.offset(dx, dy, dz))
    try {
      for (const c of cells) {
        if (v.position.floored().distanceTo(p) > 0.5) throw new StepError('moved')
        await build.placeAt(bot, c, wallItem)
      }
      if (v.position.floored().x === p.x && v.position.floored().z === p.z) {
        log.info(`aldeão preso em ${p}`)
        return { pos: p, cells }
      }
    } catch (e) {
      if (e.code === 'missing_item') throw e
      // desfaz o que colocou para não deixar lixo
      for (const c of cells) { const b = bot.blockAt(c); if (b && build.GROUPS.wall.test(b.name)) await bot.dig(b).catch(() => {}) }
    }
    await sleep(1500)
  }
  throw new StepError('trap_failed', 'aldeão não parou quieto')
}

// Joga comida perto do aldeão (ele pega sozinho). Cenoura/batata: 12 deixa ele disposto a procriar.
async function feed (bot, v, n = 12) {
  const food = bot.inventory.items().find(i => /^(carrot|potato|bread|beetroot)$/.test(i.name))
  if (!food) return false
  await nav.goto(bot, nav.near(v.position, 2), { timeout: 20000 }).catch(() => {})
  await bot.lookAt(v.position.offset(0, 0.5, 0), true)
  await bot.toss(food.type, null, Math.min(n, count(bot, food.name)))
  return true
}

module.exports = { profession, villagers, sell, sellSticks, makeFletcher, villageHere, openTrades, remember, pairs, trap, feed }
