/**
 * testMode — readiness checks for `--local-only` boot.
 *
 * Verifies that Ollama is reachable and that the configured chat model + the
 * embedding model (`nomic-embed-text`, used by MemoryEmbedder) are present.
 * On failure, prints actionable instructions and exits non-zero so test runs
 * fail fast instead of producing confusing downstream errors.
 *
 * Default test model is gpt-oss:20b (Ollama's PREFERRED_FALLBACK), overridable
 * via FRIDAY_TEST_MODEL env var or --test-model CLI flag.
 */

const OllamaService = require('./services/OllamaService');

const REQUIRED_EMBEDDING_MODEL = 'nomic-embed-text';

function _modelMatches(installed, wanted) {
  // Ollama lists models with explicit tags (e.g., 'gpt-oss:20b'). A request for
  // 'gpt-oss:20b' should match exactly; a request for 'llama3.2' should match
  // 'llama3.2:3b', 'llama3.2:1b', etc.
  if (installed === wanted) return true;
  if (!wanted.includes(':') && installed.startsWith(wanted + ':')) return true;
  return false;
}

async function ensureLocalReadiness({ testModel } = {}) {
  const baseURL = OllamaService.baseURL;
  const wantedChat = testModel || OllamaService.PREFERRED_FALLBACK;

  // 1. Ollama running?
  const running = await OllamaService.isRunning();
  if (!running) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('║  --local-only requires Ollama to be running.                  ║');
    console.error('╚══════════════════════════════════════════════════════════════╝');
    console.error('');
    console.error(`  Could not reach Ollama at ${baseURL}`);
    console.error('  Start it with:');
    console.error('    ollama serve');
    console.error('  Or change the URL with:');
    console.error('    OLLAMA_BASE_URL=http://localhost:11434 npm run web');
    console.error('');
    process.exit(1);
  }

  // 2. Required models installed?
  const installed = await OllamaService.fetchModels();
  const missing = [];

  if (!installed.some((m) => _modelMatches(m, wantedChat))) {
    missing.push({ name: wantedChat, role: 'chat (default test model)' });
  }
  if (!installed.some((m) => _modelMatches(m, REQUIRED_EMBEDDING_MODEL))) {
    missing.push({ name: REQUIRED_EMBEDDING_MODEL, role: 'embeddings (used by memory recall)' });
  }

  if (missing.length) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('║  --local-only: required Ollama models are not installed.     ║');
    console.error('╚══════════════════════════════════════════════════════════════╝');
    console.error('');
    for (const m of missing) {
      console.error(`  • ${m.name}  — ${m.role}`);
    }
    console.error('');
    console.error('  Pull them with:');
    for (const m of missing) console.error(`    ollama pull ${m.name}`);
    console.error('');
    console.error('  Override the default chat model with:');
    console.error('    FRIDAY_TEST_MODEL=qwen2.5:7b npm run web');
    console.error('');
    process.exit(1);
  }

  console.log(`[testMode] --local-only: Ollama OK at ${baseURL}`);
  console.log(`[testMode] --local-only: chat model = ${wantedChat}, embeddings = ${REQUIRED_EMBEDDING_MODEL}`);

  return { baseURL, chatModel: wantedChat, embeddingModel: REQUIRED_EMBEDDING_MODEL, installed };
}

module.exports = { ensureLocalReadiness };
