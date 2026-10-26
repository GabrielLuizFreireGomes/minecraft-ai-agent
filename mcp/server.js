// MCP (stdio) para o Claude Code controlar o agente via API local 127.0.0.1.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')
const fs = require('fs')
const path = require('path')

const port = Number(process.env.CONTROL_PORT || 3077)
const vault = process.env.VAULT_DIR || path.join(require('os').homedir(), 'OneDrive', 'Documentos', 'minecraft', 'Minecraft AI Agent')

async function call (method, route, body) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return await r.text()
  } catch {
    return 'agente offline (rode start.bat)'
  }
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const server = new McpServer({ name: 'minecraft-agent', version: '1.0.0' })

server.tool('agent_status', 'Status compacto do agente (posição, vida, etapa, esmeraldas).', {}, async () => text(await call('GET', '/status')))
server.tool('agent_inventory', 'Inventário atual.', {}, async () => text(await call('GET', '/inventory')))
server.tool('agent_pause', 'Pausa a execução local.', {}, async () => text(await call('POST', '/pause')))
server.tool('agent_resume', 'Retoma a execução local.', {}, async () => text(await call('POST', '/resume')))
server.tool('agent_stop', 'Encerra o agente (desconecta).', {}, async () => text(await call('POST', '/stop')))
server.tool('agent_set_goal', 'Define uma nota de objetivo manual.', { goal: z.string().max(200) }, async ({ goal }) => text(await call('POST', '/goal', { goal })))
server.tool('agent_reset_step', 'Zera tentativas/bloqueio de uma etapa da missão.', { step: z.string() }, async ({ step }) => text(await call('POST', '/step/reset', { step })))
server.tool('agent_say', 'Envia uma mensagem curta no chat (minúsculas, pt-br).', { text: z.string().max(100) }, async (a) => text(await call('POST', '/say', { text: a.text.toLowerCase() })))
server.tool('memory_read', 'Lê um arquivo do vault (ex.: "Índice.md", "Erros/Registro.md"). Retorna no máx. as últimas N linhas.',
  { file: z.string(), lastLines: z.number().int().min(1).max(200).default(60) },
  async ({ file, lastLines }) => {
    const p = path.resolve(vault, file)
    if (!p.startsWith(path.resolve(vault))) return text('caminho inválido')
    try { return text(fs.readFileSync(p, 'utf8').split('\n').slice(-lastLines).join('\n')) } catch { return text('arquivo não existe') }
  })

server.connect(new StdioServerTransport())
