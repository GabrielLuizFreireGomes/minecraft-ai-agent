// Missão "empire": escala de esmeraldas com aldeões.
// Fase 1 kit → Fase 2 procriador automático montado em volta de 2 aldeões presos no lugar
// (sem transporte: na 26.2 o barco é controlado pelo cliente) → Fase 3 trocas (gravetos→flecheiros).
const { Vec3, count, has, LOGS, StepError, sleep } = require('../skills/util')
const gather = require('../skills/gather')
const craft = require('../skills/craft')
const smelt = require('../skills/smelt')
const farm = require('../skills/farm')
const build = require('../skills/build')
const survival = require('../skills/survival')
const villager = require('../skills/villager')
const nav = require('../skills/nav')
const memory = require('../memory')
const log = require('../log')
const emeralds = require('./emeralds')

const HALF = 4 // cercado 9x9 (interior 7x7)
const step = (id) => emeralds.steps.find(s => s.id === id)
const B = () => { memory.state.breeder = memory.state.breeder || {}; return memory.state.breeder }
const C = () => { const c = B().center; return c && new Vec3(c.x, c.y, c.z) }

const wool = (bot) => {
  const by = {}
  for (const i of bot.inventory.items()) if (/_wool$/.test(i.name)) by[i.name] = (by[i.name] || 0) + i.count
  return by
}
const beds = (bot) => count(bot, /_bed$/)

// O 9x9 em volta de c é construível? chão sem desnível grande, sem água e sem blocos de construção.
function siteOk (bot, c) {
  for (let dx = -HALF; dx <= HALF; dx++) {
    for (let dz = -HALF; dz <= HALF; dz++) {
      const sy = build.surfaceY(bot, c.x + dx, c.z + dz, c.y)
      if (sy === null || Math.abs(sy - c.y) > 2) return false
      for (let dy = -1; dy <= 3; dy++) {
        const b = bot.blockAt(new Vec3(c.x + dx, sy + dy, c.z + dz))
        if (!b) return false
        if (/water|lava/.test(b.name) || nav.PROTECTED.test(b.name)) return false
      }
    }
  }
  return true
}

// Planta do cercado: paredes até 2 acima do chão interno mais alto; portão no meio do lado norte.
function wallPlan (bot) {
  const c = C()
  let iy = c.y
  for (let dx = -HALF + 1; dx < HALF; dx++) for (let dz = -HALF + 1; dz < HALF; dz++) iy = Math.max(iy, build.surfaceY(bot, c.x + dx, c.z + dz, c.y) ?? c.y)
  const top = iy + 2
  const list = []
  for (let dx = -HALF; dx <= HALF; dx++) {
    for (let dz = -HALF; dz <= HALF; dz++) {
      if (Math.abs(dx) !== HALF && Math.abs(dz) !== HALF) continue
      const sy = build.surfaceY(bot, c.x + dx, c.z + dz, c.y) ?? c.y
      if (dx === 0 && dz === -HALF) continue // portão
      for (let y = sy + 1; y <= top; y++) list.push({ pos: new Vec3(c.x + dx, y, c.z + dz), want: 'wall' })
    }
  }
  return { list, top }
}

const gatePos = (bot) => { const c = C(); const sy = build.surfaceY(bot, c.x, c.z - HALF, c.y) ?? c.y; return new Vec3(c.x, sy + 1, c.z - HALF) }
const interior = (dx, dz, bot) => { const c = C(); const sy = build.surfaceY(bot, c.x + dx, c.z + dz, c.y) ?? c.y; return new Vec3(c.x + dx, sy + 1, c.z + dz) }
const inCell = (dx, dz) => (B().trapped || []).some(t => Math.abs(t.pos.x - (C().x + dx)) <= 1 && Math.abs(t.pos.z - (C().z + dz)) <= 1)
const popInside = (bot) => villager.villagers(bot, 24).filter(v => { const c = C(); return Math.abs(v.position.x - (c.x + 0.5)) < HALF && Math.abs(v.position.z - (c.z + 0.5)) < HALF }).length

// Armadura de ferro + escudo: sem armadura os mobs daqui (SolarisRPG) matam com 2 flechas, e o kit
// de diamante se perdeu num túmulo que expirou. Ferro custa 24 (armadura) + 1 (escudo).
const ARMOR = { helmet: 5, chestplate: 8, leggings: 7, boots: 4 }
const wearing = (bot, piece) => bot.inventory.slots.some(i => i && new RegExp(`_${piece}$`).test(i.name) && !/^(leather|golden|chainmail)_/.test(i.name))
const gearDone = (bot) => Object.keys(ARMOR).every(p => wearing(bot, p)) && bot.inventory.slots.some(i => i?.name === 'shield')
const ironGear = {
  id: 'iron_gear',
  desc: 'fazendo armadura de ferro e escudo',
  done: gearDone,
  run: async (bot, { signal }) => {
    const missing = Object.keys(ARMOR).filter(p => !wearing(bot, p))
    const needShield = !bot.inventory.slots.some(i => i?.name === 'shield')
    const ingots = missing.reduce((n, p) => n + ARMOR[p], 0) + (needShield ? 1 : 0)
    const raw = Math.max(0, ingots - count(bot, 'iron_ingot') - count(bot, 'raw_iron'))
    if (raw > 0) await require('../skills/ore').mine(bot, /^(deepslate_)?iron_ore$/, 'raw_iron', count(bot, 'raw_iron') + raw, signal)
    const coalNeed = Math.ceil(count(bot, 'raw_iron') / 8)
    if (count(bot, /^(coal|charcoal)$/) < coalNeed) {
      await require('../skills/ore').mine(bot, /^(deepslate_)?coal_ore$/, 'coal', coalNeed, signal).catch(e => log.info('carvão de minério:', e.message))
    }
    if (nav.underground(bot)) await nav.toSurface(bot, { signal }).catch(() => {})
    if (count(bot, 'raw_iron')) await smelt.smelt(bot, 'raw_iron', 'iron_ingot', count(bot, 'raw_iron'))
    for (const p of missing) if (count(bot, 'iron_ingot') >= ARMOR[p]) await craft.craftNamed(bot, `iron_${p}`)
    if (needShield && count(bot, 'iron_ingot') >= 1) { await craft.getTable(bot); await craft.ensurePlanks(bot, 6); await craft.craftNamed(bot, 'shield') }
    await bot.equipArmorNow?.()
    const shield = bot.inventory.items().find(i => i.name === 'shield')
    if (shield) await bot.equip(shield, 'off-hand').catch(() => {})
    if (gearDone(bot)) memory.history('armadura de ferro e escudo prontos')
  }
}

const steps = [
  step('stash'), step('restock'), step('kit'),
  step('wood'), step('wooden_pickaxe'), step('stone_tools'), ironGear,
  {
    id: 'b_materials',
    outdoor: true,
    desc: 'juntando material do procriador',
    done: (bot) => B().walls || (count(bot, build.GROUPS.wall) >= 140 && count(bot, LOGS) >= 6 && beds(bot) >= 3 &&
      has(bot, 'composter') && count(bot, /_fence_gate$/) >= 1 && count(bot, /_hoe$/) >= 1 && count(bot, 'torch') >= 6 && (count(bot, /^(carrot|potato)$/) >= 24 || B().noCrops)),
    run: async (bot, { signal }) => {
      const wood = () => craft.woodType(bot)
      const surface = async () => { if (nav.underground(bot)) await nav.toSurface(bot, { signal }) }
      if (count(bot, LOGS) < 16) { await surface(); await gather.logs(bot, 20, signal) }
      if (count(bot, build.GROUPS.wall) < 140) await gather.stone(bot, 150, signal)
      if (count(bot, 'torch') < 6) await smelt.torches(bot, 8)
      if (!count(bot, /_hoe$/)) { await craft.ensureSticks(bot, 2); await craft.craftNamed(bot, 'stone_hoe') }
      if (!has(bot, 'composter')) {
        await craft.ensurePlanks(bot, 6)
        if (count(bot, /_slab$/) < 7) await craft.craftNamed(bot, `${wood()}_slab`, 2)
        await craft.craftNamed(bot, 'composter')
      }
      if (!count(bot, /_fence_gate$/)) { await craft.ensureSticks(bot, 4); await craft.ensurePlanks(bot, 2); await craft.craftNamed(bot, `${wood()}_fence_gate`) }
      while (beds(bot) < 3) {
        const [color, n] = Object.entries(wool(bot)).sort((a, b) => b[1] - a[1])[0] || [null, 0]
        // mesa antes das tábuas: fazer a mesa depois gastava as 3 tábuas da cama (no_recipe por horas)
        if (n >= 3) { await craft.getTable(bot); await craft.ensurePlanks(bot, 3); await craft.craftNamed(bot, color.replace('_wool', '_bed')); continue }
        const need = 3 * (3 - beds(bot))
        await surface()
        await survival.hunt(bot, 0, signal, { prey: new Set(['sheep']), enough: () => Object.values(wool(bot)).some(x => x >= 3) || Object.values(wool(bot)).reduce((a, b) => a + b, 0) >= need + 6 })
      }
      if (count(bot, /^(carrot|potato)$/) < 24 && !B().noCrops) {
        await surface()
        await farm.harvest(bot, { target: 30, signal }).catch(e => { if (e.code === 'not_found') { B().noCrops = true; memory.save() } else throw e })
      }
    }
  },
  {
    id: 'b_site',
    outdoor: true,
    desc: 'procurando 2 aldeões num lugar bom',
    done: () => !!B().center,
    run: async (bot, { signal }) => {
      const s = memory.state
      s.explore = s.explore || { angle: Math.floor(Math.random() * 360), legs: 0 }
      for (let leg = 0; leg < 6; leg++) {
        for (const [a, b] of villager.pairs(bot, 3.5, 80)) {
          const mid = a.position.plus(b.position).scaled(0.5).floored()
          const c = new Vec3(mid.x, build.surfaceY(bot, mid.x, mid.z, mid.y) ?? mid.y - 1, mid.z)
          if (!siteOk(bot, c)) continue
          B().center = { x: c.x, y: c.y, z: c.z }
          B().targets = [a.uuid || a.id, b.uuid || b.id]
          memory.save(true)
          memory.addPlace('procriador (planejado)', c, bot.game.dimension, 'cercado 9x9 em volta de 2 aldeões')
          return
        }
        // vai para aldeias conhecidas primeiro, depois explora
        const known = s.places.filter(p => p.name === 'aldeia' && !p.noPair && bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z)) > 40)
        if (known.length) {
          const v = known[0]
          await nav.goto(bot, nav.nearXZ(v.x, v.z, 6), { timeout: 300000, signal }).catch(() => {})
          if (!villager.pairs(bot, 3.5, 80).length) { v.noPair = true; memory.save() }
          continue
        }
        if (s.explore.legs % 5 === 4) s.explore.angle = (s.explore.angle + 72) % 360
        s.explore.legs++
        memory.save()
        await nav.wander(bot, 96, s.explore.angle, { signal }).catch(e => { if (e.code === 'aborted') throw e })
        const found = villager.villageHere(bot)
        if (found) memory.addPlace('aldeia', found, bot.game.dimension, `${villager.villagers(bot, 80).length} aldeões`)
      }
      throw new StepError('searching', 'ainda procurando par de aldeões')
    }
  },
  {
    id: 'b_trap',
    desc: 'prendendo 2 aldeões',
    done: () => (B().trapped || []).length >= 2,
    run: async (bot) => {
      const c = C()
      await nav.goto(bot, nav.near(c, 3), { timeout: 120000 })
      const trapped = B().trapped = B().trapped || []
      const start = Date.now()
      while (trapped.length < 2) {
        // qualquer aldeão dentro do interior planejado serve
        const v = villager.villagers(bot, 24).find(x => Math.abs(x.position.x - (c.x + 0.5)) < HALF - 0.5 && Math.abs(x.position.z - (c.z + 0.5)) < HALF - 0.5 &&
          !trapped.some(t => t.id === (x.uuid || x.id)))
        if (!v) {
          if (Date.now() - start > 10 * 60000) {
            // ninguém veio: solta quem foi preso e escolhe outro lugar
            for (const t of trapped) for (const p of t.cells) { const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); if (b && build.GROUPS.wall.test(b.name)) await bot.dig(b).catch(() => {}) }
            memory.state.breeder = {}
            memory.save(true)
            throw new StepError('no_villager', 'aldeões saíram do lugar; vou escolher outro')
          }
          await sleep(3000)
          continue
        }
        const t = await villager.trap(bot, v)
        trapped.push({ id: v.uuid || v.id, pos: { x: t.pos.x, y: t.pos.y, z: t.pos.z }, cells: t.cells.map(p => ({ x: p.x, y: p.y, z: p.z })) })
        memory.save(true)
        memory.history(`aldeão preso em ${t.pos.x} ${t.pos.y} ${t.pos.z} para o procriador`)
      }
    }
  },
  {
    id: 'b_walls',
    outdoor: true,
    desc: 'erguendo o cercado do procriador',
    done: () => !!B().walls,
    run: async (bot, { signal }) => {
      const { list } = wallPlan(bot)
      const miss = build.missing(bot, list)
      if (miss.wall) await gather.stone(bot, count(bot, build.GROUPS.wall) + miss.wall + 8, signal)
      await build.buildList(bot, list, { signal, label: 'cercado' })
      B().walls = true
      memory.save(true)
      memory.history('cercado do procriador pronto (falta mobiliar)')
    }
  },
  {
    id: 'b_furnish',
    desc: 'mobiliando o procriador',
    done: () => !!B().furnished,
    run: async (bot) => {
      const c = C()
      // entra pelo vão do portão
      await nav.goto(bot, nav.near(interior(0, -HALF + 1, bot), 0), { timeout: 60000 })
      // camas no lado norte, cabeceira para o norte (yaw 0 = norte no mineflayer)
      const bedXs = [-3, -2, -1, 1, 2, 3].filter(dx => !inCell(dx, -2) && !inCell(dx, -3))
      let placed = 0
      for (const dx of bedXs) {
        if (placed >= 3 || !beds(bot)) break
        const foot = interior(dx, -2, bot)
        const head = interior(dx, -3, bot)
        if (foot.y !== head.y) continue
        await build.placeAt(bot, foot, bot.inventory.items().find(i => /_bed$/.test(i.name)).name, { yaw: 0 }).then(() => placed++).catch(e => log.warn('cama', e.message))
      }
      // plantação 3x3 no canto sudeste + composteira ao lado (estação do fazendeiro)
      const plot = []
      for (let dx = 1; dx <= 3; dx++) for (let dz = 1; dz <= 3; dz++) if (!inCell(dx, dz)) plot.push(interior(dx, dz, bot).offset(0, -1, 0))
      if (count(bot, /^(carrot|potato)$/)) await farm.tillAndPlant(bot, plot)
      const comp = [interior(0, 2, bot), interior(-1, 2, bot), interior(0, 3, bot)].find(p => !inCell(p.x - c.x, p.z - c.z))
      if (comp && has(bot, 'composter')) await build.placeAt(bot, comp, 'composter').catch(e => log.warn('composteira', e.message))
      // tochas no topo dos cantos (evita mobs nascendo dentro)
      const { top } = wallPlan(bot)
      for (const [dx, dz] of [[-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]]) {
        await build.placeAt(bot, new Vec3(c.x + dx, top + 1, c.z + dz), 'torch').catch(e => log.warn('tocha', e.message))
      }
      // solta os aldeões das celas
      for (const t of B().trapped || []) {
        for (const p of t.cells) { const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); if (b && build.GROUPS.wall.test(b.name)) await bot.dig(b).catch(() => {}) }
      }
      // comida para ficarem dispostos a procriar
      for (const v of villager.villagers(bot, 10)) await villager.feed(bot, v, 12)
      // sai e fecha com o portão
      const outside = new Vec3(c.x, gatePos(bot).y, c.z - HALF - 2)
      await nav.goto(bot, nav.near(outside, 0), { timeout: 30000 })
      const gate = bot.inventory.items().find(i => /_fence_gate$/.test(i.name))
      if (gate) await build.placeAt(bot, gatePos(bot), gate.name, { yaw: 0 })
      B().furnished = true
      memory.save(true)
      memory.addPlace('procriador de aldeões', c, bot.game.dimension, '9x9, 3 camas, composteira, plantação; portão ao norte')
      memory.history(`procriador pronto em ${c.x} ${c.y} ${c.z} com ${popInside(bot)} aldeões`)
      memory.knowledge('Mecânicas', 'procriador: aldeão procria com cama livre + 12 cenouras/batatas (ou 3 pães); fazendeiro na composteira colhe e reparte comida')
    }
  },
  {
    id: 'b_tend',
    outdoor: true,
    desc: 'cuidando do procriador',
    done: () => !B().furnished || Date.now() - (B().lastTend || 0) < 15 * 60000,
    run: async (bot, { signal }) => {
      const c = C()
      await nav.goto(bot, nav.near(new Vec3(c.x, c.y, c.z - HALF - 2), 1), { timeout: 300000, signal })
      const pop = popInside(bot)
      const prev = B().population || 0
      B().population = pop
      B().lastTend = Date.now()
      memory.save()
      if (pop !== prev) memory.history(`procriador: ${pop} aldeões (antes ${prev})`)
      // reforça comida enquanto a plantação não sustenta
      if (count(bot, /^(carrot|potato|bread)$/) < 12 && !B().noCrops) await farm.harvest(bot, { target: 24, signal }).catch(() => {})
      if (count(bot, /^(carrot|potato|bread)$/) >= 6) {
        await bot.lookAt(new Vec3(c.x + 0.5, c.y + 3, c.z + 0.5), true)
        const food = bot.inventory.items().find(i => /^(carrot|potato|bread)$/.test(i.name))
        await bot.toss(food.type, null, Math.min(12, food.count)).catch(() => {})
      }
    }
  },
  // Fase 3: renda imediata enquanto o procriador cresce (gravetos → flecheiros)
  step('find_village'), step('go_village'), step('base'), step('fletcher'), step('trade_loop')
]

module.exports = {
  ironGear,
  name: 'empire',
  title: 'império de esmeraldas (procriador de aldeões → trocas)',
  steps
}
