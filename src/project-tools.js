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
  functionTool('search_project', 'Localize rapidamente símbolos, seletores, funções ou texto antes de ler arquivos grandes. Você pode passar termos alternativos separados por | em uma única busca. O resultado já inclui contexto ao redor das ocorrências, então só leia o arquivo se ainda faltar informação para editar.', {
    query: { type: 'string', description: 'Texto ou alternativas separadas por |, por exemplo renderTerrain|drawMap|biome.' },
    path: { type: 'string', description: 'Prefixo de pasta opcional para limitar a busca.' }
  }, ['query']),
  functionTool('read_project_file', 'Leia somente o trecho ainda necessário de um arquivo. Prefira search_project primeiro; evite varrer o arquivo inteiro e não releia faixas já conhecidas.', {
    path: { type: 'string', description: 'Caminho relativo, por exemplo src/app.js.' },
    start_line: { type: 'integer', minimum: 1, description: 'Primeira linha, padrão 1.' },
    end_line: { type: 'integer', minimum: 1, description: 'Última linha; a ferramenta limita cada leitura a no máximo 220 linhas.' },
    start_character: { type: 'integer', minimum: 0, description: 'Deslocamento opcional para continuar arquivos minificados ou linhas muito longas. Use nextStartCharacter retornado pela leitura anterior.' }
  }, ['path']),
  functionTool('write_project_file', 'Crie ou substitua um arquivo de texto no projeto. Use para arquivo novo ou quando uma substituição localizada não for adequada. Envie o conteúdo completo final. A ferramenta só informa sucesso depois de reler o arquivo no disco e confirmar que o conteúdo persistido corresponde ao conteúdo solicitado.', {
    path: { type: 'string', description: 'Caminho relativo do arquivo.' },
    content: { type: 'string', description: 'Conteúdo completo que será gravado.' }
  }, ['path', 'content']),
  functionTool('write_project_files', 'Grave todos os arquivos de uma entrega multi-arquivo em uma única operação transacional. Use para páginas, sites, apps e scaffolds que exigem HTML/CSS/JS ou vários artefatos. Envie cada arquivo completo. O sucesso só é retornado após releitura e confirmação de TODOS os arquivos; se qualquer gravação falhar, o Genesis tenta restaurar o estado anterior para não deixar uma entrega pela metade.', {
    files: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      description: 'Lista completa de arquivos que compõem a entrega.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'Caminho relativo do arquivo dentro do projeto.' },
          content: { type: 'string', description: 'Conteúdo completo final do arquivo.' }
        }
      }
    }
  }, ['files']),
  functionTool('replace_project_text', 'Edite um trecho exato de um arquivo existente. Prefira esta ferramenta para mudanças localizadas: reduz risco, tokens e preserva código não relacionado. Se o trecho tiver mudado no disco, a falha retorna um recorte atual para você corrigir old_text e tentar novamente sem reabrir uma exploração ampla. O sucesso só é retornado depois de uma releitura pós-escrita do arquivo.', {
    path: { type: 'string', description: 'Caminho relativo do arquivo existente.' },
    old_text: { type: 'string', minLength: 1, maxLength: 32000, description: 'Trecho atual exato que será substituído.' },
    new_text: { type: 'string', maxLength: 32000, description: 'Novo trecho que entrará no lugar.' },
    expected_replacements: { type: 'integer', minimum: 1, maximum: 100, description: 'Quantidade exata esperada de ocorrências; padrão 1.' }
  }, ['path', 'old_text', 'new_text']),
  functionTool('create_project_directory', 'Crie uma pasta dentro do projeto ativo quando a implementação realmente precisar dela.', {
    path: { type: 'string', description: 'Caminho relativo da nova pasta.' }
  }, ['path']),
  functionTool('move_project_path', 'Renomeie ou mova um arquivo ou pasta dentro do projeto ativo.', {
    from: { type: 'string', description: 'Caminho relativo atual.' },
    to: { type: 'string', description: 'Novo caminho relativo.' }
  }, ['from', 'to']),
  functionTool('delete_project_path', 'Exclua um arquivo ou pasta dentro do projeto ativo somente quando o pedido exigir explicitamente remoção.', {
    path: { type: 'string', description: 'Caminho relativo a excluir.' }
  }, ['path']),
  functionTool('run_project_check', 'Verifique a alteração com uma rotina segura e conhecida. Use auto para escolher automaticamente o melhor teste/lint/build/check disponível no projeto.', {
    check: { type: 'string', enum: ['auto', 'tests', 'lint', 'build', 'status', 'diff'], description: 'Verificação desejada; prefira auto após editar.' }
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
  try { return JSON.parse(String(value || '{}')); }
  catch { throw toolError('O modelo enviou argumentos de ferramenta inválidos.', 'invalid_tool_arguments'); }
}

function normalizedWrittenContent(value) {
  return String(value ?? '').replace(/^\uFEFF/, '');
}

async function readBackWrittenFile(projectStore, relativePath) {
  if (typeof projectStore?.readText !== 'function') {
    throw toolError(
      `A gravação de “${relativePath}” não pôde ser confirmada porque o projeto não oferece releitura do arquivo.`,
      'project_write_verification_unavailable'
    );
  }
  try {
    return await projectStore.readText(relativePath);
  } catch (error) {
    throw toolError(
      `A gravação de “${relativePath}” não pôde ser confirmada por releitura no disco: ${error?.message || 'arquivo indisponível'}.`,
      'project_write_verification_failed'
    );
  }
}

async function confirmWrittenFile(projectStore, relativePath, expectedContent) {
  const source = normalizedWrittenContent(expectedContent);
  const expected = redactText(source, Math.max(source.length, 1));
  const persisted = await readBackWrittenFile(projectStore, relativePath);
  if (persisted !== expected) {
    throw toolError(
      `A gravação de “${relativePath}” não foi confirmada: o conteúdo relido do disco difere do conteúdo solicitado.`,
      'project_write_verification_failed'
    );
  }
  return { verified: true, verification: 'read_after_write' };
}

function safeBatchFiles(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw toolError('write_project_files exige entre 1 e 16 arquivos.', 'invalid_batch_files');
  }
  const seen = new Set();
  let totalCharacters = 0;
  const files = value.map((file, index) => {
    const path = typeof file?.path === 'string' ? file.path.trim() : '';
    if (!path) throw toolError(`O arquivo ${index + 1} não possui caminho válido.`, 'invalid_batch_file_path');
    if (seen.has(path.toLowerCase())) throw toolError(`O caminho “${path}” foi enviado mais de uma vez no mesmo lote.`, 'duplicate_batch_file_path');
    if (typeof file?.content !== 'string') throw toolError(`O arquivo “${path}” não possui conteúdo textual válido.`, 'invalid_batch_file_content');
    seen.add(path.toLowerCase());
    totalCharacters += file.content.length;
    return { path, content: file.content };
  });
  if (totalCharacters > 500_000) {
    throw toolError('O lote excede 500.000 caracteres. Divida a entrega em partes menores.', 'project_batch_write_too_large');
  }
  return files;
}

async function snapshotProjectFile(projectStore, relativePath) {
  try {
    return { existed: true, content: await projectStore.readText(relativePath) };
  } catch (error) {
    if (['project_path_not_found', 'ENOENT'].includes(error?.code)) return { existed: false, content: '' };
    throw error;
  }
}

function assertNonDestructiveRewrite(existing, nextContent, relativePath = '') {
  if (existing === null || existing === undefined) return;
  const next = String(nextContent ?? '');
  const removedCharacters = existing.length - next.length;
  if (existing.length >= 2_000 && removedCharacters >= 2_000 && next.length < existing.length * 0.5) {
    throw toolError(
      `Reescrita destrutiva bloqueada${relativePath ? ` em “${relativePath}”` : ''}: ${existing.length} → ${next.length} caracteres. Use replace_project_text para alterar somente o trecho solicitado.`,
      'project_destructive_rewrite'
    );
  }
}

async function writeProjectFilesAtomically(projectStore, rawFiles) {
  const files = safeBatchFiles(rawFiles);
  const snapshots = new Map();
  for (const file of files) {
    const snapshot = await snapshotProjectFile(projectStore, file.path);
    snapshots.set(file.path, snapshot);
    assertNonDestructiveRewrite(snapshot.existed ? snapshot.content : null, file.content, file.path);
  }

  const applied = [];
  try {
    for (const file of files) {
      await projectStore.writeText(file.path, file.content);
      await confirmWrittenFile(projectStore, file.path, file.content);
      applied.push(file.path);
    }
  } catch (error) {
    let rollbackFailure = null;
    for (const relativePath of [...applied].reverse()) {
      const snapshot = snapshots.get(relativePath);
      try {
        if (snapshot?.existed) {
          await projectStore.writeText(relativePath, snapshot.content);
          await confirmWrittenFile(projectStore, relativePath, snapshot.content);
        } else {
          await projectStore.deletePath(relativePath);
        }
      } catch (rollbackError) {
        rollbackFailure ||= rollbackError;
      }
    }
    if (rollbackFailure) {
      throw toolError(
        `A gravação em lote falhou e a restauração do estado anterior também encontrou erro: ${rollbackFailure?.message || 'rollback incompleto'}.`,
        'project_batch_write_rollback_failed'
      );
    }
    throw error;
  }

  return files;
}

async function exists(target) {
  return fs.access(target).then(() => true).catch(() => false);
}

function usefulNpmScript(source) {
  const value = String(source || '').trim();
  return value && !/no test specified|not implemented|todo/i.test(value);
}

async function packageScripts(root) {
  try { return JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))?.scripts || {}; }
  catch (error) {
    if (error.code === 'ENOENT' || error.name === 'SyntaxError') return {};
    throw error;
  }
}

function npmCommand(args, script, detected) {
  const windows = process.platform === 'win32';
  const displayCommand = `${windows ? 'npm.cmd' : 'npm'} ${args.join(' ')}`;
  return {
    program: windows ? (process.env.ComSpec || process.env.COMSPEC || 'cmd.exe') : 'npm',
    args: windows ? ['/d', '/s', '/c', displayCommand] : args,
    preview: `npm ${args.join(' ')} → ${redactText(script, 500)}`,
    detected,
    displayCommand
  };
}

function clearlyAggregatesChecks(source, scripts) {
  const command = String(source || '').toLowerCase();
  const signals = new Set();
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b/.test(command)) signals.add('test');
  if (/\blint\b|\beslint\b|\bbiome\s+(?:check|lint)\b/.test(command)) signals.add('lint');
  if (/\btypecheck\b|\btsc\b/.test(command)) signals.add('typecheck');
  if (/\bbuild\b/.test(command)) signals.add('build');
  if (/\bnode\s+--check\b/.test(command)) signals.add('syntax');
  for (const name of ['test', 'lint', 'typecheck', 'build']) {
    if (usefulNpmScript(scripts[name]) && new RegExp(`\\b(?:npm|pnpm|yarn)\\s+(?:run\\s+)?${name}\\b`).test(command)) signals.add(name);
  }
  return signals.size >= 2;
}

async function automaticCommand(root) {
  const scripts = await packageScripts(root);
  if (usefulNpmScript(scripts.check) && clearlyAggregatesChecks(scripts.check, scripts)) {
    return npmCommand(['run', 'check'], scripts.check, 'check');
  }
  for (const [name, args] of [
    ['test', ['test']],
    ['lint', ['run', 'lint']],
    ['build', ['run', 'build']],
    ['typecheck', ['run', 'typecheck']]
  ]) {
    if (usefulNpmScript(scripts[name])) return npmCommand(args, scripts[name], name);
  }
  if (usefulNpmScript(scripts.check)) return npmCommand(['run', 'check'], scripts.check, 'check');
  if (await exists(path.join(root, 'pyproject.toml')) || await exists(path.join(root, 'pytest.ini'))) {
    return { program: 'python', args: ['-m', 'pytest'], preview: 'python -m pytest', detected: 'tests' };
  }
  if (await exists(path.join(root, 'Cargo.toml'))) {
    return { program: 'cargo', args: ['test'], preview: 'cargo test', detected: 'tests' };
  }
  if (await exists(path.join(root, 'go.mod'))) {
    return { program: 'go', args: ['test', './...'], preview: 'go test ./...', detected: 'tests' };
  }
  if (await exists(path.join(root, '.git'))) {
    return { program: 'git', args: ['diff', '--check'], preview: 'git diff --check', detected: 'diff' };
  }
  throw toolError('Nenhuma rotina automática segura de teste, lint, build ou diff foi detectada neste projeto.', 'project_check_unavailable');
}

async function commandFor(root, check) {
  if (check === 'auto') return automaticCommand(root);
  if (check === 'status') return { program: 'git', args: ['status', '--short'], preview: 'git status --short', detected: 'status' };
  if (check === 'diff') return { program: 'git', args: ['diff', '--check'], preview: 'git diff --check', detected: 'diff' };
  const scripts = await packageScripts(root);
  if (check === 'tests' && usefulNpmScript(scripts.test)) return npmCommand(['test'], scripts.test, 'tests');
  if (check === 'lint' && usefulNpmScript(scripts.lint)) return npmCommand(['run', 'lint'], scripts.lint, 'lint');
  if (check === 'build' && usefulNpmScript(scripts.build)) return npmCommand(['run', 'build'], scripts.build, 'build');
  if (check === 'tests' && (await exists(path.join(root, 'pyproject.toml')) || await exists(path.join(root, 'pytest.ini')))) return { program: 'python', args: ['-m', 'pytest'], preview: 'python -m pytest', detected: 'tests' };
  if (check === 'tests' && await exists(path.join(root, 'Cargo.toml'))) return { program: 'cargo', args: ['test'], preview: 'cargo test', detected: 'tests' };
  if (check === 'build' && await exists(path.join(root, 'Cargo.toml'))) return { program: 'cargo', args: ['check'], preview: 'cargo check', detected: 'build' };
  if (check === 'tests' && await exists(path.join(root, 'go.mod'))) return { program: 'go', args: ['test', './...'], preview: 'go test ./...', detected: 'tests' };
  throw toolError(`O projeto não possui uma rotina “${check}” reconhecida.`, 'project_check_unavailable');
}

function operationSummary(name, args) {
  if (name === 'write_project_file') return { title: 'Alterar arquivo', detail: `${args.path} · ${String(args.content || '').length} caracteres`, kind: 'write' };
  if (name === 'write_project_files') {
    const files = Array.isArray(args.files) ? args.files : [];
    const names = files.map(file => file?.path).filter(Boolean).slice(0, 8);
    const total = files.reduce((sum, file) => sum + String(file?.content || '').length, 0);
    return { title: 'Criar entrega multi-arquivo', detail: `${files.length} arquivo(s) · ${total} caracteres · ${names.join(', ')}`, kind: 'write' };
  }
  if (name === 'replace_project_text') return { title: 'Editar trecho', detail: `${args.path} · ${String(args.old_text || '').length} → ${String(args.new_text || '').length} caracteres`, kind: 'write' };
  if (name === 'create_project_directory') return { title: 'Criar pasta', detail: args.path, kind: 'write' };
  if (name === 'move_project_path') return { title: 'Mover ou renomear', detail: `${args.from} → ${args.to}`, kind: 'move' };
  if (name === 'delete_project_path') return { title: 'Excluir do projeto', detail: args.path, kind: 'delete' };
  if (name === 'run_project_check') return { title: 'Executar verificação', detail: args.check, kind: 'command' };
  if (name === 'read_project_file') return { title: 'Lendo trecho', detail: args.path, kind: 'read' };
  return { title: 'Pesquisando no projeto', detail: args.query, kind: 'read' };
}

function searchTerms(value) {
  return [...new Set(String(value || '').split('|').map(item => item.trim()).filter(Boolean))].slice(0, 6);
}

async function contextualizeMatches(projectStore, matches) {
  const cache = new Map();
  const output = [];
  for (const match of matches.slice(0, 8)) {
    let source = cache.get(match.path);
    if (source === undefined) {
      try { source = await projectStore.readText(match.path); }
      catch { source = ''; }
      cache.set(match.path, source);
    }
    const lines = String(source || '').split(/\r?\n/);
    const startLine = Math.max(1, Number(match.line || 1) - 4);
    const endLine = Math.min(lines.length, Number(match.line || 1) + 4);
    const raw = lines.slice(startLine - 1, endLine)
      .map((line, index) => `${startLine + index}: ${line}`)
      .join('\n');
    const context = sanitizeModelText(raw, { maxCharacters: 900, maxLineCharacters: 700 }).text;
    output.push({ ...match, startLine, endLine, context });
  }
  return output;
}

function recoveryTerms(value) {
  const source = String(value || '').normalize('NFKC');
  const identifiers = source.match(/[A-Za-z_$À-ÿ][A-Za-z0-9_$À-ÿ.-]{3,}/g) || [];
  return [...new Set(identifiers)]
    .filter(term => !/^(?:const|let|var|function|return|class|style|color|width|height|true|false|null|undefined)$/i.test(term))
    .sort((left, right) => right.length - left.length)
    .slice(0, 8);
}

async function replacementRecoveryContext(projectStore, args) {
  const source = await projectStore.readText(args.path);
  const lines = String(source || '').split(/\r?\n/);
  const oldLines = String(args.old_text || '').split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 6);
  let targetIndex = -1;

  for (const candidate of oldLines.sort((left, right) => right.length - left.length()).slice(0, 8)) {
    const probe = candidate.length > 160 ? candidate.slice(0, 160) : candidate;
    const found = lines.findIndex(line => line.includes(probe));
    if (found >= 0) { targetIndex = found; break; }
  }

  if (targetIndex < 0) {
    const terms = recoveryTerms(args.old_text);
    let bestScore = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const score = terms.reduce((sum, term) => sum + (lines[index].includes(term) ? Math.min(8, term.length) : 0), 0);
      if (score > bestScore) { bestScore = score; targetIndex = index; }
    }
  }

  if (targetIndex < 0) targetIndex = 0;
  const startLine = Math.max(1, targetIndex + 1 - 12);
  const endLine = Math.min(lines.length, targetIndex + 1 + 18);
  const raw = lines.slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join('\n');
  const sanitized = sanitizeModelText(raw, { maxCharacters: 4_500, maxLineCharacters: 1_500 });
  return {
    path: args.path,
    startLine,
    endLine,
    totalLines: lines.length,
    content: sanitized.text,
    instruction: 'O arquivo mudou desde a leitura anterior. Use este recorte atual como fonte da verdade, ajuste old_text para um trecho exato e tente replace_project_text novamente. Não recomece a exploração do projeto.'
  };
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

    if (privileged && this.permissionStore.mode === 'ask') {
      const approvalStartedAt = Date.now();
      const approval = this.approvalManager.request({ conversationId, operation, signal });
      onEvent('approval_required', { approvalId: approval.id, ...operation });
      const decision = await approval.promise;
      operation.approvalWaitMs = Math.max(0, Date.now() - approvalStartedAt);
      if (decision !== 'approve') {
        onEvent('tool_denied', operation);
        return { ok: false, denied: true, approvalWaitMs: operation.approvalWaitMs, message: 'O usuário negou esta alteração.' };
      }
      onEvent('approval_resolved', { approvalId: approval.id, decision: 'approve', ...operation });
    }

    onEvent('tool_start', operation);
    try {
      const result = await this.run(name, args, signal);
      onEvent('tool_complete', { ...operation, summary: result.summary || 'Operação concluída.' });
      return { ok: true, approvalWaitMs: operation.approvalWaitMs || 0, ...result };
    } catch (error) {
      const message = error?.message || 'Falha ao executar a ferramenta.';
      let recovery = null;
      if (name === 'replace_project_text' && error?.code === 'project_replacement_mismatch') {
        try { recovery = await replacementRecoveryContext(this.projectStore, args); }
        catch { recovery = null; }
      }
      onEvent('tool_failed', { ...operation, message, recovery: recovery ? { path: recovery.path, startLine: recovery.startLine, endLine: recovery.endLine } : null });
      return {
        ok: false,
        approvalWaitMs: operation.approvalWaitMs || 0,
        error: message,
        code: error?.code || 'project_tool_error',
        ...(recovery ? {
          retryable: true,
          recovery,
          summary: `${message} O Genesis releu somente a região relevante do arquivo; corrija old_text com o recorte atual e tente a substituição novamente.`
        } : {})
      };
    }
  }

  async run(name, args, signal) {
    if (signal?.aborted) throw toolError('Solicitação interrompida.', 'request_cancelled');
    if (name === 'search_project') {
      const queries = searchTerms(args.query);
      if (!queries.length) throw toolError('Informe ao menos um termo de busca.', 'invalid_search_query');
      const dedupe = new Map();
      for (const query of queries) {
        const found = await this.projectStore.search(query, { path: args.path, limit: 16 });
        for (const match of found) {
          const key = `${String(match.path).toLowerCase()}:${match.line}`;
          if (!dedupe.has(key)) dedupe.set(key, { ...match, matchedQuery: query });
          if (dedupe.size >= 18) break;
        }
        if (dedupe.size >= 18) break;
      }
      const matches = await contextualizeMatches(this.projectStore, [...dedupe.values()]);
      return {
        queries,
        matches,
        summary: `${matches.length} ocorrência${matches.length === 1 ? '' : 's'} contextualizada${matches.length === 1 ? '' : 's'} para ${queries.length} termo${queries.length === 1 ? '' : 's'}.`
      };
    }
    if (name === 'read_project_file') {
      const content = await this.projectStore.readText(args.path);
      if (args.start_character !== undefined && args.start_character !== null) {
        const startCharacter = Math.max(0, Math.min(content.length, Number(args.start_character) || 0));
        const endCharacter = Math.min(content.length, startCharacter + 8_000);
        const rawExcerpt = content.slice(startCharacter, endCharacter);
        const sanitized = sanitizeModelText(rawExcerpt, { maxCharacters: 8_000, maxLineCharacters: 8_000 });
        const nextStartCharacter = endCharacter < content.length ? endCharacter : null;
        return {
          path: args.path,
          startCharacter,
          endCharacter,
          nextStartCharacter,
          totalCharacters: content.length,
          content: sanitized.text,
          truncated: sanitized.changed || nextStartCharacter !== null,
          omittedOpaqueCharacters: sanitized.removedOpaqueCharacters,
          omittedDataUris: sanitized.dataUriCount,
          summary: `${args.path} · caracteres ${startCharacter}-${endCharacter} de ${content.length}. Próximo caractere: ${nextStartCharacter ?? 'fim'}.`
        };
      }
      const lines = content.split(/\r?\n/);
      const startLine = Math.max(1, Number(args.start_line || 1));
      const requestedEnd = Number(args.end_line || startLine + 159);
      const endLine = Math.min(lines.length, Math.max(startLine, requestedEnd), startLine + 219);
      const rawExcerpt = lines.slice(startLine - 1, endLine).join('\n');
      const hasLongLine = rawExcerpt.split(/\r?\n/).some(line => line.length > 2_000);
      const sanitized = sanitizeModelText(rawExcerpt, { maxCharacters: 8_000, maxLineCharacters: 2_000 });
      const truncated = sanitized.changed || hasLongLine || endLine < lines.length;
      return {
        path: args.path,
        startLine,
        endLine,
        nextStartLine: endLine < lines.length ? endLine + 1 : null,
        totalLines: lines.length,
        content: sanitized.text,
        truncated,
        omittedOpaqueCharacters: sanitized.removedOpaqueCharacters,
        omittedDataUris: sanitized.dataUriCount,
        summary: `${args.path} · linhas ${startLine}-${endLine}${endLine < lines.length ? ` de ${lines.length}` : ''}. Próxima linha: ${endLine < lines.length ? endLine + 1 : 'fim'}.${hasLongLine ? ' Há linha longa compactada; continue por start_character para ler o conteúdo omitido.' : ''}`
      };
    }
    if (name === 'write_project_file') {
      let existing = null;
      try { existing = await this.projectStore.readText(args.path); }
      catch (error) {
        if (!['project_path_not_found', 'ENOENT'].includes(error?.code)) throw error;
      }
      assertNonDestructiveRewrite(existing, args.content, args.path);
      await this.projectStore.writeText(args.path, args.content);
      const confirmation = await confirmWrittenFile(this.projectStore, args.path, args.content);
      return {
        path: args.path,
        ...confirmation,
        summary: `${args.path} gravado e confirmado por releitura no disco.`
      };
    }
    if (name === 'write_project_files') {
      const files = await writeProjectFilesAtomically(this.projectStore, args.files);
      const paths = files.map(file => file.path);
      return {
        files: paths.map(path => ({ path, verified: true })),
        paths,
        verified: true,
        verification: 'batch_read_after_write',
        summary: `${paths.length} arquivo(s) gravado(s) e confirmado(s) por releitura no disco: ${paths.join(', ')}.`
      };
    }
    if (name === 'replace_project_text') {
      const replacements = await this.projectStore.replaceText(args.path, args.old_text, args.new_text, args.expected_replacements);
      if (replacements === 0 && args.new_text === '') {
        return {
          path: args.path,
          replacements,
          alreadySatisfied: true,
          verified: true,
          verification: 'precondition_confirmed',
          summary: `${args.path} já não continha o trecho solicitado; o resultado desejado já estava aplicado no disco.`
        };
      }
      await readBackWrittenFile(this.projectStore, args.path);
      return {
        path: args.path,
        replacements,
        verified: true,
        verification: 'read_after_write',
        summary: `${args.path} atualizado em ${replacements} trecho${replacements === 1 ? '' : 's'} exato${replacements === 1 ? '' : 's'} e confirmado por releitura no disco.`
      };
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
      const command = await commandFor(root, args.check || 'auto');
      const { stdout, stderr } = await execFileAsync(command.program, command.args, {
        cwd: root,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        signal,
        env: safeCommandEnvironment(),
        shell: false
      });
      const output = sanitizeModelText(`${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim(), {
        maxCharacters: 18_000,
        maxLineCharacters: 2_500
      }).text;
      return {
        check: args.check || 'auto',
        detectedCheck: command.detected || args.check,
        command: command.displayCommand || [command.program, ...command.args].join(' '),
        output,
        summary: `Verificação “${command.detected || args.check || 'auto'}” concluída com sucesso.`
      };
    }
    throw toolError('Ferramenta desconhecida.', 'unknown_project_tool');
  }
}
