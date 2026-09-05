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
  tier.textContent = ` · ${r.tier}` + (r.ms == null ? '' : ` · ${r.ms} ms`);

  const after = document.createElement('p');
  after.style.margin = '4px 0 0';
  after.textContent = r.after === '' ? 'Silenciado (decorativo)' : r.after;

  const before = document.createElement('p');
  before.className = 'before';
  before.style.margin = '2px 0 0';
  before.textContent = `Antes: ${r.before === null ? 'sin atributo' : r.before || '(vacío)'}`;

  // The selector is an implementation detail that leaked into the UI. Clicking
  // the row asks the page to point at the element instead of asking the reader
  // to decode a path of nth-of-type steps.
  what.title = r.selector;
  what.setAttribute('role', 'button');
  what.setAttribute('tabindex', '0');
  const reveal = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    // Three outcomes, three messages. Collapsing them was worse than useless:
    // after reloading the extension, an already-open tab keeps running the old
    // content script, which does not know this message — and reporting that as
    // "the element is gone" sends the reader hunting for a bug in the page.
    let res = null, unreachable = false;
    try {
      res = await chrome.tabs.sendMessage(tab.id, {
        type: 'ariaweave:reveal', selector: r.selector,
      });
      if (res === undefined) unreachable = true;
    } catch { unreachable = true; }

    what.dataset.state = unreachable ? 'stale' : res?.found ? '' : 'gone';
  };
  what.addEventListener('click', reveal);
  what.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); }
  });

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
  const queued = state.queued ?? 0;
  const done = fixed.length === 1
    ? '1 elemento corregido en esta página'
    : `${fixed.length} elementos corregidos en esta página`;

  // A page with several images can sit for twenty seconds on the first batch.
  // Showing 0 that whole time and then jumping to 13 reads as broken; saying
  // what is still queued reads as working.
  $('count').textContent = queued > 0 ? `${done} · describiendo ${queued} más…` : done;
  items.append(...fixed.map(describeItem));

  // Only while there is something to wait for, and stopping as soon as there
  // is not — a popup that polls forever is a popup that drains a battery.
  clearTimeout(poll);
  if (queued > 0) poll = setTimeout(render, 700);
}

let poll = null;

for (const key of ['enabled', 'inspecting']) {
  $(key).addEventListener('change', (e) => chrome.storage.local.set({ [key]: e.target.checked }));
}

render();
