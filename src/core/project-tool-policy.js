const unique = values => Object.freeze([...new Set(values)]);

export const PROJECT_READ_TOOL_NAMES = unique([
  'search_project',
  'read_project_file'
]);

export const PROJECT_MUTATION_TOOL_NAMES = unique([
  'write_project_file',
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

export function allowParallelProjectToolCalls(_tools = [], _providerSupportsParallel = false) {
  // Um agente de engenharia precisa observar o resultado real da etapa anterior
  // antes de decidir a próxima. Isso também impede leituras paginadas sobrepostas,
  // mutações concorrentes e explosões de contexto com vários resultados de uma vez.
  return false;
}
