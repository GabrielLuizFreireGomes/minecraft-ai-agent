// Construção bloco a bloco: posiciona-se ao alcance, acha face de apoio e coloca. Só remove blocos naturais.
const { Vec3, sleep, count, StepError, withTimeout } = require('./util')
const nav = require('./nav')
const log = require('../log')

// Blocos naturais que podem ser removidos para construir (nunca construções).
const NATURAL = /^(air|cave_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|grass_block|dirt|coarse_dirt|podzol|stone|andesite|diorite|granite|deepslate|tuff|gravel|sand|red_sand|clay|.*_leaves|.*_log|.*_flower|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|sweet_berry_bush|vine|moss_carpet|moss_block|seagrass|pink_petals|leaf_litter|bush|firefly_bush|short_dry_grass|tall_dry_grass|wildflowers)$/
const REPLACEABLE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|seagrass|water|pink_petals|leaf_litter|bush|firefly_bush|short_dry_grass|tall_dry_grass|wildflowers|.*_flower|dandelion|poppy)$/
const SOLID_FLOOR = (b) => b && b.boundingBox === 'block' && !/leaves|water|lava/.test(b.name)

// Grupos de material intercambiável (ex.: qualquer pedregulho serve para parede).
const GROUPS = {
  wall: /^(cobblestone|cobbled_deepslate|stone_bricks|stone|deepslate)$/,
  support: /^(dirt|cobblestone|cobbled_deepslate|netherrack)$/
}

function itemFor (bot, want) {
  const re = GROUPS[want]
  return bot.inventory.items().find(i => re ? re.test(i.name) : i.name === want)
}

// Altura do chão (y do bloco sólido mais alto) numa coluna, procurando a partir de yHint.
function surfaceY (bot, x, z, yHint) {
  for (let y = yHint + 6; y >= yHint - 8; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (SOLID_FLOOR(b) && !/_log$/.test(b.name)) return y
  }
  return null
}

const FACES = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]

async function clearAt (bot, pos) {
  const b = bot.blockAt(pos)
  if (!b || REPLACEABLE.test(b.name)) return
  if (!NATURAL.test(b.name)) throw new StepError('blocked', `bloco de construção em ${pos}: ${b.name}`)
  await nav.goto(bot, new nav.goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), { timeout: 30000 }).catch(() => {})
  await bot.tool.equipForBlock(b, {}).catch(() => {})
  await bot.dig(b)
}

// Coloca `want` (nome ou grupo) em pos. opts.yaw: direção para camas/portões.
async function placeAt (bot, pos, want, opts = {}) {
  const cur = bot.blockAt(pos)
  if (cur && (GROUPS[want] ? GROUPS[want].test(cur.name) : cur.name === want)) return false
  if (cur && !REPLACEABLE.test(cur.name)) await clearAt(bot, pos)
  const item = itemFor(bot, want)
  if (!item) throw new StepError('missing_item', `sem ${want} para construir`)
  // fica ao alcance sem ocupar o lugar do bloco
  const me = bot.entity.position
  const inside = Math.abs(me.x - (pos.x + 0.5)) < 0.9 && Math.abs(me.z - (pos.z + 0.5)) < 0.9 && me.y > pos.y - 2 && me.y < pos.y + 1
  if (me.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2 || inside) {
    await nav.goto(bot, new nav.goals.GoalPlaceBlock(pos, bot.world, { range: 4 }), { timeout: 40000 })
  }
  let ref = null
  let face = null
  for (const f of FACES) {
    const r = bot.blockAt(pos.plus(f))
    if (r && r.boundingBox === 'block') { ref = r; face = f.scaled(-1); break }
  }
  if (!ref) {
    // sem apoio: coloca um bloco de suporte embaixo primeiro
    await placeAt(bot, pos.offset(0, -1, 0), 'support')
    ref = bot.blockAt(pos.offset(0, -1, 0))
    face = new Vec3(0, 1, 0)
  }
  await bot.equip(item, 'hand')
  // o reflexo de defesa pode ter trocado pra espada no meio (tentava 'colocar stone_sword'): reconfere
  if (bot.heldItem?.name !== item.name) { await bot.equip(itemFor(bot, want) || item, 'hand').catch(() => {}) }
  if (bot.heldItem?.name !== item.name && !(GROUPS[want] && GROUPS[want].test(bot.heldItem?.name || ''))) throw new StepError('place_failed', `mão com ${bot.heldItem?.name} em vez de ${want}`)
  if (opts.yaw !== undefined) {
    await bot.look(opts.yaw, 0, true)
    await bot._genericPlace(ref, face, { forceLook: 'ignore', swingArm: 'right' })
  } else {
    await bot.placeBlock(ref, face).catch(e => { if (!/blockUpdate|did not fire/i.test(e.message)) throw e })
  }
  await sleep(120)
  const now = bot.blockAt(pos)
  const ok = now && (GROUPS[want] ? GROUPS[want].test(now.name) : now.name.includes(want.replace(/_item$/, '')))
  if (!ok) throw new StepError('place_failed', `não coloquei ${want} em ${pos} (ficou ${now?.name})`)
  return true
}

// Constrói uma lista de {pos, want, yaw?}; de baixo para cima e do mais perto para o mais longe.
// ordered: mantém a ordem da lista (teto de fora pra dentro, senão ele põe apoio dentro da sala)
async function buildList (bot, list, { signal, label = 'obra', ordered = false } = {}) {
  const todo = ordered ? list : [...list].sort((a, b) => a.pos.y - b.pos.y || a.pos.distanceTo(bot.entity.position) - b.pos.distanceTo(bot.entity.position))
  let placed = 0
  let fails = 0
  for (const t of todo) {
    if (signal?.aborted) throw new StepError('aborted')
    try {
      if (await placeAt(bot, t.pos, t.want, t)) placed++
    } catch (e) {
      if (e.code === 'missing_item' || e.code === 'blocked') throw e
      log.warn(`${label}: ${e.message}`)
      if (++fails > Math.max(6, list.length / 5)) throw new StepError('build_failed', `${label}: muitas falhas`)
    }
  }
  log.info(`${label}: ${placed} blocos colocados`)
  return placed
}

// Quantos itens do grupo/nome ainda faltam para a lista.
function missing (bot, list) {
  const need = {}
  for (const t of list) {
    const cur = bot.blockAt(t.pos)
    if (cur && (GROUPS[t.want] ? GROUPS[t.want].test(cur.name) : cur.name === t.want)) continue
    need[t.want] = (need[t.want] || 0) + 1
  }
  const out = {}
  for (const [want, n] of Object.entries(need)) {
    const have = GROUPS[want] ? count(bot, GROUPS[want]) : count(bot, want)
    if (have < n) out[want] = n - have
  }
  return out
}

module.exports = { placeAt, clearAt, buildList, missing, surfaceY, NATURAL, REPLACEABLE, GROUPS, SOLID_FLOOR }
