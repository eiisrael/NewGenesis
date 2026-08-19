import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EVENT_MODULES, VIEW_IDS } from '../public/neural/neural.config.js';

const html = await readFile(new URL('../public/neural/neural.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/neural/neural.js', import.meta.url), 'utf8');
const appScript = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

function matches(source, expression, group = 1) {
  return [...source.matchAll(expression)].map(match => match[group]);
}

test('todos os IDs consultados diretamente pelo cockpit existem e são únicos', () => {
  const declared = matches(html, /\bid="([A-Za-z][\w-]*)"/g);
  const referenced = [...new Set(matches(script, /["']#([A-Za-z][\w-]*)["']/g))];
  const missing = referenced.filter(id => !declared.includes(id));
  const duplicates = declared.filter((id, index) => declared.indexOf(id) !== index);
  assert.deepEqual(missing, []);
  assert.deepEqual([...new Set(duplicates)], []);
});

test('navegação e painéis implementam exatamente as sete áreas públicas', () => {
  const navigation = matches(html, /\bdata-view="([A-Za-z][\w-]*)"/g);
  const panels = matches(html, /\bid="view-([A-Za-z][\w-]*)"/g);
  assert.deepEqual(navigation, VIEW_IDS);
  assert.deepEqual(panels, VIEW_IDS);
  for (const view of VIEW_IDS) {
    assert.match(html, new RegExp(`data-view="${view}"[^>]*aria-label="[^"]+"`));
  }
});

test('mapeamento cobre o contrato, inferência e verificação do agente atual', () => {
  for (const type of ['agent.task.contract', 'agent.local.analysis', 'agent.inference.started', 'agent.inference.completed', 'agent.verification']) {
    assert.ok(EVENT_MODULES[type]?.length, `${type} precisa acender ao menos um módulo`);
  }
});

test('link legado e carregamento seguro do módulo Neural permanecem compatíveis', () => {
  assert.match(appScript, /window\.open\('\.\/neural\/neural\.html'/);
  assert.match(html, /<script type="module" src="\.\/neural\.js"><\/script>/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(script, /new EventSource\(['"]https?:\/\//);
  assert.equal(matches(script, /(?:queueMicrotask\(bootstrap\)|DOMContentLoaded', bootstrap)/g, 0).length, 2);
});

test('bootstrap pode pedir o grafo sem sombrear a funcao loadGraph', () => {
  assert.match(script, /refreshSnapshot\(\{ quiet = false, loadGraph: shouldLoadGraph = false \} = \{\}\)/);
  assert.match(script, /if \(shouldLoadGraph && state\.project && state\.supremeMind\?\.indexed\) await loadGraph\(\{ quiet: true \}\)/);
  assert.doesNotMatch(script, /refreshSnapshot\(\{ quiet = false, loadGraph = false \}/);
  assert.match(script, /svg\.removeAttribute\('hidden'\)/);
  assert.doesNotMatch(script, /svg\.hidden = false/);
});

test('Ajuda Neural explica todas as areas e os modulos do runtime', () => {
  assert.match(html, /id="helpButton"[^>]*aria-label="Abrir Ajuda Neural"/);
  assert.match(html, /id="neuralHelpDialog"[^>]*aria-labelledby="helpTitle"/);
  for (const view of VIEW_IDS) assert.match(html, new RegExp(`data-help-view="${view}"`));
  for (const moduleName of ['Entrada', 'Planejador', 'Contexto', 'SupremeMind', 'Roteador', 'Modelo', 'Ferramentas', 'Resposta', 'Memória', 'Guardião']) {
    assert.match(html, new RegExp(`<dt>${moduleName}<\\/dt>`));
  }
  assert.match(script, /showModal\(\)/);
  assert.match(script, /closeHelpButton/);
});
