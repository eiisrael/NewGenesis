const unique = values => Object.freeze([...new Set(values)]);

export const PROJECT_READ_TOOL_NAMES = unique([
  'search_project',
  'read_project_file'
]);

export const PROJECT_MUTATION_TOOL_NAMES = unique([
  'write_project_file',
  'write_project_files',
  'replace_project_text',
  'create_project_directory',
  'move_project_path',
  'delete_project_path'
]);

export const PROJECT_VERIFICATION_TOOL_NAMES = unique([
  'run_project_check'
]);

export const PROJECT_PRIVILEGED_TOOL_NAMES = unique([
  ...PROJECT_MUTATION_TOOL_NAMES,
  ...PROJECT_VERIFICATION_TOOL_NAMES
]);

export const PROJECT_CHANGE_TOOL_NAMES = unique([
  ...PROJECT_READ_TOOL_NAMES,
  ...PROJECT_MUTATION_TOOL_NAMES,
  ...PROJECT_VERIFICATION_TOOL_NAMES
]);

const READ_SET = new Set(PROJECT_READ_TOOL_NAMES);
const MUTATION_SET = new Set(PROJECT_MUTATION_TOOL_NAMES);
const VERIFICATION_SET = new Set(PROJECT_VERIFICATION_TOOL_NAMES);
const PRIVILEGED_SET = new Set(PROJECT_PRIVILEGED_TOOL_NAMES);

export function projectToolName(tool) {
  return String(tool?.function?.name || tool?.name || '');
}

export function isProjectReadTool(value) {
  const name = typeof value === 'string' ? value : projectToolName(value);
  return READ_SET.has(name);
}

export function isProjectMutationTool(value) {
  const name = typeof value === 'string' ? value : projectToolName(value);
  return MUTATION_SET.has(name);
}

export function isProjectVerificationTool(value) {
  const name = typeof value === 'string' ? value : projectToolName(value);
  return VERIFICATION_SET.has(name);
}

export function isProjectPrivilegedTool(value) {
  const name = typeof value === 'string' ? value : projectToolName(value);
  return PRIVILEGED_SET.has(name);
}

export function projectToolPhase(tools = []) {
  const names = tools.map(projectToolName).filter(Boolean);
  if (!names.length) return 'none';
  if (names.every(name => MUTATION_SET.has(name))) return 'mutation';
  if (names.every(name => VERIFICATION_SET.has(name))) return 'verification';
  if (names.every(name => READ_SET.has(name))) return 'exploration';
  return 'mixed';
}

export function projectToolChoice(tools = []) {
  const names = tools.map(projectToolName).filter(Boolean);
  const phase = projectToolPhase(tools);
  if (!['mutation', 'verification'].includes(phase)) return 'auto';
  if (names.length === 1) {
    return { type: 'function', function: { name: names[0] } };
  }
  return 'required';
}

export function projectToolCallRequired(tools = []) {
  return ['mutation', 'verification'].includes(projectToolPhase(tools));
}

function normalizedObjective(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function onlyNamedTool(tools, name) {
  const selected = tools.filter(tool => projectToolName(tool) === name);
  return selected.length ? selected : null;
}

const SPECIAL_FILE_NAME = '(?:dockerfile|makefile|procfile|license|readme|changelog|\\.gitignore|\\.dockerignore|\\.env|\\.npmrc|\\.editorconfig)';
const SERVICE_TARGET = '(?:pagina|site|app|aplicacao|interface|landing page|dashboard|jogo|game|projeto)';
const SERVICE_BUILD_VERB = '(?:crie|criar|faca|fazer|monte|montar|desenvolva|desenvolver|construa|construir|implemente|implementar)';

export function projectMutationIntent(objective = '') {
  const text = normalizedObjective(objective).replace(/[`“”]/g, '"');

  // Pedidos de serviço que implicam vários artefatos devem ser tratados como uma
  // entrega multi-arquivo atômica, não como a criação isolada de um único arquivo.
  const genericProjectCreation = new RegExp(`\\b${SERVICE_BUILD_VERB}\\b.{0,160}\\b${SERVICE_TARGET}\\b`).test(text)
    && (/\b(?:projeto|pasta do projeto|arquivos?|files?)\b/.test(text)
      || /\b(?:html|css|javascript|java script|js|typescript|ts|python|php|react|vue|svelte)\b/.test(text));
  if (genericProjectCreation) return 'create_project';

  const directFileCreation = /\b(?:crie|criar|create|adicione|adicionar|add)\s+(?:(?:um|uma|o|a|novo|nova|new)\s+)?(?:arquivo\s+|file\s+)?["']?[a-z0-9_.\/-]+\.[a-z0-9]{1,12}["']?\b/.test(text)
    || new RegExp(`\\b(?:crie|criar|create|adicione|adicionar|add)\\s+(?:(?:um|uma|o|a|novo|nova|new)\\s+)?(?:arquivo\\s+|file\\s+)?["']?${SPECIAL_FILE_NAME}["']?(?=$|[\\s,.;:!?])`, 'i').test(text)
    || /\b(?:crie|criar|create)\b.{0,36}\b(?:arquivo|file)\b/.test(text);
  if (directFileCreation) return 'create_file';

  const directDirectoryCreation = /\b(?:crie|criar|create|adicione|adicionar|add)\b.{0,28}\b(?:pasta|diretorio|directory|folder)\b/.test(text);
  if (directDirectoryCreation) return 'create_directory';

  const explicitDelete = /\b(exclu|delet|apag)\w*\b.{0,32}\b(arquivo|pasta|diretorio|caminho|file|folder|directory|path)\b/.test(text)
    || /\bremov\w*\b.{0,20}\b(o|a|um|uma)\s+(arquivo|pasta|diretorio|file|folder|directory)\b/.test(text);
  if (explicitDelete) return 'delete';

  if (/\b(mov|renome)\w*\b.{0,40}\b(arquivo|pasta|diretorio|caminho|file|folder|directory|path)\b/.test(text)) return 'move';

  return 'edit';
}

export function projectMutationNeedsExploration(objective = '') {
  return !['create_file', 'create_project', 'create_directory'].includes(projectMutationIntent(objective));
}

export function preferredProjectMutationTools(tools = [], { objective = '', hasReadEvidence = false } = {}) {
  const mutations = tools.filter(tool => isProjectMutationTool(tool));
  if (mutations.length <= 1) return mutations;

  const intent = projectMutationIntent(objective);
  if (intent === 'delete') return onlyNamedTool(mutations, 'delete_project_path') || mutations;
  if (intent === 'move') return onlyNamedTool(mutations, 'move_project_path') || mutations;
  if (intent === 'create_directory') return onlyNamedTool(mutations, 'create_project_directory') || mutations;
  if (intent === 'create_project') return onlyNamedTool(mutations, 'write_project_files') || mutations;
  if (intent === 'create_file') return onlyNamedTool(mutations, 'write_project_file') || mutations;

  const text = normalizedObjective(objective);
  if (/\b(reescrev|substitu)\w*\b.{0,32}\barquivo\b/.test(text)) {
    return onlyNamedTool(mutations, 'write_project_file') || mutations;
  }
  if (hasReadEvidence) return onlyNamedTool(mutations, 'replace_project_text') || mutations;
  return mutations;
}

export function allowParallelProjectToolCalls(_tools = [], _providerSupportsParallel = false) {
  // Um agente de engenharia precisa observar o resultado real da etapa anterior
  // antes de decidir a próxima. Isso também impede leituras paginadas sobrepostas,
  // mutações concorrentes e explosões de contexto com vários resultados de uma vez.
  return false;
}
