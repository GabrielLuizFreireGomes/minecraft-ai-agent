// Plano sob demanda (botão do painel): Sonnet com contexto compacto; cache de 10 min por pergunta.
const ai = require('./ai')
const memory = require('./memory')
const log = require('./log')

const LONG_GOAL = 'objetivo de longo prazo: máxima produção de esmeraldas com automação em grande escala ' +
  '(hall de trocas com aldeões + farms automáticas que alimentam as trocas, ou farm de mobs/raid). fase atual: missão de gravetos para flecheiros como fonte inicial.'

let last = null

async function plan (controller, bot, question = '') {
  const q = String(question).slice(0, 200)
  if (last && !q && Date.now() - last.at < 10 * 60000) return last
  const s = memory.state
  const inv = {}
  for (const i of bot?.inventory.items() || []) inv[i.name] = (inv[i.name] || 0) + i.count
  const ctx = {
    etapa_atual: controller.current,
    etapas: controller.mission.steps.map(x => `${x.id}${s.steps[x.id]?.doneAt ? ' (feita)' : ''}`),
    erros_recentes: Object.entries(s.steps).filter(([, r]) => r.errors?.length).map(([k, r]) => `${k}: ${r.errors.slice(-1)[0]}`).slice(0, 4),
    pos: bot?.entity?.position.floored(),
    vida: bot?.health,
    fome: bot?.food,
    inv,
    locais: s.places.slice(-6).map(p => `${p.name} ${p.x} ${p.z}`),
    esmeraldas_ganhas: s.stats.emeraldsEarned
  }
  const text = await ai.ask({
    complex: true,
    system: `você planeja para um bot de minecraft survival (servidor paper, sem trapaça). ${LONG_GOAL}
responda em português, curto, em tópicos: 1) o que está fazendo agora 2) próximos 3-5 passos concretos 3) riscos. máx 120 palavras.`,
    // recursos do servidor (homes, túmulos, kits): só a seção em uso, ~300 tokens
    prompt: JSON.stringify(ctx) + `\nrecursos do servidor:\n${(memory.readNote('Servidor/Plugins.md') || '').split('## Ainda não usados')[0].slice(0, 1500)}` + (q ? `\npergunta do dono: ${q}` : '')
  })
  const out = { at: Date.now(), question: q, text: text || fallback(controller) }
  if (!q) last = out
  memory.decision(`plano pedido no painel${q ? ` ("${q}")` : ''}: ${(out.text || '').replace(/\n+/g, ' ').slice(0, 300)}`)
  log.info('plano gerado')
  return out
}

// Sem IA disponível: plano determinístico a partir das etapas pendentes.
function fallback (controller) {
  const pend = controller.mission.steps.filter(s => !memory.state.steps[s.id]?.doneAt).map(s => s.desc)
  return `(sem ia agora) próximas etapas: ${pend.slice(0, 5).join(' → ')}`
}

module.exports = { plan }
