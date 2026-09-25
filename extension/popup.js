const defaults = {
  fontSize: false,
  spacing: false,
  reader: false,
  help: false,
  converter: false,
  fontSizeValue: 110,
  spacingValue: 1.75
};

const checks = [...document.querySelectorAll('[data-option]')];
const status = document.querySelector('#status');
const section = document.querySelector('#converter');

function sync(options) {
  checks.forEach((input) => input.checked = !!options[input.dataset.option]);
  section.hidden = !options.converter;
}

chrome.storage.local.get(defaults, (opts) => sync(opts));

checks.forEach((input) => input.addEventListener('change', () => {
  const key = input.dataset.option;
  const value = input.checked;
  chrome.storage.local.set({ [key]: value }, () => {
    sync(Object.fromEntries(checks.map((x) => [x.dataset.option, x.checked])));
    status.textContent = value ? 'Opción activada.' : 'Opción desactivada.';
  });
}));

const file = document.querySelector('#file');
const mode = document.querySelector('#mode');
const acceptByMode = { pdfdocx: '.pdf', docxpdf: '.docx', pptxdocx: '.pptx' };

mode.addEventListener('change', () => {
  file.value = '';
  file.accept = acceptByMode[mode.value];
  status.textContent = '';
});

document.querySelector('#convert').addEventListener('click', async () => {
  if (!file.files[0]) {
    status.textContent = 'Elegí un archivo primero.';
    return;
  }
  const button = document.querySelector('#convert');
  button.disabled = true;
  status.textContent = 'Convirtiendo…';
  try {
    const result = await window.EduAccessConverter.convert(file.files[0], mode.value);
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    status.textContent = 'Documento descargado.';
  } catch (e) {
    status.textContent = e.message + (mode.value === 'pdfdocx' ? ' Si es un PDF escaneado o con fuente rara, usá el convertidor de la página web con OCR.' : '');
  } finally {
    button.disabled = false;
  }
});

const aiFile = document.querySelector('#aiFile');
const aiResult = document.querySelector('#aiResult');

document.querySelector('#analyze').addEventListener('click', async () => {
  if (!aiFile.files[0]) {
    status.textContent = 'Elegí un documento para analizar.';
    return;
  }
  const button = document.querySelector('#analyze');
  button.disabled = true;
  status.textContent = 'Analizando documento…';
  aiResult.hidden = true;
  try {
    const result = await window.EduAccessConverter.analyzeDocument(aiFile.files[0]);
    aiResult.innerHTML = `
      <strong>Resumen</strong>
      <p>${result.summary}</p>
      <strong>Explicación simple</strong>
      <p>${result.explanation}</p>
      <strong>Palabras clave</strong>
      <p>${result.keywords.join(', ') || 'Sin palabras clave'}</p>
      ${Array.isArray(result.questions) && result.questions.length ? `<strong>Preguntas de estudio</strong><ul>${result.questions.map(q => `<li>${q}</li>`).join('')}</ul>` : ''}
    `;
    aiResult.hidden = false;
    status.textContent = 'Análisis generado.';
  } catch (e) {
    status.textContent = e.message;
  } finally {
    button.disabled = false;
  }
});
