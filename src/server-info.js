// O servidor manda no login a árvore de comandos que este jogador pode usar (declare_commands).
// Os nomes com prefixo "plugin:comando" revelam os plugins. Guarda no state e no vault
// (Servidor/Comandos.md) para o bot e o planner saberem o que existe sem tentar às cegas.
const memory = require('./memory')
const log = require('./log')

function parse (packet) {
  const nodes = packet.nodes
  const literal = (i) => nodes[i]?.flags?.command_node_type === 1 ? nodes[i].extraNodeData.name : null
  const subs = (i, depth) => {
    if (depth === 0) return []
    return (nodes[i]?.children || []).map(c => {
      const name = literal(c)
      if (!name) return null
      const deeper = subs(c, depth - 1)
      return deeper.length ? `${name} (${deeper.join(', ')})` : name
    }).filter(Boolean)
  }
  const out = {}
  for (const c of nodes[packet.rootIndex].children) {
    const name = literal(c)
    if (name) out[name] = subs(c, 2)
  }
  return out
}

function attach (bot) {
  bot._client.once('declare_commands', (packet) => {
    try {
      const cmds = parse(packet)
      const names = Object.keys(cmds)
      const plugins = [...new Set(names.filter(n => n.includes(':')).map(n => n.split(':')[0]))].sort()
      const plain = names.filter(n => !n.includes(':')).sort()
      const s = memory.state.server
      const changed = JSON.stringify(s.available || []) !== JSON.stringify(plain)
      s.available = plain
      s.plugins = plugins
      memory.save()
      log.info(`servidor: ${plain.length} comandos disponíveis, plugins: ${plugins.join(', ')}`)
      if (changed) {
        const lines = plain.map(n => `- /${n}${cmds[n].length ? ` — ${cmds[n].slice(0, 12).join(', ')}` : ''}`)
        memory.writeNote('Servidor/Comandos.md', `# Comandos disponíveis para o NapoLtz\n\nVoltar: [[Servidor]]\n\nGerado do pacote declare_commands em ${new Date().toISOString().slice(0, 16)}.\n\n## Plugins\n${plugins.map(p => `- ${p}`).join('\n')}\n\n## Comandos\n${lines.join('\n')}\n`)
      }
    } catch (e) { log.warn('declare_commands', e.message) }
  })
}

module.exports = { attach, parse }
