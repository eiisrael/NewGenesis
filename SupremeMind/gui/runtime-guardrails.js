const guardStyle = document.createElement('link');
guardStyle.rel = 'stylesheet';
guardStyle.href = '/runtime-guardrails.css';
document.head.append(guardStyle);

const INDEX_BUTTONS = new Set([
  'searchBtn', 'contextBtn', 'generateGalaxyBtn', 'impactBtn',
  'orbitBtn', 'doctorBtn', 'benchmarkBtn'
]);

let projectStatus = null;
let lastStatusAt = 0;

function showToast(message) {
  const stack = document.querySelector('#toastStack');
  if (!stack) return;
  const node = document.createElement('div');
  node.className = 'toast error';
  node.textContent = message;
  stack.append(node);
  setTimeout(() => node.remove(), 6500);
}

function openProjectView() {
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-project'));
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'project'));
  const log = document.querySelector('#projectLog');
  if (log) log.textContent = 'O projeto ainda não possui índice.\n\n1. Clique em Inicializar.\n2. Clique em Indexar.\n3. Volte à busca quando o Dashboard mostrar arquivos indexados.';
  document.querySelector('[data-action="init"]')?.focus();
}

function renderAvailability() {
  const ready = Boolean(projectStatus?.indexed);
  for (const id of INDEX_BUTTONS) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.classList.toggle('sm-requires-index', !ready);
    button.setAttribute('aria-disabled', String(!ready));
    button.title = ready ? '' : 'Inicialize e indexe o projeto antes de usar esta função.';
  }
}

async function refreshProjectStatus(force = false) {
  if (!force && projectStatus && Date.now() - lastStatusAt < 2500) return projectStatus;
  try {
    projectStatus = await window.SupremeMindProgress?.status?.(force) ?? null;
    if (!projectStatus) {
      const response = await fetch('/api/status');
      projectStatus = await response.json();
    }
    lastStatusAt = Date.now();
    renderAvailability();
  } catch {
    // A tela principal já informa quando o servidor está indisponível.
  }
  return projectStatus;
}

window.addEventListener('suprememind-project-status', event => {
  projectStatus = event.detail;
  lastStatusAt = Date.now();
  renderAvailability();
});

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || !INDEX_BUTTONS.has(button.id)) return;
  if (!projectStatus || projectStatus.indexed) {
    refreshProjectStatus();
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  const message = projectStatus.indexError
    ? `O índice está inválido: ${projectStatus.indexError}`
    : 'Este projeto ainda não foi indexado. Inicialize e indexe antes de pesquisar ou analisar.';
  showToast(message);
  openProjectView();
}, true);

refreshProjectStatus(true);
setInterval(() => refreshProjectStatus(true), 6000);
