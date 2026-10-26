const { count, withTimeout, StepError, Vec3 } = require('./util')
const nav = require('./nav')
const craft = require('./craft')
const memory = require('../memory')
const log = require('../log')

// Só usa baús que o próprio agente colocou (registrados em state.base.chest).
async function ensureBaseChest (bot) {
  const s = memory.state
  if (s.base?.chest) return s.base.chest
  if (!count(bot, 'chest')) await craft.craft(bot, 'chest', 1)
  const b = await craft.placeNear(bot, 'chest')
  s.base = { x: b.position.x, y: b.position.y, z: b.position.z, dim: bot.game.dimension, chest: { x: b.position.x, y: b.position.y, z: b.position.z } }
  memory.save(true)
  memory.addPlace('base', b.position, bot.game.dimension, 'baú do agente')
  memory.history(`base criada em ${b.position.x} ${b.position.y} ${b.position.z}`)
  return s.base.chest
}

async function deposit (bot, test, keep = 0) {
  const c = memory.state.base?.chest
  if (!c) throw new StepError('no_chest')
  const pos = new Vec3(c.x, c.y, c.z)
  await nav.goto(bot, nav.near(pos, 3), { timeout: 120000 })
  const block = bot.blockAt(pos)
  if (!block || !/chest|barrel/.test(block.name)) {
    memory.state.base.chest = null
    memory.save()
    throw new StepError('chest_missing', 'baú da base sumiu')
  }
  const win = await withTimeout(bot.openContainer(block), 8000)
  try {
    for (const it of bot.inventory.items().filter(i => typeof test === 'string' ? i.name === test : test.test(i.name))) {
      const amount = Math.max(0, Math.min(it.count, count(bot, it.name) - keep))
      if (amount > 0) await win.deposit(it.type, null, amount)
    }
    log.info('deposit ok')
  } finally { win.close() }
}

// Itens do dono que não devem ir para exploração (risco de morte). Comida boa: guarda o excedente.
// Só materiais crus valiosos vão pro baú; ferramentas e armaduras ficam com o bot (kit em uso).
const VALUABLE = /^(diamond|diamond_block|netherite_ingot|netherite_scrap|netherite_block|ancient_debris|emerald_block|gold_block|iron_block|totem_of_undying|elytra|nether_star|beacon|.*shulker_box|trident|heart_of_the_sea|echo_shard|enchanted_golden_apple|music_disc_.*)$/
const KEEP = { golden_carrot: 64, cooked_beef: 32, bread: 32 }

const needsStash = (bot) => bot.inventory.items().some(i => VALUABLE.test(i.name) || (KEEP[i.name] && count(bot, i.name) > KEEP[i.name]))

// Guarda valiosos num baú do próprio agente colocado onde ele está (registrado no vault).
async function stashValuables (bot) {
  const s = memory.state
  // longe da base o chunk do baú não está carregado (blockAt = null) e ele achava que o baú tinha
  // sumido: criava baú novo onde estivesse (apareceu um em 2580 63 559). Volta pra base ou desiste.
  if (s.stash && bot.entity.position.distanceTo(new Vec3(s.stash.x, s.stash.y, s.stash.z)) > 96) {
    await require('../commands').tryHome(bot).catch(() => false)
    if (bot.entity.position.distanceTo(new Vec3(s.stash.x, s.stash.y, s.stash.z)) > 96) throw new StepError('far_from_base', 'baú dos valiosos longe; guardo quando passar na base')
  }
  let block = s.stash && bot.blockAt(new Vec3(s.stash.x, s.stash.y, s.stash.z))
  if (block && /chest/.test(block.name)) {
    await nav.goto(bot, nav.near(block.position, 3), { timeout: 120000 })
  } else {
    if (!count(bot, 'chest')) await craft.craft(bot, 'chest', 1)
    block = await craft.placeNear(bot, 'chest')
    s.stash = { x: block.position.x, y: block.position.y, z: block.position.z, dim: bot.game.dimension }
    memory.save(true)
    memory.addPlace('baú do agente (itens do dono)', block.position, bot.game.dimension, 'diamantes e valiosos guardados antes de explorar')
  }
  // Calcula tudo antes: o inventário só atualiza depois que o servidor confirma cada clique.
  const plan = {}
  for (const it of bot.inventory.items()) {
    if (VALUABLE.test(it.name)) plan[it.name] = { type: it.type, n: count(bot, it.name) }
    else if (KEEP[it.name] && count(bot, it.name) > KEEP[it.name]) plan[it.name] = { type: it.type, n: count(bot, it.name) - KEEP[it.name] }
  }
  const win = await withTimeout(bot.openContainer(block), 8000)
  const stored = []
  try {
    for (const [name, { type, n }] of Object.entries(plan)) {
      await win.deposit(type, null, n)
      stored.push(`${name} x${n}`)
    }
  } finally { win.close() }
  if (stored.length) memory.history(`guardei no baú do agente: ${stored.join(', ')}`)
  log.info('stash:', stored.join(', '))
}

// Pega comida de volta do baú do agente quando o estoque no inventário está baixo.
// Retira até n de um item do baú do agente. Retorna quanto pegou (0 se não tinha ou baú longe).
async function withdraw (bot, name, n) {
  const s = memory.state.stash
  if (!s) return 0
  const pos = new Vec3(s.x, s.y, s.z)
  if (bot.entity.position.distanceTo(pos) > 96) await require('../commands').tryHome(bot).catch(() => false)
  if (bot.entity.position.distanceTo(pos) > 96) return 0
  const seen = memory.state.chests?.[`${s.x},${s.y},${s.z}`]
  if (seen && !seen.items[name]) return 0
  await nav.goto(bot, nav.near(pos, 3), { timeout: 120000 })
  if (freeSlots(bot) < 2) { await dropJunk(bot, 3); await depositSurplus(bot) }
  const win = await withTimeout(bot.openContainer(bot.blockAt(pos)), 8000)
  try {
    const have = win.containerItems().filter(i => i.name === name).reduce((t, i) => t + i.count, 0)
    const take = Math.min(have, n)
    if (take > 0) await win.withdraw(bot.registry.itemsByName[name].id, null, take)
    if (take > 0) log.info(`baú: peguei ${name} x${take}`)
    return take
  } finally { win.close() }
}

const FOOD_PREF = ['golden_carrot', 'cooked_beef', 'cooked_porkchop', 'bread', 'baked_potato', 'cooked_chicken']
async function restockFood (bot, want = 64) {
  const s = memory.state.stash
  if (!s) return false
  // o registro de estoque já sabe o que tem lá: sem comida guardada, nem vai
  const seen = memory.state.chests?.[`${s.x},${s.y},${s.z}`]
  if (seen && !FOOD_PREF.some(n => seen.items[n])) return false
  const pos = new Vec3(s.x, s.y, s.z)
  if (bot.entity.position.distanceTo(pos) > 96) await require('../commands').tryHome(bot).catch(() => false)
  if (bot.entity.position.distanceTo(pos) > 96) return false
  await nav.goto(bot, nav.near(pos, 3), { timeout: 120000 })
  if (freeSlots(bot) < 2) { await dropJunk(bot, 3); await depositSurplus(bot) }
  const win = await withTimeout(bot.openContainer(bot.blockAt(pos)), 8000)
  try {
    for (const name of FOOD_PREF) {
      const have = win.containerItems().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
      if (!have) continue
      const n = Math.min(have, want)
      await win.withdraw(bot.registry.itemsByName[name].id, null, n)
      log.info(`restock: peguei ${name} x${n}`)
      return true
    }
  } finally { win.close() }
  return false
}

// Lixo de mineração: joga fora quando o inventário enche (túmulo e coleta precisam de espaço).
// Pedra fica até o limite (paredes do procriador usam ~150).
const JUNK = /^(dirt|coarse_dirt|gravel|sand|red_sand|andesite|diorite|granite|tuff|calcite|netherrack|sandstone|cobbled_deepslate|rotten_flesh|spider_eye|poisonous_potato|kelp|seagrass|snowball|.*_sapling|poppy|dandelion|cornflower|azure_bluet|oxeye_daisy|allium|blue_orchid|.*_tulip|lily_of_the_valley|short_grass|tall_grass|fern|dead_bush|wheat_seeds|beetroot_seeds|pumpkin_seeds|melon_seeds|bone|arrow|feather|string|egg|ink_sac|leather|prismarine_shard|flint)$/
const LIMIT = { cobblestone: 256, dirt: 32, granite: 16, diorite: 16, andesite: 16, wheat_seeds: 16, pumpkin_seeds: 4, string: 16, bone: 8, arrow: 32, feather: 8, flint: 8, leather: 16, egg: 4 }
const freeSlots = (bot) => bot.inventory.emptySlotCount()

// Ferramenta repetida (vinha de vários túmulos: 5 machados, 4 picaretas, 6 espadas): fica a melhor de
// cada tipo (2 picaretas); o resto sai. Joga fora sem andar (é chamado de dentro do dropJunk).
const TIER = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']
async function dedupeTools (bot) {
  let tossed = 0
  for (const kind of ['pickaxe', 'axe', 'shovel', 'hoe', 'sword']) {
    const list = bot.inventory.items().filter(i => i.name.endsWith('_' + kind) && i.name !== 'pickaxe')
      .sort((x, y) => TIER.indexOf(y.name.split('_')[0]) - TIER.indexOf(x.name.split('_')[0]))
    const keep = kind === 'pickaxe' ? 2 : 1
    for (const it of list.slice(keep)) { await bot.tossStack(it).catch(() => {}); tossed++ }
  }
  if (tossed) log.info(`inventário: joguei fora ${tossed} ferramentas repetidas`)
  return tossed
}

async function dropJunk (bot, want = 8) {
  if (freeSlots(bot) >= want) return 0
  await dedupeTools(bot)
  if (freeSlots(bot) >= want) return 0
  // joga para um lado aberto e anda para o outro; parado em cima, o bot recolhe tudo de volta
  const p = bot.entity.position.floored()
  const open = (dx, dz) => [1, 2, 3].every(k => bot.blockAt(p.offset(dx * k, 1, dz * k))?.boundingBox === 'empty')
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const dir = dirs.find(([dx, dz]) => open(dx, dz) && open(-dx, -dz)) || dirs.find(([dx, dz]) => open(dx, dz))
  if (!dir) return 0
  await bot.lookAt(bot.entity.position.offset(dir[0] * 4, 2.2, dir[1] * 4), true)
  let tossed = 0
  for (const name of [...new Set(bot.inventory.items().map(i => i.name))]) {
    const keep = LIMIT[name] ?? (JUNK.test(name) ? 0 : null)
    if (keep === null) continue
    let extra = count(bot, name) - keep
    for (const it of bot.inventory.items().filter(i => i.name === name)) {
      if (extra <= 0) break
      const n = Math.min(it.count, extra)
      await bot.toss(it.type, null, n).catch(() => {})
      extra -= n
      tossed += n
    }
  }
  if (tossed) log.info(`inventário: joguei fora ${tossed} itens de lixo (livres: ${freeSlots(bot)})`)
  if (tossed) await nav.goto(bot, nav.nearXZ(p.x - dir[0] * 7, p.z - dir[1] * 7, 2), { timeout: 15000 }).catch(() => {})
  return tossed
}

// Mochila cheia de coisa que não é lixo: perto do baú da base, guarda o excedente. Fica só o que a
// missão usa (ferramentas, armadura, comida, material do procriador, gravetos pras trocas).
const CARRY = [
  [/_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$|^(shield|bow|shears|flint_and_steel)$/, 99],
  [/^(golden_carrot|cooked_beef|cooked_porkchop|bread|baked_potato|cooked_chicken|cooked_mutton|mutton|beef|porkchop|chicken)$/, 64],
  [/^cobblestone$/, 192], [/^stick$/, 64], [/_log$/, 16], [/_planks$/, 16], [/^torch$/, 32], [/_bed$/, 3],
  [/^(composter|crafting_table|chest|furnace)$/, 2], [/_fence_gate$/, 2], [/_slab$/, 6], [/^(wheat_seeds|carrot|potato|wheat)$/, 24],
  [/^(emerald|diamond|iron_ingot|coal|charcoal|flint|string|white_wool|.*_wool)$/, 64]
]
const carryLimit = (name) => (CARRY.find(([re]) => re.test(name)) || [null, 0])[1]

async function depositSurplus (bot) {
  const c = memory.state.base?.chest
  if (!c || freeSlots(bot) >= 4) return 0
  const pos = new Vec3(c.x, c.y, c.z)
  if (bot.entity.position.distanceTo(pos) > 32) return 0
  await nav.goto(bot, nav.near(pos, 3), { timeout: 60000 })
  const block = bot.blockAt(pos)
  if (!block || !/chest|barrel/.test(block.name)) return 0
  const plan = {}
  for (const it of bot.inventory.items()) {
    const extra = count(bot, it.name) - carryLimit(it.name)
    if (extra > 0) plan[it.name] = { type: it.type, n: extra }
  }
  const win = await withTimeout(bot.openContainer(block), 8000)
  let stored = 0
  try {
    for (const [name, { type, n }] of Object.entries(plan)) {
      await win.deposit(type, null, n).then(() => { stored += n }).catch(e => log.warn(`guardar ${name}:`, e.message))
    }
  } finally { win.close() }
  if (stored) { log.info(`inventário: guardei ${stored} itens excedentes no baú da base`); memory.history(`guardei excedente no baú da base: ${Object.keys(plan).join(', ')}`) }
  return stored
}

// Abre espaço onde estiver (túmulo longe do baú): lixo primeiro, depois o que passa do limite de carga,
// por último pedra/troncos até 64. Perder pedregulho é melhor que deixar a armadura no túmulo.
async function makeRoom (bot, want = 10) {
  await dropJunk(bot, want)
  if (freeSlots(bot) >= want) return freeSlots(bot)
  const limits = [(name) => carryLimit(name), (name) => /^(cobblestone|.*_log|.*_planks|stick)$/.test(name) ? 0 : carryLimit(name)]
  for (const limit of limits) {
    for (const name of [...new Set(bot.inventory.items().map(i => i.name))]) {
      if (freeSlots(bot) >= want) break
      let extra = count(bot, name) - limit(name)
      for (const it of bot.inventory.items().filter(i => i.name === name)) {
        if (extra <= 0) break
        const n = Math.min(it.count, extra)
        await bot.toss(it.type, null, n).catch(() => {})
        extra -= n
      }
    }
    await new Promise(r => setTimeout(r, 400))
  }
  log.info(`inventário: abri espaço para o túmulo (livres: ${freeSlots(bot)})`)
  return freeSlots(bot)
}

// Confere os baús do agente (atualiza o registro de estoque; pedido pelo painel).
async function checkChests (bot, signal) {
  const s = memory.state
  const known = new Map()
  for (const c of Object.values(s.chests || {})) known.set(`${c.x},${c.y},${c.z}`, c)
  for (const c of [s.stash, s.base?.chest]) if (c) known.set(`${c.x},${c.y},${c.z}`, c)
  let seen = 0
  for (const [k, c] of known) {
    if (signal?.aborted) break
    const pos = new Vec3(c.x, c.y, c.z)
    if (bot.entity.position.distanceTo(pos) > 160) continue
    for (let i = 0; i < 3 && bot.entity.position.distanceTo(pos) > 4; i++) {
      await nav.goto(bot, nav.near(pos, 3), { timeout: 120000, signal }).catch(e => { if (e.code === 'aborted') throw e })
    }
    const block = bot.blockAt(pos)
    if (!block || !/chest|barrel/.test(block.name)) { require('../stock').forget(k); continue }
    const win = await withTimeout(bot.openContainer(block), 8000)
    win.close()
    seen++
  }
  log.info(`estoque: conferi ${seen} baú(s)`)
  return seen
}

// Pega do baú da casa (base.chest) itens que casam com re, até n. Retorna quanto pegou.
async function take (bot, re, n) {
  const c = memory.state.base?.chest
  if (!c) return 0
  const pos = new Vec3(c.x, c.y, c.z)
  if (bot.entity.position.distanceTo(pos) > 64) return 0
  await nav.goto(bot, nav.near(pos, 3), { timeout: 60000 })
  const block = bot.blockAt(pos)
  if (!block || !/chest|barrel/.test(block.name)) return 0
  const win = await withTimeout(bot.openContainer(block), 8000)
  let got = 0
  try {
    for (const it of win.containerItems().filter(i => re.test(i.name))) {
      if (got >= n) break
      const k = Math.min(it.count, n - got)
      await win.withdraw(it.type, null, k).then(() => { got += k }).catch(() => {})
    }
  } finally { win.close() }
  if (got) log.info(`baú da casa: peguei ${got} (${re.source})`)
  return got
}

module.exports = { take, ensureBaseChest, deposit, stashValuables, needsStash, restockFood, withdraw, dropJunk, freeSlots, checkChests, depositSurplus, makeRoom }
