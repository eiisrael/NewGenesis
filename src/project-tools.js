import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redactText } from './telemetry.js';
import { sanitizeModelText } from './core/content-sanitizer.js';
import { isProjectPrivilegedTool } from './core/project-tool-policy.js';

const execFileAsync = promisify(execFile);

function safeCommandEnvironment() {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL'
  ];
  const environment = {};
  for (const key of allowed) if (process.env[key] !== undefined) environment[key] = process.env[key];
  return { ...environment, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
}

const functionTool = (name, description, properties, required = []) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false }
  }
});

export const PROJECT_TOOL_DEFINITIONS = Object.freeze([
  functionTool('read_project_file', 'Leia somente o trecho necessário de um arquivo de texto do projeto ativo. Use caminhos relativos e prefira search_project para localizar a região antes de paginar arquivos grandes.', {
    path: { type: 'string', description: 'Caminho relativo, por exemplo src/app.js.' },
    start_line: { type: 'integer', minimum: 1, description: 'Primeira linha, padrão 1.' },
    end_line: { type: 'integer', minimum: 1, description: 'Última linha, limitada a 400 linhas por leitura.' }
  }, ['path']),
  functionTool('search_project', 'Pesquise texto nos arquivos indexados do projeto antes de decidir uma leitura longa ou alteração.', {
    query: { type: 'string', description: 'Texto, função, seletor, classe ou identificador a localizar.' },
    path: { type: 'string', description: 'Prefixo de pasta opcional para limitar a busca.' }
  }, ['query']),
  functionTool('write_project_file', 'Crie ou substitua um arquivo de texto no projeto. Envie sempre o conteúdo completo final.', {
    path: { type: 'string', description: 'Caminho relativo do arquivo.' },
    content: { type: 'string', description: 'Conteúdo completo que será gravado.' }
  }, ['path', 'content']),
  functionTool('replace_project_text', 'Altere um trecho exato de um arquivo existente sem reenviar o arquivo inteiro. Prefira esta ferramenta para edições pequenas ou em arquivos grandes.', {
    path: { type: 'string', description: 'Caminho relativo do arquivo existente.' },
    old_text: { type: 'string', minLength: 1, maxLength: 32000, description: 'Trecho atual exato que será substituído.' },
    new_text: { type: 'string', maxLength: 32000, description: 'Novo trecho que entrará no lugar.' },
    expected_replacements: { type: 'integer', minimum: 1, maximum: 100, description: 'Quantidade exata esperada de ocorrências; padrão 1.' }
  }, ['path', 'old_text', 'new_text']),
  functionTool('create_project_directory', 'Crie uma pasta dentro do projeto ativo.', {
    path: { type: 'string', description: 'Caminho relativo da nova pasta.' }
  }, ['path']),
  functionTool('move_project_path', 'Renomeie ou mova um arquivo ou pasta dentro do projeto ativo.', {
    from: { type: 'string', description: 'Caminho relativo atual.' },
    to: { type: 'string', description: 'Novo caminho relativo.' }
  }, ['from', 'to']),
  functionTool('delete_project_path', 'Exclua um arquivo ou pasta dentro do projeto ativo somente quando o pedido exigir.', {
    path: { type: 'string', description: 'Caminho relativo a excluir.' }
  }, ['path']),
  functionTool('run_project_check', 'Execute uma verificação segura e conhecida no projeto, sem shell arbitrário.', {
    check: { type: 'string', enum: ['tests', 'lint', 'build', 'status', 'diff'], description: 'Verificação desejada.' }
  }, ['check'])
]);

export function projectToolDefinitionsFor(contract, { writable = false } = {}) {
  const allowed = new Set(contract?.toolPolicy?.allowed || []);
  if (!writable) {
    for (const name of [...allowed]) if (isProjectPrivilegedTool(name)) allowed.delete(name);
  }
  return PROJECT_TOOL_DEFINITIONS.filter(tool => allowed.has(tool.function.name));
}

function toolError(message, code = 'project_tool_error') {
  return Object.assign(new Error(message), { code });
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { throw toolError('O modelo enviou argumentos de ferramenta inválidos.', 'invalid_tool_arguments'); }
}

function commandFor(root, check) {
  const windows = process.platform === 'win32';
  const executable = name => windows && name === 'npm' ? 'npm.cmd' : name;
  if (check === 'status') return { program: 'git', args: ['status', '--short'] };
  if (check === 'diff') return { program: 'git', args: ['diff', '--stat'] };
  return fs.readFile(path.join(root, 'package.json'), 'utf8').then(source => {
    const scripts = JSON.parse(source)?.scripts || {};
    if (check === 'tests' && scripts.test) return { program: executable('npm'), args: ['test'], preview: `npm test → ${redactText(scripts.test, 500)}` };
    if (check === 'lint' && scripts.lint) return { program: executable('npm'), args: ['run', 'lint'], preview: `npm run lint → ${redactText(scripts.lint, 500)}` };
    if (check === 'build' && scripts.build) return { program: executable('npm'), args: ['run', 'build'], preview: `npm run build → ${redactText(scripts.build, 500)}` };
    throw toolError(`O projeto não possui uma rotina “${check}” reconhecida.`, 'project_check_unavailable');
  }).catch(async error => {
    if (error.code !== 'ENOENT') throw error;
    const exists = async name => fs.access(path.join(root, name)).then(() => true).catch(() => false);
    if (check === 'tests' && await exists('pyproject.toml')) return { program: 'python', args: ['-m', 'pytest'] };
    if (check === 'tests' && await exists('Cargo.toml')) return { program: 'cargo', args: ['test'] };
    if (check === 'build' && await exists('Cargo.toml')) return { program: 'cargo', args: ['check'] };
    if (check === 'tests' && await exists('go.mod')) return { program: 'go', args: ['test', './...'] };
    throw toolError(`O projeto não possui uma rotina “${check}” reconhecida.`, 'project_check_unavailable');
  });
}

function operationSummary(name, args) {
  if (name === 'write_project_file') return { title: 'Alterar arquivo', detail: `${args.path} · ${String(args.content || '').length} caracteres`, kind: 'write' };
  if (name === 'replace_project_text') return { title: 'Editar trecho', detail: `${args.path} · ${String(args.old_text || '').length} → ${String(args.new_text || '').length} caracteres`, kind: 'write' };
  if (name === 'create_project_directory') return { title: 'Criar pasta', detail: args.path, kind: 'write' };
  if (name === 'move_project_path') return { title: 'Mover ou renomear', detail: `${args.from} → ${args.to}`, kind: 'move' };
  if (name === 'delete_project_path') return { title: 'Excluir do projeto', detail: args.path, kind: 'delete' };
  if (name === 'run_project_check') return { title: 'Executar verificação', detail: args.check, kind: 'command' };
  if (name === 'read_project_file') return { title: 'Lendo arquivo', detail: args.path, kind: 'read' };
  return { title: 'Pesquisando no projeto', detail: args.query, kind: 'read' };
}

export class ProjectToolExecutor {
  constructor({ projectStore, permissionStore, approvalManager }) {
    this.projectStore = projectStore;
    this.permissionStore = permissionStore;
    this.approvalManager = approvalManager;
  }

  async execute(toolCall, { conversationId, onEvent = () => {}, signal } = {}) {
    const name = String(toolCall?.function?.name || toolCall?.name || '');
    const args = parseArguments(toolCall?.function?.arguments ?? toolCall?.arguments);
    const operation = operationSummary(name, args);
    const privileged = isProjectPrivilegedTool(name);

    if (!PROJECT_TOOL_DEFINITIONS.some(tool => tool.function.name === name)) {
      return { ok: false, error: 'Ferramenta desconhecida.', code: 'unknown_project_tool' };
    }

    if (privileged && !this.projectStore.summary()?.writable) {
      return { ok: false, error: 'Abra o projeto em modo editável para permitir alterações.', code: 'project_read_only' };
    }

    if (name === 'run_project_check' && this.projectStore.summary()?.writable) {
      const command = await commandFor(this.projectStore.rootPath(), args.check);
      operation.detail = command.preview || [command.program, ...command.args].join(' ');
    }

    if (privileged && (this.permissionStore.mode === 'ask' || name === 'run_project_check')) {
      const approval = this.approvalManager.request({ conversationId, operation, signal });
      onEvent('approval_required', { approvalId: approval.id, ...operation });
      const decision = await approval.promise;
      if (decision !== 'approve') {
        onEvent('tool_denied', operation);
        return { ok: false, denied: true, message: 'O usuário negou esta alteração.' };
      }
      onEvent('approval_resolved', { approvalId: approval.id, decision: 'approve', ...operation });
    }

    onEvent('tool_start', operation);
    try {
      const result = await this.run(name, args, signal);
      onEvent('tool_complete', { ...operation, summary: result.summary || 'Operação concluída.' });
      return { ok: true, ...result };
    } catch (error) {
      const message = error?.message || 'Falha ao executar a ferramenta.';
      onEvent('tool_failed', { ...operation, message });
      return { ok: false, error: message, code: error?.code || 'project_tool_error' };
    }
  }

  async run(name, args, signal) {
    if (signal?.aborted) throw toolError('Solicitação interrompida.', 'request_cancelled');
    if (name === 'read_project_file') {
      const content = await this.projectStore.readText(args.path);
      const lines = content.split(/\r?\n/);
      const startLine = Math.max(1, Number(args.start_line || 1));
      const endLine = Math.min(lines.length, Math.max(startLine, Number(args.end_line || startLine + 399)), startLine + 399);
      const rawExcerpt = lines.slice(startLine - 1, endLine).join('\n');
      // 10K mantém o JSON da ferramenta dentro do orçamento do agente e evita
      // reenviar blocos enormes a cada rodada. Os números de linha continuam
      // disponíveis para uma leitura seguinte precisa.
      const sanitized = sanitizeModelText(rawExcerpt, { maxCharacters: 10_000, maxLineCharacters: 2_500 });
      const excerpt = sanitized.text;
      const truncated = sanitized.changed || endLine < lines.length;
      return {
        path: args.path,
        startLine,
        endLine,
        nextStartLine: endLine < lines.length ? endLine + 1 : null,
        totalLines: lines.length,
        content: excerpt,
        truncated,
        omittedOpaqueCharacters: sanitized.removedOpaqueCharacters,
        omittedDataUris: sanitized.dataUriCount,
        summary: `${args.path} · linhas ${startLine}-${endLine}${endLine < lines.length ? ` de ${lines.length}` : ''}. Próxima linha: ${endLine < lines.length ? endLine + 1 : 'fim'}.`
      };
    }
    if (name === 'search_project') {
      const matches = await this.projectStore.search(args.query, { path: args.path, limit: 24 });
      return { matches, summary: `${matches.length} ocorrência${matches.length === 1 ? '' : 's'} encontrada${matches.length === 1 ? '' : 's'}.` };
    }
    if (name === 'write_project_file') {
      await this.projectStore.writeText(args.path, args.content);
      return { path: args.path, summary: `${args.path} atualizado com segurança.` };
    }
    if (name === 'replace_project_text') {
      const replacements = await this.projectStore.replaceText(args.path, args.old_text, args.new_text, args.expected_replacements);
      return { path: args.path, replacements, summary: `${args.path} atualizado em ${replacements} trecho${replacements === 1 ? '' : 's'} exato${replacements === 1 ? '' : 's'}.` };
    }
    if (name === 'create_project_directory') {
      await this.projectStore.createDirectory(args.path);
      return { path: args.path, summary: `Pasta ${args.path} criada.` };
    }
    if (name === 'move_project_path') {
      await this.projectStore.movePath(args.from, args.to);
      return { from: args.from, to: args.to, summary: `${args.from} movido para ${args.to}.` };
    }
    if (name === 'delete_project_path') {
      await this.projectStore.deletePath(args.path);
      return { path: args.path, summary: `${args.path} excluído.` };
    }
    if (name === 'run_project_check') {
      const root = this.projectStore.rootPath();
      const command = await commandFor(root, args.check);
      const { stdout, stderr } = await execFileAsync(command.program, command.args, {
        cwd: root,
        windowsHide: true,
        timeout: 90000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        signal,
        env: safeCommandEnvironment()
      });
      const output = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim().slice(-24000);
      return { check: args.check, command: [command.program, ...command.args].join(' '), output, summary: `Verificação “${args.check}” concluída.` };
    }
    throw toolError('Ferramenta desconhecida.', 'unknown_project_tool');
  }
}
