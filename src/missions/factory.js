// Missão "fábrica de esmeraldas": tudo gira em torno de uma casa segura perto da base.
// Antes (procriador longe, 64 tentativas de juntar material, 28 mortes em 3 dias a ~280 blocos da base)
// o bot rodava o mapa e perdia o equipamento a cada morte. Agora: casa fechada e iluminada com cama
// (dorme e renasce lá), baú com reserva, e só depois fazendas e trocas, sempre perto de casa.
const { Vec3, count, has, LOGS, StepError, sleep } = require('../skills/util')
const gather = require('../skills/gather')
const craft = require('../skills/craft')
const smelt = require('../skills/smelt')
const build = require('../skills/build')
const survival = require('../skills/survival')
const nav = require('../skills/nav')
const commands = require('../commands')
const memory = require('../memory')
const log = require('../log')
const emeralds = require('./emeralds')
const { ironGear } = require('./empire')

const step = (id) => emeralds.steps.find(s => s.id === id)
const H = () => memory.state.home || {}
const W = 7 // interior 7x7; paredes em -1 e 7
const OWNER_HOUSE = { x: 2200, z: 788 } // casa do dono (spawn): nunca construir perto
const WOOL = /_wool$/

// ---- planta da casa (relativa à origem O = canto interior noroeste, y = chão)
const at = (dx, dy, dz) => { const h = H(); return new Vec3(h.x + dx, h.y + dy, h.z + dz) }
const door = { dx: 3, dz: W } // porta na parede sul
function wallPlan () {
  const list = []
  for (let dy = 1; dy <= 3; dy++) {
    for (let dx = -1; dx <= W; dx++) {
      for (let dz = -1; dz <= W; dz++) {
        const edge = dx === -1 || dx === W || dz === -1 || dz === W
        if (!edge) continue
        if (dx === door.dx && dz === door.dz && dy <= 2) continue
        list.push({ pos: at(dx, dy, dz), want: 'wall' })
      }
    }
  }
  return list
}
// teto de fora pra dentro (cada bloco encosta num já colocado)
function roofPlan () {
  const list = []
  for (let ring = 0; ring <= Math.ceil((W + 1) / 2); ring++) {
    for (let dx = -1 + ring; dx <= W - ring; dx++) {
      for (let dz = -1 + ring; dz <= W - ring; dz++) {
        const onRing = dx === -1 + ring || dx === W - ring || dz === -1 + ring || dz === W - ring
        if (onRing) list.push({ pos: at(dx, 4, dz), want: 'wall' })
      }
    }
  }
  return list
}
const torchesInside = () => [[0, 0], [0, W - 1], [W - 1, W - 1], [3, 3], [W - 1, 5]].map(([x, z]) => ({ pos: at(x, 1, z), want: 'torch' }))
function torchesOutside (bot) {
  const out = []
  for (let d = -5; d <= W + 4; d += 4) {
    for (const [x, z] of [[d, -5], [d, W + 4], [-5, d], [W + 4, d]]) {
      const h = H()
      const sy = build.surfaceY(bot, h.x + x, h.z + z, h.y)
      if (sy === null) continue
      if (x >= W + 1 && x <= W + 12 && z >= -2 && z <= W + 2) continue // lote da fazenda
      out.push({ pos: new Vec3(h.x + x, sy + 1, h.z + z), want: 'torch' })
    }
  }
  return out
}

const built = (bot, list) => list.every(t => { const b = bot.blockAt(t.pos); return b && (build.GROUPS[t.want] ? build.GROUPS[t.want].test(b.name) : b.name === t.want || b.name.includes(t.want)) })
const homeNear = (bot, r = 48) => H().x !== undefined && bot.entity.position.distanceTo(at(3, 1, 3)) < r

// ---- escolha do terreno: plano, seco, sem construção, perto da base e longe da casa do dono
function scoreSite (bot, ox, oz, hint) {
  const hs = []
  for (let dx = -1; dx <= W; dx++) {
    for (let dz = -1; dz <= W; dz++) {
      const y = build.surfaceY(bot, ox + dx, oz + dz, hint)
      if (y === null) return null
      const top = bot.blockAt(new Vec3(ox + dx, y, oz + dz))
      if (!top || /water|lava|ice/.test(top.name) || nav.PROTECTED.test(top.name)) return null
      for (let up = 1; up <= 5; up++) {
        const b = bot.blockAt(new Vec3(ox + dx, y + up, oz + dz))
        if (b && (/water|lava/.test(b.name) || (!build.NATURAL.test(b.name) && !build.REPLACEABLE.test(b.name)))) return null
      }
      hs.push(y)
    }
  }
  hs.sort((a, b) => a - b)
  const floor = hs[Math.floor(hs.length / 2)]
  if (hs[hs.length - 1] - hs[0] > 4) return null
  // lote da fazenda a leste (x de W+1 até W+11): sem água nem construção, desnível até 5
  let rough = 0
  for (let dx = W + 1; dx <= W + 12; dx++) {
    for (let dz = -2; dz <= W + 2; dz++) {
      const y = build.surfaceY(bot, ox + dx, oz + dz, floor)
      if (y === null || Math.abs(y - floor) > 5) return null
      const top = bot.blockAt(new Vec3(ox + dx, y, oz + dz))
      if (!top || /water|lava/.test(top.name) || nav.PROTECTED.test(top.name)) return null
      rough += Math.abs(y - floor) / 4
    }
  }
  rough += hs.reduce((n, y) => n + Math.abs(y - floor), 0)
  return { y: floor, rough }
}

const hSite = {
  id: 'h_site',
  desc: 'escolhendo terreno pra casa',
  done: () => H().x !== undefined,
  run: async (bot, { signal }) => {
    const base = memory.state.base || { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
    const center = new Vec3(base.x, base.y, base.z)
    if (bot.entity.position.distanceTo(center) > 40) {
      await commands.tryHome(bot).catch(() => false)
      await nav.goto(bot, nav.nearXZ(center.x, center.z, 6), { timeout: 180000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    }
    await bot.waitForChunksToLoad().catch(() => {})
    let best = null
    for (let r = 8; r <= 56; r += 4) {
      for (let a = 0; a < 360; a += 20) {
        const ox = Math.round(center.x + Math.cos(a * Math.PI / 180) * r)
        const oz = Math.round(center.z + Math.sin(a * Math.PI / 180) * r)
        if (Math.hypot(ox + 3 - OWNER_HOUSE.x, oz + 3 - OWNER_HOUSE.z) < 22 || Math.hypot(ox + 14 - OWNER_HOUSE.x, oz + 3 - OWNER_HOUSE.z) < 20) continue
        const sc = scoreSite(bot, ox, oz, base.y)
        if (!sc) continue
        const score = sc.rough + r / 8
        if (!best || score < best.score) best = { x: ox, y: sc.y, z: oz, score }
      }
      if (best && best.score < 12) break
    }
    if (!best) throw new StepError('no_site', 'sem terreno plano perto da base')
    memory.state.home = { x: best.x, y: best.y, z: best.z, w: W }
    memory.save(true)
    memory.addPlace('casa do bot (canto)', new Vec3(best.x, best.y, best.z), bot.game.dimension, `casa ${W}x${W} — terreno nota ${best.score.toFixed(1)}`)
    memory.decision(`casa do bot em ${best.x} ${best.y} ${best.z} (plana, perto da base, longe da casa do dono)`)
    log.info(`casa: terreno em ${best.x} ${best.y} ${best.z} (nota ${best.score.toFixed(1)})`)
  }
}

// ---- material: pedra (paredes+teto ~180), madeira, tochas, cama, baús, porta
const NEED = { wall: 200, logs: 10, torch: 24 }
const doorName = (bot) => `${craft.woodType(bot) || 'oak'}_door`
const hMaterials = {
  id: 'h_materials',
  desc: 'juntando material da casa',
  // casa já levantada: só falta o que vai dentro (antes pedia 200 pedras de novo e voltava a minerar)
  done: (bot) => H().built || (H().shell && count(bot, 'torch') >= 5 && count(bot, /_bed$/) >= 1 && count(bot, 'chest') >= 2 && count(bot, /_door$/) >= 1) || (count(bot, build.GROUPS.wall) >= NEED.wall && count(bot, LOGS) + count(bot, /_planks$/) / 4 >= 4 &&
    count(bot, 'torch') >= NEED.torch && count(bot, /_bed$/) >= 1 && count(bot, 'chest') >= 2 && count(bot, /_door$/) >= 1 && count(bot, 'furnace') + (has(bot, 'crafting_table') ? 1 : 0) >= 1),
  run: async (bot, { signal }) => {
    if (!homeNear(bot, 80)) await nav.goto(bot, nav.nearXZ(at(3, 1, 3).x, at(3, 1, 3).z, 8), { timeout: 240000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    if (count(bot, LOGS) < NEED.logs) await gather.logs(bot, NEED.logs, signal)
    if (!H().shell && count(bot, build.GROUPS.wall) < NEED.wall) await gather.stone(bot, NEED.wall, signal)
    if (count(bot, 'torch') < NEED.torch) await smelt.torches(bot, NEED.torch)
    if (!count(bot, 'chest')) await craft.craft(bot, 'chest', 1)
    if (count(bot, 'chest') < 2) await craft.craft(bot, 'chest', 1)
    if (!count(bot, /_door$/)) { await craft.getTable(bot); await craft.ensurePlanks(bot, 6); await craft.craftNamed(bot, doorName(bot)) }
    if (!count(bot, 'furnace')) await craft.craft(bot, 'furnace', 1)
    if (!count(bot, /_bed$/)) {
      const wool = () => Object.entries(bot.inventory.items().filter(i => WOOL.test(i.name)).reduce((o, i) => ({ ...o, [i.name]: (o[i.name] || 0) + i.count }), {})).sort((a, b) => b[1] - a[1])[0]
      if (!wool() || wool()[1] < 3) await survival.hunt(bot, 0, signal, { prey: new Set(['sheep']), enough: () => (wool()?.[1] || 0) >= 3 })
      await craft.getTable(bot)
      await craft.ensurePlanks(bot, 3)
      await craft.craftNamed(bot, wool()[0].replace('_wool', '_bed'))
    }
  }
}

// ---- obra: limpa e nivela, paredes, teto
const hBuild = {
  id: 'h_build',
  desc: 'construindo a casa',
  done: (bot) => H().built || H().shell || (homeNear(bot, 64) && built(bot, wallPlan()) && built(bot, roofPlan())),
  run: async (bot, { signal }) => {
    await nav.goto(bot, nav.near(at(3, 1, 3), 2), { timeout: 240000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    // limpa o volume (só natural: grama, folha, tronco, terra acima do chão)
    for (let dy = 1; dy <= 5; dy++) {
      for (let dx = -1; dx <= W; dx++) {
        for (let dz = -1; dz <= W; dz++) {
          if (signal?.aborted) throw new StepError('aborted')
          const p = at(dx, dy, dz)
          const b = bot.blockAt(p)
          if (b && !build.REPLACEABLE.test(b.name)) await build.clearAt(bot, p).catch(e => log.warn('casa limpar', e.message))
        }
      }
    }
    // chão: preenche buracos no nível do piso
    const floor = []
    for (let dx = -1; dx <= W; dx++) for (let dz = -1; dz <= W; dz++) floor.push({ pos: at(dx, 0, dz), want: 'support' })
    await build.buildList(bot, floor.filter(t => !build.SOLID_FLOOR(bot.blockAt(t.pos))), { signal, label: 'casa: piso' })
    await build.buildList(bot, wallPlan(), { signal, label: 'casa: paredes' })
    // tocha dentro já com as paredes de pé: casa escura e sem porta deixou um creeper nascer lá dentro (−24)
    if (count(bot, 'torch') >= 5) await build.buildList(bot, torchesInside(), { signal, label: 'casa: tochas dentro' }).catch(e => log.warn('tochas dentro', e.message))
    // teto: anda até o meio da sala antes (alcance pro centro), de fora pra dentro
    await nav.goto(bot, nav.near(at(3, 1, 3), 1), { timeout: 30000, signal }).catch(() => {})
    await build.buildList(bot, roofPlan(), { signal, label: 'casa: teto', ordered: true })
    if (built(bot, wallPlan()) && built(bot, roofPlan())) { memory.state.home.shell = true; memory.save(true) }
  }
}

// ---- mobília: tochas, porta, cama, baús, mesa, fornalha
const furnishPlan = (bot) => [
  ...torchesInside(),
  { pos: at(5, 1, 0), want: 'chest' }, { pos: at(6, 1, 0), want: 'chest' },
  { pos: at(W - 1, 1, 2), want: 'crafting_table' }, { pos: at(W - 1, 1, 3), want: 'furnace' }
]
const bedPos = () => at(1, 1, 2) // pé da cama; cabeceira ao norte (1,1,1)
const hFurnish = {
  id: 'h_furnish',
  desc: 'mobiliando a casa (cama, baús, tochas, porta)',
  done: (bot) => H().built,
  run: async (bot, { signal }) => {
    await nav.goto(bot, nav.near(at(3, 1, 3), 1), { timeout: 120000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    // conserta parede/teto (explosão de creeper abriu buraco) antes de mobiliar
    const holes = [...wallPlan(), ...roofPlan()].filter(t => !built(bot, [t])).length
    if (holes) {
      log.info(`casa: ${holes} buracos pra consertar`)
      if (count(bot, build.GROUPS.wall) < holes + 4) await gather.stone(bot, holes + 8, signal)
      await build.buildList(bot, wallPlan(), { signal, label: 'casa: conserto paredes' })
      await build.buildList(bot, roofPlan(), { signal, label: 'casa: conserto teto', ordered: true })
    }
    if (count(bot, 'torch') < 6) await smelt.torches(bot, 8)
    if (!count(bot, 'crafting_table') && !bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 12 })) await craft.craft(bot, 'crafting_table', 1)
    for (const t of furnishPlan(bot)) {
      if (!count(bot, t.want) && !built(bot, [t])) continue
      await build.placeAt(bot, t.pos, t.want).catch(e => log.warn('mobília', e.message))
    }
    const bed = bot.inventory.items().find(i => /_bed$/.test(i.name))
    if (bed && !/_bed$/.test(bot.blockAt(bedPos())?.name || '')) await build.placeAt(bot, bedPos(), bed.name, { yaw: 0 }).catch(e => log.warn('cama', e.message))
    const d = bot.inventory.items().find(i => /_door$/.test(i.name))
    if (d) await build.placeAt(bot, at(door.dx, 1, door.dz), d.name).catch(e => log.warn('porta', e.message))
    // cama e baús da casa viram a base (respawn, depósito, /home)
    const chest = at(5, 1, 0)
    if (/chest/.test(bot.blockAt(chest)?.name || '')) {
      memory.state.base = { x: chest.x, y: chest.y, z: chest.z, dim: bot.game.dimension, chest: { x: chest.x, y: chest.y, z: chest.z } }
    }
    const bedBlock = bot.blockAt(bedPos())
    if (/_bed$/.test(bedBlock?.name || '')) {
      memory.state.home.bed = { x: bedBlock.position.x, y: bedBlock.position.y, z: bedBlock.position.z }
    }
    await nav.goto(bot, nav.near(at(3, 1, 4), 1), { timeout: 20000 }).catch(() => {})
    await commands.run(bot, '/sethome base').catch(() => {})
    memory.state.home.built = !!memory.state.home.bed
    memory.save(true)
    if (memory.state.home.built) memory.history(`casa pronta em ${H().x} ${H().y} ${H().z}: cama, baús, tochas, porta; /home base aponta pra ela`)
  }
}

// ---- iluminação em volta (mob não nasce perto da casa)
const hLight = {
  id: 'h_light',
  desc: 'iluminando em volta da casa',
  done: (bot) => H().lit,
  run: async (bot, { signal }) => {
    const list = torchesOutside(bot)
    if (count(bot, 'torch') < list.length) await smelt.torches(bot, list.length + 4)
    await build.buildList(bot, list, { signal, label: 'casa: tochas fora' })
    memory.state.home.lit = true
    memory.save()
  }
}

// ---- guarda reserva no baú da casa (morreu: renasce na cama e se equipa)
const hSpare = {
  id: 'h_spare',
  desc: 'guardando reserva no baú de casa',
  done: () => H().spare,
  run: async (bot) => {
    const st = require('../skills/storage')
    // reserva: só o que não se usa toda hora (tronco e pedra ficam com ele; guardar tudo travou o balde)
    await st.deposit(bot, /^(iron_ingot|raw_iron|golden_carrot|diamond|emerald)$/, 0).catch(e => log.warn('reserva', e.message))
    memory.state.home.spare = true
    memory.save()
  }
}

// ================= fase 2: fazenda de trigo colada na casa + venda pro fazendeiro =================
// Fazendeiro da aldeia ao lado compra trigo (20 = 1 esmeralda, 16 usos por reposição). Trigo também
// vira pão (comida). Lote 9x9 a leste da casa, água no centro, muro de pedra 2 de altura, tochas.
const F = () => { const h = H(); return { x: h.x + W + 2, y: h.y, z: h.z - 1 } }
const fat = (dx, dy, dz) => { const f = F(); return new Vec3(f.x + dx, f.y + dy, f.z + dz) }
const FS = 9
const isCenter = (dx, dz) => dx === 4 && dz === 4
const farmCells = () => { const out = []; for (let dx = 0; dx < FS; dx++) for (let dz = 0; dz < FS; dz++) if (!isCenter(dx, dz)) out.push([dx, dz]); return out }
const gateAt = () => fat(-1, 1, 4) // lado da casa
function farmWall () {
  const list = []
  for (let dy = 1; dy <= 2; dy++) {
    for (let dx = -1; dx <= FS; dx++) {
      for (let dz = -1; dz <= FS; dz++) {
        if (!(dx === -1 || dx === FS || dz === -1 || dz === FS)) continue
        if (dx === -1 && dz === 4) continue // portão
        list.push({ pos: fat(dx, dy, dz), want: 'wall' })
      }
    }
  }
  return list
}
const farmTorches = () => [[-1, -1], [FS, -1], [-1, FS], [FS, FS], [4, -1], [4, FS], [FS, 4]].map(([x, z]) => ({ pos: fat(x, 3, z), want: 'torch' }))

const fBucket = {
  id: 'f_bucket',
  desc: 'fazendo balde (água da fazenda)',
  done: (bot) => memory.state.farm?.water || has(bot, 'bucket') || has(bot, 'water_bucket'),
  run: async (bot, { signal }) => {
    // madeira primeiro: mesa/fornalha/balde precisam de tábua
    if (count(bot, LOGS) < 2 && count(bot, /_planks$/) < 8) await require('../skills/storage').take(bot, LOGS, 8)
    if (count(bot, LOGS) < 2 && count(bot, /_planks$/) < 8) await gather.logs(bot, 6, signal)
    if (count(bot, 'iron_ingot') < 3) {
      if (count(bot, 'raw_iron') < 3) await require('../skills/ore').mine(bot, /^(deepslate_)?iron_ore$/, 'raw_iron', 3, signal)
      await smelt.smelt(bot, 'raw_iron', 'iron_ingot', count(bot, 'raw_iron'))
    }
    if (!count(bot, LOGS) && count(bot, /_planks$/) < 4) await require('../skills/storage').take(bot, LOGS, 8)
    if (!count(bot, LOGS) && count(bot, /_planks$/) < 4) await gather.logs(bot, 6, signal)
    await craft.getTable(bot)
    await craft.craftNamed(bot, 'bucket')
  }
}

const fSeeds = {
  id: 'f_seeds',
  desc: 'juntando sementes (quebrando mato)',
  done: (bot) => memory.state.farm?.planted || count(bot, 'wheat_seeds') >= 24,
  run: async (bot, { signal }) => {
    const ids = ['short_grass', 'tall_grass', 'fern'].map(n => bot.registry.blocksByName[n]?.id).filter(Boolean)
    for (let round = 0; round < 6 && count(bot, 'wheat_seeds') < 24; round++) {
      const spots = bot.findBlocks({ matching: ids, maxDistance: 40, count: 40 })
      if (!spots.length) { await nav.wander(bot, 40, nav.exploreAngle(bot), { signal }).catch(e => { if (e.code === 'aborted') throw e }); continue }
      for (const p of spots) {
        if (signal?.aborted) throw new StepError('aborted')
        if (count(bot, 'wheat_seeds') >= 24) break
        const b = bot.blockAt(p)
        if (!b || !ids.includes(b.type)) continue
        await nav.goto(bot, new nav.goals.GoalLookAtBlock(p, bot.world, { reach: 4 }), { timeout: 15000, signal }).catch(() => {})
        await bot.dig(b).catch(() => {})
      }
      for (const it of Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 12)) {
        await nav.goto(bot, nav.near(it.position, 0), { timeout: 6000, signal }).catch(() => {})
      }
      log.info(`sementes: ${count(bot, 'wheat_seeds')}`)
    }
    if (count(bot, 'wheat_seeds') < 8) throw new StepError('few_seeds', `só ${count(bot, 'wheat_seeds')} sementes`)
  }
}

// enche o balde no bloco de água-fonte mais perto
async function fillBucket (bot, signal) {
  if (has(bot, 'water_bucket')) return
  // várias fontes, da mais perto pra mais longe; chega perto com alvo simples antes de mirar
  const ids = [bot.registry.blocksByName.water.id]
  const spots = bot.findBlocks({ matching: ids, maxDistance: 96, count: 40, useExtraInfo: b => b.metadata === 0 && bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air' }).slice(0, 5)
  if (!spots.length) throw new StepError('no_water', 'sem água por perto pro balde')
  for (const p of spots) {
    if (signal?.aborted) throw new StepError('aborted')
    // perto primeiro (alvo simples), depois visada direta do bloco: no barranco acima da água o raio batia na grama
    await nav.goto(bot, nav.nearXZ(p.x, p.z, 5), { timeout: 90000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    await nav.goto(bot, new nav.goals.GoalLookAtBlock(p, bot.world, { reach: 4 }), { timeout: 30000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    if (bot.entity.position.offset(0, 1.6, 0).distanceTo(p.offset(0.5, 1, 0.5)) > 4.5) continue
    await bot.equip(bot.inventory.items().find(i => i.name === 'bucket'), 'hand')
    for (let k = 0; k < 2 && !has(bot, 'water_bucket'); k++) {
      await bot.lookAt(p.offset(0.5, 0.9, 0.5), true)
      await sleep(300) // a direção do olhar só chega ao servidor no próximo tick
      bot.activateItem()
      await sleep(700)
    }
    if (has(bot, 'water_bucket')) return
    log.warn(`balde: não encheu em ${p} (bloco ${bot.blockAt(p)?.name})`)
  }
  throw new StepError('bucket_failed', 'não enchi o balde')
}

const fFarm = {
  id: 'f_farm',
  desc: 'montando a fazenda de trigo',
  done: () => !!memory.state.farm?.built,
  run: async (bot, { signal }) => {
    memory.state.farm = memory.state.farm || {}
    await nav.goto(bot, nav.near(fat(4, 1, 4), 3), { timeout: 240000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    // limpa acima do chão e nivela o piso do lote + muro
    for (let dy = 1; dy <= 4; dy++) {
      for (let dx = -1; dx <= FS; dx++) {
        for (let dz = -1; dz <= FS; dz++) {
          if (signal?.aborted) throw new StepError('aborted')
          const b = bot.blockAt(fat(dx, dy, dz))
          // tocha que eu mesmo pus em volta da casa caiu no lote: tiro
          if (b && /torch/.test(b.name)) { await nav.goto(bot, new nav.goals.GoalLookAtBlock(b.position, bot.world, { reach: 4 }), { timeout: 15000 }).catch(() => {}); await bot.dig(b).catch(() => {}); continue }
          // só limpa natural (o muro/portão já levantados numa tentativa anterior ficam)
          if (b && !build.REPLACEABLE.test(b.name) && build.NATURAL.test(b.name)) await build.clearAt(bot, fat(dx, dy, dz)).catch(e => log.warn('fazenda limpar', e.message))
        }
      }
    }
    const floor = []
    for (let dx = -1; dx <= FS; dx++) for (let dz = -1; dz <= FS; dz++) floor.push({ pos: fat(dx, 0, dz), want: 'support' })
    await build.buildList(bot, floor.filter(t => !build.SOLID_FLOOR(bot.blockAt(t.pos))), { signal, label: 'fazenda: piso' })
    // água no centro
    if (!memory.state.farm.water) {
      await fillBucket(bot, signal)
      const c = fat(4, 0, 4)
      await nav.goto(bot, nav.near(c.offset(0, 1, 0), 2), { timeout: 60000, signal })
      const b = bot.blockAt(c)
      if (b && b.boundingBox === 'block') { await bot.tool.equipForBlock(b, {}).catch(() => {}); await bot.dig(b) }
      await bot.equip(bot.inventory.items().find(i => i.name === 'water_bucket'), 'hand')
      await bot.lookAt(c.offset(0.5, 0.1, 0.5), true)
      await sleep(300)
      bot.activateItem()
      await sleep(600)
      if (/water/.test(bot.blockAt(c)?.name || '')) { memory.state.farm.water = true; memory.save() } else throw new StepError('water_failed', 'água não ficou no centro')
    }
    // muro, portão e tochas
    if (count(bot, build.GROUPS.wall) < 80) await gather.stone(bot, 90, signal)
    await build.buildList(bot, farmWall(), { signal, label: 'fazenda: muro' })
    const gate = bot.inventory.items().find(i => /_fence_gate$/.test(i.name))
    if (!gate) { await craft.getTable(bot); await craft.ensureSticks(bot, 4); await craft.ensurePlanks(bot, 2); await craft.craftNamed(bot, `${craft.woodType(bot) || 'oak'}_fence_gate`).catch(e => log.warn('portão', e.message)) }
    const g = bot.inventory.items().find(i => /_fence_gate$/.test(i.name))
    if (g) await build.placeAt(bot, gateAt(), g.name).catch(e => log.warn('portão', e.message))
    if (count(bot, 'torch') < 7) await smelt.torches(bot, 8)
    await build.buildList(bot, farmTorches(), { signal, label: 'fazenda: tochas' }).catch(e => log.warn('tochas fazenda', e.message))
    // ara e planta
    const hoe = bot.inventory.items().find(i => /_hoe$/.test(i.name)) || (await craft.craft(bot, 'stone_hoe', 1).then(() => bot.inventory.items().find(i => /_hoe$/.test(i.name))).catch(() => null))
    if (!hoe) throw new StepError('missing_item', 'sem enxada')
    let planted = 0
    for (const [dx, dz] of farmCells()) {
      if (signal?.aborted) throw new StepError('aborted')
      const p = fat(dx, 0, dz)
      const b = bot.blockAt(p)
      if (!b) continue
      if (/^(grass_block|dirt|dirt_path|coarse_dirt)$/.test(b.name)) {
        await nav.goto(bot, new nav.goals.GoalLookAtBlock(p, bot.world, { reach: 4 }), { timeout: 15000, signal }).catch(() => {})
        await bot.equip(hoe, 'hand').catch(() => {})
        await bot.activateBlock(b, new Vec3(0, 1, 0)).catch(() => {})
        await sleep(150)
      }
      const seed = bot.inventory.items().find(i => i.name === 'wheat_seeds')
      if (seed && bot.blockAt(p)?.name === 'farmland' && bot.blockAt(p.offset(0, 1, 0))?.name === 'air') {
        await bot.equip(seed, 'hand').catch(() => {})
        await bot.activateBlock(bot.blockAt(p), new Vec3(0, 1, 0)).catch(() => {})
        planted++
        await sleep(120)
      }
    }
    memory.state.farm = { ...memory.state.farm, built: true, planted: planted > 0, x: F().x, y: F().y, z: F().z, size: FS }
    memory.save(true)
    memory.history(`fazenda de trigo pronta (${planted} plantados) ao lado da casa`)
    log.info(`fazenda: ${planted} canteiros plantados`)
  }
}

// rotina: colhe, replanta, faz pão, vende trigo pro fazendeiro, guarda esmeralda
const VILLAGE = () => (memory.state.places || []).find(p => p.name === 'aldeia') || { x: 2195, y: 71, z: 775 }
const fTend = {
  id: 'f_tend',
  desc: 'cuidando da fazenda e vendendo trigo',
  repeat: true,
  done: () => !memory.state.farm?.built, // sem fazenda ainda: pula (rodava à toa)
  run: async (bot, { signal, setWait }) => {
    const farm = require('../skills/farm')
    await nav.goto(bot, nav.near(fat(4, 1, 4), 4), { timeout: 180000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    const before = count(bot, 'wheat')
    await farm.harvest(bot, { target: count(bot, 'wheat') + 80, itemTest: /^wheat$/, maxDistance: 10, signal }).catch(e => { if (e.code === 'aborted') throw e })
    const got = count(bot, 'wheat') - before
    if (got) log.info(`fazenda: colhi ${got} trigo`)
    // replanta buracos (semente da colheita)
    for (const [dx, dz] of farmCells()) {
      const p = fat(dx, 0, dz)
      const seed = bot.inventory.items().find(i => i.name === 'wheat_seeds')
      if (!seed) break
      if (bot.blockAt(p)?.name === 'farmland' && bot.blockAt(p.offset(0, 1, 0))?.name === 'air') {
        await nav.goto(bot, new nav.goals.GoalLookAtBlock(p, bot.world, { reach: 4 }), { timeout: 10000, signal }).catch(() => {})
        await bot.equip(seed, 'hand').catch(() => {})
        await bot.activateBlock(bot.blockAt(p), new Vec3(0, 1, 0)).catch(() => {})
      }
    }
    // comida: pão quando a comida boa acaba
    if (survival.foodCount(bot) < 10 && count(bot, 'wheat') >= 3) { await craft.getTable(bot); await craft.craftNamed(bot, 'bread', Math.min(5, Math.floor(count(bot, 'wheat') / 3))).catch(e => log.warn('pão', e.message)) }
    // vende o resto (fica com 9 pra pão)
    if (count(bot, 'wheat') >= 29) {
      const v = VILLAGE()
      await nav.goto(bot, nav.nearXZ(v.x, v.z, 6), { timeout: 120000, signal }).catch(e => { if (e.code === 'aborted') throw e })
      const em = await require('../skills/villager').sell(bot, 'wheat', { signal, keep: 9 })
      if (em) memory.history(`vendi trigo: +${em} esmeraldas (total ${memory.state.stats.emeraldsEarned})`)
    }
    if (count(bot, 'emerald') >= 8) await require('../skills/storage').deposit(bot, 'emerald', 0).catch(e => log.warn('guardar esmeralda', e.message))
    setWait(4 * 60000, 'esperando o trigo crescer')
  }
}

// porta: colocada de dentro (parado no vão o servidor recusa) — casa sem porta deixa mob entrar
const doorPos = () => at(door.dx, 1, door.dz)
const hDoor = {
  id: 'h_door',
  desc: 'colocando a porta da casa',
  done: (bot) => !H().built || /_door$|_fence_gate$/.test(bot.blockAt(doorPos())?.name || '') || (H().doorTries || 0) >= 5,
  run: async (bot, { signal }) => {
    memory.state.home.doorTries = (H().doorTries || 0) + 1
    if (!count(bot, /_door$/)) { await craft.getTable(bot); await craft.ensurePlanks(bot, 6); await craft.craftNamed(bot, doorName(bot)) }
    // 2 blocos pra dentro do vão, olhando pro chão dele (do centro da sala ficava no limite do alcance)
    await nav.goto(bot, nav.near(at(door.dx, 1, door.dz - 2), 0), { timeout: 60000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    // 3ª tentativa em diante: portão de cerca (segura mob igual) se a porta continuar recusada
    const useGate = (H().doorTries || 0) >= 3
    if (useGate && !count(bot, /_fence_gate$/)) { await craft.getTable(bot); await craft.ensureSticks(bot, 4); await craft.ensurePlanks(bot, 2); await craft.craftNamed(bot, `${craft.woodType(bot) || 'oak'}_fence_gate`).catch(() => {}) }
    // chão do vão tem que ser bloco cheio (um portão tinha ido parar no piso e a porta era recusada)
    for (const p of [at(door.dx, 0, door.dz), at(door.dx, 0, door.dz + 1)]) {
      const b = bot.blockAt(p)
      if (b && !(b.boundingBox === 'block' && build.SOLID_FLOOR(b) && !/gate|door|fence|slab|stairs/.test(b.name))) {
        if (b.boundingBox === 'block' || /gate|door|fence/.test(b.name)) { await bot.tool.equipForBlock(b, {}).catch(() => {}); await bot.dig(b).catch(() => {}) }
        await build.placeAt(bot, p, 'support').catch(e => log.warn('chão da porta', e.message))
      }
    }
    await nav.goto(bot, nav.near(at(door.dx, 1, door.dz - 2), 0), { timeout: 30000, signal }).catch(() => {})
    const d = bot.inventory.items().find(i => useGate ? /_fence_gate$/.test(i.name) : /_door$/.test(i.name))
    await bot.equip(d, 'hand')
    const below = bot.blockAt(at(door.dx, 0, door.dz))
    await bot.lookAt(below.position.offset(0.5, 1, 0.5), true)
    await bot.placeBlock(below, new Vec3(0, 1, 0)).catch(e => log.warn('porta', e.message))
    await sleep(300)
    if (/_door$|_fence_gate$/.test(bot.blockAt(doorPos())?.name || '')) memory.history('porta da casa colocada')
    memory.save()
  }
}

// oficina dentro de casa: mesa e fornalha (sem elas cada craft fazia uma mesa nova lá fora)
const hFixtures = {
  id: 'h_fixtures',
  desc: 'colocando mesa e fornalha em casa',
  done: (bot) => !H().built || (H().fixTries || 0) >= 3 || (bot.blockAt(at(W - 1, 1, 2))?.name === 'crafting_table' && bot.blockAt(at(W - 1, 1, 3))?.name === 'furnace'),
  run: async (bot, { signal }) => {
    memory.state.home.fixTries = (H().fixTries || 0) + 1
    if (count(bot, LOGS) < 2 && count(bot, /_planks$/) < 4) await require('../skills/storage').take(bot, LOGS, 4)
    if (!count(bot, 'crafting_table') && bot.blockAt(at(W - 1, 1, 2))?.name !== 'crafting_table') await craft.craft(bot, 'crafting_table', 1).catch(e => log.warn('mesa', e.message))
    await nav.goto(bot, nav.near(at(4, 1, 3), 0), { timeout: 60000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    if (count(bot, 'crafting_table')) await build.placeAt(bot, at(W - 1, 1, 2), 'crafting_table').catch(e => log.warn('mesa', e.message))
    if (!count(bot, 'furnace') && bot.blockAt(at(W - 1, 1, 3))?.name !== 'furnace') await craft.craft(bot, 'furnace', 1).catch(e => log.warn('fornalha', e.message))
    if (count(bot, 'furnace')) await build.placeAt(bot, at(W - 1, 1, 3), 'furnace').catch(e => log.warn('fornalha', e.message))
    memory.save()
  }
}

// armadura reserva no baú de casa: morreu → renasce na cama e veste na hora (antes refazia tudo pelado)
const SPARE = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
const spareInChest = () => {
  const c = memory.state.base?.chest
  const reg = c && memory.state.chests?.[`${c.x},${c.y},${c.z}`]
  return !!reg && SPARE.every(n => reg.items[n])
}
const hSpareArmor = {
  id: 'h_spare_armor',
  desc: 'fazendo armadura reserva pro baú de casa',
  done: (bot) => !H().built || spareInChest(),
  run: async (bot, { signal }) => {
    const worn = (n) => bot.inventory.slots.slice(5, 9).some(i => i?.name === n)
    const loose = (n) => bot.inventory.items().some(i => i.name === n)
    const need = SPARE.filter(n => !loose(n))
    const cost = { iron_helmet: 5, iron_chestplate: 8, iron_leggings: 7, iron_boots: 4 }
    const ingots = need.reduce((t, n) => t + cost[n], 0)
    if (count(bot, 'iron_ingot') < ingots) {
      const raw = ingots - count(bot, 'iron_ingot') - count(bot, 'raw_iron')
      if (raw > 0) await require('../skills/ore').mine(bot, /^(deepslate_)?iron_ore$/, 'raw_iron', count(bot, 'raw_iron') + raw, signal)
      if (nav.underground(bot)) await nav.toSurface(bot, { signal }).catch(() => {})
      await smelt.smelt(bot, 'raw_iron', 'iron_ingot', count(bot, 'raw_iron'))
    }
    for (const n of need) if (count(bot, 'iron_ingot') >= cost[n]) await craft.craftNamed(bot, n)
    // guarda só as peças soltas (as vestidas continuam no corpo)
    const st = require('../skills/storage')
    await st.deposit(bot, new RegExp(`^(${SPARE.join('|')})$`), 0)
    if (SPARE.some(worn)) log.info('reserva: armadura de ferro guardada no baú de casa')
  }
}
// renasceu sem armadura em casa: veste a reserva antes de qualquer coisa
async function wearSpare (bot) {
  if ([5, 6, 7, 8].some(s => bot.inventory.slots[s]) || !spareInChest()) return false
  const got = await require('../skills/storage').take(bot, /^iron_(helmet|chestplate|leggings|boots)$/, 4)
  if (got) { await bot.equipArmorNow?.(); memory.history('renasci e vesti a armadura reserva de casa'); log.info('reserva: vesti a armadura de casa') }
  return got > 0
}

// ================= complexo murado: casa + fazenda dentro de um muro, iluminado =================
// Mob aqui não some de dia (husk não queima, RPG): tocha em volta não bastou (7 mortes numa hora perto
// de casa). Muro de 2 de altura cercando tudo + portão + luz dentro: ele trabalha seguro lá dentro.
const CB = () => { const h = H(); return { x0: h.x - 3, x1: h.x + W + FS + 5, z0: h.z - 4, z1: h.z + W + 4 } }
const gateC = () => { const h = H(); return { x: h.x + 3, z: CB().z1 } } // na frente da porta da casa
// chão real da coluna, ignorando o pedregulho do próprio muro (antes o muro virava "chão" e crescia a cada rodada)
function groundY (bot, x, z, hint) {
  let y = hint + 10
  for (; y > hint - 12; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && b.boundingBox === 'block' && !/leaves/.test(b.name)) break }
  while (y > hint - 12 && /^cobblestone$/.test(bot.blockAt(new Vec3(x, y, z))?.name || '')) y--
  const b = bot.blockAt(new Vec3(x, y, z))
  return b && b.boundingBox === 'block' ? y : null
}
// planta do muro calculada uma vez e guardada (posições fixas)
function compoundCells (bot) {
  const h = H()
  if (h.wallCells) return h.wallCells
  const b = CB()
  const g = gateC()
  const cells = []
  for (let x = b.x0; x <= b.x1; x++) {
    for (let z = b.z0; z <= b.z1; z++) {
      if (!(x === b.x0 || x === b.x1 || z === b.z0 || z === b.z1)) continue
      if (x === g.x && z === g.z) continue
      const gy = groundY(bot, x, z, h.y)
      if (gy === null) continue
      const top = bot.blockAt(new Vec3(x, gy, z))
      if (top && nav.PROTECTED.test(top.name)) continue
      cells.push([x, gy + 1, z], [x, gy + 2, z])
    }
  }
  memory.state.home.wallCells = cells
  memory.save()
  return cells
}
function compoundWall (bot) {
  return compoundCells(bot).map(([x, y, z]) => new Vec3(x, y, z))
    .filter(p => { const cur = bot.blockAt(p); return !(cur && build.GROUPS.wall.test(cur.name)) && !(cur && !build.REPLACEABLE.test(cur.name) && !build.NATURAL.test(cur.name)) })
    .map(p => ({ pos: p, want: 'wall' }))
}

function compoundTorches (bot) {
  const b = CB()
  const out = []
  for (let x = b.x0 + 3; x < b.x1; x += 6) {
    for (let z = b.z0 + 3; z < b.z1; z += 6) {
      const h = H()
      const inHouse = x >= h.x - 1 && x <= h.x + W && z >= h.z - 1 && z <= h.z + W
      const f = F()
      const inFarm = x >= f.x - 1 && x <= f.x + FS && z >= f.z - 1 && z <= f.z + FS
      if (inHouse || inFarm) continue
      const sy = build.surfaceY(bot, x, z, h.y)
      if (sy !== null) out.push({ pos: new Vec3(x, sy + 1, z), want: 'torch' })
    }
  }
  return out
}
const cWall = {
  id: 'c_wall',
  desc: 'murando o complexo (casa + fazenda)',
  done: (bot) => !H().built || H().walled,
  run: async (bot, { signal }) => {
    const c = CB()
    await nav.goto(bot, nav.nearXZ((c.x0 + c.x1) / 2, (c.z0 + c.z1) / 2, 6), { timeout: 120000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    let list = compoundWall(bot)
    if (count(bot, build.GROUPS.wall) < list.length) await gather.stone(bot, list.length + 10, signal)
    list = compoundWall(bot)
    await build.buildList(bot, list, { signal, label: 'complexo: muro' })
    const g = gateC()
    const sy = build.surfaceY(bot, g.x, g.z, H().y)
    // portão: madeira do baú de casa ou de árvore; falha aqui não trava o muro
    if (!count(bot, /_fence_gate$/)) {
      try {
        if (count(bot, LOGS) < 2 && count(bot, /_planks$/) < 8) await require('../skills/storage').take(bot, LOGS, 4)
        if (count(bot, LOGS) < 2 && count(bot, /_planks$/) < 8) await gather.logs(bot, 3, signal)
        await craft.getTable(bot); await craft.ensureSticks(bot, 4); await craft.ensurePlanks(bot, 2)
        await craft.craftNamed(bot, `${craft.woodType(bot) || 'oak'}_fence_gate`)
      } catch (e) { if (e.code === 'aborted') throw e; log.warn('portão', e.message) }
    }
    const gate = bot.inventory.items().find(i => /_fence_gate$/.test(i.name))
    // tocha antiga no lugar do portão: tira
    for (const dy of [1, 2]) {
      const tb = sy !== null && bot.blockAt(new Vec3(g.x, sy + dy, g.z))
      if (tb && /torch/.test(tb.name)) { await nav.goto(bot, new nav.goals.GoalLookAtBlock(tb.position, bot.world, { reach: 4 }), { timeout: 20000 }).catch(() => {}); await bot.dig(tb).catch(() => {}) }
    }
    if (gate && sy !== null) await build.placeAt(bot, new Vec3(g.x, sy + 1, g.z), gate.name).catch(e => log.warn('portão do complexo', e.message))
    const torches = compoundTorches(bot)
    if (count(bot, 'torch') < torches.length) await smelt.torches(bot, torches.length + 2).catch(e => log.warn('tochas', e.message))
    await build.buildList(bot, torches, { signal, label: 'complexo: tochas' }).catch(e => log.warn('tochas complexo', e.message))
    const left = compoundWall(bot).length
    log.info(`complexo: faltam ${left} blocos de muro`)
    // alguns cantos são inalcançáveis (água, desnível): até 6 faltando conta como murado
    if (left <= 6) { memory.state.home.walled = true; memory.history('complexo murado: casa e fazenda dentro do muro, portão em frente à porta') }
    memory.save()
  }
}

// limpar a casa: mob entrou (porta aberta) e mata o bot na cama a cada renascimento.
// Só com armadura de ferro e espada: entra e luta (o reflexo defend bate em quem chega a 4,5).
const hClear = {
  id: 'h_clear',
  desc: 'limpando mob de dentro da casa',
  done: () => !H().infested,
  run: async (bot, { signal }) => {
    const armored = [5, 6, 7, 8].every(s => bot.inventory.slots[s])
    const sword = bot.inventory.items().find(i => /_sword$/.test(i.name))
    if (!armored || !sword) throw new StepError('not_ready', 'sem armadura/espada pra limpar a casa')
    await bot.equip(sword, 'hand').catch(() => {})
    const h = H()
    const insideMob = () => bot.nearestEntity(e => survival.HOSTILE.has(e.name) && e.position.x >= h.x - 0.3 && e.position.x < h.x + 7.3 && e.position.z >= h.z - 0.3 && e.position.z < h.z + 7.3)
    await nav.goto(bot, nav.near(at(door.dx, 1, door.dz + 1), 1), { timeout: 90000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    const start = Date.now()
    while (insideMob() && Date.now() - start < 90000) {
      if (signal?.aborted) throw new StepError('aborted')
      const m = insideMob()
      if (bot.health < 10) { await nav.goto(bot, nav.near(at(door.dx, 1, door.dz + 6), 1), { timeout: 15000 }).catch(() => {}); await sleep(8000); continue }
      if (m.position.distanceTo(bot.entity.position) > 3) await nav.goto(bot, new nav.goals.GoalFollow(m, 2), { timeout: 8000, signal }).catch(() => {})
      else { await bot.lookAt(m.position.offset(0, m.height * 0.8, 0), true); bot.attack(m); await sleep(650) }
    }
    if (!insideMob()) { delete memory.state.home.infested; memory.save(); memory.history('casa limpa: matei os mobs que tinham entrado') }
  }
}

// renascimento na cama de casa: clicar na cama de dia já fixa o ponto (antes renascia a 20 blocos, no meio de husk)
const hSpawn = {
  id: 'h_spawn',
  desc: 'marcando a cama de casa como renascimento',
  done: () => !H().bed || (H().spawnSetAt && Date.now() - H().spawnSetAt < 6 * 3600000) || (H().spawnTriedAt && Date.now() - H().spawnTriedAt < 30 * 60000),
  run: async (bot, { signal }) => {
    const b = H().bed
    await nav.goto(bot, nav.near(new Vec3(b.x, b.y, b.z), 1), { timeout: 90000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    const lines = require('../commands').collectReplies(bot, 2500)
    await bot.activateBlock(bot.blockAt(new Vec3(b.x, b.y, b.z))).catch(() => {})
    const got = (await lines).join(' ')
    log.info(`casa: cama clicada (${got.slice(0, 80) || 'sem resposta'})`)
    // de dia o servidor só responde 'only at night' e não fixa: aí vale quando dormir lá à noite (controller)
    memory.state.home.spawnSetAt = /respawn point|renascimento|spawn/i.test(got) ? Date.now() : undefined
    memory.state.home.spawnTriedAt = Date.now()
    memory.save()
  }
}

// arma antes de sair (lição do avaliador): com qualquer madeira na mão, espada de madeira custa quase nada
const weapon = {
  id: 'weapon',
  desc: 'fazendo uma espada antes de sair',
  done: (bot) => bot.inventory.items().some(i => /_sword$/.test(i.name)) || (count(bot, LOGS) < 1 && count(bot, /_planks$/) < 3),
  run: async (bot) => { await craft.craft(bot, 'wooden_sword', 1) }
}

// portão do complexo: vão de 2 de altura com portão de cerca embaixo (pedra em cima deixava 1 bloco: nem ele passava)
// portão fica na frente da porta: usa o nível do chão da casa se ali for chão firme (o scan achava terra solta lá em cima)
const gatePos = (bot) => {
  const g = gateC()
  const h = H()
  const floor = bot.blockAt(new Vec3(g.x, h.y, g.z))
  if (floor && floor.boundingBox === 'block') return new Vec3(g.x, h.y + 1, g.z)
  const gy = groundY(bot, g.x, g.z, h.y)
  return gy === null ? null : new Vec3(g.x, gy + 1, g.z)
}
const cGate = {
  id: 'c_gate',
  desc: 'colocando o portão do complexo',
  done: (bot) => !H().walled || H().gated || (H().gateTries || 0) >= 4,
  run: async (bot, { signal }) => {
    memory.state.home.gateTries = (H().gateTries || 0) + 1
    const p = gatePos(bot)
    if (!p) throw new StepError('no_gate_pos', 'sem chão no portão')
    if (count(bot, LOGS) < 2 && count(bot, /_planks$/) < 8) await require('../skills/storage').take(bot, LOGS, 4)
    if (count(bot, LOGS) < 2 && count(bot, /_planks$/) < 8) await gather.logs(bot, 3, signal)
    if (!count(bot, /_fence_gate$/)) { await craft.getTable(bot); await craft.ensureSticks(bot, 4); await craft.ensurePlanks(bot, 2); await craft.craftNamed(bot, `${craft.woodType(bot) || 'oak'}_fence_gate`) }
    // de dentro do complexo, de frente pro vão
    await nav.goto(bot, nav.near(p.offset(0, 0, -2), 1), { timeout: 60000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    for (const dy of [1, 0]) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (b && b.name !== 'air' && !/fence_gate/.test(b.name)) { await bot.tool.equipForBlock(b, {}).catch(() => {}); await bot.dig(b).catch(() => {}) }
    }
    const gate = bot.inventory.items().find(i => /_fence_gate$/.test(i.name))
    await bot.equip(gate, 'hand')
    const below = bot.blockAt(p.offset(0, -1, 0))
    await bot.lookAt(below.position.offset(0.5, 1, 0.5), true)
    await sleep(250)
    await bot.placeBlock(below, new Vec3(0, 1, 0)).catch(e => log.warn('portão', e.message))
    await sleep(300)
    if (/fence_gate/.test(bot.blockAt(p)?.name || '')) { memory.state.home.gated = true; memory.history('portão do complexo colocado') }
    memory.save()
  }
}

// ================= golem de ferro guardando o complexo =================
// Zumbi daqui tira ~11 por golpe mesmo de ferro: corpo a corpo perde. Golem (100 de vida, mata zumbi em 2-3
// golpes) dentro do muro limpa intruso e não sai por portão fechado. Peças: 4 blocos de ferro + abóbora esculpida.
const golemSpot = () => { const h = H(); return { x: h.x + 10, z: h.z + W + 2 } } // entre a casa e a fazenda, lado sul
async function getCarvedPumpkin (bot, signal) {
  if (count(bot, 'carved_pumpkin')) return
  if (!count(bot, 'pumpkin')) {
    const ids = [bot.registry.blocksByName.pumpkin.id]
    for (let i = 0; i < 6 && !count(bot, 'pumpkin'); i++) {
      const p = bot.findBlocks({ matching: ids, maxDistance: 96, count: 1 })[0]
      if (!p) { await nav.wander(bot, 64, nav.exploreAngle(bot), { signal }).catch(e => { if (e.code === 'aborted') throw e }); continue }
      await nav.goto(bot, new nav.goals.GoalLookAtBlock(p, bot.world, { reach: 4 }), { timeout: 120000, signal }).catch(e => { if (e.code === 'aborted') throw e })
      const b = bot.blockAt(p)
      if (b && b.name === 'pumpkin') { await bot.tool.equipForBlock(b, {}).catch(() => {}); await bot.dig(b).catch(() => {}) }
      await sleep(500)
      for (const it of Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(p) < 5)) await nav.goto(bot, nav.near(it.position, 0), { timeout: 6000 }).catch(() => {})
    }
    if (!count(bot, 'pumpkin')) throw new StepError('no_pumpkin', 'sem abóbora por perto')
  }
  // esculpe: coloca a abóbora, tesoura nela, quebra a esculpida
  if (!count(bot, 'shears')) { if (count(bot, 'iron_ingot') < 2) throw new StepError('missing_item', 'sem ferro pra tesoura'); await craft.getTable(bot); await craft.craftNamed(bot, 'shears') }
  const spot = bot.entity.position.floored().offset(2, 0, 0)
  const ground = bot.blockAt(spot.offset(0, -1, 0))
  await bot.equip(bot.inventory.items().find(i => i.name === 'pumpkin'), 'hand')
  await bot.placeBlock(ground, new Vec3(0, 1, 0)).catch(e => log.warn('abóbora', e.message))
  await sleep(300)
  const pb = bot.blockAt(spot)
  if (pb?.name === 'pumpkin') {
    await bot.equip(bot.inventory.items().find(i => i.name === 'shears'), 'hand')
    await bot.activateBlock(pb).catch(() => {})
    await sleep(400)
  }
  const cb = bot.blockAt(spot)
  if (cb?.name === 'carved_pumpkin') { await bot.dig(cb).catch(() => {}); await sleep(400); for (const it of Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(spot) < 4)) await nav.goto(bot, nav.near(it.position, 0), { timeout: 6000 }).catch(() => {}) }
  if (!count(bot, 'carved_pumpkin')) throw new StepError('carve_failed', 'não consegui esculpir a abóbora')
}
const hasParts = (bot) => count(bot, 'iron_block') >= 4 && count(bot, 'carved_pumpkin') >= 1
const gParts = {
  id: 'g_parts',
  remoteOk: true,
  desc: 'juntando peças do golem (ferro e abóbora)',
  done: (bot) => !H().walled || H().golem || hasParts(bot),
  run: async (bot, { signal }) => {
    const needIngots = Math.max(0, 36 - count(bot, 'iron_block') * 9) + (count(bot, 'shears') || count(bot, 'carved_pumpkin') ? 0 : 2)
    if (count(bot, 'iron_ingot') < needIngots) {
      const raw = needIngots - count(bot, 'iron_ingot') - count(bot, 'raw_iron')
      if (raw > 0) await require('../skills/ore').mine(bot, /^(deepslate_)?iron_ore$/, 'raw_iron', count(bot, 'raw_iron') + raw, signal)
      if (nav.underground(bot)) await nav.toSurface(bot, { signal }).catch(() => {})
      await smelt.smelt(bot, 'raw_iron', 'iron_ingot', count(bot, 'raw_iron'))
    }
    await getCarvedPumpkin(bot, signal)
    while (count(bot, 'iron_block') < 4 && count(bot, 'iron_ingot') >= 9) { await craft.getTable(bot); await craft.craftNamed(bot, 'iron_block') }
    // peças prontas: acaba o modo remoto e volta pra montar o golem em casa
    if (hasParts(bot) && memory.state.remote) { memory.state.remote.until = Date.now(); memory.save(); log.info('golem: peças prontas, voltando pra casa') }
  }
}
const gGolem = {
  id: 'g_golem',
  desc: 'fazendo um golem de ferro pra guardar o complexo',
  done: (bot) => !H().walled || H().golem || (H().golemTries || 0) >= 6,
  run: async (bot, { signal }) => {
    if (!hasParts(bot)) throw new StepError('missing_item', 'faltam peças do golem')
    memory.state.home.golemTries = (H().golemTries || 0) + 1
    memory.save()
    // longe (renasceu no spawn do mundo): /home base com as peças na mão, antes de olhar o terreno
    const hc = at(3, 1, 3)
    if (bot.entity.position.distanceTo(hc) > 150) await commands.tryHome(bot).catch(() => false)
    if (bot.entity.position.distanceTo(hc) > 40) await nav.goto(bot, nav.nearXZ(hc.x, hc.z, 10), { timeout: 600000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    await bot.waitForChunksToLoad().catch(() => {})
    if (count(bot, 'iron_block') < 4) throw new StepError('missing_item', `só ${count(bot, 'iron_block')} blocos de ferro`)
    const s = golemSpot()
    const gy = groundY(bot, s.x, s.z, H().y)
    if (gy === null) throw new StepError('no_spot', 'sem chão pro golem')
    const base = new Vec3(s.x, gy + 1, s.z)
    await nav.goto(bot, nav.near(base.offset(0, 0, -3), 1), { timeout: 240000, signal }).catch(() => {})
    // T: base, corpo, braços (eixo x), cabeça por último
    const plan = [[0, 0, 0, 'iron_block'], [0, 1, 0, 'iron_block'], [-1, 1, 0, 'iron_block'], [1, 1, 0, 'iron_block']]
    for (const [dx, dy, dz, want] of plan) {
      const p = base.offset(dx, dy, dz)
      const cur = bot.blockAt(p)
      if (cur && cur.name !== 'air' && cur.name !== want && build.NATURAL.test(cur.name)) await build.clearAt(bot, p).catch(() => {})
      await build.placeAt(bot, p, want).catch(e => log.warn('golem', e.message))
    }
    for (const dx of [-1, 1]) { const below = bot.blockAt(base.offset(dx, 0, 0)); if (below && below.name !== 'air' && build.NATURAL.test(below.name)) await build.clearAt(bot, below.position).catch(() => {}) }
    await build.placeAt(bot, base.offset(0, 2, 0), 'carved_pumpkin', { yaw: Math.PI }).catch(e => log.warn('golem cabeça', e.message))
    await sleep(1500)
    const golem = bot.nearestEntity(e => e.name === 'iron_golem' && e.position.distanceTo(base) < 6)
    if (golem) { memory.state.home.golem = true; memory.history('golem de ferro criado: guarda o complexo'); log.info('golem: criado') }
    memory.save()
  }
}

// cama de volta: depois de limpar a casa (golem), coloca outra cama e volta a renascer em casa
const hRebed = {
  id: 'h_rebed',
  desc: 'pondo a cama de volta em casa',
  done: () => !H().built || !!H().bed || !!H().infested,
  run: async (bot, { signal }) => {
    if (!count(bot, /_bed$/)) {
      const wool = () => Object.entries(bot.inventory.items().filter(i => WOOL.test(i.name)).reduce((o, i) => ({ ...o, [i.name]: (o[i.name] || 0) + i.count }), {})).sort((a, b) => b[1] - a[1])[0]
      if (!wool() || wool()[1] < 3) await survival.hunt(bot, 0, signal, { prey: new Set(['sheep']), enough: () => (wool()?.[1] || 0) >= 3 })
      await craft.getTable(bot); await craft.ensurePlanks(bot, 3); await craft.craftNamed(bot, wool()[0].replace('_wool', '_bed'))
    }
    const b = bot.inventory.items().find(i => /_bed$/.test(i.name))
    await nav.goto(bot, nav.near(at(3, 1, 3), 1), { timeout: 90000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    await build.placeAt(bot, bedPos(), b.name, { yaw: 0 })
    const bb = bot.blockAt(bedPos())
    if (/_bed$/.test(bb?.name || '')) { memory.state.home.bed = { x: bb.position.x, y: bb.position.y, z: bb.position.z }; memory.save() }
  }
}

const steps = [
  hSpawn,
  step('stash'), step('restock'), step('kit'), weapon,
  step('wood'), step('wooden_pickaxe'), step('stone_tools'),
  // armadura antes da obra: pelado, um esqueleto na sombra derruba ele duas vezes seguidas no canteiro
  ironGear,
  hClear,
  hSite, hMaterials, hBuild, hFurnish, hDoor, hFixtures, hLight,
  hSpare, cWall, cGate, hSpareArmor, gParts, gGolem, hRebed,
  fBucket, fSeeds, fFarm, fTend
]

module.exports = {
  name: 'factory',
  title: 'fábrica de esmeraldas (casa segura → fazendas → aldeões)',
  steps,
  wearSpare,
  home: { at, W, door, bedPos }
}
