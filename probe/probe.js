// Hour-zero probe. Answers one question: can this machine describe an image
// with Chrome's built-in model, for free, with no key?
//
// Every step reports what actually happened, including the exact error. The
// point is discovery — nothing here assumes an API shape.
//
// Chrome refuses to start the model download without a user gesture, so the
// read-only checks run on load and the download runs from a click. An earlier
// version auto-ran everything and reported "T3 does not exist" for what was
// really "nobody clicked anything" — a confident wrong answer, which is the
// failure mode the verifier exists to catch.

const out = document.getElementById('out');
const verdictEl = document.getElementById('verdict');
const goBtn = document.getElementById('go');
const noteEl = document.getElementById('note');
const findings = {};

function row(state, label, detail) {
  const marks = { ok: '✓', bad: '✗', warn: '!', info: '·' };
  const el = document.createElement('div');
  el.className = `row ${state}`;
  el.innerHTML = '<span class="mark"></span><span><span class="label"></span>'
               + '<span class="detail"></span></span>';
  el.querySelector('.mark').textContent = marks[state];
  el.querySelector('.label').textContent = label;
  el.querySelector('.detail').textContent = detail ? '\n' + detail : '';
  out.appendChild(el);
  return el;
}

const err = (e) => `${e?.name || 'Error'}: ${e?.message || String(e)}`;

// A picture with two unmistakable facts in it, so a real description is
// distinguishable from a plausible hallucination.
async function testImage() {
  const c = new OffscreenCanvas(320, 320);
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, 320, 320);
  x.fillStyle = '#c62828'; x.beginPath(); x.arc(160, 160, 92, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#1565c0'; x.fillRect(24, 24, 64, 64);
  return c.convertToBlob({ type: 'image/png' });
}

function findApi() {
  if (typeof self.LanguageModel !== 'undefined') return ['LanguageModel', self.LanguageModel];
  if (self.chrome?.aiOriginTrial?.languageModel) return ['chrome.aiOriginTrial.languageModel', chrome.aiOriginTrial.languageModel];
  if (self.ai?.languageModel) return ['ai.languageModel', self.ai.languageModel];
  return [null, null];
}

let API = null;

// ---- read-only checks: safe to run on load, no gesture needed ----------------

async function inspect() {
  const chromeVersion = (navigator.userAgent.match(/Chrome\/(\d+\.[\d.]+)/) || [])[1] || 'unknown';
  row('info', `Chrome ${chromeVersion}`, navigator.platform);
  findings.chromeVersion = chromeVersion;

  let apiName;
  [apiName, API] = findApi();
  if (!API) {
    row('bad', 'No Prompt API in this context',
        'Tried: LanguageModel, chrome.aiOriginTrial.languageModel, ai.languageModel');
    findings.api = null;
    return verdict();
  }
  row('ok', 'Prompt API found', apiName);
  findings.api = apiName;

  try {
    findings.textAvailability = await API.availability();
    row(findings.textAvailability === 'available' ? 'ok' : 'warn',
        `Text availability: ${findings.textAvailability}`);
  } catch (e) {
    findings.textAvailability = 'error';
    row('bad', 'availability() threw', err(e));
  }

  // The question that actually matters. "downloadable" already proves image
  // input is a supported modality here — it is not the same as "unavailable".
  try {
    findings.imageAvailability = await API.availability({ expectedInputs: [{ type: 'image' }] });
    const good = findings.imageAvailability === 'available';
    const possible = findings.imageAvailability === 'downloadable'
                  || findings.imageAvailability === 'downloading';
    row(good ? 'ok' : possible ? 'warn' : 'bad',
        `Image availability: ${findings.imageAvailability}`,
        possible ? 'Image input is supported. The model still needs downloading.' : '');
  } catch (e) {
    findings.imageAvailability = 'error';
    row('warn', 'availability({image}) threw', err(e));
  }

  if (findings.imageAvailability === 'unavailable') {
    return verdict();
  }

  // Chrome requires a click before it will fetch the model.
  goBtn.hidden = false;
  goBtn.textContent = findings.imageAvailability === 'available'
    ? 'Run the image test'
    : 'Download the model and run the image test';
  if (findings.imageAvailability !== 'available') {
    noteEl.hidden = false;
    noteEl.textContent = 'Chrome may need to fetch the model. If the component is already on '
                       + 'this machine it is near-instant; on a clean profile it is several GB. '
                       + 'Either way keep this page open — run it in a tab, not the popup, '
                       + 'which closes when it loses focus.';
  }
  verdictEl.textContent = 'Waiting for a click. Chrome will not start the download without one.';
  goBtn.addEventListener('click', run, { once: true });
}

// ---- the real test: needs the gesture ---------------------------------------

async function run() {
  goBtn.disabled = true;
  let session;

  let downloaded = false;
  try {
    verdictEl.textContent = 'creating session…';
    const t0 = performance.now();
    session = await API.create({
      expectedInputs: [{ type: 'image' }],
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          downloaded = true;
          verdictEl.textContent = `downloading model… ${Math.round(e.loaded * 100)}%`;
        });
      },
    });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    findings.setupSeconds = Number(secs);
    findings.downloaded = downloaded;
    row('ok', downloaded
          ? `Model downloaded and session created in ${secs}s`
          : `Session created in ${secs}s — model already present, nothing downloaded`);
    findings.sessionCreated = true;
  } catch (e) {
    row('bad', 'create({image}) failed', err(e));
    findings.sessionCreated = false;
    findings.createError = err(e);
    return verdict();
  }

  try {
    const blob = await testImage();
    verdictEl.textContent = 'prompting with image…';
    const started = performance.now();
    const answer = await session.prompt([{
      role: 'user',
      content: [
        { type: 'text', value: 'Describe this image in one short sentence.' },
        { type: 'image', value: blob },
      ],
    }]);
    findings.latencyMs = Math.round(performance.now() - started);
    findings.answer = answer.trim();
    row('ok', `Image prompt returned in ${findings.latencyMs}ms`, findings.answer);

    const saw = /red|circle|blue|square|round|rojo|círculo|azul/i.test(answer);
    findings.sawImage = saw;
    row(saw ? 'ok' : 'warn',
        saw ? 'Description matches the drawn image' : 'Description does not mention what was drawn',
        saw ? '' : 'Expected a red circle or blue square. Possible hallucination.');

    const img = document.createElement('img');
    img.id = 'shot';
    img.alt = 'The test image: a red circle with a blue square in the top-left corner';
    img.src = URL.createObjectURL(blob);
    out.appendChild(img);
  } catch (e) {
    row('bad', 'Image prompt failed', err(e));
    findings.answer = null;
  } finally {
    session.destroy?.();
  }

  verdict();
}

// ---- verdict ----------------------------------------------------------------

function verdict() {
  const set = (text, color) => {
    verdictEl.textContent = text;
    verdictEl.style.borderColor = color;
  };

  if (!findings.api) {
    set('T3 DOES NOT EXIST HERE.\nNo built-in Prompt API at all. T1 and T2 carry the free path.', '#e48d74');
  } else if (findings.imageAvailability === 'unavailable') {
    set('T3 IS TEXT-ONLY HERE.\nNo image input, so it cannot describe pictures. Useless for this project.', '#e48d74');
  } else if (findings.sessionCreated === false) {
    set(`T3 UNPROVEN.\nThe model exists but the session failed:\n${findings.createError}`, '#e48d74');
  } else if (findings.answer && findings.sawImage) {
    set(`T3 EXISTS.\nImage described in ${findings.latencyMs}ms. The tier ladder stands as specced.`, '#5fc2a8');
  } else if (findings.answer) {
    set('T3 IS DOUBTFUL.\nIt answered without mentioning what was drawn. Re-run before trusting it.', '#e0c063');
  }
  console.log('[AriaWeave probe]', findings);
}

inspect().catch((e) => {
  row('bad', 'Probe crashed', err(e));
  verdict();
});
