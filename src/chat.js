// Respostas no chat "como o dono": pt-br, minúsculas, curtas. Nunca inicia conversa.
// Regras locais primeiro; Claude (Haiku) só para pergunta direta que as regras não cobrem.
const ai = require('./ai')
const log = require('./log')
const config = require('./config')

const STYLE = `você responde no chat do minecraft como o jogador ${config.username}.
regras: português brasileiro, tudo minúsculo, casual, curtíssimo (máx 8 palavras), sem emoji, sem pontuação formal, sem explicar.
nunca invente fatos pessoais, nunca passe senha, token, coordenada exata ou dado privado, nunca puxe assunto.
exemplos de estilo: "to fazendo uma farm aqui", "pera ai", "ja peguei", "n sei ainda", "to indo", "vou ver isso".
se não precisar responder, responda exatamente: -`

// Histórico curto em data/chat.json (últimas 200 linhas, ~30 KB): o bot lê só as últimas trocas com
// a pessoa como contexto e o painel mostra o trecho recente. Log bruto de pacotes só com DEBUG_CHAT=1.
const fs = require('fs')
const path = require('path')
const HIST = path.join(config.dataDir, 'chat.json')
const MAX = 200
let history = []
try { history = JSON.parse(fs.readFileSync(HIST, 'utf8')) } catch {}
let saveTimer = null
function remember (entry) {
  history.push({ at: new Date().toISOString(), ...entry })
  if (history.length > MAX) history = history.slice(-MAX)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => fs.writeFile(HIST, JSON.stringify(history), () => {}), 2000)
}
const recentChat = (n = 40) => history.slice(-n)
const withPlayer = (name, n = 6) => history.filter(h => h.from === name || h.to === name).slice(-n)

const aliases = [config.username.toLowerCase(), config.username.toLowerCase().replace(/\d+$/, ''), 'napo']

const rules = [
  [/\b(oq|o que|q) (vc|voce|vcs|tu)? ?(ta|tá|esta|está) fazendo|fazendo oq|fazendo o que/, c => c.activity ? `to ${c.activity}` : 'nada demais'],
  [/\b(ta|tá|esta|está) (ai|aí|on|online)\b|\bta ai\?|\bafk\b\?/, () => 'to'],
  [/^(oi+|ola|olá|eae+|eai|e ai|salve|fala|opa|bom dia|boa tarde|boa noite)\b/, c => c.greet],
  [/\b(vem|vem ca|vem cá|cola|bora|vamo|vamos)\b/, () => 'pera ai'],
  [/\b(me (da|dá|passa|empresta)|tem como (me )?(dar|passar))\b/, () => 'n posso agora'],
  [/\b(tem|vc tem|voce tem|tu tem) (\w+)/, (c, m) => c.hasItem(m[2]) ? 'tenho' : 'n tenho'],
  [/\b(onde|aonde) (vc|voce|tu) (ta|tá|esta|está)/, () => 'to por ai'],
  [/\b(obrigad|vlw|valeu|tmj)/, () => 'tmj'],
  [/\b(senha|password|token|login)\b/, () => 'n'],
  [/\b(quer|bora) (fazer|ir|jogar)/, () => 'agora n da'],
  [/\b(vai|consegue|pode) (fazer|ver|pegar)/, () => 'vou ver isso'],
  [/\b(ja|já) (pegou|fez|terminou)/, c => c.activity ? 'ainda n' : 'ja']
]

const SECRET = /(senha|password|token|bearer|\/login|\/register)/i

function sanitize (text) {
  if (!text) return null
  let t = text.split('\n')[0].toLowerCase()
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/["“”]/g, '').trim().replace(/[.!]+$/g, '').trim()
  if (!t || t === '-' || SECRET.test(t)) return null
  if (config.password && t.includes(config.password.toLowerCase())) return null
  return t.slice(0, 90)
}

// Extrai {from, text, whisper} de uma linha de chat qualquer (formatos de plugins variam).
function parse (line, players, me) {
  const clean = line.replace(/§./g, '').trim()
  // console do servidor (/say) também conta, para o dono testar
  const srv = clean.match(/^\[(Server|Servidor|Console)\]\s+(.+)$/i)
  if (srv) return { from: 'Server', text: srv[2], whisper: false }
  let m =clean.match(/^\[?([A-Za-z0-9_]{3,16}) ?(?:->|→|»|>) ?(?:me|eu|mim|você|voce)\]? ?:? (.+)$/i) ||
    clean.match(/^([A-Za-z0-9_]{3,16}) (?:te sussurrou|sussurrou|whispers(?: to you)?|disse a voce):? (.+)$/i)
  if (m && players[m[1]]) return { from: m[1], text: m[2], whisper: true }
  m = clean.match(/^(?:\[[^\]]*\]\s*|\S{1,3}\s+)*<?([A-Za-z0-9_]{3,16})>?\s*(?:»|:|>|\||-)?\s+(.+)$/)
  if (m && players[m[1]] && m[1] !== me) return { from: m[1], text: m[2], whisper: false }
  return null
}

const GREET = /^(oi+|ola|olá|eae+|eai|e ai|salve|fala|opa|bom dia|boa tarde|boa noite|iae|yo)\b/
const CLOSER = /^(k{2,}|ks+|rs+|ok+|blz|beleza|show|top|hm+|ah+|ata|dale|fechou|suave|tranquilo|isso|sim|n|nao|não|aham|uhum|entendi|vdd|pode crer)$/
const QUESTION = /\?|^(qual|quando|como|onde|aonde|pq|porque|por que|quem|quanto|quantos|cade|cadê|tem|ta|tá|vc|voce|você|tu)\b/
const YOU = /\b(vc|voce|você|tu|teu|tua|seu|sua|contigo|cê|ce)\b/
const REQUEST = /\b(vem|cola|bora|vamo|vamos|me (da|dá|passa|empresta|ajuda)|ajuda|pode|consegue|faz|traz)\b/

// Nota 0-100: a mensagem é comigo? e preciso responder? (sem IA; motivos ficam no log)
function score (msg, c) {
  const t = msg.text.toLowerCase().trim()
  const why = []
  let to = 0
  if (msg.whisper) { to = 100; why.push('privado') } else if (msg.from !== 'Server' && c.others.length <= 1) { to = 100; why.push('só nós dois online') } else {
    if (c.aliases.some(a => a.length >= 3 && t.includes(a))) { to += 90; why.push('meu nome') }
    if (c.sinceTalk < 60000) { to += 55; why.push('conversa em andamento') } else if (c.sinceTalk < 180000) { to += 30; why.push('conversa recente') }
    if (YOU.test(t)) { to += 20; why.push('2ª pessoa') }
    if (QUESTION.test(t)) { to += 10; why.push('pergunta') }
    if (c.dist !== null && c.dist < 16) { to += 20; why.push('perto de mim') }
    const other = c.others.find(n => n.toLowerCase() !== msg.from.toLowerCase() && n.length >= 3 && t.includes(n.toLowerCase().slice(0, Math.max(4, n.length - 2))))
    if (other) { to -= 70; why.push(`cita ${other}`) }
  }
  to = Math.max(0, Math.min(100, to))
  let need = 0
  if (CLOSER.test(t)) { need = 0; why.push('só fechamento') } else if (GREET.test(t) && t.split(/\s+/).length <= 3) {
    need = c.greetedRecently ? 5 : 70
    why.push(c.greetedRecently ? 'já cumprimentei' : 'cumprimento')
  } else {
    if (QUESTION.test(t)) { need += 60; why.push('quer resposta') }
    if (REQUEST.test(t)) { need += 50; why.push('pedido') }
    if (/\b(obrigad|vlw|valeu|tmj)/.test(t)) { need += 45; why.push('agradecimento') }
    if (need === 0 && to >= 90) { need = 25; why.push('falou comigo') }
  }
  need = Math.min(100, need)
  return { to, need, reply: to >= 60 && need >= 40, why }
}

function attach (bot, ctx) {
  const lastTo = new Map()
  const recent = []
  const talkingWith = new Map()
  const greeted = new Map()
  let lastSent = 0
  let busy = false

  function send (to, text) {
    const now = Date.now()
    const t = sanitize(text)
    if (!t) return
    if (now - lastSent < 3000) return
    if (now - (lastTo.get(to) || 0) < 4000) return
    while (recent.length && recent[0].at < now - 600000) recent.shift()
    if (recent.length >= 12) return
    if (recent.some(r => r.text === t && r.at > now - 120000)) return
    recent.push({ text: t, at: now })
    lastSent = now
    lastTo.set(to, now)
    talkingWith.set(to, now)
    if (GREET.test(t)) greeted.set(to, now)
    setTimeout(() => bot.chat(t), 1200 + Math.random() * 2500)
    log.info(`chat -> ${to}: ${t}`)
    remember({ from: bot.username, to, text: t, out: true })
  }

  // log bruto de chat (diagnóstico local; não sai do PC)
  const debug = process.env.DEBUG_CHAT === '1'
  const chatLog = path.join(config.dataDir, 'logs', `chat-${new Date().toISOString().slice(0, 10)}.log`)
  const raw = (s) => { if (debug) fs.appendFile(chatLog, `${new Date().toISOString()} ${s}\n`, () => {}) }
  if (debug) {
    for (const pk of ['player_chat', 'system_chat', 'profileless_chat']) {
      bot._client.on(pk, (d) => raw(`[pkt ${pk}] ${JSON.stringify(d).slice(0, 400)}`))
    }
  }

  // Neste servidor o plugin de chat manda mensagem de jogador como player_chat e o mineflayer
  // só entrega o texto puro (sem nome). Remetente vem do UUID do pacote.
  const seen = new Map()
  const dedupe = (m) => { const k = `${m.from}|${m.text}`; if (Date.now() - (seen.get(k) || 0) < 3000) return true; seen.set(k, Date.now()); return false }
  bot._client.on('player_chat', (d) => {
    const sender = Object.values(bot.players).find(p => p.uuid === d.senderUuid)
    const text = d.plainMessage
    if (!sender || !text) return
    const msg = { from: sender.username, text, whisper: false }
    raw(`[player_chat] ${msg.from}: ${msg.text}`)
    if (!dedupe(msg)) handle(msg)
  })

  bot.on('messagestr', (line, position) => {
    if (position === 'game_info') return
    const msg = parse(line, bot.players, bot.username)
    raw(`[${position}] ${JSON.stringify(line)} -> ${msg ? `${msg.from}: ${msg.text}` : 'ignorado'} (jogadores: ${Object.keys(bot.players).length})`)
    if (msg && !dedupe(msg)) handle(msg)
  })

  async function handle (msg) {
    if (!msg || msg.from === bot.username) return
    const text = msg.text.toLowerCase()
    const sender = bot.players[msg.from]?.entity
    const sc = score(msg, {
      others: Object.keys(bot.players).filter(n => n !== bot.username),
      aliases,
      sinceTalk: Date.now() - (talkingWith.get(msg.from) || 0),
      greetedRecently: Date.now() - (greeted.get(msg.from) || 0) < 10 * 60000,
      dist: sender && bot.entity ? sender.position.distanceTo(bot.entity.position) : null
    })
    raw(`[score] ${msg.from}: "${msg.text}" -> comigo ${sc.to} / responder ${sc.need} (${sc.why.join(', ')})`)
    remember({ from: msg.from, text: msg.text.slice(0, 200), whisper: msg.whisper || undefined, score: { to: sc.to, need: sc.need }, why: sc.why.join(', ') })
    if (sc.to >= 60) talkingWith.set(msg.from, Date.now())
    if (GREET.test(text) && sc.to >= 60) greeted.set(msg.from, Date.now())
    if (!sc.reply) return
    const body = aliases.reduce((s, a) => s.replace(new RegExp(`\\b${a}\\b[,:]?`, 'g'), ''), text).trim()

    const c = {
      activity: ctx.activity(),
      greet: ['eae', 'salve', 'opa'][Math.floor(Math.random() * 3)],
      hasItem: (w) => bot.inventory.items().some(i => i.name.includes(w.replace(/s$/, '')))
    }
    for (const [re, fn] of rules) {
      const m = body.match(re)
      if (m) return send(msg.from, fn(c, m))
    }
    const question = /\?|^(qual|quando|como|onde|pq|porque|quem|quanto|vc|voce|tu)\b/.test(body)
    if (!question || busy || body.length < 3) return
    busy = true
    try {
      const reply = await ai.ask({
        system: STYLE,
        prompt: `contexto: estou ${c.activity || 'jogando'}.\nconversa recente:\n${withPlayer(msg.from).slice(0, -1).map(h => `${h.from}: ${h.text}`).join('\n') || '(nenhuma)'}\n${msg.from} disse agora: "${msg.text.slice(0, 200)}"\nsua resposta:`,
        cacheKey: `chat:${body.slice(0, 80)}`
      })
      send(msg.from, reply)
    } finally { busy = false }
  }
}

module.exports = { attach, parse, sanitize, rules, score, recentChat }
