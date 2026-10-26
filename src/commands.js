// Comandos autorizados do servidor (/sethome, /home, /tpa...). Descobre por tentativa e registra no vault.
const { sleep } = require('./skills/util')
const memory = require('./memory')
const log = require('./log')

function collectReplies (bot, ms) {
  const lines = []
  const on = (l) => lines.push(l.replace(/§./g, ''))
  bot.on('messagestr', on)
  return sleep(ms).then(() => { bot.removeListener('messagestr', on); return lines })
}

function record (name, ok, reply) {
  const cmds = memory.state.server.commands
  const prev = cmds[name]
  cmds[name] = { ok, reply: (reply || '').slice(0, 120), at: new Date().toISOString() }
  memory.save()
  if (!prev || prev.ok !== ok) memory.serverNote(`/${name}: ${ok ? 'funciona' : 'não funciona'} — "${(reply || '').slice(0, 80)}"`)
}

const unknown = /desconhecido|unknown|não existe|nao existe|sem permiss|no permission|don't have permission|not allowed/i

async function trySetHome (bot) {
  if (memory.state.server.commands.sethome?.ok === false) return false
  const wait = collectReplies(bot, 3000)
  bot.chat('/sethome base')
  const lines = await wait
  const ok = !lines.some(l => unknown.test(l)) && lines.some(l => /home|casa|definid|set/i.test(l))
  record('sethome', ok, lines[0])
  return ok
}

// Teleporte legítimo via /home do servidor quando o destino está longe.
async function tryHome (bot, target) {
  const s = memory.state
  if (!s.base || s.server.commands.home?.ok === false || s.server.commands.sethome?.ok !== true) return false
  // /home base cai dentro da casa infestada; só vale com as peças do golem na mão (volta pra montar)
  const golemParts = bot.inventory.items().some(i => i.name === 'carved_pumpkin') && bot.inventory.items().filter(i => i.name === 'iron_block').reduce((n, i) => n + i.count, 0) >= 4
  if (s.home?.infested && !golemParts) return false
  // só compensa se a base deixa o bot bem mais perto do destino (sem destino = voltar pra base)
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  if (target && (flat(bot.entity.position, target) < 200 || flat(s.base, target) > flat(bot.entity.position, target) - 150)) return false
  if (!target && flat(bot.entity.position, s.base) < 150) return false
  // de noite a base vira armadilha (respawn na cama + zumbis): teleporte só de dia
  const t = bot.time?.timeOfDay ?? 0
  if (t >= 12542 && t <= 23460) return false
  const from = bot.entity.position.clone()
  const wait = collectReplies(bot, 8000)
  bot.chat('/home base')
  const lines = await wait
  const moved = bot.entity.position.distanceTo(from) > 30
  record('home', moved, lines[0])
  if (moved) log.info('home: teleportado para a base')
  return moved
}

// Comandos de plugin que o bot pode rodar sozinho (informativos e homes dele). Nada de senha/conta,
// nada de mexer em homes do dono (portal, roger, home).
const ALLOWED = /^\/(listhomes|kits|kit\s+\w+|graves|grave|rexgraves\s+(list|locate|tp\s+\d+)|rpg(\s+\w+)?|srpg(\s+\w+)?|solaris\s+(skills|attributes)|backpack|bp|help(\s+\w+)?|pl|plugins|home\s+(base|casaclaude)|sethome\s+base|delhome\s+casaclaude)$/i
const OWNER_HOMES = /^(portal|roger|home)$/i

// Texto puro de componente de chat (string JSON, objeto ou NBT {type, value}).
function text (v, depth = 0) {
  if (v == null || depth > 12) return ''
  if (typeof v === 'string') {
    if (depth < 2 && /^[[{]/.test(v)) { try { return text(JSON.parse(v), depth + 1) } catch {} }
    return v.replace(/§./g, '')
  }
  if (Array.isArray(v)) return v.slice(0, 40).map(x => text(x, depth + 1)).join(' ').trim()
  if (typeof v === 'object') {
    if ('type' in v && 'value' in v) return text(v.value, depth + 1)
    return [v.text, v.extra].map(x => text(x, depth + 1)).join('').trim()
  }
  return ''
}

async function run (bot, cmd) {
  cmd = String(cmd || '').trim()
  if (!ALLOWED.test(cmd)) return { ok: false, motivo: 'comando fora da lista permitida' }
  const home = cmd.match(/^\/(?:home|sethome|delhome)\s+(\w+)/i)
  if (home && OWNER_HOMES.test(home[1])) return { ok: false, motivo: 'home do dono' }
  const wait = collectReplies(bot, 2500)
  let win = null
  const onWin = (w) => { win = w }
  bot.once('windowOpen', onWin)
  bot.chat(cmd)
  const lines = (await wait).filter(l => l.trim())
  bot.removeListener('windowOpen', onWin)
  // comandos de menu (kits, mochila) abrem uma janela: registra o que tem e fecha
  let menu = null
  if (win && process.env.DUMP_MENU === '1') {
    require('fs').writeFileSync(require('path').join(__dirname, '..', 'data', 'menu-dump.json'), JSON.stringify({ title: win.title, slots: win.slots.slice(0, win.inventoryStart).filter(Boolean).map(i => ({ slot: i.slot, name: i.name, components: i.components })) }))
    bot.closeWindow(win)
    return { ok: true, cmd, lines, dumped: true }
  }
  if (win) {
    menu = {
      title: text(win.title).slice(0, 120),
      items: win.slots.slice(0, win.inventoryStart).filter(Boolean).map(i => {
        const lore = (i.components || []).find(c => c.type === 'lore')
        const desc = lore ? text(lore.data).slice(0, 160) : ''
        return { slot: i.slot, item: i.name, name: text(i.customName) || i.name, desc }
      }).filter(i => !/glass_pane$/.test(i.item)).slice(0, 54)
    }
    bot.closeWindow(win)
  }
  const name = cmd.slice(1).split(/\s+/)[0].toLowerCase()
  record(name, !lines.some(l => unknown.test(l)), lines.join(' | '))
  return { ok: true, cmd, lines, menu }
}

// Túmulo longe: o RexGraves teleporta até ele (/rexgraves tp <n>). O índice vem de /rexgraves list,
// na ordem em que aparecem; escolhe o túmulo mais perto das coordenadas guardadas.
async function graveTp (bot, pos) {
  if (memory.state.server.commands.rexgraves_tp?.ok === false) return false
  const r = await run(bot, '/rexgraves list')
  const graves = []
  for (const l of r.lines || []) {
    const m = l.match(/(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/)
    if (m) graves.push({ x: +m[1], y: +m[2], z: +m[3], line: l })
  }
  if (!graves.length) return false
  let idx = 0
  graves.forEach((g, i) => { if (Math.hypot(g.x - pos.x, g.z - pos.z) < Math.hypot(graves[idx].x - pos.x, graves[idx].z - pos.z)) idx = i })
  const from = bot.entity.position.clone()
  const wait = collectReplies(bot, 6000)
  bot.chat(`/rexgraves tp ${idx + 1}`)
  const lines = await wait
  const moved = bot.entity.position.distanceTo(from) > 20
  record('rexgraves_tp', moved, lines.join(' | ') || graves[idx].line)
  if (moved) log.info(`túmulo: teleportado pelo /rexgraves tp ${idx + 1}`)
  return moved
}

// Kit grátis do OrbitKits (/kits): clica nos que estiverem prontos para resgatar.
async function claimKits (bot) {
  const s = memory.state.server
  if (s.kitNextTry && Date.now() < s.kitNextTry) return 0
  s.kitNextTry = Date.now() + 30 * 60000
  let claimed = 0
  let onOpen
  const opened = new Promise(resolve => { onOpen = resolve; bot.once('windowOpen', resolve) })
  bot.chat('/kits')
  const win = await Promise.race([opened, sleep(4000).then(() => null)])
  bot.removeListener('windowOpen', onOpen)
  if (!win) return 0
  try {
    for (const it of win.slots.slice(0, win.inventoryStart).filter(Boolean)) {
      const lore = (it.components || []).find(c => c.type === 'lore')
      if (!/ready to claim|click to claim|resgatar/i.test(text(lore?.data))) continue
      await bot.clickWindow(it.slot, 0, 0).catch(() => {})
      await sleep(600)
      claimed++
      memory.history(`kit resgatado: ${text(it.customName) || it.name}`)
    }
  } finally { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) }
  if (claimed) log.info(`kits: resgatei ${claimed}`)
  memory.save()
  return claimed
}

module.exports = { trySetHome, tryHome, collectReplies, run, graveTp, claimKits }
