// Popup UI. Spanish strings are hardcoded on purpose — SPEC §5.1 exception.

const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function stateFromPage() {
  const tab = await activeTab();
  if (!tab?.id) return null;
  // No content script on chrome:// pages and the Web Store (SPEC §7).
  return chrome.tabs.sendMessage(tab.id, { type: 'ariaweave:state' }).catch(() => null);
}

function describeItem(r) {
  const li = document.createElement('li');

  const what = document.createElement('span');
  what.className = 'what';
  what.textContent = r.id ? `#${r.id}` : r.selector;

  const tier = document.createElement('span');
  tier.className = 'tier';
  tier.textContent = ` · ${r.tier}`;

  const after = document.createElement('p');
  after.style.margin = '4px 0 0';
  after.textContent = r.after === '' ? 'Silenciado (decorativo)' : r.after;

  const before = document.createElement('p');
  before.className = 'before';
  before.style.margin = '2px 0 0';
  before.textContent = `Antes: ${r.before === null ? 'sin atributo' : r.before || '(vacío)'}`;

  li.append(what, tier, after, before);

  if (r.after !== '') {
    const report = document.createElement('button');
    report.type = 'button';
    report.className = 'report';
    report.setAttribute('aria-pressed', 'false');
    report.textContent = 'Reportar descripción incorrecta';
    report.addEventListener('click', async () => {
      const { reports = [] } = await chrome.storage.local.get('reports');
      reports.push({ selector: r.selector, text: r.after, tier: r.tier, at: Date.now() });
      await chrome.storage.local.set({ reports });
      report.setAttribute('aria-pressed', 'true');
      report.textContent = 'Reportada';
    });
    li.append(report);
  }
  return li;
}

async function render() {
  const stored = await chrome.storage.local.get(['enabled', 'inspecting']);
  $('enabled').checked = stored.enabled !== false;
  $('inspecting').checked = stored.inspecting === true;

  const state = await stateFromPage();
  const items = $('items');
  items.replaceChildren();

  if (!state) {
    $('count').textContent = 'AriaWeave no se ejecuta en esta página';
    return;
  }
  const fixed = state.records ?? [];
  $('count').textContent = fixed.length === 1
    ? '1 elemento corregido en esta página'
    : `${fixed.length} elementos corregidos en esta página`;
  items.append(...fixed.map(describeItem));
}

for (const key of ['enabled', 'inspecting']) {
  $(key).addEventListener('change', (e) => chrome.storage.local.set({ [key]: e.target.checked }));
}

render();
