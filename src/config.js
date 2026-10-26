const path = require('path')
const os = require('os')

const root = path.join(__dirname, '..')
const env = process.env

module.exports = {
  root,
  host: env.MC_HOST || 'caiosujinho.jogar.io',
  port: Number(env.MC_PORT || 25565),
  username: env.MC_USERNAME || 'NapoLtz',
  // Lida só do .env; nunca logada, nunca enviada à IA nem ao chat.
  password: env.MC_PASSWORD || '',
  version: env.MC_VERSION || '26.2',
  controlPort: Number(env.CONTROL_PORT || 3077),
  panelHost: env.PANEL_HOST || '0.0.0.0',
  avoidRadius: Number(env.AVOID_PLAYER_RADIUS || 48),
  dataDir: path.join(root, 'data'),
  vaultDir: env.VAULT_DIR || path.join(os.homedir(), 'OneDrive', 'Documentos', 'minecraft', 'Minecraft AI Agent'),
  ai: {
    enabled: (env.AI_ENABLED || '1') === '1',
    claudeBin: env.CLAUDE_BIN || 'claude',
    simpleModel: env.AI_MODEL_SIMPLE || 'claude-haiku-5-5',
    complexModel: env.AI_MODEL_COMPLEX || 'claude-sonnet-5-5',
    maxCallsPerHour: Number(env.AI_MAX_CALLS_PER_HOUR || 6),
    timeoutMs: 90000
  },
  mission: env.MISSION || 'factory'
}
