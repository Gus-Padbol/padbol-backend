import { AI_PROVIDER_DEFAULT } from '../constants.js';
import { anthropicProvider } from './anthropicProvider.js';

const PROVIDERS = {
  anthropic: anthropicProvider,
};

export function getAiProvider(name = process.env.AI_PROVIDER || AI_PROVIDER_DEFAULT) {
  const key = String(name ?? '').trim().toLowerCase() || AI_PROVIDER_DEFAULT;
  const provider = PROVIDERS[key];
  if (!provider) {
    const err = new Error(`AI provider no soportado: ${key}`);
    err.status = 503;
    err.code = 'AI_PROVIDER_UNSUPPORTED';
    throw err;
  }
  return provider;
}

export function listRegisteredAiProviders() {
  return Object.keys(PROVIDERS);
}
