// Colheita de plantações maduras (replanta) e preparo de terra arada com plantio.
const { Vec3, sleep, count, StepError } = require('./util')
const nav = require('./nav')
const log = require('../log')

const CROPS = { carrots: 'carrot', potatoes: 'potato', wheat: 'wheat_seeds', beetroots: 'beetroot_seeds' }
const mature = (b) => { try { return b.getProperties().age >= (b.name === 'beetroots' ? 3 : 7) } catch { return false } }

// Colhe até ter `target` itens (cenoura/batata/trigo) de plantações maduras por perto e replanta.
async function harvest (bot, { target, itemTest = /^(carrot|potato)$/, maxDistance = 64, signal } = {}) {
  const ids = Object.keys(CROPS).map(n => bot.registry.blocksByName[n]?.id).filter(Boolean)
  let misses = 0
  while (count(bot, itemTest) < target) {
    if (signal?.aborted) throw new StepError('aborted')
    const spots = bot.findBlocks({ matching: ids, maxDistance, count: 64 }).map(p => bot.blockAt(p)).filter(b => b && mature(b))
    if (!spots.length) { if (++misses > 1) throw new StepError('not_found', 'sem plantação madura por perto'); await sleep(2000); continue }
    for (const b of spots.slice(0, 12)) {
      await nav.goto(bot, nav.near(b.position, 2), { timeout: 20000, signal }).catch(() => {})
      const cur = bot.blockAt(b.position)
      if (!cur || !mature(cur)) continue
      await bot.dig(cur).catch(() => {})
      await sleep(250)
      await nav.goto(bot, nav.near(b.position, 0), { timeout: 5000 }).catch(() => {})
      await replant(bot, b.position, CROPS[b.name])
      if (count(bot, itemTest) >= target) break
    }
  }
}

async function replant (bot, pos, seed) {
  const soil = bot.blockAt(pos.offset(0, -1, 0))
  const s = bot.inventory.items().find(i => i.name === seed)
  if (!soil || soil.name !== 'farmland' || !s) return
  try { await bot.equip(s, 'hand'); await bot.activateBlock(soil, new Vec3(0, 1, 0)) } catch {}
}

// Ara e planta um conjunto de posições de chão (grama/terra) com cenoura/batata.
async function tillAndPlant (bot, floors) {
  const hoe = bot.inventory.items().find(i => /_hoe$/.test(i.name))
  if (!hoe) throw new StepError('missing_item', 'sem enxada')
  for (const p of floors) {
    const b = bot.blockAt(p)
    if (!b) continue
    await nav.goto(bot, nav.near(p, 2), { timeout: 15000 }).catch(() => {})
    if (/^(grass_block|dirt|dirt_path|coarse_dirt)$/.test(b.name)) {
      await bot.equip(hoe, 'hand')
      await bot.activateBlock(b, new Vec3(0, 1, 0)).catch(() => {})
      await sleep(200)
    }
    const seed = bot.inventory.items().find(i => /^(carrot|potato)$/.test(i.name))
    if (seed && bot.blockAt(p)?.name === 'farmland') {
      await bot.equip(seed, 'hand')
      await bot.activateBlock(bot.blockAt(p), new Vec3(0, 1, 0)).catch(() => {})
      await sleep(150)
    }
  }
  log.info(`farm: ${floors.length} canteiros preparados`)
}

module.exports = { harvest, tillAndPlant, mature }
