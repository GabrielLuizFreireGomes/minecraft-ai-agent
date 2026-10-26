// Escalonamento para o Claude via CLI `claude -p` (usa a assinatura do Claude Code, sem API paga).
// Só é chamado para: chat que regras locais não resolvem e etapas travadas.
// Contexto mínimo, sem ferramentas, sem MCP, sem settings do usuário (~1.3k tokens por chamada).
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { ai, dataDir } = require('./config')
const log = require('./log')

const cwd = path.join(dataDir, 'ai')
fs.mkdirSync(cwd, { recursive: true })
const calls = []
const cache = new Map()

function budgetOk () {
  const hourAgo = Date.now() - 3600000
  while (calls.length && calls[0] < hourAgo) calls.shift()
  return calls.length < ai.maxCallsPerHour
}

function ask ({ system, prompt, complex = false, cacheKey }) {
  if (!ai.enabled) return Promise.resolve(null)
  if (cacheKey && cache.has(cacheKey)) return Promise.resolve(cache.get(cacheKey))
  if (!budgetOk()) { log.warn('ai: limite por hora atingido'); return Promise.resolve(null) }
  calls.push(Date.now())
  const model = complex ? ai.complexModel : ai.simpleModel
  const args = ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--setting-sources', 'project', '--disable-slash-commands', '--system-prompt', system, '--output-format', 'json']
  return new Promise(resolve => {
    let out = ''
    let done = false
    const child = spawn(ai.claudeBin, args, { cwd, windowsHide: true })
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const timer = setTimeout(() => { child.kill(); log.warn('ai: timeout'); finish(null) }, ai.timeoutMs)
    child.stdout.on('data', d => { out += d })
    child.on('error', e => { clearTimeout(timer); log.warn('ai: claude indisponível', e.message); finish(null) })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out.replace(/^﻿/, ''))
        if (j.is_error) throw new Error(j.result || 'erro')
        const text = String(j.result || '').trim()
        log.info(`ai[${model}] ${j.usage?.input_tokens + (j.usage?.cache_creation_input_tokens || 0) + (j.usage?.cache_read_input_tokens || 0)} tok in`)
        if (cacheKey) cache.set(cacheKey, text)
        finish(text)
      } catch (e) { log.warn('ai: resposta inválida', e.message, out.slice(0, 200)); finish(null) }
    })
    child.stdin.end(prompt)
  })
}

// Pede JSON e faz parse tolerante.
async function askJson (opts) {
  const text = await ask(opts)
  if (!text) return null
  const m = text.match(/\{[\s\S]*\}/)
  try { return m ? JSON.parse(m[0]) : null } catch { return null }
}

module.exports = { ask, askJson, budgetOk }
