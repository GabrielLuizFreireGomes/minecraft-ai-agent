const { Vec3, sleep, count, StepError, withTimeout, LOGS, PLANKS } = require('./util')
const nav = require('./nav')
const log = require('../log')

// Coloca um bloco do inventário perto do bot, num chão sólido livre.
async function placeNear (bot, itemName) {
  const item = bot.inventory.items().find(i => i.name === itemName)
  if (!item) throw new StepError('missing_item', `sem ${itemName}`)
  const base = bot.entity.position.floored()
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [1, -1], [-1, 1]]
  for (const dy of [0, 1, -1]) {
    for (const [dx, dz] of offsets) {
      const target = base.offset(dx, dy, dz)
      const below = bot.blockAt(target.offset(0, -1, 0))
      const at = bot.blockAt(target)
      const above = bot.blockAt(target.offset(0, 1, 0))
      if (!below || !at || below.boundingBox !== 'block' || at.name !== 'air') continue
      if (!above || above.name !== 'air' && dy === 0) continue
      try {
        await bot.equip(item, 'hand')
        await bot.lookAt(target.offset(0.5, 0, 0.5))
        await bot.placeBlock(below, new Vec3(0, 1, 0))
        await sleep(250)
        const placed = bot.blockAt(target)
        if (placed?.name === itemName) return placed
      } catch (e) { log.warn('placeNear', itemName, e.message) }
    }
  }
  throw new StepError('cant_place', `não achei lugar para ${itemName}`)
}

async function getTable (bot) {
  const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 24 })
  if (table) {
    await nav.goto(bot, nav.near(table.position, 3), { timeout: 40000 })
    return table
  }
  if (!count(bot, 'crafting_table')) await craft(bot, 'crafting_table', 1)
  return placeNear(bot, 'crafting_table')
}

const NEEDS_TABLE = new Set(['wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel',
  'furnace', 'chest', 'fletching_table', 'diamond_pickaxe', 'diamond_axe', 'diamond_sword', 'diamond_shovel', 'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'iron_pickaxe', 'iron_sword', 'iron_axe', 'bread', 'shield', 'bucket'])

// Garante insumos básicos: tábuas a partir de troncos, gravetos a partir de tábuas.
// Receitas do prismarine-recipe usam um tipo de tábua só; conta o maior estoque de um mesmo tipo.
const bestPlank = (bot) => {
  const by = {}
  for (const i of bot.inventory.items()) if (PLANKS.test(i.name)) by[i.name] = (by[i.name] || 0) + i.count
  return Object.entries(by).sort((a, b) => b[1] - a[1])[0] || [null, 0]
}

async function ensurePlanks (bot, n) {
  for (let guard = 0; bestPlank(bot)[1] < n && guard < 20; guard++) {
    const logs = bot.inventory.items().filter(i => LOGS.test(i.name)).sort((a, b) => count(bot, b.name) - count(bot, a.name))
    if (!logs.length) throw new StepError('need_logs', 'sem troncos para tábuas')
    const plank = logs[0].name.replace(/^stripped_/, '').replace(/_(log|stem|wood|hyphae)$/, '_planks')
    const have = count(bot, plank)
    // troncos de tipos misturados: só o que existe deste tipo; a próxima volta usa outro tipo
    await craftRaw(bot, plank, Math.min(logs[0].count, count(bot, logs[0].name), Math.ceil((n - have) / 4)), null)
  }
}

async function ensureSticks (bot, n) {
  if (count(bot, 'stick') >= n) return
  await ensurePlanks(bot, Math.ceil((n - count(bot, 'stick')) / 4) * 2)
  await craftRaw(bot, 'stick', Math.ceil((n - count(bot, 'stick')) / 4), null)
}

async function craftRaw (bot, name, times, table) {
  const item = bot.registry.itemsByName[name]
  if (!item) throw new StepError('unknown_item', name)
  const recipe = bot.recipesFor(item.id, null, 1, table)[0]
  if (!recipe) throw new StepError('no_recipe', `sem receita/insumos para ${name}`)
  for (let i = 0; i < times; i++) await manualCraft(bot, recipe, table)
}

// bot.craft do mineflayer dessincroniza na 26.2 (o servidor reenvia a janela a cada clique e as
// receitas com 2+ ingredientes ficam pela metade). Aqui: um clique por vez, esperando o servidor.
async function manualCraft (bot, recipe, table) {
  // mochila cheia: o resultado não tem pra onde ir e o shift-clique trava (escudo falhou assim)
  if (bot.inventory.emptySlotCount() < 2) await require('./storage').makeRoom(bot, 3)
  // janela anterior ainda aberta/fechando: a 2ª peça seguida saía "vazia" (abria antes do servidor fechar a outra)
  if (bot.currentWindow) { bot.closeWindow(bot.currentWindow); await sleep(400) }
  const win = table ? await withTimeout(bot.openBlock(table), 8000, 'table_open') : bot.inventory
  if (table) await sleep(250) // servidor manda o conteúdo da mesa logo depois de abrir
  const width = table ? 3 : 2
  const settle = () => sleep(250)
  try {
    const targets = new Map() // itemId -> [gridSlot]
    if (recipe.inShape) {
      recipe.inShape.forEach((row, y) => row.forEach((ing, x) => {
        if (!ing || ing.id < 0) return
        if (!targets.has(ing.id)) targets.set(ing.id, [])
        targets.get(ing.id).push(1 + x + y * width)
      }))
    } else {
      let slot = 1
      for (const ing of recipe.ingredients || []) {
        if (!targets.has(ing.id)) targets.set(ing.id, [])
        targets.get(ing.id).push(slot++)
      }
    }
    for (const [id, slots] of targets) {
      // o item pode estar dividido em várias pilhas (tábuas 1 + 1 + 7): usa uma pilha de cada vez
      const total = win.slots.reduce((n, it, idx) => n + (idx >= win.inventoryStart && it?.type === id ? it.count : 0), 0)
      if (total < slots.length) throw new StepError('missing_item', `sem ${bot.registry.items[id]?.name} suficiente`)
      const remaining = [...slots]
      while (remaining.length) {
        const src = win.slots.findIndex((it, idx) => idx >= win.inventoryStart && it && it.type === id)
        if (src < 0) throw new StepError('missing_item', `sem ${bot.registry.items[id]?.name} suficiente`)
        const take = Math.min(win.slots[src].count, remaining.length)
        await bot.clickWindow(src, 0, 0); await settle() // pega a pilha
        for (const g of remaining.splice(0, take)) { await bot.clickWindow(g, 1, 0); await settle() } // solta 1 em cada
        if (win.selectedItem) { await bot.clickWindow(src, 0, 0); await settle() } // devolve o resto
      }
    }
    // o servidor 26.2 às vezes demora pra mostrar o resultado (escudo falhava na 1ª tentativa)
    for (let i = 0; i < 8 && win.slots[0]?.type !== recipe.result.id; i++) await sleep(200)
    const result = win.slots[0]
    if (!result || result.type !== recipe.result.id) throw new StepError('craft_failed', `resultado errado: ${result?.name || 'vazio'}`)
    await bot.clickWindow(0, 0, 1) // shift-clique: resultado vai pro inventário
    await sleep(400)
  } finally {
    if (table) { bot.closeWindow(win); await sleep(400) }
  }
}

const INPUTS = {
  crafting_table: { planks: 4 },
  stick: { planks: 2 },
  wooden_pickaxe: { planks: 3, stick: 2 },
  wooden_axe: { planks: 3, stick: 2 },
  wooden_sword: { planks: 2, stick: 1 },
  stone_pickaxe: { cobblestone: 3, stick: 2 },
  stone_axe: { cobblestone: 3, stick: 2 },
  stone_sword: { cobblestone: 2, stick: 1 },
  stone_shovel: { cobblestone: 1, stick: 2 },
  furnace: { cobblestone: 8 },
  chest: { planks: 8 },
  fletching_table: { planks: 4, flint: 2 },
  diamond_pickaxe: { diamond: 3, stick: 2 },
  diamond_axe: { diamond: 3, stick: 2 },
  diamond_sword: { diamond: 2, stick: 1 },
  diamond_shovel: { diamond: 1, stick: 2 },
  diamond_helmet: { diamond: 5 },
  diamond_chestplate: { diamond: 8 },
  diamond_leggings: { diamond: 7 },
  diamond_boots: { diamond: 4 }
}

// Craft de alto nível: resolve tábuas/gravetos/mesa automaticamente.
async function craft (bot, name, n = 1) {
  const before = count(bot, name)
  const need = INPUTS[name]
  const yieldPer = name === 'stick' ? 4 : 1
  const times = Math.ceil(n / yieldPer)
  if (name === 'stick') return ensureSticks(bot, before + n)
  // mesa ANTES dos insumos: feita depois, ela gastava as tábuas separadas (no_recipe em picareta e cama)
  const table = NEEDS_TABLE.has(name) ? await getTable(bot) : null
  if (need?.stick) await ensureSticks(bot, need.stick * times)
  if (need?.planks) await ensurePlanks(bot, need.planks * times)
  await craftRaw(bot, name, times, table)
  // o servidor confirma o slot com atraso; espera antes de declarar falha
  for (let i = 0; i < 20 && count(bot, name) <= before; i++) await sleep(100)
  if (count(bot, name) <= before) throw new StepError('craft_failed', name)
  log.info(`craft: ${name} x${n}`)
}

// Craft genérico por nome quando os insumos já estão no inventário; usa a mesa só se precisar.
async function craftNamed (bot, name, times = 1) {
  const item = bot.registry.itemsByName[name]
  if (!item) throw new StepError('unknown_item', name)
  const before = count(bot, name)
  let table = null
  let recipe = bot.recipesFor(item.id, null, 1, null)[0]
  if (!recipe) {
    table = await getTable(bot)
    recipe = bot.recipesFor(item.id, null, 1, table)[0]
  }
  if (!recipe) throw new StepError('no_recipe', `sem receita/insumos para ${name}`)
  for (let i = 0; i < times; i++) await manualCraft(bot, recipe, table)
  for (let i = 0; i < 20 && count(bot, name) <= before; i++) await sleep(100)
  if (count(bot, name) <= before) throw new StepError('craft_failed', name)
  log.info(`craft: ${name} x${count(bot, name) - before}`)
}

// Tipo de madeira mais abundante (para escolher a variante da receita: oak_slab, oak_fence_gate...).
function woodType (bot) {
  const by = {}
  for (const i of bot.inventory.items()) {
    const m = i.name.match(/^(?:stripped_)?(\w+?)_(log|planks|stem)$/)
    if (m) by[m[1]] = (by[m[1]] || 0) + i.count * (m[2] === 'planks' ? 1 : 4)
  }
  return Object.entries(by).sort((a, b) => b[1] - a[1])[0]?.[0] || 'oak'
}

module.exports = { craft, craftNamed, woodType, placeNear, getTable, ensurePlanks, ensureSticks, INPUTS }
