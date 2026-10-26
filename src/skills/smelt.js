// Fornalha: carvão vegetal a partir de troncos (para tochas).
const { sleep, count, StepError, withTimeout, LOGS, PLANKS } = require('./util')
const craft = require('./craft')
const nav = require('./nav')
const log = require('../log')

async function getFurnace (bot) {
  const near = bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 24 })
  if (near) { await nav.goto(bot, nav.near(near.position, 3), { timeout: 30000 }); return near }
  if (!count(bot, 'furnace')) await craft.craft(bot, 'furnace')
  return craft.placeNear(bot, 'furnace')
}

async function charcoal (bot, n) {
  if (count(bot, 'charcoal') + count(bot, 'coal') >= n) return
  const block = await getFurnace(bot)
  const f = await withTimeout(bot.openFurnace(block), 8000, 'furnace_open')
  try {
    const log_ = bot.inventory.items().find(i => LOGS.test(i.name))
    if (!log_) throw new StepError('need_logs', 'sem tronco para carvão')
    const fuel = bot.inventory.items().find(i => PLANKS.test(i.name)) || log_
    await f.putFuel(fuel.type, null, Math.min(fuel.count, Math.ceil(n * 1.5 / 1.5) + 1))
    await f.putInput(log_.type, null, Math.min(log_.count, n))
    for (let i = 0; i < n * 12 && count(bot, 'charcoal') < n; i++) {
      await sleep(1000)
      if (f.outputItem()?.count) await f.takeOutput().catch(() => {})
    }
  } finally { f.close() }
  log.info(`carvão: ${count(bot, 'charcoal')}`)
}

async function torches (bot, n) {
  if (count(bot, 'torch') >= n) return
  await charcoal(bot, Math.ceil((n - count(bot, 'torch')) / 4))
  await craft.ensureSticks(bot, Math.ceil(n / 4))
  // uma por vez: a receita escolhida podia ser a do carvão vegetal com só 2 e faltava no meio
  for (let i = 0; i < 16 && count(bot, 'torch') < n && count(bot, /^(coal|charcoal)$/) && count(bot, 'stick'); i++) await craft.craftNamed(bot, 'torch', 1)
  if (count(bot, 'torch') < n && count(bot, /^(coal|charcoal)$/) && !count(bot, 'stick')) { await craft.ensureSticks(bot, 4); return torches(bot, n) }
}

// Funde n itens (ex.: raw_iron → iron_ingot) com carvão; cada carvão funde 8.
async function smelt (bot, input, output, n) {
  const before = count(bot, output)
  const have = count(bot, input)
  n = Math.min(n, have)
  if (n <= 0) return 0
  const coal = () => bot.inventory.items().find(i => /^(coal|charcoal)$/.test(i.name))
  if (!coal() || count(bot, /^(coal|charcoal)$/) < Math.ceil(n / 8)) await charcoal(bot, Math.ceil(n / 8))
  const block = await getFurnace(bot)
  const f = await withTimeout(bot.openFurnace(block), 8000, 'furnace_open')
  try {
    const fuel = coal()
    if (!fuel) throw new StepError('need_fuel', 'sem carvão para fundir')
    await f.putFuel(fuel.type, null, Math.min(fuel.count, Math.ceil(n / 8)))
    await f.putInput(bot.registry.itemsByName[input].id, null, n)
    for (let i = 0; i < n * 12 + 10 && count(bot, output) - before < n; i++) {
      await sleep(1000)
      if (f.outputItem()?.count) await f.takeOutput().catch(() => {})
    }
  } finally { f.close() }
  log.info(`fornalha: ${output} +${count(bot, output) - before}`)
  return count(bot, output) - before
}

module.exports = { charcoal, torches, getFurnace, smelt }
