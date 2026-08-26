import { PreciseOpenRouterProvider } from './precise-openrouter-provider.js';
import { AIHordeImageProvider } from './ai-horde-image-provider.js';

export function createProviders(config, settings) {
  const common = { requestTimeoutMs: config.requestTimeoutMs, discoveryTimeoutMs: config.discoveryTimeoutMs };
  return [
    new PreciseOpenRouterProvider({
      ...common,
      id: 'openrouter',
      name: 'Modelos gratuitos',
      kind: 'cloud',
      freeLabel: 'Modelos :free · custo zero',
      ...config.providers.openrouter,
      apiKey: settings.key,
      configured: Boolean(settings.key),
      selectionMode: settings.preferences.selectionMode,
      selectedModel: settings.preferences.selectedModel
    })
  ];
}

export function createImageProviders(config, textProviders) {
  const openRouter = textProviders.find(provider => provider.id === 'openrouter');
  return [
    ...(openRouter?.generateImage ? [openRouter] : []),
    new AIHordeImageProvider({
      ...config.images.aiHorde,
      requestTimeoutMs: config.discoveryTimeoutMs,
      clientAgent: `NewGenesis:${config.version}:https://github.com/eiisrael/NewGenesis`
    })
  ];
}
