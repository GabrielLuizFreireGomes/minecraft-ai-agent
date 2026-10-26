// Minério específico (ferro, carvão): procura veio visível em 24 blocos e vai até ele (pathfinder ou
// escada cavada); sem veio à vista, avança o túnel de mineração e procura de novo.
const { sleep, count, StepError } = require('./util')
const nav = require('./nav')
const gather = require('./gather')
const log = require('../log')

const LIQUID = /water|lava/
const wet = (bot, p) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => LIQUID.test(bot.blockAt(p.offset(x, y, z))?.name || ''))

async function mine (bot, oreRe, drop, target, signal) {
  const ids = bot.registry.blocksArray.filter(b => oreRe.test(b.name)).map(b => b.id)
  const bad = new Set()
  const start = Date.now()
  while (count(bot, drop) < target) {
    if (signal?.aborted) throw new StepError('aborted')
    if (Date.now() - start > 15 * 60000) throw new StepError('timeout', `${drop}: ${count(bot, drop)}/${target} em 15 min`)
    const spots = bot.findBlocks({ matching: ids, maxDistance: 24, count: 16 }).filter(p => !bad.has(p.toString()) && !wet(bot, p))
    if (!spots.length) {
      // nada à vista: avança uns 12 blocos de túnel (desce até a pedra se estiver na superfície)
      await gather.stone(bot, count(bot, /^(cobblestone|cobbled_deepslate)$/) + 12, signal).catch(e => { if (e.code === 'aborted') throw e })
      continue
    }
    const p = spots[0]
    const center = p.offset(0.5, 0.5, 0.5)
    if (bot.entity.position.offset(0, 1.6, 0).distanceTo(center) > 4.2) {
      await nav.goto(bot, new nav.goals.GoalLookAtBlock(p, bot.world, { reach: 4 }), { timeout: 30000, signal }).catch(e => { if (e.code === 'aborted') throw e })
      if (bot.entity.position.offset(0, 1.6, 0).distanceTo(center) > 4.2) await nav.digTo(bot, center, { reach: 3, signal }).catch(() => {})
    }
    const b = bot.blockAt(p)
    if (!b || !ids.includes(b.type) || bot.entity.position.offset(0, 1.6, 0).distanceTo(center) > 4.6) { bad.add(p.toString()); continue }
    await bot.tool.equipForBlock(b, { requireHarvest: true }).catch(() => {})
    await bot.dig(b).catch(() => bad.add(p.toString()))
    await sleep(300)
    // pega o que caiu
    for (const it of Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(center) < 5)) {
      await nav.goto(bot, nav.near(it.position, 0), { timeout: 6000, signal }).catch(() => {})
    }
    log.info(`minério: ${drop} ${count(bot, drop)}/${target}`)
  }
}

module.exports = { mine }
