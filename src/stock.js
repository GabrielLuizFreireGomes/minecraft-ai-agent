// Estoque geral: inventário ao vivo + o que o bot viu dentro dos baús dele (state.chests).
// Cada vez que o bot abre um baú, o conteúdo é registrado ao abrir e de novo ao fechar,
// então o painel e as etapas sabem o que tem guardado sem ir até lá.
const memory = require('./memory')

const key = (p) => `${p.x},${p.y},${p.z}`
const tally = (items) => {
  const out = {}
  for (const i of items) out[i.name] = (out[i.name] || 0) + i.count
  return out
}

function record (pos, win, dim) {
  const s = memory.state
  s.chests = s.chests || {}
  const items = win.containerItems ? win.containerItems() : win.slots.slice(0, win.inventoryStart).filter(Boolean)
  const prev = s.chests[key(pos)] || {}
  s.chests[key(pos)] = { x: pos.x, y: pos.y, z: pos.z, dim, label: prev.label || label(pos), items: tally(items), seenAt: new Date().toISOString() }
  memory.save()
}

function label (pos) {
  const s = memory.state
  const same = (p) => p && p.x === pos.x && p.y === pos.y && p.z === pos.z
  if (same(s.stash)) return 'baú do agente (valiosos)'
  if (same(s.base?.chest)) return 'baú da base'
  const place = (s.places || []).find(same)
  return place?.name || 'baú'
}

// Liga o registro em todo openContainer (usado por storage.js e por qualquer etapa).
function attach (bot) {
  const open = bot.openContainer.bind(bot)
  bot.openContainer = async (block, ...rest) => {
    const win = await open(block, ...rest)
    const pos = block.position || block
    if (/chest|barrel|shulker/.test(block.name || '')) {
      const dim = bot.game.dimension
      record(pos, win, dim)
      const close = win.close.bind(win)
      win.close = () => { try { record(pos, win, dim) } catch {} return close() }
    }
    return win
  }
}

function forget (k) {
  if (memory.state.chests?.[k]) { delete memory.state.chests[k]; memory.save() }
}

// Quanto existe de um item somando inventário e baús registrados.
function total (bot, name) {
  const inv = bot ? bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0) : 0
  const stored = Object.values(memory.state.chests || {}).reduce((n, c) => n + (c.items[name] || 0), 0)
  return { inv, stored, all: inv + stored }
}

// Visão para o painel/planner: itens agrupados por categoria.
const CATS = [
  ['valiosos', /diamond$|emerald|netherite|gold_ingot|iron_ingot|lapis|redstone|totem|elytra|ancient_debris/],
  ['comida', /carrot|beef|pork|mutton|chicken|bread|potato|apple|cod|salmon|rabbit|stew|berries|melon_slice|cookie|pie/],
  ['ferramentas e armas', /_(pickaxe|axe|shovel|hoe|sword)$|^(bow|crossbow|shield|shears|flint_and_steel|fishing_rod|trident)$/],
  ['armadura', /_(helmet|chestplate|leggings|boots)$/],
  ['blocos', /cobble|stone|dirt|granite|andesite|diorite|planks|log|sand|gravel|deepslate|slab|tuff|glass|wool$/],
  ['construção do procriador', /bed$|composter|fence_gate|torch|seeds|wheat|crafting_table|chest$|furnace/]
]
const catOf = (name) => (CATS.find(([, re]) => re.test(name)) || ['outros'])[0]

function view (bot) {
  const inventory = bot ? tally(bot.inventory.items()) : {}
  const armor = bot ? [5, 6, 7, 8].map(s => bot.inventory.slots[s]).filter(Boolean).map(i => i.name) : []
  for (const a of armor) inventory[a] = (inventory[a] || 0) + 1
  const chests = Object.entries(memory.state.chests || {}).map(([k, c]) => ({ key: k, ...c }))
  const totals = { ...inventory }
  for (const c of chests) for (const [n, q] of Object.entries(c.items)) totals[n] = (totals[n] || 0) + q
  const rows = Object.entries(totals).map(([name, all]) => ({
    name,
    cat: catOf(name),
    inv: inventory[name] || 0,
    stored: all - (inventory[name] || 0),
    all,
    worn: armor.includes(name)
  })).sort((a, b) => a.cat.localeCompare(b.cat) || b.all - a.all)
  return {
    online: !!bot?.entity,
    slots: bot ? { used: 36 - bot.inventory.emptySlotCount(), total: 36 } : null,
    rows,
    chests: chests.map(c => ({ key: c.key, label: c.label, pos: [c.x, c.y, c.z], seenAt: c.seenAt, kinds: Object.keys(c.items).length, count: Object.values(c.items).reduce((a, b) => a + b, 0) }))
  }
}

module.exports = { attach, record, total, view, forget, catOf }
