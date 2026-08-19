const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const icons = {
  chat: '<svg viewBox="0 0 24 24"><path d="M5 5h14v10H8l-3 3V5Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="m5 12 14-7-4 14-3-6-7-1Z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>'
};

const state = {
  app: null,
  policy: null,
  modes: [],
  providers: [],
  openrouter: null,
  userMemory: null,
  freeModels: [],
  conversations: [],
  current: null,
  mode: 'balanced',
  sending: false,
  timeline: [],
  thinkingStartedAt: 0,
  thinkingTimer: null,
  logs: [],
  logSource: null,
  logPaused: false,
  logConnected: false,
  activeLogTab: 'logs',
  unseenLogs: 0,
  pendingAttachments: [],
  editingMessageId: null,
  activeEditMessageId: null,
  activeRequestController: null,
  streamingContent: '',
  activeTask: null,
  activeUsage: null,
  stopRequested: false,
  project: null,
  projectImporting: false,
  projectOperationId: 0,
  activeProjectPickerController: null,
  permissions: { mode: 'ask', options: [] },
  activeApproval: null,
  handoffLoading: false,
  profile: { name: 'Erick Israel', photo: '' },
  language: 'pt-BR',
  settingsTab: 'profile',
  conversationMenuId: null,
  policyPhraseIndex: 0,
  policyPhraseTimer: null
};

const UI_EN = {
  'Nova conversa': 'New conversation',
  'Buscar conversas': 'Search conversations',
  'Projeto': 'Project',
  'Histórico': 'History',
  'Abrir projeto': 'Open project',
  'Selecione uma pasta local': 'Select a local folder',
  'Configurações': 'Settings',
  'Ajustes e personalização': 'Preferences and personalization',
  'Modelos gratuitos': 'Free models',
  'Agentes gratuitos e eficientes.': 'Free and efficient agents.',
  'Inteligência sem custo.': 'Intelligence at no cost.',
  'Tecnologia ao seu alcance.': 'Technology within your reach.',
  'Produtividade sem limites': 'Limitless productivity',
  'Produtividade sem limites.': 'Limitless productivity.',
  'Liberdade na criação.': 'Freedom to create.',
  'Roteamento automático': 'Automatic routing',
  'Gênesis pronto': 'Genesis ready',
  'Configure sua chave': 'Configure your key',
  'Abrir observabilidade': 'Open observability',
  'Exportar conversa': 'Export conversation',
  'Alternar tema': 'Switch theme',
  'Uma mente. Os melhores modelos gratuitos.': 'One mind. The best free models.',
  'Converse com um único agente que preserva sua linha de raciocínio e alterna entre modelos gratuitos quando uma cota termina.': 'Talk to a single agent that preserves your train of thought and switches between free models when a quota ends.',
  'Criar um plano': 'Create a plan',
  'Estratégia clara e acionável': 'Clear, actionable strategy',
  'Construir software': 'Build software',
  'Arquitetura e implementação': 'Architecture and implementation',
  'Analisar um problema': 'Analyze a problem',
  'Riscos, opções e decisão': 'Risks, options, and decision',
  'Raciocínio': 'Reasoning',
  'Código': 'Code',
  'Rápido': 'Fast',
  'Memória contínua': 'Continuous memory',
  'Contexto econômico ativo': 'Efficient context enabled',
  'Enviar': 'Send',
  'Parar': 'Stop',
  'STATUS': 'STATUS',
  'Gênesis Core': 'Genesis Core',
  'CONTINUIDADE': 'CONTINUITY',
  'Linha de raciocínio preservada': 'Train of thought preserved',
  'Histórico canônico independente do modelo': 'Canonical history independent of model',
  'memória': 'memory',
  'CONTEXTO DO MODELO': 'MODEL CONTEXT',
  'Disponibilidade máxima': 'Maximum availability',
  'Aguardando primeira resposta': 'Waiting for first response',
  'usados': 'used',
  'restantes': 'remaining',
  'SESSÃO': 'SESSION',
  'Eficiência': 'Efficiency',
  'Tokens poupados': 'Tokens saved',
  'por compactação': 'through compaction',
  'Trocas de motor': 'Engine switches',
  'sem perder contexto': 'without losing context',
  'Mensagens': 'Messages',
  'nesta conversa': 'in this conversation',
  'Respostas': 'Responses',
  'concluídas': 'completed',
  'ATIVIDADE': 'ACTIVITY',
  'Roteamento ao vivo': 'Live routing',
  'As decisões de rota aparecerão aqui durante a próxima resposta.': 'Routing decisions will appear here during the next response.',
  'Pensando...': 'Thinking...',
  'Configurações 2.0': 'Settings 2.0',
  'Perfil': 'Profile',
  'Conta e idioma': 'Account and language',
  'Conexão': 'Connection',
  'Chave e segurança': 'Key and security',
  'Modelos': 'Models',
  'Seleção inteligente': 'Smart selection',
  'Privacidade': 'Privacy',
  'Memória adaptativa': 'Adaptive memory',
  'Preferências salvas localmente': 'Preferences saved locally',
  'CONFIGURAÇÕES': 'SETTINGS',
  'Personalize sua identidade e o idioma do painel.': 'Personalize your identity and the panel language.',
  'Seu perfil': 'Your profile',
  'Identificação utilizada somente neste navegador.': 'Identity used only in this browser.',
  'PERFIL LOCAL': 'LOCAL PROFILE',
  'Clique na foto para personalizar.': 'Click the photo to personalize.',
  'Editar nome': 'Edit name',
  'Digite seu nome': 'Enter your name',
  'Cancelar': 'Cancel',
  'Salvar': 'Save',
  'Remover foto': 'Remove photo',
  'IDIOMA': 'LANGUAGE',
  'Idioma da interface': 'Interface language',
  'A escolha é salva automaticamente neste navegador.': 'Your choice is saved automatically in this browser.',
  'Português': 'Portuguese',
  'Brasil': 'Brazil',
  'Conexão gratuita': 'Free connection',
  'Gerencie sua Key com armazenamento local protegido.': 'Manage your key with protected local storage.',
  'OpenRouter desconectado': 'OpenRouter disconnected',
  'Adicione sua chave para carregar os modelos gratuitos.': 'Add your key to load free models.',
  'Offline': 'Offline',
  'Online': 'Online',
  'Criar chave ↗': 'Create key ↗',
  'Salvar chave neste computador': 'Save key on this computer',
  'Mantém a conexão após reiniciar o Genesis.': 'Keeps the connection after restarting Genesis.',
  'Conectar e carregar': 'Connect and load',
  'Remover chave salva': 'Remove saved key',
  'Privacidade e aprendizado': 'Privacy and learning',
  'Controle como o Gênesis adapta a experiência ao seu uso.': 'Control how Genesis adapts the experience to your usage.',
  'MEMÓRIA ADAPTATIVA': 'ADAPTIVE MEMORY',
  'Preferências do usuário': 'User preferences',
  'Aprende somente padrões não sensíveis; nenhuma mensagem bruta é copiada.': 'Learns only non-sensitive patterns; no raw message is copied.',
  'O Gênesis começará a adaptar tom e prioridades durante o uso.': 'Genesis will adapt tone and priorities during use.',
  'Limpar aprendizado': 'Clear learning',
  'Roteamento de modelos': 'Model routing',
  'Escolha entre seleção automática ou um modelo principal.': 'Choose automatic selection or a primary model.',
  'SELEÇÃO': 'SELECTION',
  'Modelo de inteligência': 'Intelligence model',
  'Automático': 'Automatic',
  'O Genesis escolhe e alterna entre os modelos free.': 'Genesis chooses and switches between free models.',
  'Manual': 'Manual',
  'Fixe um modelo; o roteador free assume se ele falhar.': 'Pin a model; the free router takes over if it fails.',
  'Modelo manual': 'Manual model',
  'Conecte sua chave para carregar os modelos': 'Connect your key to load models',
  'Fechar': 'Close',
  'Salvar ajustes': 'Save settings',
  'Adicionar foto de perfil': 'Add profile photo',
  'Idioma do painel': 'Panel language',
  'Atualizar modelos gratuitos': 'Refresh free models',
  'Somente leitura': 'Read only',
  'Arquivos': 'Files',
  'Linhas': 'Lines',
  'Tamanho': 'Size',
  'Fechar projeto': 'Close project',
  'Voltar': 'Back',
  'Abrir outra pasta': 'Open another folder',
  'Adicionar arquivos': 'Add files',
  'Permissões do agente': 'Agent permissions'
  ,'Recolher barra lateral': 'Collapse sidebar'
  ,'Expandir barra lateral': 'Expand sidebar'
  ,'Ativo': 'Active'
  ,'Personalizar conversa': 'Customize conversation'
  ,'Personalizar': 'Customize'
  ,'Excluir conversa': 'Delete conversation'
  ,'Copiar': 'Copy'
  ,'Editar': 'Edit'
  ,'Modo do agente': 'Agent mode'
  ,'Mensagem': 'Message'
  ,'Enviar mensagem': 'Send message'
  ,'Modelos gratuitos online': 'Free models online'
  ,'Modelos temporariamente ocupados': 'Models temporarily busy'
  ,'SISTEMA GENESIS ONLINE': 'GENESIS SYSTEM ONLINE'
  ,'Contexto com boa disponibilidade': 'Context with good availability'
  ,'Uso real da janela de contexto': 'Actual context-window usage'
  ,'Tokens restantes': 'Remaining tokens'
  ,'Categorias das configurações': 'Settings categories'
  ,'Gênesis 2.0': 'Genesis 2.0'
  ,'Somente rotas gratuitas; disponibilidade e filas podem variar.': 'Free routes only; availability and queues may vary.'
  ,'Todos os direitos reservados.': 'All rights reserved.'
  ,'Abrir pelo caminho': 'Open by path'
  ,'Buscar arquivo no projeto': 'Search project files'
  ,'Nenhum projeto': 'No project'
  ,'Escolha uma pasta para começar.': 'Choose a folder to get started.'
  ,'Pensando': 'Thinking'
  ,'Memória preparada': 'Memory prepared'
  ,'Resposta concluída': 'Response completed'
  ,'Rastro de trabalho seguro': 'Safe work trace'
  ,'Observabilidade do Genesis': 'Genesis observability'
  ,'Logs': 'Logs'
  ,'Pensamento': 'Thought process'
  ,'Pausar': 'Pause'
  ,'Limpar': 'Clear'
  ,'Conectando': 'Connecting'
  ,'Todos os níveis': 'All levels'
  ,'Todas as áreas': 'All areas'
  ,'Agente': 'Agent'
  ,'Provedores': 'Providers'
  ,'Memória': 'Memory'
  ,'Conversa': 'Conversation'
  ,'Servidor': 'Server'
  ,'Sistema': 'System'
  ,'Conversas': 'Conversations'
  ,'Inteligência do sistema': 'System intelligence'
  ,'· Somente rotas gratuitas; disponibilidade e filas podem variar.': '· Free routes only; availability and queues may vary.'
  ,'· © 2026 Erick Israel. Todos os direitos reservados.': '· © 2026 Erick Israel. All rights reserved.'
  ,'Abrir painel de inteligência': 'Open intelligence panel'
  ,'Fechar painel': 'Close panel'
  ,'Genesis está raciocinando': 'Genesis is reasoning'
  ,'Preparando a memória de continuidade…': 'Preparing continuity memory…'
  ,'Autorizar alteração?': 'Authorize change?'
  ,'O Gênesis aguarda sua decisão.': 'Genesis is waiting for your decision.'
  ,'Negar': 'Deny'
  ,'Aprovar': 'Approve'
  ,'Arquivos prontos para envio': 'Files ready to send'
  ,'Diga ao Genesis o que você quer construir…': 'Tell Genesis what you want to build…'
  ,'Adicionar arquivos': 'Add files'
  ,'Arquivos e imagens': 'Files and images'
  ,'PDF, imagens, texto e código': 'PDF, images, text, and code'
  ,'Até 5 arquivos · 8 MB cada · 16 MB no total': 'Up to 5 files · 8 MB each · 16 MB total'
  ,'PERMISSÕES': 'PERMISSIONS'
  ,'Solicitar Permissão': 'Request permission'
  ,'Aprovar ou negar cada alteração': 'Approve or deny each change'
  ,'Permissão Completa': 'Full permission'
  ,'Autonomia dentro do projeto ativo': 'Autonomy within the active project'
  ,'Nenhuma operação pode sair da pasta do projeto.': 'No operation can leave the project folder.'
  ,'Carregar modelo com mais tokens': 'Load model with more tokens'
  ,'Transferir memória canônica sem interromper o trabalho': 'Transfer canonical memory without interrupting the work'
  ,'OBSERVABILIDADE': 'OBSERVABILITY'
  ,'Sucesso': 'Success'
  ,'Aviso': 'Warning'
  ,'Erro': 'Error'
  ,'Filtrar eventos': 'Filter events'
  ,'Filtrar por nível': 'Filter by level'
  ,'Filtrar por categoria': 'Filter by category'
  ,'Visões de observabilidade': 'Observability views'
  ,'Hora': 'Time'
  ,'Nível': 'Level'
  ,'Área': 'Area'
  ,'Evento': 'Event'
  ,'Mostra decisões, progresso e trocas de motor em tempo real, sem revelar instruções internas, credenciais ou raciocínio privado.': 'Shows decisions, progress, and engine switches in real time without revealing internal instructions, credentials, or private reasoning.'
  ,'Transmissão local protegida': 'Protected local stream'
  ,'Aguardando eventos': 'Waiting for events'
  ,'PRIMEIRO PASSO': 'FIRST STEP'
  ,'Ative a inteligência do Gênesis': 'Activate Genesis intelligence'
  ,'Adicione sua Key da OpenRouter em Configurações para carregar e alternar automaticamente entre os modelos gratuitos.': 'Add your OpenRouter key in Settings to automatically load and switch between free models.'
  ,'Pular': 'Skip'
  ,'Abrir Configurações': 'Open Settings'
};

const textOrigins = new WeakMap();
const attributeOrigins = new WeakMap();
let languageRefreshQueued = false;

function translatedUiText(value) {
  const clean = String(value || '').trim();
  if (!clean) return clean;
  if (UI_EN[clean]) return UI_EN[clean];
  return clean
    .replace(/^(\d+) modelos$/, '$1 models')
    .replace(/^(\d+) modelo$/, '$1 model')
    .replace(/(\d+) arquivos\b/g, '$1 files')
    .replace(/(\d+) mensagens ativas\b/g, '$1 active messages')
    .replace(/(\d+) mensagens\b/g, '$1 messages')
    .replace(/(\d+) mensagem\b/g, '$1 message')
    .replace(/(\d+) tokens poupados\b/g, '$1 tokens saved')
    .replace(/(\d+) poupados\b/g, '$1 saved')
    .replace(/tokens na resposta/g, 'tokens in response')
    .replace(/restantes de/g, 'remaining out of')
    .replace(/tokens no último contexto/g, 'tokens in the latest context')
    .replace(/^Personalizar /, 'Customize ')
    .replace(/^Peça ao Genesis para analisar /, 'Ask Genesis to analyze ')
    .replace(/^(\d+)% livre$/, '$1% free');
}

function shouldSkipTranslation(element) {
  return Boolean(element.closest('.message-content, .log-copy, .thought-copy, code, pre, [data-no-translate]'));
}

function translatePage() {
  document.documentElement.lang = state.language;
  const english = state.language === 'en-US';
  for (const element of document.querySelectorAll('body *')) {
    if (shouldSkipTranslation(element)) continue;
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue.trim()) continue;
      if (!textOrigins.has(node)) textOrigins.set(node, node.nodeValue);
      const original = textOrigins.get(node);
      const leading = original.match(/^\s*/)?.[0] || '';
      const trailing = original.match(/\s*$/)?.[0] || '';
      const next = english ? translatedUiText(original) : original.trim();
      const value = `${leading}${next}${trailing}`;
      if (node.nodeValue !== value) node.nodeValue = value;
    }
    const origins = attributeOrigins.get(element) || {};
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      if (!element.hasAttribute(attribute)) continue;
      const current = element.getAttribute(attribute);
      if (!(attribute in origins)) origins[attribute] = current;
      else if (current !== origins[attribute] && current !== translatedUiText(origins[attribute])) origins[attribute] = current;
      const original = origins[attribute];
      const value = english ? translatedUiText(original) : original;
      if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
    }
    attributeOrigins.set(element, origins);
  }
}

function queueLanguageRefresh() {
  if (languageRefreshQueued || state.language !== 'en-US') return;
  languageRefreshQueued = true;
  queueMicrotask(() => {
    languageRefreshQueued = false;
    translatePage();
  });
}

const elements = {
  appShell: $('#appShell'),
  sidebar: $('#sidebar'),
  sidebarCollapseButton: $('#sidebarCollapseButton'),
  inspector: $('#inspector'),
  conversationList: $('#conversationList'),
  conversationCount: $('#conversationCount'),
  conversationSearch: $('#conversationSearch'),
  conversationPopover: $('#conversationPopover'),
  conversationRenameInput: $('#conversationRenameInput'),
  saveConversationRename: $('#saveConversationRename'),
  closeConversationPopover: $('#closeConversationPopover'),
  conversationTitle: $('#conversationTitle'),
  runtimeStatus: $('#runtimeStatus'),
  genesisVersion: $('#genesisVersion'),
  activeEngine: $('#activeEngine'),
  emptyState: $('#emptyState'),
  messageList: $('#messageList'),
  thinkingCard: $('#thinkingCard'),
  thinkingTitle: $('#thinkingTitle'),
  thinkingDetail: $('#thinkingDetail'),
  thinkingTimer: $('#thinkingTimer'),
  approvalCard: $('#approvalCard'),
  approvalTitle: $('#approvalTitle'),
  approvalDetail: $('#approvalDetail'),
  approveApprovalButton: $('#approveApprovalButton'),
  denyApprovalButton: $('#denyApprovalButton'),
  composerForm: $('#composerForm'),
  messageInput: $('#messageInput'),
  attachmentInput: $('#attachmentInput'),
  attachmentTray: $('#attachmentTray'),
  attachmentButton: $('#attachmentButton'),
  attachmentMenu: $('#attachmentMenu'),
  permissionButton: $('#permissionButton'),
  permissionMenu: $('#permissionMenu'),
  permissionMenuTitle: $('#permissionMenuTitle'),
  chooseFilesButton: $('#chooseFilesButton'),
  sendButton: $('#sendButton'),
  providerStack: $('#providerStack'),
  refreshProviders: $('#refreshProviders'),
  routeTimeline: $('#routeTimeline'),
  tokenHint: $('#tokenHint'),
  continuityValue: $('#continuityValue'),
  continuityDetail: $('#continuityDetail'),
  contextMeterCard: $('#contextMeterCard'),
  contextMeterStatus: $('#contextMeterStatus'),
  contextMeterPercent: $('#contextMeterPercent'),
  contextProgress: $('#contextProgress'),
  contextProgressFill: $('#contextProgressFill'),
  contextUsedTokens: $('#contextUsedTokens'),
  contextRemainingTokens: $('#contextRemainingTokens'),
  modelHandoffButton: $('#modelHandoffButton'),
  savedTokensMetric: $('#savedTokensMetric'),
  switchMetric: $('#switchMetric'),
  messageMetric: $('#messageMetric'),
  requestMetric: $('#requestMetric'),
  setupDialog: $('#setupDialog'),
  toastRegion: $('#toastRegion'),
  drawerBackdrop: $('#drawerBackdrop'),
  logsDrawer: $('#logsDrawer'),
  logsToggle: $('#logsToggle'),
  logsBadge: $('#logsBadge'),
  logsClose: $('#logsClose'),
  streamState: $('#streamState'),
  pauseLogsButton: $('#pauseLogsButton'),
  clearLogsButton: $('#clearLogsButton'),
  logsFilters: $('#logsFilters'),
  logSearch: $('#logSearch'),
  logLevelFilter: $('#logLevelFilter'),
  logCategoryFilter: $('#logCategoryFilter'),
  logList: $('#logList'),
  thoughtList: $('#thoughtList'),
  logsPanel: $('#logsPanel'),
  thoughtsPanel: $('#thoughtsPanel'),
  logCount: $('#logCount'),
  thoughtCount: $('#thoughtCount'),
  logsFooterStatus: $('#logsFooterStatus'),
  openRouterForm: $('#openRouterForm'),
  openRouterApiKey: $('#openRouterApiKey'),
  persistOpenRouterKey: $('#persistOpenRouterKey'),
  connectOpenRouterButton: $('#connectOpenRouterButton'),
  disconnectOpenRouterButton: $('#disconnectOpenRouterButton'),
  openRouterQuotaMeter: $('#openRouterQuotaMeter'),
  openRouterQuotaValue: $('#openRouterQuotaValue'),
  openRouterQuotaBar: $('#openRouterQuotaBar'),
  openRouterQuotaFill: $('#openRouterQuotaFill'),
  openRouterQuotaDetail: $('#openRouterQuotaDetail'),
  refreshQuotaButton: $('#refreshQuotaButton'),
  toggleKeyVisibility: $('#toggleKeyVisibility'),
  openRouterStatusTitle: $('#openRouterStatusTitle'),
  openRouterStatusDetail: $('#openRouterStatusDetail'),
  openRouterIndicator: $('#openRouterIndicator'),
  modelSettings: $('#modelSettings'),
  freeModelCount: $('#freeModelCount'),
  manualModelSelect: $('#manualModelSelect'),
  selectedModelNote: $('#selectedModelNote'),
  configFeedback: $('#configFeedback'),
  saveModelButton: $('#saveModelButton'),
  userAvatar: $('#userAvatar'),
  profileAvatar: $('#profileAvatar'),
  profileImageInput: $('#profileImageInput'),
  removeProfilePhoto: $('#removeProfilePhoto'),
  profileDisplayName: $('#profileDisplayName'),
  profileEditor: $('#profileEditor'),
  profileNameInput: $('#profileNameInput'),
  editProfileButton: $('#editProfileButton'),
  cancelProfileButton: $('#cancelProfileButton'),
  saveProfileButton: $('#saveProfileButton'),
  policyPhrase: $('#policyPhrase'),
  configTour: $('#configTour'),
  skipConfigTour: $('#skipConfigTour'),
  startConfigTourSetup: $('#startConfigTourSetup'),
  adaptiveMemoryEnabled: $('#adaptiveMemoryEnabled'),
  adaptiveMemorySummary: $('#adaptiveMemorySummary'),
  clearAdaptiveMemory: $('#clearAdaptiveMemory'),
  settingsPanelTitle: $('#settingsPanelTitle'),
  settingsPanelDescription: $('#settingsPanelDescription'),
  projectCard: $('#projectCard'),
  projectCardClose: $('#projectCardClose'),
  projectName: $('#projectName'),
  projectDetail: $('#projectDetail'),
  projectState: $('#projectState'),
  projectFileCount: $('#projectFileCount'),
  projectToggle: $('#projectToggle'),
  projectActiveDot: $('#projectActiveDot'),
  projectFolderInput: $('#projectFolderInput'),
  projectDialog: $('#projectDialog'),
  projectDialogTitle: $('#projectDialogTitle'),
  projectSummaryName: $('#projectSummaryName'),
  projectSummaryDetail: $('#projectSummaryDetail'),
  projectMetricFiles: $('#projectMetricFiles'),
  projectMetricLines: $('#projectMetricLines'),
  projectMetricSize: $('#projectMetricSize'),
  projectTechnologies: $('#projectTechnologies'),
  projectFileSearch: $('#projectFileSearch'),
  projectFileList: $('#projectFileList'),
  projectImportFeedback: $('#projectImportFeedback'),
  projectAccessBadge: $('#projectAccessBadge'),
  projectPathInput: $('#projectPathInput'),
  openProjectPathButton: $('#openProjectPathButton'),
  removeProjectButton: $('#removeProjectButton'),
  replaceProjectButton: $('#replaceProjectButton')
};

const ATTACHMENT_LIMITS = { maxFiles: 5, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 };
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'log', 'js', 'mjs', 'cjs',
  'ts', 'tsx', 'jsx', 'py', 'html', 'css', 'scss', 'sql', 'sh', 'ps1', 'bat', 'java', 'c', 'cc',
  'cpp', 'h', 'hpp', 'go', 'rs', 'php', 'rb', 'swift', 'kt', 'kts', 'toml', 'ini', 'env'
]);

const PROJECT_LIMITS = { maxFiles: 10000, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 };
const PROJECT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'adoc', 'csv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'astro', 'py', 'pyi', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'sql', 'graphql', 'gql', 'proto', 'sh', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'cs', 'fs', 'fsx', 'vb', 'go', 'rs', 'php', 'rb', 'swift', 'dart', 'lua',
  'r', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'sol', 'tf', 'tfvars', 'hcl', 'dockerignore', 'gitignore', 'gitattributes', 'editorconfig',
  'csproj', 'fsproj', 'vbproj', 'vcxproj', 'sln', 'slnx', 'props', 'targets', 'cmake', 'mk', 'ninja', 'lock', 'plist', 'podspec', 'xcconfig', 'storyboard', 'xib'
]);
const PROJECT_NAMES = new Set([
  'dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'rakefile', 'gemfile', 'procfile', 'license', 'licence', 'readme', 'changelog',
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock',
  'composer.json', 'composer.lock', 'pyproject.toml', 'poetry.lock', 'pipfile', 'pipfile.lock', 'requirements.txt', 'pom.xml',
  'build.gradle', 'settings.gradle', 'gradlew', 'mvnw', 'tsconfig.json', 'jsconfig.json', 'cmakelists.txt', 'meson.build', 'meson_options.txt',
  'directory.build.props', 'directory.build.targets', 'global.json', 'nuget.config', 'gradle.properties'
]);
const PROJECT_IGNORED_DIRECTORIES = new Set([
  '.git', '.svn', '.hg', '.genesis', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit',
  'target', 'bin', 'obj', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle', '.idea'
]);
const PROJECT_SENSITIVE_NAMES = new Set([
  '.env', '.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json', 'secrets.json', 'service-account.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'known_hosts'
]);
const PROJECT_SENSITIVE_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'crt', 'cer']);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  })[character]);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function projectPath(value) {
  return String(value || '').normalize('NFKC').replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean).join('/');
}

function projectFileAccepted(relativePath, file) {
  const cleanPath = projectPath(relativePath);
  const segments = cleanPath.toLowerCase().split('/');
  const basename = segments.at(-1) || '';
  const extension = basename.includes('.') ? basename.split('.').pop() : '';
  if (!cleanPath || segments.some(segment => segment === '..' || PROJECT_IGNORED_DIRECTORIES.has(segment))) return false;
  if (PROJECT_SENSITIVE_NAMES.has(basename) || basename.startsWith('.env.') || PROJECT_SENSITIVE_EXTENSIONS.has(extension)) return false;
  if (!PROJECT_NAMES.has(basename) && !PROJECT_EXTENSIONS.has(extension)) return false;
  return Number(file?.size || 0) <= PROJECT_LIMITS.maxFileBytes;
}

function projectLanguageLabel(relativePath) {
  const extension = fileExtension(relativePath);
  return ({ js: 'JS', mjs: 'JS', cjs: 'JS', jsx: 'JSX', ts: 'TS', tsx: 'TSX', py: 'PY', rs: 'RS', go: 'GO', java: 'JAVA',
    kt: 'KT', cs: 'C#', cpp: 'C++', c: 'C', h: 'H', php: 'PHP', rb: 'RB', swift: 'SWIFT', dart: 'DART', vue: 'VUE',
    svelte: 'SVELTE', astro: 'ASTRO', html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON', yaml: 'YAML', yml: 'YAML',
    toml: 'TOML', md: 'MD', sql: 'SQL', sh: 'SH', ps1: 'PS1', tf: 'TF' })[extension] || extension.slice(0, 5).toUpperCase() || 'TXT';
}

function setProjectFeedback(message = '', type = 'progress') {
  elements.projectImportFeedback.hidden = !message;
  elements.projectImportFeedback.className = `project-import-feedback ${type === 'error' ? 'error' : ''}`;
  elements.projectImportFeedback.textContent = message;
}

function beginProjectOperation({ allowPathOverride = false } = {}) {
  const operationId = ++state.projectOperationId;
  state.projectImporting = true;
  elements.projectCard.disabled = true;
  elements.projectCardClose.disabled = true;
  elements.replaceProjectButton.disabled = true;
  elements.openProjectPathButton.disabled = !allowPathOverride;
  return operationId;
}

function finishProjectOperation(operationId) {
  if (operationId !== state.projectOperationId) return;
  state.projectImporting = false;
  elements.projectCard.disabled = false;
  elements.projectCardClose.disabled = false;
  elements.replaceProjectButton.disabled = false;
  elements.openProjectPathButton.disabled = false;
}

function renderProjectFiles() {
  const files = state.project?.files || [];
  const query = elements.projectFileSearch.value.trim().toLowerCase();
  const filtered = files.filter(file => file.path.toLowerCase().includes(query));
  if (!filtered.length) {
    elements.projectFileList.innerHTML = `<div class="project-file-empty">${files.length ? 'Nenhum arquivo encontrado.' : 'Abra uma pasta para ver o inventário.'}</div>`;
    return;
  }
  elements.projectFileList.innerHTML = filtered.slice(0, 500).map(file => `
    <div class="project-file-row">
      <span class="project-file-icon">${escapeHtml(projectLanguageLabel(file.path))}</span>
      <span class="project-file-copy"><strong title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</strong><small>${escapeHtml(file.language || 'Texto')} · ${compactNumber(file.lines)} linhas</small></span>
      <small>${formatBytes(file.size)}</small>
    </div>`).join('');
}

function renderProject() {
  const project = state.project;
  elements.projectCard.classList.toggle('active', Boolean(project));
  elements.projectCardClose.hidden = !project;
  elements.projectActiveDot.hidden = !project;
  elements.projectFileCount.textContent = String(project?.fileCount || 0);
  elements.projectName.textContent = project?.name || 'Abrir projeto';
  elements.projectDetail.textContent = project ? `${compactNumber(project.fileCount)} arquivos · ${project.technologies?.slice(0, 2).join(' + ') || 'projeto local'}` : 'Selecione uma pasta local';
  elements.projectState.lastChild.textContent = project ? 'Ativo' : 'Local';
  elements.projectToggle.title = project ? `Projeto: ${project.name}` : 'Abrir projeto';
  elements.messageInput.placeholder = project ? `Peça ao Genesis para analisar ${project.name}…` : 'Diga ao Genesis o que você quer construir…';
  elements.projectDialogTitle.textContent = project?.name || 'Projeto';
  elements.projectSummaryName.textContent = project?.name || 'Nenhum projeto';
  elements.projectSummaryDetail.textContent = project
    ? `${project.technologies?.join(', ') || 'Tecnologias não identificadas'} · ${project.writable ? 'edição protegida ativa' : 'indexado em modo leitura'}`
    : 'Escolha uma pasta para começar.';
  elements.projectAccessBadge.classList.toggle('writable', Boolean(project?.writable));
  elements.projectAccessBadge.lastChild.textContent = project?.writable ? 'Editável' : 'Somente leitura';
  elements.projectMetricFiles.textContent = compactNumber(project?.fileCount || 0);
  elements.projectMetricLines.textContent = compactNumber(project?.totalLines || 0);
  elements.projectMetricSize.textContent = formatBytes(project?.totalBytes || 0);
  elements.projectTechnologies.innerHTML = (project?.technologies || []).map(value => `<span class="project-technology">${escapeHtml(value)}</span>`).join('');
  elements.removeProjectButton.disabled = !project;
  elements.removeProjectButton.hidden = !project;
  renderProjectFiles();
}

function renderPermissions() {
  const mode = state.permissions?.mode === 'full' ? 'full' : 'ask';
  elements.permissionButton.classList.toggle('full', mode === 'full');
  elements.permissionButton.title = mode === 'full' ? 'Permissão Completa' : 'Solicitar Permissão';
  elements.permissionMenuTitle.textContent = mode === 'full' ? 'Permissão Completa' : 'Solicitar Permissão';
  $$('[data-permission-mode]').forEach(button => button.classList.toggle('active', button.dataset.permissionMode === mode));
}

function closePermissionMenu() {
  elements.permissionMenu.hidden = true;
  elements.permissionButton.setAttribute('aria-expanded', 'false');
}

async function setPermissionMode(mode) {
  const payload = await api('/api/permissions', { method: 'PUT', body: JSON.stringify({ mode }) });
  state.permissions = payload.permissions;
  renderPermissions();
  closePermissionMenu();
  toast(mode === 'full' ? 'Permissão completa ativa dentro do projeto.' : 'O Gênesis pedirá aprovação para alterações.', mode === 'full' ? 'warning' : 'success');
}

function openProjectDialog() {
  renderProject();
  if (!elements.projectDialog.open) elements.projectDialog.showModal();
}

async function directoryEntries(handle, prefix = '', output = []) {
  for await (const [name, entry] of handle.entries()) {
    if (output.length >= PROJECT_LIMITS.maxFiles) break;
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'directory') {
      if (!PROJECT_IGNORED_DIRECTORIES.has(name.toLowerCase())) await directoryEntries(entry, relativePath, output);
      continue;
    }
    if (entry.kind !== 'file') continue;
    const file = await entry.getFile();
    if (projectFileAccepted(relativePath, file)) output.push({ path: projectPath(relativePath), file });
  }
  return output;
}

async function importProject(name, entries, source) {
  if (state.projectImporting) return;
  state.projectImporting = true;
  elements.projectCard.disabled = true;
  elements.projectCardClose.disabled = true;
  elements.replaceProjectButton.disabled = true;
  openProjectDialog();
  const files = [];
  let totalBytes = 0;
  let skipped = 0;
  try {
    for (const entry of entries) {
      if (files.length >= PROJECT_LIMITS.maxFiles) { skipped += 1; continue; }
      if (!projectFileAccepted(entry.path, entry.file)) { skipped += 1; continue; }
      if (totalBytes + entry.file.size > PROJECT_LIMITS.maxTotalBytes) { skipped += 1; continue; }
      setProjectFeedback(`Lendo projeto… ${files.length + 1}/${Math.min(entries.length, PROJECT_LIMITS.maxFiles)}`);
      const content = await entry.file.text();
      if (content.includes('\0')) { skipped += 1; continue; }
      files.push({ path: projectPath(entry.path), content });
      totalBytes += entry.file.size;
    }
    if (!files.length) throw new Error('A pasta não possui arquivos de texto ou código compatíveis.');
    setProjectFeedback(`Indexando ${files.length} arquivos no Genesis…`);
    const payload = await api('/api/project', {
      method: 'PUT',
      body: JSON.stringify({ name, source, files })
    });
    state.project = payload.project;
    elements.projectFileSearch.value = '';
    renderProject();
    setProjectFeedback(`${files.length} arquivos indexados${skipped ? ` · ${skipped} ignorados por segurança ou limite` : ''}.`, 'success');
    toast(`Projeto ${state.project.name} aberto no Genesis.`);
  } catch (error) {
    setProjectFeedback(error.message, 'error');
    toast(error.message, 'error');
  } finally {
    state.projectImporting = false;
    elements.projectCard.disabled = false;
    elements.projectCardClose.disabled = false;
    elements.replaceProjectButton.disabled = false;
  }
}

async function chooseProjectFolder() {
  if (state.projectImporting) return;
  const operationId = beginProjectOperation({ allowPathOverride: true });
  const pickerController = new AbortController();
  state.activeProjectPickerController = pickerController;
  openProjectDialog();
  setProjectFeedback('Aguardando a seleção da pasta editável… Se a janela não aparecer, cole o caminho acima.');
  try {
    const payload = await api('/api/project/pick', { method: 'POST', body: '{}', signal: pickerController.signal });
    if (payload.cancelled) {
      setProjectFeedback('Seleção cancelada.', 'success');
      return;
    }
    state.project = payload.project;
    elements.projectFileSearch.value = '';
    renderProject();
    setProjectFeedback(`${state.project.fileCount} arquivos indexados · edição protegida disponível.`, 'success');
    toast(`Projeto ${state.project.name} aberto para análise e edição.`);
    return;
  } catch (nativeError) {
    if (pickerController.signal.aborted) return;
    setProjectFeedback('O seletor editável não está disponível; tentando importação em modo leitura…');
  } finally {
    if (state.activeProjectPickerController === pickerController) state.activeProjectPickerController = null;
    finishProjectOperation(operationId);
  }
  if (typeof window.showDirectoryPicker === 'function') {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      const entries = await directoryEntries(handle);
      await importProject(handle.name, entries, 'directory-picker');
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
      if (!['TypeError', 'NotSupportedError', 'SecurityError', 'NotAllowedError'].includes(error?.name)) {
        toast(`Não foi possível abrir a pasta: ${error.message}`, 'error');
        return;
      }
    }
  }
  elements.projectFolderInput.click();
}

async function openProjectFromPath() {
  const selectedPath = elements.projectPathInput.value.trim();
  if (!selectedPath) {
    setProjectFeedback('Cole o caminho completo da pasta do projeto.', 'error');
    elements.projectPathInput.focus();
    return;
  }
  state.activeProjectPickerController?.abort();
  state.activeProjectPickerController = null;
  const operationId = beginProjectOperation();
  openProjectDialog();
  setProjectFeedback('Abrindo e indexando a pasta editável…');
  try {
    const payload = await api('/api/project/open-path', {
      method: 'POST',
      body: JSON.stringify({ path: selectedPath })
    });
    state.project = payload.project;
    elements.projectFileSearch.value = '';
    renderProject();
    setProjectFeedback(`${state.project.fileCount} arquivos indexados · edição protegida disponível.`, 'success');
    toast(`Projeto ${state.project.name} aberto para análise e edição.`);
  } catch (error) {
    setProjectFeedback(error.message, 'error');
    toast(error.message, 'error');
  } finally {
    finishProjectOperation(operationId);
  }
}

async function removeProject() {
  if (!state.project || !window.confirm(`Fechar o projeto “${state.project.name}” e removê-lo do contexto do Genesis?`)) return;
  const payload = await api('/api/project', { method: 'DELETE' });
  state.project = payload.project;
  elements.projectFileSearch.value = '';
  setProjectFeedback('');
  renderProject();
  if (elements.projectDialog.open) elements.projectDialog.close();
  toast('Projeto fechado.', 'warning');
}

function fileExtension(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || 'file';
}

function supportedFile(file) {
  const extension = fileExtension(file.name);
  const inferredImages = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  const imageMime = IMAGE_TYPES.has(file.type) ? file.type : inferredImages[extension];
  if (imageMime) return { kind: 'image', mimeType: imageMime };
  if (file.type === 'application/pdf' || extension === 'pdf') return { kind: 'pdf', mimeType: 'application/pdf' };
  if (TEXT_EXTENSIONS.has(extension)) return { kind: 'text', mimeType: 'text/plain' };
  return null;
}

function closeAttachmentMenu() {
  elements.attachmentMenu.hidden = true;
  elements.attachmentButton.setAttribute('aria-expanded', 'false');
}

function renderPendingAttachments() {
  elements.attachmentTray.hidden = state.pendingAttachments.length === 0;
  elements.attachmentTray.innerHTML = state.pendingAttachments.map(attachment => `
    <div class="pending-attachment" data-pending-id="${escapeHtml(attachment.id)}">
      <span class="pending-attachment-preview">${attachment.previewUrl ? `<img src="${escapeHtml(attachment.previewUrl)}" alt="">` : escapeHtml(fileExtension(attachment.name).slice(0, 4))}</span>
      <span class="pending-attachment-copy"><strong title="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name)}</strong><small>${formatBytes(attachment.size)}</small></span>
      <button class="remove-attachment" type="button" data-remove-attachment="${escapeHtml(attachment.id)}" aria-label="Remover ${escapeHtml(attachment.name)}"><svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg></button>
    </div>`).join('');
}

function clearPendingAttachments({ revoke = true } = {}) {
  if (revoke) state.pendingAttachments.forEach(attachment => {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  });
  state.pendingAttachments = [];
  renderPendingAttachments();
}

function addPendingFiles(files) {
  const incoming = [...(files || [])];
  if (!incoming.length) return;
  let total = state.pendingAttachments.reduce((sum, attachment) => sum + attachment.size, 0);
  for (const file of incoming) {
    if (state.pendingAttachments.length >= ATTACHMENT_LIMITS.maxFiles) {
      toast(`Limite de ${ATTACHMENT_LIMITS.maxFiles} arquivos por mensagem.`, 'warning');
      break;
    }
    const type = supportedFile(file);
    if (!type) {
      toast(`Formato não suportado: ${file.name}`, 'error');
      continue;
    }
    if (file.size > ATTACHMENT_LIMITS.maxFileBytes) {
      toast(`${file.name} excede 8 MB.`, 'error');
      continue;
    }
    if (total + file.size > ATTACHMENT_LIMITS.maxTotalBytes) {
      toast('Os anexos excedem o limite total de 16 MB.', 'error');
      break;
    }
    if (state.pendingAttachments.some(item => item.name === file.name && item.size === file.size && item.file.lastModified === file.lastModified)) continue;
    total += file.size;
    state.pendingAttachments.push({
      id: crypto.randomUUID?.() || `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      file,
      name: file.name,
      size: file.size,
      ...type,
      previewUrl: type.kind === 'image' ? URL.createObjectURL(file) : null
    });
  }
  renderPendingAttachments();
  closeAttachmentMenu();
}

function fileDataUrl(attachment, signal) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => reader.abort();
    if (signal?.aborted) return reject(new DOMException('Resposta interrompida.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    reader.onerror = () => { cleanup(); reject(new Error(`Não foi possível ler ${attachment.name}.`)); };
    reader.onabort = () => { cleanup(); reject(new DOMException('Resposta interrompida.', 'AbortError')); };
    reader.onload = () => {
      cleanup();
      const value = String(reader.result || '').replace(/^data:[^;]*;/, `data:${attachment.mimeType};`);
      resolve({ name: attachment.name, mimeType: attachment.mimeType, dataUrl: value });
    };
    reader.readAsDataURL(attachment.file);
  });
}

function renderMessageAttachments(message) {
  const attachments = message.attachments || [];
  if (!attachments.length) return '';
  const conversationId = state.current?.id || '';
  return `<div class="message-attachments">${attachments.map(attachment => {
    const baseUrl = `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachment.id)}`;
    const stableUrl = `${baseUrl}?v=${encodeURIComponent(attachment.size || 0)}`;
    const inlineUrl = attachment.previewUrl || stableUrl;
    if (attachment.kind === 'image') {
      return `<a class="message-attachment image" href="${escapeHtml(inlineUrl)}" data-reload-url="${escapeHtml(stableUrl)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(inlineUrl)}" alt="${escapeHtml(attachment.name)}" decoding="async"><span class="image-caption">${escapeHtml(attachment.name)} · ${formatBytes(attachment.size)}</span><span class="image-fallback">Miniatura indisponível · clique para recarregar</span></a>`;
    }
    const content = `<span class="message-file-icon">${escapeHtml(fileExtension(attachment.name).slice(0, 4))}</span><span class="message-file-copy"><strong>${escapeHtml(attachment.name)}</strong><small>${formatBytes(attachment.size)} · abrir arquivo</small></span>`;
    return attachment.temporary
      ? `<span class="message-attachment file">${content}</span>`
      : `<a class="message-attachment file" href="${escapeHtml(baseUrl)}?download=1">${content}</a>`;
  }).join('')}</div>`;
}

function inlineMarkdown(value) {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return text;
}

function renderTextBlock(value) {
  const lines = String(value).split(/\r?\n/);
  const output = [];
  let list = null;
  const closeList = () => {
    if (list) output.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const wanted = bullet ? 'ul' : 'ol';
      if (list !== wanted) { closeList(); list = wanted; output.push(`<${list}>`); }
      output.push(`<li>${inlineMarkdown((bullet || ordered)[1])}</li>`);
      continue;
    }
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      closeList();
      output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    closeList();
    output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  return output.join('');
}

function markdown(value) {
  const source = String(value || '');
  const pattern = /```([\w.+-]*)\s*\n?([\s\S]*?)```/g;
  const output = [];
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) output.push(renderTextBlock(source.slice(cursor, match.index)));
    const language = String(match[1] || 'text').toLowerCase();
    const label = ({ sh: 'Bash', shell: 'Bash', bash: 'Bash', ps1: 'PowerShell', powershell: 'PowerShell',
      js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript', py: 'Python',
      json: 'JSON', html: 'HTML', css: 'CSS', sql: 'SQL', text: 'Código' })[language] || language;
    output.push(`<div class="code-block" data-language="${escapeHtml(language)}"><div class="code-block-header"><span>${escapeHtml(label)}</span><button class="code-copy-button" type="button" data-copy-code aria-label="Copiar código"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg><span>Copiar</span></button></div><pre><code>${escapeHtml(match[2].replace(/\s+$/, ''))}</code></pre></div>`);
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) output.push(renderTextBlock(source.slice(cursor)));
  return output.join('');
}

async function api(url, options = {}) {
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  if (method !== 'GET') headers['x-genesis-client'] = 'web';
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(url, { ...options, method, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || `Falha ${response.status}`);
  }
  return response.json();
}

function relativeTime(value) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(state.language, { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  const days = Math.round(hours / 24);
  return formatter.format(days, 'day');
}

function compactNumber(value) {
  const number = Number(value || 0);
  if (number >= 1000000) return `${(number / 1000000).toFixed(number >= 10000000 ? 0 : 1)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k`;
  return String(number);
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.innerHTML = `<i></i><span>${escapeHtml(message)}</span>`;
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 4200);
}

function profileInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'EU';
  return `${parts[0][0] || ''}${parts.length > 1 ? parts.at(-1)[0] : parts[0][1] || ''}`.toLocaleUpperCase(state.language);
}

function renderProfile() {
  const name = state.profile.name;
  const initials = profileInitials(name);
  const photo = String(state.profile.photo || '');
  elements.userAvatar.textContent = photo ? '' : initials;
  elements.userAvatar.classList.toggle('has-photo', Boolean(photo));
  elements.userAvatar.style.backgroundImage = photo ? `url(${JSON.stringify(photo).slice(1, -1)})` : '';
  const profileInitialsElement = elements.profileAvatar.querySelector('span');
  if (profileInitialsElement) profileInitialsElement.textContent = initials;
  elements.profileAvatar.classList.toggle('has-photo', Boolean(photo));
  elements.profileAvatar.style.backgroundImage = photo ? `url(${JSON.stringify(photo).slice(1, -1)})` : '';
  elements.removeProfilePhoto.hidden = !photo;
  elements.profileDisplayName.textContent = name;
  elements.profileNameInput.value = name;
  queueLanguageRefresh();
}

function loadProfile() {
  try {
    const stored = JSON.parse(localStorage.getItem('genesis:userProfile') || '{}');
    const name = String(stored.name || '').trim();
    const photo = /^data:image\/(?:png|jpeg|webp);base64,/i.test(stored.photo || '') ? stored.photo : '';
    if (name) state.profile = { name: name.slice(0, 60), photo };
  } catch { /* mantém o perfil padrão */ }
  renderProfile();
}

function persistProfile() {
  localStorage.setItem('genesis:userProfile', JSON.stringify(state.profile));
}

function setProfileEditor(open) {
  elements.profileEditor.hidden = !open;
  elements.editProfileButton.hidden = open;
  if (open) {
    elements.profileNameInput.value = state.profile.name;
    requestAnimationFrame(() => elements.profileNameInput.focus());
  }
}

function saveProfile() {
  const name = elements.profileNameInput.value.replace(/\s+/g, ' ').trim();
  if (name.length < 2) return toast('Digite um nome válido para o perfil.', 'warning');
  state.profile = { ...state.profile, name: name.slice(0, 60) };
  persistProfile();
  renderProfile();
  setProfileEditor(false);
  toast('Perfil atualizado com sucesso.');
}

async function updateProfilePhoto(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return toast('Use uma imagem PNG, JPEG ou WebP.', 'warning');
  if (file.size > 900 * 1024) return toast('A foto deve ter no máximo 900 KB.', 'warning');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Não foi possível ler a foto selecionada.'));
    reader.readAsDataURL(file);
  });
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(dataUrl)) return toast('A foto selecionada não é válida.', 'warning');
  state.profile = { ...state.profile, photo: dataUrl };
  persistProfile();
  renderProfile();
  toast('Foto de perfil atualizada.');
}

function removeProfilePhoto() {
  state.profile = { ...state.profile, photo: '' };
  persistProfile();
  renderProfile();
  toast('Foto de perfil removida.', 'warning');
}

const settingsPanelCopy = {
  profile: ['Perfil', 'Personalize sua identidade e o idioma do painel.'],
  connection: ['Conexão', 'Gerencie a chave e a segurança da conexão gratuita.'],
  models: ['Modelos', 'Defina como o Gênesis seleciona os modelos gratuitos.'],
  privacy: ['Privacidade', 'Controle a memória adaptativa e os dados locais.']
};

function setSettingsTab(tab = 'profile') {
  if (!settingsPanelCopy[tab]) tab = 'profile';
  state.settingsTab = tab;
  $$('.settings-nav-button').forEach(button => button.classList.toggle('active', button.dataset.settingsTab === tab));
  $$('.settings-panel').forEach(panel => {
    const active = panel.dataset.settingsPanel === tab;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  const [title, description] = settingsPanelCopy[tab];
  elements.settingsPanelTitle.textContent = title;
  elements.settingsPanelDescription.textContent = description;
  elements.saveModelButton.hidden = tab !== 'models';
  setConfigFeedback();
  queueLanguageRefresh();
}

function setLanguage(language, { persist = true, notify = true } = {}) {
  state.language = language === 'en-US' ? 'en-US' : 'pt-BR';
  if (persist) localStorage.setItem('genesis:language', state.language);
  $$('[data-language]').forEach(button => {
    const active = button.dataset.language === state.language;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  translatePage();
  renderConversations();
  if (notify) toast(state.language === 'en-US' ? 'Language changed to English.' : 'Idioma alterado para Português.');
}

function loadLanguage() {
  setLanguage(localStorage.getItem('genesis:language') || 'pt-BR', { persist: false, notify: false });
}

function setSidebarCollapsed(collapsed, { persist = true } = {}) {
  const preference = Boolean(collapsed);
  const applied = preference && matchMedia('(min-width: 901px)').matches;
  elements.appShell.classList.toggle('sidebar-collapsed', applied);
  elements.sidebarCollapseButton.setAttribute('aria-expanded', String(!applied));
  elements.sidebarCollapseButton.setAttribute('aria-label', applied ? 'Expandir barra lateral' : 'Recolher barra lateral');
  elements.sidebarCollapseButton.title = applied ? 'Expandir barra lateral' : 'Recolher barra lateral';
  if (persist) localStorage.setItem('genesis:sidebarCollapsed', preference ? '1' : '0');
}

const logCategoryLabels = {
  agent: 'Agente', providers: 'Provedores', storage: 'Memória', conversation: 'Conversa',
  server: 'Servidor', system: 'Sistema'
};

function logTime(value, includeDate = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return new Intl.DateTimeFormat(state.language, {
    ...(includeDate ? { day: '2-digit', month: '2-digit' } : {}),
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date);
}

function filteredLogs({ thoughts = false } = {}) {
  const query = elements.logSearch.value.trim().toLowerCase();
  const level = elements.logLevelFilter.value;
  const category = elements.logCategoryFilter.value;
  return state.logs.filter(item => {
    if (thoughts && item.thought !== true) return false;
    if (level && item.level !== level) return false;
    if (category && item.category !== category) return false;
    if (!query) return true;
    return [item.title, item.detail, item.type, item.category, item.providerId].some(value => String(value || '').toLowerCase().includes(query));
  });
}

function renderLogBadge() {
  elements.logsBadge.hidden = state.unseenLogs < 1;
  elements.logsBadge.textContent = state.unseenLogs > 99 ? '99+' : String(state.unseenLogs);
}

function renderTelemetry() {
  const allLogs = filteredLogs();
  const thoughts = filteredLogs({ thoughts: true });
  elements.logCount.textContent = String(state.logs.length);
  elements.thoughtCount.textContent = String(state.logs.filter(item => item.thought === true).length);

  elements.logList.innerHTML = allLogs.length ? allLogs.slice().reverse().map(item => `
    <article class="log-row" data-log-id="${escapeHtml(item.id)}">
      <time class="log-time" datetime="${escapeHtml(item.timestamp)}">${logTime(item.timestamp)}</time>
      <span class="log-level ${escapeHtml(item.level)}"><i></i>${escapeHtml(item.level)}</span>
      <span class="log-category">${escapeHtml(logCategoryLabels[item.category] || item.category)}</span>
      <span class="log-copy"><strong>${escapeHtml(item.title)}</strong>${item.detail ? `<span>${escapeHtml(item.detail)}</span>` : ''}</span>
    </article>`).join('') : '<div class="logs-empty">Nenhum evento corresponde aos filtros atuais.</div>';

  elements.thoughtList.innerHTML = thoughts.length ? thoughts.slice().reverse().map(item => `
    <article class="thought-item ${escapeHtml(item.level)}" data-thought-id="${escapeHtml(item.id)}">
      <span class="thought-marker"><svg viewBox="0 0 24 24"><path d="M12 3a7 7 0 0 0-4 12.7V19h8v-3.3A7 7 0 0 0 12 3ZM9 22h6M9 15h6"/></svg></span>
      <span class="thought-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail || 'Etapa registrada pelo Genesis.')}</span></span>
      <time class="thought-meta" datetime="${escapeHtml(item.timestamp)}">${logTime(item.timestamp, true)}${item.providerId ? ` · ${escapeHtml(item.providerId)}` : ''}</time>
    </article>`).join('') : '<div class="logs-empty">O rastro de trabalho aparecerá quando o Genesis executar uma tarefa.</div>';

  const visible = state.activeLogTab === 'thoughts' ? thoughts.length : allLogs.length;
  elements.logsFooterStatus.textContent = `${visible} evento${visible === 1 ? '' : 's'} ${visible === 1 ? 'visível' : 'visíveis'} · retenção local de ${state.logs.length}`;
  renderLogBadge();
}

function setLogConnection(connected) {
  state.logConnected = connected;
  const status = state.logPaused ? 'paused' : connected ? 'live' : 'connecting';
  const label = state.logPaused ? 'Pausado' : connected ? 'Ao vivo' : 'Reconectando';
  elements.streamState.className = `stream-state ${status}`;
  elements.streamState.querySelector('span').textContent = label;
}

function receiveLog(event) {
  if (!event?.id || state.logs.some(item => item.id === event.id)) return;
  state.logs.push(event);
  if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500);
  const drawerOpen = elements.appShell.classList.contains('logs-open');
  if (!drawerOpen || state.logPaused) state.unseenLogs += 1;
  if (!state.logPaused) renderTelemetry();
  else renderLogBadge();
}

function connectTelemetry() {
  state.logSource?.close();
  setLogConnection(false);
  const source = new EventSource('/api/logs/stream');
  state.logSource = source;
  source.addEventListener('open', () => setLogConnection(true));
  source.addEventListener('snapshot', event => {
    try {
      const payload = JSON.parse(event.data);
      state.logs = Array.isArray(payload.logs) ? payload.logs.slice(-500) : [];
      if (!state.logPaused) renderTelemetry();
    } catch { /* the stream reconnects automatically */ }
  });
  source.addEventListener('log', event => {
    try { receiveLog(JSON.parse(event.data)); } catch { /* ignore malformed event */ }
  });
  source.addEventListener('error', () => setLogConnection(false));
}

function selectLogTab(tab) {
  state.activeLogTab = tab === 'thoughts' ? 'thoughts' : 'logs';
  $$('.log-tab').forEach(button => {
    const active = button.dataset.logTab === state.activeLogTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  elements.logsPanel.hidden = state.activeLogTab !== 'logs';
  elements.thoughtsPanel.hidden = state.activeLogTab !== 'thoughts';
  renderTelemetry();
}

function openLogs(tab = state.activeLogTab) {
  closeDrawers();
  elements.appShell.classList.add('logs-open');
  elements.logsDrawer.setAttribute('aria-hidden', 'false');
  elements.logsToggle.setAttribute('aria-expanded', 'true');
  if (!state.logPaused) state.unseenLogs = 0;
  selectLogTab(tab);
}

async function clearTelemetry() {
  if (!window.confirm('Limpar todo o histórico local de observabilidade?')) return;
  await api('/api/logs', { method: 'DELETE' });
  state.logs = [];
  state.unseenLogs = 0;
  renderTelemetry();
  toast('Logs locais limpos.');
}

function toggleTelemetryPause() {
  state.logPaused = !state.logPaused;
  elements.pauseLogsButton.classList.toggle('active', state.logPaused);
  elements.pauseLogsButton.querySelector('span').textContent = state.logPaused ? 'Retomar' : 'Pausar';
  elements.pauseLogsButton.title = state.logPaused ? 'Retomar atualização visual' : 'Pausar atualização visual';
  if (!state.logPaused) {
    state.unseenLogs = 0;
    renderTelemetry();
  }
  setLogConnection(state.logConnected);
}

function renderConversations() {
  const query = elements.conversationSearch.value.trim().toLowerCase();
  const conversations = state.conversations.filter(item => item.title.toLowerCase().includes(query));
  elements.conversationCount.textContent = String(state.conversations.length);
  if (!conversations.length) {
    elements.conversationList.innerHTML = `<div class="empty-history">${query ? 'Nenhuma conversa encontrada.' : 'Suas conversas aparecerão aqui.'}</div>`;
    return;
  }
  elements.conversationList.innerHTML = conversations.map(conversation => {
    const markerColor = ['violet', 'cyan', 'green', 'amber', 'rose'].includes(conversation.markerColor) ? conversation.markerColor : 'violet';
    return `
    <div class="conversation-item ${conversation.id === state.current?.id ? 'active' : ''}" data-conversation-id="${conversation.id}" role="button" tabindex="0">
      <button class="conversation-icon marker-${markerColor}" type="button" data-conversation-menu-id="${conversation.id}" aria-label="Personalizar ${escapeHtml(conversation.title)}" title="Marcador e nome">${icons.chat}</button>
      <span class="conversation-copy"><strong>${escapeHtml(conversation.title)}</strong><small>${relativeTime(conversation.updatedAt)} · ${conversation.messageCount || 0} mensagens</small></span>
      <button class="conversation-delete" data-delete-id="${conversation.id}" type="button" aria-label="Excluir conversa">${icons.trash}</button>
    </div>`;
  }).join('');
}

function closeConversationPopover() {
  state.conversationMenuId = null;
  elements.conversationPopover.hidden = true;
  elements.conversationPopover.style.top = '';
}

function openConversationPopover(conversationId, anchor) {
  const conversation = state.conversations.find(item => item.id === conversationId);
  if (!conversation) return;
  if (matchMedia('(min-width: 901px)').matches && elements.appShell.classList.contains('sidebar-collapsed')) {
    setSidebarCollapsed(false, { persist: false });
  }
  state.conversationMenuId = conversationId;
  elements.conversationRenameInput.value = conversation.title;
  const markerColor = ['violet', 'cyan', 'green', 'amber', 'rose'].includes(conversation.markerColor) ? conversation.markerColor : 'violet';
  elements.conversationPopover.querySelectorAll('[data-marker-color]').forEach(button => {
    button.classList.toggle('active', button.dataset.markerColor === markerColor);
  });
  elements.conversationPopover.hidden = false;
  requestAnimationFrame(() => {
    const sidebarRect = elements.sidebar.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const maxTop = Math.max(84, sidebarRect.height - elements.conversationPopover.offsetHeight - 14);
    elements.conversationPopover.style.top = `${Math.min(maxTop, Math.max(84, anchorRect.top - sidebarRect.top - 8))}px`;
  });
}

async function updateConversationPersonalization(changes) {
  const conversationId = state.conversationMenuId;
  if (!conversationId) return;
  const payload = await api(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH', body: JSON.stringify(changes)
  });
  const summaryIndex = state.conversations.findIndex(item => item.id === conversationId);
  if (summaryIndex >= 0) {
    const messageCount = state.conversations[summaryIndex].messageCount || payload.conversation.messages?.length || 0;
    state.conversations[summaryIndex] = { ...state.conversations[summaryIndex], ...payload.conversation, messageCount };
  }
  if (state.current?.id === conversationId) state.current = { ...state.current, ...payload.conversation };
  renderConversations();
  updateConversationHeader();
}

async function saveConversationName() {
  const title = elements.conversationRenameInput.value.replace(/\s+/g, ' ').trim();
  if (!title) return toast('Digite um nome para a conversa.', 'warning');
  elements.saveConversationRename.disabled = true;
  try {
    await updateConversationPersonalization({ title });
    closeConversationPopover();
    toast('Conversa renomeada.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    elements.saveConversationRename.disabled = false;
  }
}

function startPolicyPhraseRotation() {
  const phrases = [
    'Agentes gratuitos e eficientes.',
    'Inteligência sem custo.',
    'Tecnologia ao seu alcance.',
    'Produtividade sem limites.',
    'Liberdade na criação.'
  ];
  clearInterval(state.policyPhraseTimer);
  state.policyPhraseTimer = window.setInterval(() => {
    if (!elements.policyPhrase) return;
    elements.policyPhrase.classList.add('leaving');
    window.setTimeout(() => {
      state.policyPhraseIndex = (state.policyPhraseIndex + 1) % phrases.length;
      elements.policyPhrase.textContent = phrases[state.policyPhraseIndex];
      elements.policyPhrase.classList.remove('leaving');
    }, 220);
  }, 3400);
}

function setConfigTour(open, { remember = false } = {}) {
  if (remember) localStorage.setItem('genesis:configTourSkipped', '1');
  elements.configTour.hidden = !open;
  document.body.classList.toggle('tour-open', open);
}

function renderAdaptiveMemory() {
  const memory = state.userMemory || { enabled: true, messagesObserved: 0, summary: [] };
  elements.adaptiveMemoryEnabled.checked = memory.enabled !== false;
  elements.clearAdaptiveMemory.disabled = !memory.messagesObserved;
  elements.adaptiveMemorySummary.textContent = !memory.enabled
    ? 'Aprendizado pausado. O contexto da conversa continua funcionando normalmente.'
    : memory.summary?.length
      ? memory.summary.join(' · ')
      : 'O Gênesis começará a adaptar tom e prioridades durante o uso.';
}

async function updateAdaptiveMemory(enabled) {
  const payload = await api('/api/user-memory', {
    method: 'PUT', body: JSON.stringify({ enabled })
  });
  state.userMemory = payload.userMemory;
  renderAdaptiveMemory();
  toast(enabled ? 'Memória adaptativa ativada.' : 'Memória adaptativa pausada.', enabled ? 'success' : 'warning');
}

async function clearAdaptiveMemory() {
  if (!window.confirm('Limpar as preferências aprendidas localmente?')) return;
  const payload = await api('/api/user-memory', { method: 'DELETE' });
  state.userMemory = payload.userMemory;
  renderAdaptiveMemory();
  toast('Aprendizado local removido.', 'warning');
}

function messageMeta(message) {
  if (message.role !== 'assistant' || !message.meta) return '';
  const meta = message.meta;
  const latency = meta.latencyMs ? `${(meta.latencyMs / 1000).toFixed(1)}s` : '';
  const saved = meta.context?.savedTokens ? `${compactNumber(meta.context.savedTokens)} poupados` : '';
  const responseTokens = Number(meta.usage?.outputTokens || 0);
  const inputTokens = Number(meta.usage?.inputTokens || 0);
  const rawRequestCount = meta.usage?.requestCount;
  const requestCount = Number.isFinite(Number(rawRequestCount)) ? Math.max(0, Number(rawRequestCount)) : 1;
  const accuracy = ({
    reported: 'medição do provedor',
    estimated: 'estimativa local',
    mixed: 'medição mista',
    local: 'processamento 100% local',
    unknown: 'uso não informado pelo provedor'
  })[meta.usage?.accuracy] || 'medição mista/estimada';
  const contextUsed = Number(meta.context?.usedTokens || meta.usage?.totalTokens || 0);
  const contextWindow = Number(meta.context?.contextWindow || 0);
  const remainingTokens = Number.isFinite(meta.context?.remainingTokens)
    ? Number(meta.context.remainingTokens)
    : Math.max(0, contextWindow - contextUsed);
  return `<div class="message-meta">
    <span class="engine-tag"><i></i>${escapeHtml(meta.model || 'automático')}</span>
    ${meta.freeVerified ? '<span class="free-tag">✓ FREE</span>' : ''}
    ${latency ? `<span>${latency}</span>` : ''}${saved ? `<span>${saved}</span>` : ''}
    <small class="message-token-accounting"><strong>${compactNumber(inputTokens)}</strong> enviados · <strong>${compactNumber(responseTokens)}</strong> recebidos · ${requestCount} requisição${requestCount === 1 ? '' : 'ões'} · ${accuracy}${contextWindow ? ` · <strong>${compactNumber(remainingTokens)}</strong> livres na última janela de ${compactNumber(contextWindow)}` : ''}</small>
  </div>`;
}

function messageTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(state.language, {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function estimatedClientTokens(message) {
  const recorded = Number(message.meta?.tokenEstimate || 0);
  if (recorded > 0) return recorded;
  const textTokens = Math.max(1, Math.ceil(String(message.content || '').length / 4));
  return textTokens + 4 + (message.attachments?.length || 0) * 700;
}

function messageAvatar(message) {
  const userTokens = message.role === 'user' ? `<small>~${compactNumber(estimatedClientTokens(message))} tokens</small>` : '';
  const avatar = message.role === 'assistant'
    ? '<span class="badge-orbit message-orbit" aria-hidden="true"><i></i></span>'
    : '<div class="message-avatar">EU</div>';
  return `<div class="message-avatar-stack">
    ${avatar}
    <small>${messageTimestamp(message.createdAt)}</small>
    ${userTokens}
  </div>`;
}

function userMessageBody(message) {
  if (state.editingMessageId !== message.id) return `<div class="message-content"><p>${escapeHtml(message.content).replace(/\n/g, '<br>')}</p></div>`;
  const attachmentNote = message.attachments?.length
    ? `<small>${message.attachments.length} anexo${message.attachments.length === 1 ? '' : 's'} será${message.attachments.length === 1 ? '' : 'o'} preservado${message.attachments.length === 1 ? '' : 's'}.</small>`
    : '<small>As respostas posteriores serão substituídas.</small>';
  return `<div class="message-edit-form" data-edit-form="${message.id}">
    <textarea data-edit-input="${message.id}" maxlength="20000" aria-label="Editar mensagem">${escapeHtml(message.content)}</textarea>
    <div class="message-edit-footer">${attachmentNote}<span>
      <button class="message-edit-cancel" type="button" data-cancel-edit="${message.id}">Cancelar</button>
      <button class="message-edit-resend" type="button" data-resend-edit="${message.id}">Enviar novamente</button>
    </span></div>
  </div>`;
}

function beginMessageEdit(messageId) {
  if (state.sending) return toast('Pare a resposta atual antes de editar outra mensagem.', 'warning');
  const message = state.current?.messages.find(item => item.id === messageId && item.role === 'user');
  if (!message) return;
  state.editingMessageId = messageId;
  renderMessages();
  requestAnimationFrame(() => {
    const input = elements.messageList.querySelector(`[data-edit-input="${CSS.escape(messageId)}"]`);
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 74), 220)}px`;
  });
}

function cancelMessageEdit() {
  state.editingMessageId = null;
  renderMessages();
}

function resendEditedMessage(messageId) {
  if (state.sending) return;
  const input = elements.messageList.querySelector(`[data-edit-input="${CSS.escape(messageId)}"]`);
  const message = state.current?.messages.find(item => item.id === messageId && item.role === 'user');
  if (!input || !message) return;
  const content = input.value.trim();
  if (!content && !message.attachments?.length) return toast('A mensagem editada não pode ficar vazia.', 'error');
  state.editingMessageId = null;
  sendMessage(content, { editMessageId: messageId });
}

function renderMessages() {
  const messages = state.current?.messages || [];
  elements.emptyState.hidden = messages.length > 0;
  elements.messageList.hidden = messages.length === 0;
  elements.messageList.innerHTML = messages.map(message => `
    <article class="message ${message.role}" data-message-id="${message.id}">
      ${messageAvatar(message)}
      <div class="message-body">
        ${message.role === 'assistant' ? `<div class="message-content">${markdown(message.content)}</div>` : userMessageBody(message)}
        ${renderMessageAttachments(message)}
        ${messageMeta(message)}
        ${state.editingMessageId === message.id ? '' : `<div class="message-actions">
          <button class="message-action-button" data-copy-id="${message.id}">Copiar</button>
          ${message.role === 'user' ? `<button class="message-action-button" data-edit-id="${message.id}">Editar</button>${message.editedAt ? '<span>editada</span>' : ''}` : ''}
        </div>`}
      </div>
    </article>`).join('');
  updateConversationHeader();
  updateMetrics();
}

function updateConversationHeader() {
  elements.conversationTitle.textContent = state.current?.title || 'Nova conversa';
  state.mode = state.current?.mode || state.mode || 'balanced';
  $$('.mode-chip').forEach(button => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
}

function updateMetrics() {
  const conversation = state.current;
  const stats = conversation?.stats || {};
  elements.savedTokensMetric.textContent = compactNumber(stats.savedTokens);
  elements.switchMetric.textContent = compactNumber(stats.providerSwitches);
  elements.messageMetric.textContent = compactNumber(conversation?.messages?.length || 0);
  elements.requestMetric.textContent = compactNumber(stats.requests);
  const lastAssistant = [...(conversation?.messages || [])].reverse().find(message => message.role === 'assistant');
  const context = lastAssistant?.meta?.context;
  elements.continuityValue.textContent = `${context?.memoryRetainedPercent ?? 100}%`;
  elements.continuityDetail.textContent = context
    ? `${context.retainedMessages}/${context.totalMessages} mensagens ativas · ${compactNumber(context.savedTokens)} tokens poupados`
    : 'Histórico canônico independente do modelo';
  elements.tokenHint.textContent = context
    ? `${compactNumber(context.estimatedTokens)} tokens no último contexto`
    : 'Contexto econômico ativo';
  updateContextMeter(context);
}

function updateContextMeter(context) {
  const configuredModel = state.openrouter?.configuration?.selectionMode === 'manual'
    ? state.freeModels.find(model => model.id === state.openrouter.configuration.selectedModel)
    : null;
  const measuredWindow = Number(context?.contextWindow || 0);
  const contextWindow = Math.max(measuredWindow, Number(configuredModel?.contextWindow || 0));
  const usedTokens = Number(context?.usedTokens || 0);
  if (!contextWindow) {
    elements.contextMeterCard.dataset.level = 'healthy';
    elements.contextMeterStatus.textContent = 'Aguardando primeira resposta';
    elements.contextMeterPercent.textContent = '—';
    elements.contextUsedTokens.textContent = '0';
    elements.contextRemainingTokens.textContent = '—';
    elements.contextProgressFill.style.width = '100%';
    elements.contextProgress.setAttribute('aria-valuenow', '100');
    elements.modelHandoffButton.hidden = true;
    return;
  }
  const remainingTokens = Math.max(0, contextWindow - usedTokens);
  const remainingPercent = Math.max(0, Math.min(100, Math.round((remainingTokens / contextWindow) * 100)));
  const level = remainingPercent <= 20 ? 'critical' : remainingPercent <= 50 ? 'warning' : 'healthy';
  elements.contextMeterCard.dataset.level = level;
  elements.contextMeterStatus.textContent = level === 'critical' ? 'Contexto próximo do limite' : level === 'warning' ? 'Uso moderado do contexto' : 'Contexto com boa disponibilidade';
  elements.contextMeterPercent.textContent = `${remainingPercent}% livre`;
  elements.contextUsedTokens.textContent = compactNumber(usedTokens);
  elements.contextRemainingTokens.textContent = compactNumber(remainingTokens);
  elements.contextProgressFill.style.width = `${remainingPercent}%`;
  elements.contextProgress.setAttribute('aria-valuenow', String(remainingPercent));
  elements.modelHandoffButton.hidden = level !== 'critical';
}

async function handoffToLargerModel() {
  if (!state.current || state.handoffLoading || state.sending) return;
  state.handoffLoading = true;
  const button = elements.modelHandoffButton;
  const original = button.innerHTML;
  button.disabled = true;
  button.classList.add('loading');
  button.innerHTML = `<span class="handoff-spinner"></span><span><strong>Carregando modelo…</strong><small>A nova IA está estudando a memória canônica</small></span>`;
  addTimeline('route', 'Carregando modelo', 'Validando a linha de trabalho antes de transferir a sessão.');
  try {
    const payload = await api(`/api/conversations/${encodeURIComponent(state.current.id)}/handoff`, { method: 'POST' });
    applyOpenRouterPayload(payload.openrouter);
    elements.activeEngine.textContent = `Genesis · ${payload.handoff.modelName}`;
    addTimeline('complete', 'Continuidade validada', `${payload.handoff.modelName} · ${compactNumber(payload.handoff.contextWindow)} tokens de contexto`);
    updateMetrics();
    toast('Novo modelo carregado com a memória canônica preservada.');
  } catch (error) {
    addTimeline('fallback', 'Troca não concluída', error.message);
    toast(error.message, 'error');
  } finally {
    state.handoffLoading = false;
    button.disabled = false;
    button.classList.remove('loading');
    button.innerHTML = original;
  }
}

const providerLabels = {
  online: 'Online', cooldown: 'Em espera', degraded: 'Instável', setup: 'Configurar',
  detecting: 'Detectando', ready: 'Pronto'
};

function renderProviders() {
  elements.providerStack.innerHTML = state.providers.map(provider => {
    const selection = provider.selectionMode === 'manual'
      ? provider.selectedModel
      : `Automático · ${provider.modelCount || 0} modelos free`;
    const detail = provider.lastError?.message || provider.resolvedModel || provider.lastModel || selection || provider.freeLabel;
    return `<div class="provider-card">
      <span class="provider-monogram openrouter">OR</span>
      <span class="provider-copy"><strong>${escapeHtml(provider.name)}</strong><small title="${escapeHtml(detail)}">${escapeHtml(detail)}</small></span>
      <span class="provider-state ${provider.state}"><i></i>${providerLabels[provider.state] || provider.state}</span>
    </div>`;
  }).join('');
}

function setConfigFeedback(message = '', type = 'success') {
  elements.configFeedback.hidden = !message;
  elements.configFeedback.className = `config-feedback ${type === 'error' ? 'error' : ''}`;
  elements.configFeedback.textContent = message;
}

function applyOpenRouterPayload(payload) {
  if (!payload) return;
  state.openrouter = payload;
  state.freeModels = Array.isArray(payload.models) ? payload.models : [];
  if (payload.provider) state.providers = [payload.provider];
  renderProviders();
  renderOpenRouterSettings();
}

function currentSelectionMode() {
  return $('input[name="modelSelection"]:checked')?.value === 'manual' ? 'manual' : 'automatic';
}

function renderOpenRouterSettings() {
  const configuration = state.openrouter?.configuration || {};
  const configured = configuration.configured === true;
  const modelCount = state.freeModels.length;
  elements.persistOpenRouterKey.checked = configured ? configuration.persisted === true : true;
  elements.openRouterStatusTitle.textContent = configured ? 'OpenRouter conectado' : 'OpenRouter desconectado';
  elements.openRouterStatusDetail.textContent = configured
    ? `${configuration.account?.label || 'Chave validada'} · ${modelCount} modelos gratuitos disponíveis`
    : 'Adicione sua chave para carregar os modelos gratuitos.';
  elements.openRouterIndicator.classList.toggle('online', configured);
  elements.openRouterIndicator.querySelector('span').textContent = configured ? 'Online' : 'Offline';
  elements.connectOpenRouterButton.textContent = configured ? 'Atualizar conexão' : 'Conectar e carregar';
  elements.disconnectOpenRouterButton.hidden = !configured;
  elements.modelSettings.classList.toggle('disabled', !configured);
  elements.saveModelButton.disabled = !configured;
  elements.openRouterApiKey.placeholder = configured ? 'Chave configurada — deixe vazio para manter' : 'sk-or-v1-••••••••••••••••';
  elements.freeModelCount.textContent = `${modelCount} modelo${modelCount === 1 ? '' : 's'}`;
  renderQuotaMeter();

  const selectionMode = configuration.selectionMode === 'manual' ? 'manual' : 'automatic';
  $$('input[name="modelSelection"]').forEach(input => {
    input.checked = input.value === selectionMode;
    input.closest('.strategy-option').classList.toggle('active', input.checked);
    input.disabled = !configured;
  });

  const selected = configuration.selectedModel || '';
  elements.manualModelSelect.innerHTML = modelCount
    ? state.freeModels.map(model => `<option value="${escapeHtml(model.id)}" ${model.id === selected ? 'selected' : ''}>${escapeHtml(model.name)} · ${compactNumber(model.contextWindow)} ctx</option>`).join('')
    : '<option value="">Conecte sua chave para carregar os modelos</option>';
  if (modelCount && !state.freeModels.some(model => model.id === elements.manualModelSelect.value)) elements.manualModelSelect.value = state.freeModels[0].id;
  updateModelControls();
}

// Mostra o quota-meter quando o Genesis já tem uma chave conectada (do vault)
// ou recém-conectada. Usa dados do provider.header* se o servidor enviou.
function renderQuotaMeter() {
  const meter = elements.openRouterQuotaMeter;
  if (!meter) return;
  const configured = state.openrouter?.configuration?.configured === true;
  meter.hidden = !configured;
  if (!configured) return;
  const provider = state.openrouter?.provider || {};
  // Ordem de prioridade (real primeiro, header depois):
  //  1) configuration.account.limitRemaining vêm do /auth/key (sem gastar quota).
  //  2) provider.remainingTokens / remainingRequests vêm dos headers de cobrança.
  //  3) Sem números → estado "unknown" honesto (nunca "— / —").
  const account = state.openrouter?.configuration?.account || {};
  const remainingRequests = numberOrNull(provider.remainingRequests);
  const remainingTokensHeader = numberOrNull(provider.remainingTokens);
  const limit = numberOrNull(account.limit ?? provider.limit);
  const limitRemaining = numberOrNull(account.limitRemaining);
  const remainingTokens = remainingTokensHeader ?? limitRemaining;
  const hasNumbers = remainingTokens !== null || remainingRequests !== null;
  const elapsed = provider.lastCheckedAt ? Date.now() - new Date(provider.lastCheckedAt).getTime() : null;
  const primary = { remaining: remainingTokens, limit: limit, unit: 'tokens', isNumber: hasNumbers };
  const secondary = { remaining: remainingRequests };
  const filled = computeFillRatio(primary, secondary, hasNumbers);
  applyQuotaFill(filled, hasNumbers, { provider, configured, account });
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function computeFillRatio(primary, secondary, hasNumbers) {
  if (!hasNumbers) return { percent: null, mode: 'unknown' };
  const tokens = primary.remaining;
  const limit = primary.limit;
  // Tenta com tokens; se houver restart info, usa a menor métrica.
  if (tokens !== null && tokens !== undefined && tokens >= 0) {
    if (typeof limit === 'number' && limit > 0) {
      // Percentual real (limit > 0 é raro em free tier, mas acontece em Pro).
      const pct = Math.max(0, Math.min(100, (tokens / limit) * 100));
      return { percent: pct, tokensRemaining: tokens, mode: 'normal' };
    }
    // Sem limit_total: ainda exibe o número absoluto (a barra fica cheia).
    return { percent: null, tokensRemaining: tokens, mode: 'tokens-only' };
  }
  if (secondary.remaining !== null && secondary.remaining !== undefined && secondary.remaining >= 0) {
    return {
      percent: null,
      tokensRemaining: secondary.remaining,
      mode: 'requests-only'
    };
  }
  return { percent: null, mode: 'unknown' };
}

function applyQuotaFill(filled, hasNumbers, ctx = {}) {
  const fill = elements.openRouterQuotaFill;
  const valueEl = elements.openRouterQuotaValue;
  const detailEl = elements.openRouterQuotaDetail;
  const bar = elements.openRouterQuotaBar;
  if (!fill || !valueEl || !detailEl || !bar) return;
  fill.classList.remove('warn', 'critical', 'unknown');
  valueEl.classList.remove('warn', 'critical', 'unknown');
  if (!hasNumbers || filled.mode === 'unknown') {
    // Sem números no momento — texto explicativo em vez de "— / —".
    fill.classList.add('unknown');
    valueEl.classList.add('unknown');
    const account = ctx?.account || {};
    const isFree = account.isFreeTier === true;
    const limitDisplay = (typeof account.limit === 'number' && account.limit > 0)
      ? `${formatTokens(account.limit)} (limite)` : '';
    const remainDisplay = (typeof account.limitRemaining === 'number' && account.limitRemaining >= 0)
      ? `${formatTokens(account.limitRemaining)} restantes` : '';
    const accountDetail = (limitDisplay || remainDisplay)
      ? ` Limite da chave: ${limitDisplay || '—'}; restantes: ${remainDisplay || '—'}.`
      : isFree
        ? ' Plano free-tier (sem limite de quota explícito por chave).'
        : ' Plano Pro (sem contadores nesta resposta — faça uma requisição).';
    valueEl.textContent = 'Quota ainda não medida';
    detailEl.textContent = `OpenRouter ainda não retornou contadores nesta chave.${accountDetail}`;
    bar.setAttribute('aria-valuenow', 0);
    return;
  } else if (ctx?.configured === false) {
    // Conta não configurada (raro, mas tratado)
    fill.classList.add('unknown');
    valueEl.classList.add('unknown');
    valueEl.textContent = '— / —';
    detailEl.textContent = 'Conecte uma chave OpenRouter para começar a usar o Genesis.';
    bar.setAttribute('aria-valuenow', 0);
    return;
  }
  // Constrói texto curto e significativo.
  let valueText;
  if (filled.mode === 'tokens-only') {
    valueText = `${formatTokens(filled.tokensRemaining)} restantes`;
    valueEl.textContent = valueText;
    detailEl.textContent = 'Renova quando a chave tem créditos ilimitados (free tier).';
    fill.style.width = '100%';
    bar.setAttribute('aria-valuenow', 100);
    // Cor de aviso se extremamente baixo
    if (filled.tokensRemaining !== null && filled.tokensRemaining < 1000) {
      fill.classList.add('warn');
      valueEl.classList.add('warn');
      detailEl.textContent = 'Tokens restantes muito baixos — o Genesis pode parar em breve.';
    }
  } else if (filled.mode === 'requests-only') {
    valueText = `${filled.tokensRemaining} req. restantes`;
    valueEl.textContent = valueText;
    detailEl.textContent = 'Limite por número de requests nesta janela.';
    fill.style.width = '100%';
    bar.setAttribute('aria-valuenow', 100);
    if (filled.tokensRemaining !== null && filled.tokensRemaining < 5) {
      fill.classList.add('warn');
      valueEl.classList.add('warn');
      detailEl.textContent = 'Poucas requisições restantes — o Genesis pode parar em breve.';
    }
  } else {
    const pct = Math.max(0, Math.min(100, filled.percent || 0));
    fill.style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', pct);
    valueEl.textContent = `${formatTokens(filled.tokensRemaining)} restantes`;
    if (pct < 10) {
      fill.classList.add('critical');
      valueEl.classList.add('critical');
    } else if (pct < 30) {
      fill.classList.add('warn');
      valueEl.classList.add('warn');
    }
    detailEl.textContent = `Janela de quota do OpenRouter atualizada conforme o uso.`;
  }
}

function formatTokens(value) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function updateModelControls() {
  const configured = state.openrouter?.configuration?.configured === true;
  const manual = currentSelectionMode() === 'manual';
  $$('.strategy-option').forEach(option => option.classList.toggle('active', option.dataset.strategy === (manual ? 'manual' : 'automatic')));
  elements.manualModelSelect.disabled = !configured || !manual || !state.freeModels.length;
  elements.selectedModelNote.innerHTML = manual
    ? `Modelo principal: <code>${escapeHtml(elements.manualModelSelect.value || 'selecione um modelo')}</code>. O roteador free continua como contingência.`
    : 'O Gênesis ranqueia todo o catálogo gratuito, tenta no máximo três rotas e mantém o <code>openrouter/free</code> como contingência final.';
}

async function openOpenRouterSetup() {
  setConfigTour(false);
  setSettingsTab('profile');
  elements.openRouterApiKey.value = '';
  elements.openRouterApiKey.type = 'password';
  setConfigFeedback();
  const [payload, memoryPayload] = await Promise.all([
    api('/api/openrouter/config'),
    api('/api/user-memory').catch(() => null)
  ]);
  applyOpenRouterPayload(payload);
  if (memoryPayload?.userMemory) {
    state.userMemory = memoryPayload.userMemory;
    renderAdaptiveMemory();
  }
  elements.setupDialog.showModal();
  if (payload.configuration?.configured && !payload.models?.length) {
    api('/api/openrouter/models').then(applyOpenRouterPayload).catch(error => setConfigFeedback(error.message, 'error'));
  }
}

async function connectOpenRouter() {
  const apiKey = elements.openRouterApiKey.value.trim();
  if (!apiKey && !state.openrouter?.configuration?.configured) {
    setConfigFeedback('Cole sua chave OpenRouter para conectar.', 'error');
    elements.openRouterApiKey.focus();
    return;
  }
  elements.connectOpenRouterButton.disabled = true;
  elements.connectOpenRouterButton.textContent = 'Validando…';
  setConfigFeedback('Validando a chave e carregando somente modelos gratuitos…');
  try {
    const payload = await api('/api/openrouter/key', {
      method: 'POST',
      body: JSON.stringify({ apiKey, persist: elements.persistOpenRouterKey.checked })
    });
    elements.openRouterApiKey.value = '';
    applyOpenRouterPayload(payload);
    const persisted = payload.configuration?.persisted === true;
    const successMessage = persisted
      ? 'Sua Key foi salva com sucesso.'
      : 'Sua Key foi validada com sucesso e ficará ativa nesta sessão.';
    setConfigTour(false, { remember: true });
    setConfigFeedback(successMessage);
    toast(successMessage);
  } catch (error) {
    elements.openRouterApiKey.value = '';
    setConfigFeedback(error.message, 'error');
  } finally {
    elements.connectOpenRouterButton.disabled = false;
    renderOpenRouterSettings();
  }
}

async function saveModelPreference() {
  if (!state.openrouter?.configuration?.configured) return setConfigFeedback('Conecte sua chave antes de escolher o modelo.', 'error');
  const selectionMode = currentSelectionMode();
  const selectedModel = selectionMode === 'manual' ? elements.manualModelSelect.value : 'openrouter/free';
  elements.saveModelButton.disabled = true;
  try {
    const payload = await api('/api/openrouter/preferences', {
      method: 'PUT', body: JSON.stringify({ selectionMode, selectedModel })
    });
    applyOpenRouterPayload(payload);
    setConfigFeedback(selectionMode === 'manual' ? 'Modelo manual aplicado com fallback free.' : 'Seleção automática ativada.');
    toast('Seleção de modelo atualizada.');
  } catch (error) {
    setConfigFeedback(error.message, 'error');
  } finally {
    elements.saveModelButton.disabled = false;
  }
}

async function disconnectOpenRouter() {
  if (!window.confirm('Remover a chave OpenRouter da memória e do cofre local?')) return;
  const payload = await api('/api/openrouter/key', { method: 'DELETE' });
  applyOpenRouterPayload(payload);
  elements.openRouterApiKey.value = '';
  setConfigFeedback('Chave removida deste Genesis.');
  toast('OpenRouter desconectado.', 'warning');
}

function renderTimeline() {
  if (!state.timeline.length) {
    elements.routeTimeline.innerHTML = '<div class="timeline-empty"><span></span><p>As decisões de rota aparecerão aqui durante a próxima resposta.</p></div>';
    return;
  }
  elements.routeTimeline.innerHTML = state.timeline.slice(-5).map(item => `
    <div class="timeline-item ${item.type}"><span class="timeline-dot"></span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></div>`).join('');
  elements.routeTimeline.scrollTop = elements.routeTimeline.scrollHeight;
}

function addTimeline(type, title, detail) {
  state.timeline.push({ type, title, detail });
  if (state.timeline.length > 50) state.timeline = state.timeline.slice(-50);
  renderTimeline();
}

function showSearchingModel(detail = 'Selecionando uma rota gratuita compatível e preservando o contexto da conversa.') {
  const last = state.timeline[state.timeline.length - 1];
  if (last?.type === 'searching') {
    last.title = 'Pensando...';
    last.detail = detail;
    renderTimeline();
    return;
  }
  addTimeline('searching', 'Pensando...', detail);
}

let neuralWindow = null;
let neuralWatchdog = null;

function openNeuralInterface() {
  // Single-instance: se já existe uma janela viva, só foca.
  if (neuralWindow && !neuralWindow.closed) {
    try { neuralWindow.focus(); } catch { /* cross-origin */ }
    return;
  }
  const features = [
    'width=900', 'height=620',
    'minWidth=700', 'minHeight=500',
    'resizable=yes', 'scrollbars=no',
    'toolbar=no', 'location=no', 'menubar=no', 'status=no',
    'popup=yes'
  ].join(',');
  try {
    neuralWindow = window.open('./neural/neural.html', 'GenesisNeuralInterface', features);
  } catch (err) {
    console.warn('[genesis] falhou ao abrir Interface Neural', err);
    return;
  }
  if (!neuralWindow) {
    toast('Permita pop-ups para abrir a Interface Neural.', 'warning');
    return;
  }
  // Watchdog limpa a referência quando o usuário fechar a janela,
  // sem interceptar nada do lifecycle interno (zera a 0 CPU/GPU limpo).
  neuralWatchdog = setInterval(() => {
    if (neuralWindow?.closed) {
      clearInterval(neuralWatchdog);
      neuralWatchdog = null;
      neuralWindow = null;
    }
  }, 1500);
}

async function createConversation() {
  const payload = await api('/api/conversations', {
    method: 'POST', body: JSON.stringify({ mode: state.mode })
  });
  state.current = payload.conversation;
  state.conversations.unshift({ ...payload.conversation, messageCount: 0 });
  localStorage.setItem('genesis:lastConversation', state.current.id);
  renderConversations();
  renderMessages();
  closeDrawers();
  elements.messageInput.focus();
  return state.current;
}

async function loadConversation(id) {
  clearPendingAttachments();
  const payload = await api(`/api/conversations/${encodeURIComponent(id)}`);
  state.current = payload.conversation;
  state.mode = state.current.mode || 'balanced';
  localStorage.setItem('genesis:lastConversation', id);
  renderConversations();
  renderMessages();
  closeDrawers();
  requestAnimationFrame(scrollToBottom);
}

async function deleteConversation(id) {
  if (!window.confirm('Excluir esta conversa e sua memória local?')) return;
  await api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.conversations = state.conversations.filter(item => item.id !== id);
  if (state.current?.id === id) {
    const next = state.conversations[0];
    if (next) await loadConversation(next.id);
    else await createConversation();
  } else renderConversations();
  toast('Conversa excluída.');
}

async function refreshProviders({ quiet = false } = {}) {
  elements.refreshProviders.classList.add('loading');
  try {
    const payload = await api('/api/providers/refresh', { method: 'POST', body: '{}' });
    state.providers = payload.providers;
    if (payload.openrouter) applyOpenRouterPayload(payload.openrouter);
    else renderProviders();
    const online = state.providers.filter(provider => provider.state === 'online').length;
    const configured = state.openrouter?.configuration?.configured === true;
    elements.runtimeStatus.textContent = online
      ? 'Modelos gratuitos online'
      : configured ? 'Modelos temporariamente ocupados' : 'Configure sua chave';
    if (!quiet) toast(online
      ? 'Modelos gratuitos atualizados.'
      : configured ? 'As rotas estão temporariamente ocupadas.' : 'Conecte uma chave válida nas configurações.', online ? 'success' : 'warning');
  } catch (error) {
    if (!quiet) toast(error.message, 'error');
  } finally {
    elements.refreshProviders.classList.remove('loading');
  }
}

function setThinking(active, title = 'Genesis está raciocinando', detail = 'Preparando a memória de continuidade…') {
  elements.thinkingCard.hidden = !active;
  elements.thinkingTitle.textContent = title;
  elements.thinkingDetail.textContent = detail;
  if (active) {
    state.thinkingStartedAt = performance.now();
    clearInterval(state.thinkingTimer);
    state.thinkingTimer = setInterval(() => {
      elements.thinkingTimer.textContent = `${((performance.now() - state.thinkingStartedAt) / 1000).toFixed(1)}s`;
    }, 100);
    requestAnimationFrame(scrollToBottom);
  } else {
    clearInterval(state.thinkingTimer);
    state.thinkingTimer = null;
  }
}

function showApproval(payload) {
  state.activeApproval = payload;
  elements.approvalTitle.textContent = payload.title || 'Autorizar alteração?';
  elements.approvalDetail.textContent = payload.detail || 'O Gênesis aguarda sua decisão.';
  elements.approvalCard.hidden = false;
  elements.approveApprovalButton.disabled = false;
  elements.denyApprovalButton.disabled = false;
  requestAnimationFrame(scrollToBottom);
}

function clearApproval() {
  state.activeApproval = null;
  elements.approvalCard.hidden = true;
  elements.approveApprovalButton.disabled = false;
  elements.denyApprovalButton.disabled = false;
}

async function resolveApproval(decision) {
  const approval = state.activeApproval;
  if (!approval?.approvalId) return;
  elements.approveApprovalButton.disabled = true;
  elements.denyApprovalButton.disabled = true;
  elements.thinkingTitle.textContent = decision === 'approve' ? 'Autorização recebida' : 'Alteração recusada';
  elements.thinkingDetail.textContent = decision === 'approve' ? 'O Gênesis continuará a operação com segurança…' : 'A decisão está sendo aplicada…';
  try {
    await api(`/api/approvals/${encodeURIComponent(approval.approvalId)}`, {
      method: 'POST',
      body: JSON.stringify({ decision })
    });
    clearApproval();
  } catch (error) {
    clearApproval();
    toast(error.message, 'error');
  }
}

function setSending(active) {
  state.sending = active;
  elements.sendButton.disabled = false;
  elements.sendButton.classList.toggle('stop', active);
  elements.sendButton.setAttribute('aria-label', active ? 'Parar resposta' : 'Enviar mensagem');
  elements.sendButton.innerHTML = active ? `<span>Parar</span>${icons.stop}` : `<span>Enviar</span>${icons.send}`;
  elements.composerForm.setAttribute('aria-busy', String(active));
  elements.messageInput.disabled = active;
  elements.attachmentButton.disabled = active;
  elements.attachmentInput.disabled = active;
  elements.permissionButton.disabled = active;
  if (active) { closeAttachmentMenu(); closePermissionMenu(); }
  elements.runtimeStatus.textContent = active ? 'Genesis em execução' : 'Genesis pronto';
}

function stopCurrentRequest() {
  if (!state.sending || !state.activeRequestController || state.activeRequestController.signal.aborted) return;
  state.stopRequested = true;
  elements.sendButton.disabled = true;
  elements.runtimeStatus.textContent = 'Interrompendo Genesis';
  elements.thinkingTitle.textContent = 'Interrompendo resposta';
  elements.thinkingDetail.textContent = 'Cancelando a rota ativa e preservando a mensagem enviada…';
  state.activeRequestController.abort();
  clearApproval();
}

function scrollToBottom() {
  const stage = $('#chatStage');
  stage.scrollTop = stage.scrollHeight;
}

async function readSse(response, onEvent) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || `Falha ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      if (!frame.trim() || frame.startsWith(':')) continue;
      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length) onEvent(event, JSON.parse(data.join('\n')));
    }
    if (done) break;
  }
}

function handleStreamEvent(event, payload) {
  if (event === 'accepted') {
    const messages = state.current?.messages || [];
    let temporaryIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (String(messages[index].id || '').startsWith('temp-')) { temporaryIndex = index; break; }
    }
    const acceptedIndex = temporaryIndex >= 0
      ? temporaryIndex
      : messages.findIndex(message => message.id === state.activeEditMessageId);
    if (acceptedIndex >= 0 && payload.message) {
      messages[acceptedIndex] = payload.message;
      renderMessages();
      scrollToBottom();
    }
  } else if (event === 'stream_reset') {
    state.streamingContent = '';
    if (state.current) state.current.messages = state.current.messages.filter(message => message.id !== 'temp-stream');
    renderMessages();
  } else if (event === 'delta') {
    state.streamingContent += String(payload.content || '');
    if (state.current && state.streamingContent) {
      const existing = state.current.messages.find(message => message.id === 'temp-stream');
      if (existing) existing.content = state.streamingContent;
      else state.current.messages.push({ id: 'temp-stream', role: 'assistant', content: state.streamingContent, createdAt: new Date().toISOString(), attachments: [], meta: null });
      renderMessages();
      scrollToBottom();
    }
  } else if (event === 'task_contract') {
    state.activeTask = payload.task || null;
    const task = payload.task || {};
    const labels = { project_overview: 'inventário local', diagnose: 'diagnóstico', analysis: 'análise', change: 'alteração', fix: 'correção', answer: 'resposta' };
    const requests = Number(task.requestBudget?.limit || 0);
    const inputLimit = Number(task.requestBudget?.inputTokenLimit || 0);
    const detail = `${labels[task.kind] || 'tarefa'} · ${task.steps?.length || 0} etapas · teto ${requests} requisição${requests === 1 ? '' : 'ões'}${inputLimit ? ` / ${compactNumber(inputLimit)} tokens de entrada` : ' · execução local'}`;
    elements.thinkingTitle.textContent = 'Planejando a tarefa';
    elements.thinkingDetail.textContent = detail;
    addTimeline('route', 'Contrato e limites definidos', detail);
  } else if (event === 'local_analysis') {
    state.activeUsage = { inputTokens: 0, outputTokens: 0, requestCount: 0, accuracy: 'local' };
    elements.thinkingTitle.textContent = 'Análise local concluída';
    elements.thinkingDetail.textContent = payload.message || 'Projeto analisado sem consumir a API.';
    elements.activeEngine.textContent = 'Genesis Local · 0 requisições';
    addTimeline('complete', 'Zero consumo de API', `${payload.projectFiles || 0} arquivos inventariados localmente.`);
  } else if (event === 'inference_start') {
    const requestNumber = Number(payload.requestNumber || payload.budget?.used || 1);
    const limit = Number(payload.budget?.limit || 0);
    const detail = `Requisição ${requestNumber}${limit ? `/${limit}` : ''} · ~${compactNumber(payload.estimatedInputTokens || 0)} tokens de entrada · ${payload.toolsEnabled?.length || 0} ferramentas`;
    elements.thinkingTitle.textContent = payload.kind === 'final-synthesis' ? 'Sintetizando a resposta final' : 'Executando inferência controlada';
    elements.thinkingDetail.textContent = detail;
    elements.activeEngine.textContent = `${payload.provider || 'OpenRouter'} · ${payload.model || 'modelo gratuito'}`;
    addTimeline('attempt', 'Envio protegido por orçamento', detail);
  } else if (event === 'inference_complete') {
    state.activeUsage = payload.usage || state.activeUsage;
    const usage = payload.usage || {};
    const detail = `${compactNumber(usage.inputTokens || 0)} enviados · ${compactNumber(usage.outputTokens || 0)} recebidos · ${(Number(payload.latencyMs || 0) / 1000).toFixed(1)}s`;
    addTimeline('complete', `Requisição ${payload.requestNumber || ''} concluída`.trim(), detail);
  } else if (event === 'verification') {
    const verification = payload.verification || {};
    const detail = verification.summary || 'Verificação determinística concluída.';
    elements.thinkingTitle.textContent = verification.verified ? 'Entrega verificada' : 'Entrega verificada parcialmente';
    elements.thinkingDetail.textContent = detail;
    addTimeline(verification.status === 'failed' ? 'fallback' : 'complete', elements.thinkingTitle.textContent, detail);
  } else if (event === 'route') {
    elements.thinkingDetail.textContent = payload.message;
    addTimeline('route', 'Memória preparada', payload.message);
  } else if (event === 'attempt') {
    const detail = `Selecionando uma rota gratuita compatível${payload.projectFiles ? ` para ${payload.projectFiles} arquivos do projeto` : ''}, sem interromper o contexto.`;
    elements.thinkingTitle.textContent = 'Pensando...';
    elements.thinkingDetail.textContent = detail;
    elements.activeEngine.textContent = 'Seleção automática em andamento';
    if (payload.contextWindow) updateContextMeter({
      contextWindow: payload.contextWindow,
      usedTokens: payload.inputTokens,
      usageAccuracy: 'estimated'
    });
    showSearchingModel(detail);
  } else if (event === 'compact') {
    elements.thinkingDetail.textContent = payload.message;
    addTimeline('compact', 'Contexto recomposto', payload.message);
  } else if (event === 'fallback') {
    state.streamingContent = '';
    if (state.current) state.current.messages = state.current.messages.filter(message => message.id !== 'temp-stream');
    const detail = 'Atualizando as rotas gratuitas e selecionando automaticamente a melhor opção disponível.';
    elements.thinkingTitle.textContent = 'Pensando...';
    elements.thinkingDetail.textContent = detail;
    elements.activeEngine.textContent = 'Atualizando modelos gratuitos';
    showSearchingModel(detail);
  } else if (event === 'recovery') {
    const detail = 'Abrindo uma nova janela gratuita e mantendo integralmente o contexto desta solicitação.';
    elements.thinkingTitle.textContent = 'Pensando...';
    elements.thinkingDetail.textContent = detail;
    elements.activeEngine.textContent = 'Recuperação automática em andamento';
    showSearchingModel(detail);
  } else if (event === 'continuation') {
    elements.thinkingTitle.textContent = 'Concluindo a resposta…';
    elements.thinkingDetail.textContent = payload.message;
    addTimeline('route', 'Continuação automática', payload.message);
  } else if (event === 'approval_required') {
    elements.thinkingTitle.textContent = 'Aguardando sua aprovação';
    elements.thinkingDetail.textContent = `${payload.title} · ${payload.detail}`;
    showApproval(payload);
    addTimeline('approval', 'Aguardando aprovação', `${payload.title} · ${payload.detail}`);
  } else if (event === 'approval_resolved') {
    clearApproval();
    elements.thinkingTitle.textContent = 'Preparando alteração';
    elements.thinkingDetail.textContent = 'A autorização foi validada; continuando com segurança…';
  } else if (event === 'tool_start') {
    clearApproval();
    const title = payload.kind === 'command' ? 'Executando comando seguro…' : payload.kind === 'read' ? 'Analisando o projeto…' : 'Aplicando alteração…';
    elements.thinkingTitle.textContent = title;
    elements.thinkingDetail.textContent = `${payload.title} · ${payload.detail}`;
    addTimeline('tool', title.replace('…', ''), `${payload.title} · ${payload.detail}`);
  } else if (event === 'tool_complete') {
    elements.thinkingTitle.textContent = 'Verificando o trabalho…';
    elements.thinkingDetail.textContent = payload.summary || 'Operação concluída; atualizando o contexto do projeto…';
    addTimeline('complete', 'Etapa concluída', elements.thinkingDetail.textContent);
    if (state.project?.writable) api('/api/project').then(({ project }) => { state.project = project; renderProject(); }).catch(() => {});
  } else if (event === 'tool_denied') {
    clearApproval();
    elements.thinkingTitle.textContent = 'Alteração recusada';
    elements.thinkingDetail.textContent = 'A decisão foi respeitada; preparando a resposta final…';
    addTimeline('fallback', 'Alteração negada', `${payload.title} · ${payload.detail}`);
  } else if (event === 'tool_failed') {
    clearApproval();
    elements.thinkingTitle.textContent = 'Reavaliando a operação…';
    elements.thinkingDetail.textContent = payload.message || 'A ferramenta não concluiu; buscando uma alternativa segura…';
    addTimeline('fallback', 'Ferramenta não concluiu', elements.thinkingDetail.textContent);
  } else if (event === 'image_attempt') {
    elements.thinkingTitle.textContent = 'Gênesis está criando a imagem…';
    elements.thinkingDetail.textContent = `${payload.model} · rota gratuita · tentativa ${payload.attempt}`;
    elements.activeEngine.textContent = `${payload.provider} · ${payload.model}`;
    addTimeline('attempt', 'Criando imagem', elements.thinkingDetail.textContent);
  } else if (event === 'image_fallback') {
    elements.thinkingTitle.textContent = 'Buscando outra rota gratuita…';
    elements.thinkingDetail.textContent = `${payload.reason?.message || 'Rota indisponível.'} Próxima: ${payload.nextProvider}.`;
    addTimeline('fallback', 'Alternando rota de imagem', elements.thinkingDetail.textContent);
  } else if (event === 'image_complete') {
    elements.thinkingTitle.textContent = 'Finalizando imagem…';
    elements.thinkingDetail.textContent = `${payload.imageCount} imagem${payload.imageCount === 1 ? '' : 's'} criada${payload.imageCount === 1 ? '' : 's'} com modelo gratuito.`;
    addTimeline('complete', 'Imagem criada', `${payload.model} · ${(payload.latencyMs / 1000).toFixed(1)}s`);
  } else if (event === 'complete') {
    elements.activeEngine.textContent = `${payload.provider} · ${payload.model}`;
    addTimeline('complete', 'Resposta concluída', `${payload.provider} · ${payload.model} · ${(payload.latencyMs / 1000).toFixed(1)}s`);
  } else if (event === 'done') {
    if (payload.providers) { state.providers = payload.providers; renderProviders(); }
  } else if (event === 'stopped') {
    const requests = Number(payload.usage?.requestCount || 0);
    const sent = Number(payload.usage?.inputTokens || 0);
    state.activeUsage = payload.usage || null;
    addTimeline('stopped', 'Resposta interrompida', requests
      ? `A rota foi cancelada; ${requests} requisição${requests === 1 ? '' : 'ões'} e ${compactNumber(sent)} tokens enviados/estimados foram contabilizados.`
      : 'A solicitação foi parada antes de consumir uma rota.');
  } else if (event === 'error') {
    state.streamingContent = '';
    if (state.current) state.current.messages = state.current.messages.filter(message => message.id !== 'temp-stream');
    if (payload.providers) { state.providers = payload.providers; renderProviders(); }
    const attempts = payload.attempts?.length || 0;
    const requests = Number(payload.usage?.requestCount || 0);
    const sent = Number(payload.usage?.inputTokens || payload.usage?.sentInputTokenEstimate || 0);
    state.activeUsage = payload.usage || null;
    addTimeline('fallback', 'Execução encerrada pelo limite seguro', `${requests} requisição${requests === 1 ? '' : 'ões'} concluída${requests === 1 ? '' : 's'} · ${compactNumber(sent)} tokens enviados/estimados · ${attempts} rota${attempts === 1 ? '' : 's'} avaliada${attempts === 1 ? '' : 's'}.`);
    throw new Error(payload.error?.message || 'Nenhuma rota gratuita está disponível neste momento.');
  }
}

async function sendMessage(prefill, options = {}) {
  if (state.sending) return;
  if (state.handoffLoading) return toast('Aguarde o novo modelo concluir a leitura da memória.', 'warning');
  const editMessageId = String(options.editMessageId || '');
  const editedMessage = editMessageId
    ? state.current?.messages.find(message => message.id === editMessageId && message.role === 'user')
    : null;
  const content = String(prefill ?? elements.messageInput.value).trim();
  if (!content && !state.pendingAttachments.length && !editedMessage?.attachments?.length) return;
  if (!state.current) await createConversation();
  if (editMessageId && !editedMessage) return toast('A mensagem que seria editada não foi encontrada.', 'error');
  const conversationId = state.current.id;
  const outgoingAttachments = editMessageId ? [] : [...state.pendingAttachments];
  const displayContent = content || 'Analise os arquivos anexados e apresente os pontos relevantes.';
  if (editMessageId) {
    const messageIndex = state.current.messages.findIndex(message => message.id === editMessageId);
    state.current.messages = state.current.messages.slice(0, messageIndex + 1);
    state.current.messages[messageIndex] = { ...state.current.messages[messageIndex], content: displayContent, editedAt: new Date().toISOString(), meta: { tokenEstimate: Math.max(1, Math.ceil(displayContent.length / 4)) + 4, tokenAccuracy: 'estimated' } };
    if (messageIndex === 0) state.current.title = displayContent.length > 54 ? `${displayContent.slice(0, 53)}…` : displayContent;
  } else {
    elements.messageInput.value = '';
    autoResizeInput();
    state.current.messages.push({
      id: `temp-${Date.now()}`,
      role: 'user',
      content: displayContent,
      createdAt: new Date().toISOString(),
      attachments: outgoingAttachments.map(attachment => ({ ...attachment, temporary: true })),
      meta: { tokenEstimate: Math.max(1, Math.ceil(displayContent.length / 4)) + 4 + outgoingAttachments.length * 700, tokenAccuracy: 'estimated' }
    });
    if (state.current.messages.length === 1) state.current.title = displayContent.length > 54 ? `${displayContent.slice(0, 53)}…` : displayContent;
  }
  renderMessages();
  renderConversations();
  scrollToBottom();
  state.timeline = [];
  state.activeTask = null;
  state.activeUsage = null;
  renderTimeline();
  const requestController = new AbortController();
  state.activeRequestController = requestController;
  state.activeEditMessageId = editMessageId || null;
  state.stopRequested = false;
  setSending(true);
  setThinking(true, outgoingAttachments.length ? 'Preparando anexos' : undefined, outgoingAttachments.length ? `Validando ${outgoingAttachments.length} arquivo${outgoingAttachments.length === 1 ? '' : 's'} antes do envio…` : undefined);
  let streamError = null;
  let accepted = false;
  try {
    const attachments = await Promise.all(outgoingAttachments.map(attachment => fileDataUrl(attachment, requestController.signal)));
    if (requestController.signal.aborted) throw new DOMException('Resposta interrompida.', 'AbortError');
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-genesis-client': 'web' },
      body: JSON.stringify({ content, mode: state.mode, language: state.language, attachments, editMessageId: editMessageId || undefined }),
      signal: requestController.signal
    });
    if (response.ok) {
      accepted = true;
      state.pendingAttachments = [];
      renderPendingAttachments();
    }
    await readSse(response, (event, payload) => {
      try { handleStreamEvent(event, payload); } catch (error) { streamError = error; }
    });
    if (streamError) throw streamError;
    await bootstrapConversation(conversationId);
  } catch (error) {
    if (requestController.signal.aborted || error?.name === 'AbortError') {
      addTimeline('stopped', 'Resposta interrompida', 'A rota ativa foi cancelada; nenhuma resposta incompleta foi salva.');
      toast('Resposta interrompida.', 'warning');
    } else {
      toast(error.message, 'error');
    }
    await bootstrapConversation(conversationId).catch(() => {});
  } finally {
    if (accepted) outgoingAttachments.forEach(attachment => {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    });
    if (state.activeRequestController === requestController) state.activeRequestController = null;
    state.activeEditMessageId = null;
    state.stopRequested = false;
    clearApproval();
    setThinking(false);
    setSending(false);
    elements.messageInput.focus();
    scrollToBottom();
  }
}

async function bootstrapConversation(id) {
  const payload = await api(`/api/conversations/${encodeURIComponent(id)}`);
  state.current = payload.conversation;
  const index = state.conversations.findIndex(item => item.id === id);
  const summary = { ...payload.conversation, messageCount: payload.conversation.messages.length };
  delete summary.messages;
  if (index >= 0) state.conversations[index] = summary;
  else state.conversations.unshift(summary);
  state.conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  renderConversations();
  renderMessages();
}

function autoResizeInput() {
  elements.messageInput.style.height = 'auto';
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 180)}px`;
}

function closeDrawers() {
  elements.appShell.classList.remove('sidebar-open', 'inspector-open', 'logs-open');
  elements.logsDrawer.setAttribute('aria-hidden', 'true');
  elements.logsToggle.setAttribute('aria-expanded', 'false');
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('genesis:theme', theme);
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f4f6fa' : '#080b11';
}

function bindEvents() {
  $('#newChatButton').addEventListener('click', () => {
    if (state.sending) return toast('Pare a resposta atual antes de iniciar outra conversa.', 'warning');
    clearPendingAttachments();
    createConversation().catch(error => toast(error.message, 'error'));
  });
  elements.conversationSearch.addEventListener('input', renderConversations);
  elements.conversationList.addEventListener('click', event => {
    const menuButton = event.target.closest('[data-conversation-menu-id]');
    if (menuButton) {
      event.stopPropagation();
      openConversationPopover(menuButton.dataset.conversationMenuId, menuButton);
      return;
    }
    const deleteButton = event.target.closest('[data-delete-id]');
    if (deleteButton) { event.stopPropagation(); deleteConversation(deleteButton.dataset.deleteId).catch(error => toast(error.message, 'error')); return; }
    const button = event.target.closest('[data-conversation-id]');
    if (button && button.dataset.conversationId !== state.current?.id) {
      if (state.sending) return toast('Pare a resposta atual antes de trocar de conversa.', 'warning');
      state.editingMessageId = null;
      loadConversation(button.dataset.conversationId).catch(error => toast(error.message, 'error'));
    }
  });
  elements.conversationList.addEventListener('keydown', event => {
    if (event.target.closest('button')) return;
    const item = event.target.closest('[data-conversation-id]');
    if (item && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      if (item.dataset.conversationId !== state.current?.id && !state.sending) loadConversation(item.dataset.conversationId).catch(error => toast(error.message, 'error'));
    }
  });
  elements.conversationPopover.addEventListener('click', event => {
    const marker = event.target.closest('[data-marker-color]');
    if (!marker) return;
    updateConversationPersonalization({ markerColor: marker.dataset.markerColor }).then(() => {
      elements.conversationPopover.querySelectorAll('[data-marker-color]').forEach(button => button.classList.toggle('active', button === marker));
      toast('Marcador atualizado.');
    }).catch(error => toast(error.message, 'error'));
  });
  elements.closeConversationPopover.addEventListener('click', closeConversationPopover);
  elements.saveConversationRename.addEventListener('click', saveConversationName);
  elements.conversationRenameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); saveConversationName(); }
    if (event.key === 'Escape') { event.preventDefault(); closeConversationPopover(); }
  });
  elements.messageList.addEventListener('click', event => {
    const failedImage = event.target.closest('.message-attachment.image-load-failed');
    if (failedImage) {
      event.preventDefault();
      failedImage.classList.remove('image-load-failed');
      const separator = failedImage.dataset.reloadUrl.includes('?') ? '&' : '?';
      failedImage.querySelector('img').src = `${failedImage.dataset.reloadUrl}${separator}retry=${Date.now()}`;
      return;
    }
    const codeButton = event.target.closest('[data-copy-code]');
    if (codeButton) {
      const code = codeButton.closest('.code-block')?.querySelector('code')?.textContent || '';
      navigator.clipboard.writeText(code).then(() => {
        const label = codeButton.querySelector('span');
        if (label) {
          const previous = label.textContent;
          label.textContent = 'Copiado';
          setTimeout(() => { label.textContent = previous; }, 1400);
        }
      });
      return;
    }
    const editButton = event.target.closest('[data-edit-id]');
    if (editButton) return beginMessageEdit(editButton.dataset.editId);
    const cancelEditButton = event.target.closest('[data-cancel-edit]');
    if (cancelEditButton) return cancelMessageEdit();
    const resendEditButton = event.target.closest('[data-resend-edit]');
    if (resendEditButton) return resendEditedMessage(resendEditButton.dataset.resendEdit);
    const button = event.target.closest('[data-copy-id]');
    if (!button) return;
    const message = state.current?.messages.find(item => item.id === button.dataset.copyId);
    if (message) navigator.clipboard.writeText(message.content).then(() => toast('Mensagem copiada.'));
  });
  elements.messageList.addEventListener('error', event => {
    if (event.target.matches('.message-attachment.image img')) event.target.closest('.message-attachment.image')?.classList.add('image-load-failed');
  }, true);
  elements.messageList.addEventListener('load', event => {
    if (event.target.matches('.message-attachment.image img')) event.target.closest('.message-attachment.image')?.classList.remove('image-load-failed');
  }, true);
  elements.messageList.addEventListener('input', event => {
    if (!event.target.matches('[data-edit-input]')) return;
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(Math.max(event.target.scrollHeight, 74), 220)}px`;
  });
  elements.messageList.addEventListener('keydown', event => {
    if (!event.target.matches('[data-edit-input]')) return;
    if (event.key === 'Escape') cancelMessageEdit();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      resendEditedMessage(event.target.dataset.editInput);
    }
  });
  elements.composerForm.addEventListener('submit', event => {
    event.preventDefault();
    if (state.sending) stopCurrentRequest();
    else sendMessage();
  });
  elements.attachmentButton.addEventListener('click', event => {
    event.stopPropagation();
    elements.attachmentMenu.hidden = !elements.attachmentMenu.hidden;
    elements.attachmentButton.setAttribute('aria-expanded', String(!elements.attachmentMenu.hidden));
  });
  elements.permissionButton.addEventListener('click', event => {
    event.stopPropagation();
    closeAttachmentMenu();
    elements.permissionMenu.hidden = !elements.permissionMenu.hidden;
    elements.permissionButton.setAttribute('aria-expanded', String(!elements.permissionMenu.hidden));
  });
  elements.permissionMenu.addEventListener('click', event => {
    const button = event.target.closest('[data-permission-mode]');
    if (!button) return;
    setPermissionMode(button.dataset.permissionMode).catch(error => toast(error.message, 'error'));
  });
  elements.approveApprovalButton.addEventListener('click', () => resolveApproval('approve'));
  elements.denyApprovalButton.addEventListener('click', () => resolveApproval('deny'));
  elements.chooseFilesButton.addEventListener('click', () => {
    closeAttachmentMenu();
    elements.attachmentInput.click();
  });
  elements.attachmentInput.addEventListener('change', () => {
    addPendingFiles(elements.attachmentInput.files);
    elements.attachmentInput.value = '';
  });
  elements.attachmentTray.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-attachment]');
    if (!button) return;
    const index = state.pendingAttachments.findIndex(item => item.id === button.dataset.removeAttachment);
    if (index < 0) return;
    const [attachment] = state.pendingAttachments.splice(index, 1);
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    renderPendingAttachments();
  });
  elements.composerForm.addEventListener('dragenter', event => {
    if ([...(event.dataTransfer?.types || [])].includes('Files')) {
      event.preventDefault();
      elements.composerForm.classList.add('dragging');
    }
  });
  elements.composerForm.addEventListener('dragover', event => {
    if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
  });
  elements.composerForm.addEventListener('dragleave', event => {
    if (!elements.composerForm.contains(event.relatedTarget)) elements.composerForm.classList.remove('dragging');
  });
  elements.composerForm.addEventListener('drop', event => {
    event.preventDefault();
    elements.composerForm.classList.remove('dragging');
    addPendingFiles(event.dataTransfer?.files);
  });
  elements.messageInput.addEventListener('input', autoResizeInput);
  elements.messageInput.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) addPendingFiles(files);
  });
  elements.messageInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
  });
  $$('.mode-chip').forEach(button => button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    $$('.mode-chip').forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-checked', String(active));
    });
    toast(`Modo ${button.textContent.trim()} ativo.`);
  }));
  $$('.starter-card').forEach(button => button.addEventListener('click', () => {
    const prompt = state.language === 'en-US' ? (button.dataset.promptEn || button.dataset.prompt) : button.dataset.prompt;
    sendMessage(prompt);
  }));
  elements.projectCard.addEventListener('click', () => state.project ? openProjectDialog() : chooseProjectFolder());
  elements.projectCardClose.addEventListener('click', () => removeProject().catch(error => toast(error.message, 'error')));
  elements.projectToggle.addEventListener('click', () => state.project ? openProjectDialog() : chooseProjectFolder());
  elements.projectFolderInput.addEventListener('change', () => {
    const selected = [...elements.projectFolderInput.files];
    elements.projectFolderInput.value = '';
    if (!selected.length) return;
    const firstPath = projectPath(selected[0].webkitRelativePath || selected[0].name);
    const rootName = firstPath.split('/')[0] || 'Projeto';
    const entries = selected.map(file => {
      const fullPath = projectPath(file.webkitRelativePath || file.name);
      const segments = fullPath.split('/');
      return { path: segments.length > 1 ? segments.slice(1).join('/') : fullPath, file };
    });
    importProject(rootName, entries, 'folder-upload');
  });
  elements.projectFileSearch.addEventListener('input', renderProjectFiles);
  $('#closeProjectDialog').addEventListener('click', () => elements.projectDialog.close());
  $('#dismissProjectDialog').addEventListener('click', () => elements.projectDialog.close());
  elements.replaceProjectButton.addEventListener('click', chooseProjectFolder);
  elements.openProjectPathButton.addEventListener('click', openProjectFromPath);
  elements.projectPathInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); openProjectFromPath(); }
  });
  elements.removeProjectButton.addEventListener('click', () => removeProject().catch(error => toast(error.message, 'error')));
  elements.refreshProviders.addEventListener('click', () => refreshProviders());
  elements.modelHandoffButton.addEventListener('click', handoffToLargerModel);
  $('#themeButton').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
  $('#sidebarOpen').addEventListener('click', () => elements.appShell.classList.add('sidebar-open'));
  elements.sidebarCollapseButton.addEventListener('click', () => setSidebarCollapsed(!elements.appShell.classList.contains('sidebar-collapsed')));
  matchMedia('(min-width: 901px)').addEventListener('change', () => setSidebarCollapsed(localStorage.getItem('genesis:sidebarCollapsed') === '1', { persist: false }));
  $('#sidebarClose').addEventListener('click', closeDrawers);
  $('#inspectorToggle').addEventListener('click', () => elements.appShell.classList.add('inspector-open'));
  $('#inspectorClose').addEventListener('click', closeDrawers);
  elements.logsToggle.addEventListener('click', () => {
    if (elements.appShell.classList.contains('logs-open')) closeDrawers();
    else openLogs();
  });
  elements.logsClose.addEventListener('click', closeDrawers);
  elements.pauseLogsButton.addEventListener('click', toggleTelemetryPause);
  elements.clearLogsButton.addEventListener('click', () => clearTelemetry().catch(error => toast(error.message, 'error')));
  $$('.log-tab').forEach(button => button.addEventListener('click', () => selectLogTab(button.dataset.logTab)));
  elements.logSearch.addEventListener('input', renderTelemetry);
  elements.logLevelFilter.addEventListener('change', renderTelemetry);
  elements.logCategoryFilter.addEventListener('change', renderTelemetry);
  elements.drawerBackdrop.addEventListener('click', closeDrawers);
  $('#openSetupButton').addEventListener('click', () => openOpenRouterSetup().catch(error => toast(error.message, 'error')));
  elements.skipConfigTour.addEventListener('click', event => {
    event.stopPropagation();
    setConfigTour(false, { remember: true });
  });
  elements.startConfigTourSetup.addEventListener('click', () => {
    setConfigTour(false);
    openOpenRouterSetup().catch(error => toast(error.message, 'error'));
  });
  elements.adaptiveMemoryEnabled.addEventListener('change', () => {
    updateAdaptiveMemory(elements.adaptiveMemoryEnabled.checked).catch(error => {
      elements.adaptiveMemoryEnabled.checked = !elements.adaptiveMemoryEnabled.checked;
      toast(error.message, 'error');
    });
  });
  elements.clearAdaptiveMemory.addEventListener('click', () => clearAdaptiveMemory().catch(error => toast(error.message, 'error')));
  $$('.settings-nav-button').forEach(button => button.addEventListener('click', () => setSettingsTab(button.dataset.settingsTab)));
  $$('[data-language]').forEach(button => button.addEventListener('click', () => setLanguage(button.dataset.language)));
  elements.profileAvatar.addEventListener('click', () => elements.profileImageInput.click());
  elements.profileImageInput.addEventListener('change', () => {
    const [file] = elements.profileImageInput.files || [];
    elements.profileImageInput.value = '';
    updateProfilePhoto(file).catch(error => toast(error.message, 'error'));
  });
  elements.removeProfilePhoto.addEventListener('click', removeProfilePhoto);
  elements.editProfileButton.addEventListener('click', () => setProfileEditor(true));
  elements.cancelProfileButton.addEventListener('click', () => setProfileEditor(false));
  elements.saveProfileButton.addEventListener('click', saveProfile);
  elements.profileNameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); saveProfile(); }
    if (event.key === 'Escape') { event.preventDefault(); setProfileEditor(false); }
  });
  $('#closeSetupButton').addEventListener('click', () => elements.setupDialog.close());
  $('#cancelSetupButton').addEventListener('click', () => elements.setupDialog.close());
  elements.connectOpenRouterButton.addEventListener('click', connectOpenRouter);
  elements.disconnectOpenRouterButton.addEventListener('click', () => disconnectOpenRouter().catch(error => setConfigFeedback(error.message, 'error')));
  elements.toggleKeyVisibility.addEventListener('click', () => {
    elements.openRouterApiKey.type = elements.openRouterApiKey.type === 'password' ? 'text' : 'password';
  });
  $$('input[name="modelSelection"]').forEach(input => input.addEventListener('change', updateModelControls));
  elements.manualModelSelect.addEventListener('change', updateModelControls);
  elements.openRouterForm.addEventListener('submit', event => {
    event.preventDefault();
    if (elements.openRouterApiKey.value.trim()) connectOpenRouter();
    else saveModelPreference();
  });
  $('#exportButton').addEventListener('click', () => {
    if (!state.current) return;
    window.location.href = `/api/conversations/${encodeURIComponent(state.current.id)}/export`;
  });
  elements.refreshQuotaButton?.addEventListener('click', async () => {
    if (!elements.refreshQuotaButton) return;
    const original = elements.refreshQuotaButton.textContent;
    elements.refreshQuotaButton.disabled = true;
    elements.refreshQuotaButton.textContent = 'Atualizando…';
    try {
      const payload = await api('/api/openrouter/key', {
        method: 'POST',
        body: JSON.stringify({ apiKey: '', persist: state.openrouter?.configuration?.persisted === true })
      });
      applyOpenRouterPayload(payload);
      toast('Quota atualizada.');
    } catch (error) {
      setConfigFeedback(error.message, 'error');
    } finally {
      elements.refreshQuotaButton.disabled = false;
      elements.refreshQuotaButton.textContent = original;
    }
  });
  $('#neuralToggle').addEventListener('click', () => openNeuralInterface());
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); openNeuralInterface(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); elements.messageInput.focus(); }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); clearPendingAttachments(); createConversation(); }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'l') { event.preventDefault(); openLogs(); }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); state.project ? openProjectDialog() : chooseProjectFolder(); }
    if (event.key === 'Escape') { closeConversationPopover(); closeAttachmentMenu(); closePermissionMenu(); closeDrawers(); if (elements.projectDialog.open) elements.projectDialog.close(); }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('#conversationPopover') && !event.target.closest('[data-conversation-menu-id]')) closeConversationPopover();
    if (!event.target.closest('.attachment-control')) closeAttachmentMenu();
    if (!event.target.closest('.permission-control')) closePermissionMenu();
  });
  window.addEventListener('beforeunload', () => {
    state.logSource?.close();
    state.pendingAttachments.forEach(attachment => attachment.previewUrl && URL.revokeObjectURL(attachment.previewUrl));
  });
}

async function bootstrap() {
  const preferredTheme = localStorage.getItem('genesis:theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(preferredTheme);
  loadLanguage();
  loadProfile();
  setSidebarCollapsed(localStorage.getItem('genesis:sidebarCollapsed') === '1');
  bindEvents();
  new MutationObserver(queueLanguageRefresh).observe(document.body, { childList: true, characterData: true, subtree: true });
  connectTelemetry();
  try {
    const payload = await api('/api/bootstrap');
    state.app = payload.app;
    if (elements.genesisVersion) elements.genesisVersion.textContent = `Gênesis v${payload.app.version}`;
    state.policy = payload.policy;
    state.modes = payload.modes;
    state.providers = payload.providers;
    state.userMemory = payload.userMemory || null;
    state.project = payload.project || null;
    state.permissions = payload.permissions || state.permissions;
    applyOpenRouterPayload(payload.openrouter);
    renderAdaptiveMemory();
    startPolicyPhraseRotation();
    const needsConfigTour = payload.openrouter?.configuration?.configured !== true
      && localStorage.getItem('genesis:configTourSkipped') !== '1';
    setConfigTour(needsConfigTour);
    renderPermissions();
    state.conversations = payload.conversations;
    renderProject();
    renderConversations();
    const savedId = localStorage.getItem('genesis:lastConversation');
    const selected = state.conversations.find(item => item.id === savedId) || state.conversations[0];
    if (selected) await loadConversation(selected.id);
    else await createConversation();
    translatePage();
    refreshProviders({ quiet: true });
    window.setInterval(() => {
      if (!document.hidden && !state.sending && state.openrouter?.configuration?.configured) refreshProviders({ quiet: true });
    }, 240000);
  } catch (error) {
    toast(`Não foi possível iniciar: ${error.message}`, 'error');
    elements.runtimeStatus.textContent = 'Servidor indisponível';
  }
}

bootstrap();
