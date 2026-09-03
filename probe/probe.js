// Hour-zero probe. Answers one question: can this machine describe an image
// with Chrome's built-in model, for free, with no key?
//
// Every step reports what actually happened, including the exact error. The
// point is discovery — nothing here assumes an API shape.

const out = document.getElementById('out');
const verdictEl = document.getElementById('verdict');
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

async function main() {
  // 1 — environment
  const chromeVersion = (navigator.userAgent.match(/Chrome\/(\d+\.[\d.]+)/) || [])[1] || 'unknown';
  row('info', `Chrome ${chromeVersion}`, navigator.platform);
  findings.chromeVersion = chromeVersion;

  // 2 — is there an API at all
  const [apiName, API] = findApi();
  if (!API) {
    row('bad', 'No Prompt API in this context',
        'Tried: LanguageModel, chrome.aiOriginTrial.languageModel, ai.languageModel');
    findings.api = null;
    return verdict();
  }
  row('ok', `Prompt API found`, apiName);
  findings.api = apiName;

  // 3 — text availability
  try {
    findings.textAvailability = await API.availability();
    row(findings.textAvailability === 'available' ? 'ok' : 'warn',
        `Text availability: ${findings.textAvailability}`,
        findings.textAvailability === 'downloadable'
          ? 'Model not downloaded yet. Creating a session below will start the download.'
          : '');
  } catch (e) {
    findings.textAvailability = 'error';
    row('bad', 'availability() threw', err(e));
  }

  // 4 — image availability. This is the question that actually matters.
  try {
    findings.imageAvailability = await API.availability({ expectedInputs: [{ type: 'image' }] });
    row(findings.imageAvailability === 'available' ? 'ok' : 'warn',
        `Image availability: ${findings.imageAvailability}`);
  } catch (e) {
    findings.imageAvailability = 'error';
    row('warn', 'availability({image}) threw', err(e) + '\nFalling through to a real create() attempt.');
  }

  // 5 — create a session that expects an image
  let session;
  try {
    session = await API.create({
      expectedInputs: [{ type: 'image' }],
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          verdictEl.textContent = `downloading model… ${Math.round(e.loaded * 100)}%`;
        });
      },
    });
    row('ok', 'Session created with image input expected');
    findings.sessionCreated = true;
  } catch (e) {
    row('bad', 'create({image}) failed', err(e));
    findings.sessionCreated = false;
    return verdict();
  }

  // 6 — the real test: prompt with an actual image
  try {
    const blob = await testImage();
    document.getElementById('verdict').textContent = 'prompting with image…';
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

    // Did it actually look at the picture?
    const saw = /red|circle|blue|square|round/i.test(answer);
    findings.sawImage = saw;
    row(saw ? 'ok' : 'warn',
        saw ? 'Description matches the drawn image' : 'Description does not mention what was drawn',
        saw ? '' : 'Expected some mention of a red circle or blue square. Possible hallucination.');

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

function verdict() {
  const works = findings.sessionCreated && findings.answer && findings.sawImage;
  const partial = findings.sessionCreated && findings.answer && !findings.sawImage;

  if (works) {
    verdictEl.textContent =
      `T3 EXISTS.\nThe tier ladder stands as specced. Lane D can write fixtures for four tiers.`;
    verdictEl.style.borderColor = '#5fc2a8';
  } else if (partial) {
    verdictEl.textContent =
      `T3 IS DOUBTFUL.\nThe API answered but may not have seen the image. Re-run before trusting it.`;
    verdictEl.style.borderColor = '#e0c063';
  } else {
    verdictEl.textContent =
      `T3 DOES NOT EXIST HERE.\nT1 and T2 must carry the entire free path alone. Do not add a second\n`
      + `cloud model — that breaks the zero-config promise instead of saving it.`;
    verdictEl.style.borderColor = '#e48d74';
  }
  console.log('[AriaWeave probe]', findings);
}

main().catch((e) => {
  row('bad', 'Probe crashed', err(e));
  verdict();
});
