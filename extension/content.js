(() => {
  const defaults = {
    fontSize: false,
    spacing: false,
    reader: false,
    help: false,
    converter: false,
    fontSizeValue: 110,
    spacingValue: 1.75
  };

  let options = { ...defaults };
  let reader = null;
  let panelFrame = null;
  let previousOverflow = '';
  let panelSearchQuery = '';
  let cachedPanelItems = { titles: [], links: [], results: [] };
  let dragState = null;
  let mutationTimer = null;

  const excluded = [
    'nav', 'aside', 'footer', 'form', 'table', 'figure', 'script', 'style', 'noscript',
    '[role="navigation"]', '[role="complementary"]', '#toc', '.toc', '.infobox', '.navbox',
    '.metadata', '.mw-editsection', '.mw-references-wrap', '.reflist', '.reference', '.thumb',
    '.sidebar', '.vertical-navbox', '.ambox', '.printfooter', '#eduaccess-help-frame', '#eduaccess-reader'
  ].join(',');

  const searchExcluded = [
    'script', 'style', 'noscript', 'canvas', 'svg', 'video', 'audio', '#eduaccess-help-frame', '#eduaccess-reader'
  ].join(',');

  const textSelector = [
    'h1','h2','h3','h4','h5','h6','p','li','span','a','button','label','td','th',
    'strong','em','small','blockquote','summary','figcaption','legend','dd','dt',
    'div','section','article','main','[role="heading"]','[role="button"]','[aria-label]'
  ].join(',');

  function save(partial) {
    chrome.storage.local.set(partial);
  }

  function updateAndSave(partial) {
    apply(partial);
    save(partial);
  }

  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeSearch(text) {
    return normalize(text)
      .toLocaleLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'");
  }

  function isEduAccessElement(el) {
    return Boolean(el?.closest?.('#eduaccess-help-frame, #eduaccess-reader'));
  }

  function isInsideReaderContent(el) {
    return Boolean(reader && el?.closest?.('#eduaccess-reader .ea-reader-inner'));
  }

  function canUseEduAccessElementForSearch(el) {
    return isInsideReaderContent(el) || !isEduAccessElement(el);
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function directTextLength(el) {
    if (!el?.childNodes) return 0;
    let count = 0;
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) count += normalize(child.textContent).length;
    }
    return count;
  }

  function hasUsefulText(el) {
    const text = normalize(el?.innerText || el?.textContent || el?.getAttribute?.('aria-label'));
    return text.length >= 2;
  }

  function bestRoot() {
    return document.querySelector([
      '[role="main"]', 'main', 'article',
      '.region-main', '#region-main', '#page-content', '.course-content', '.activity-description',
      '.main-content', '.content', '#mw-content-text .mw-parser-output', '#bodyContent', '#content'
    ].join(',')) || document.body;
  }

  function source() {
    return reader?.querySelector('.ea-reader-inner') || bestRoot();
  }

  function searchSource() {
    return reader?.querySelector('.ea-reader-inner') || document.body;
  }

  function getShadowRoot(el) {
    try { return el.shadowRoot || null; } catch { return null; }
  }

  function collectDeepElements(root, selector = textSelector, out = []) {
    if (!root) return out;

    const base = root instanceof Document ? root.body : root;
    if (!base) return out;

    if (base instanceof Element && base.matches?.(selector)) out.push(base);

    try {
      base.querySelectorAll?.(selector).forEach((el) => out.push(el));
    } catch {}

    try {
      base.querySelectorAll?.('*').forEach((el) => {
        const shadow = getShadowRoot(el);
        if (shadow) collectDeepElements(shadow, selector, out);

        if (el.tagName === 'IFRAME') {
          try {
            const iframeDoc = el.contentDocument;
            if (iframeDoc?.body) collectDeepElements(iframeDoc.body, selector, out);
          } catch {}
        }
      });
    } catch {}

    return out;
  }

  function isRelevant(el) {
    return Boolean(
      el &&
      hasUsefulText(el) &&
      !el.closest?.(excluded) &&
      !isEduAccessElement(el) &&
      isVisible(el)
    );
  }

  function canSearch(el) {
    const insideReader = isInsideReaderContent(el);
    const blockedSelector = insideReader
      ? 'script,style,noscript,canvas,svg,video,audio,#eduaccess-help-frame'
      : searchExcluded;

    return Boolean(
      el &&
      el instanceof Element &&
      hasUsefulText(el) &&
      !el.closest?.(blockedSelector) &&
      canUseEduAccessElementForSearch(el) &&
      isVisible(el)
    );
  }

  function cloneTextNode(node) {
    const item = document.createElement(node.tagName.toLowerCase());
    function appendText(sourceNode, dest) {
      for (const child of sourceNode.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          dest.append(document.createTextNode(child.textContent));
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.matches(excluded)) continue;
          if (child.matches('a[href]')) {
            const a = document.createElement('a');
            a.href = child.href;
            a.textContent = child.textContent;
            dest.append(a);
          } else {
            appendText(child, dest);
          }
        }
      }
    }
    appendText(node, item);
    item.textContent = normalize(item.textContent);
    return item;
  }

  function readableNodes() {
    const target = bestRoot();
    const candidates = collectDeepElements(target, 'h1,h2,h3,h4,p,li,div,section,article,[role="heading"]')
      .filter(isRelevant)
      .filter((n) => !n.parentElement?.closest?.('li'))
      .filter((n) => {
        const text = normalize(n.innerText || n.textContent);
        const tag = n.tagName?.toUpperCase();
        if (/^H[1-4]$/.test(tag) || n.getAttribute?.('role') === 'heading') return text.length > 2;
        if (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') {
          if (directTextLength(n) < 30) return false;
          const childBlocks = [...n.children].filter((child) => normalize(child.innerText || child.textContent).length > 35).length;
          return childBlocks < 3 && text.length > 35;
        }
        return text.length > 35;
      });

    const seenText = new Set();
    const unique = [];
    for (const node of candidates) {
      const text = normalize(node.innerText || node.textContent).slice(0, 240);
      if (!text || seenText.has(text)) continue;
      seenText.add(text);
      unique.push(node);
      if (unique.length >= 900) break;
    }
    return unique;
  }

  function createReader() {
    if (reader) return;
    reader = document.createElement('div');
    reader.id = 'eduaccess-reader';

    const toolbar = document.createElement('div');
    toolbar.className = 'ea-reader-toolbar';
    toolbar.innerHTML = '<strong>✳ Modo lectura simple</strong>';

    const actions = document.createElement('div');
    actions.className = 'ea-reader-actions';
    const smaller = document.createElement('button');
    smaller.textContent = 'A−';
    const bigger = document.createElement('button');
    bigger.textContent = 'A+';
    const close = document.createElement('button');
    close.className = 'ea-close';
    close.textContent = 'Cerrar lectura';
    smaller.addEventListener('click', () => updateAndSave({ fontSize: true, fontSizeValue: Math.max(90, Number(options.fontSizeValue) - 5) }));
    bigger.addEventListener('click', () => updateAndSave({ fontSize: true, fontSizeValue: Math.min(160, Number(options.fontSizeValue) + 5) }));
    close.addEventListener('click', () => updateAndSave({ reader: false }));
    actions.append(smaller, bigger, close);
    toolbar.append(actions);

    const inner = document.createElement('div');
    inner.className = 'ea-reader-inner';
    const nodes = readableNodes();

    if (!nodes.some((n) => n.tagName === 'H1')) {
      const title = document.createElement('h1');
      title.textContent = document.title.replace(/ - Wikipedia.*$/i, '').trim() || 'Lectura simple';
      inner.append(title);
    }

    for (const node of nodes) {
      const copy = cloneTextNode(node);
      if (copy.textContent.trim()) inner.append(copy);
    }

    if (!nodes.length) {
      const p = document.createElement('p');
      const fallback = normalize(bestRoot().innerText || document.body.innerText).slice(0, 4500);
      p.textContent = fallback || 'No se encontró contenido principal para leer en esta página.';
      inner.append(p);
    }

    reader.append(toolbar, inner);
    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.append(reader);
    sendPanelData(panelSearchQuery);
  }

  function closeReader() {
    if (!reader) return;
    clearMark();
    reader.remove();
    reader = null;
    document.documentElement.style.overflow = previousOverflow;
    sendPanelData(panelSearchQuery);
  }

  function restoreInline(el, name, valueKey, priorityKey) {
    const value = el.dataset[valueKey];
    const priority = el.dataset[priorityKey] || '';
    if (value === undefined) return;
    if (value) el.style.setProperty(name, value, priority);
    else el.style.removeProperty(name);
  }

  function rememberInline(el, name, valueKey, priorityKey) {
    if (el.dataset[valueKey] !== undefined) return;
    el.dataset[valueKey] = el.style.getPropertyValue(name) || '';
    el.dataset[priorityKey] = el.style.getPropertyPriority(name) || '';
  }

  function shouldAdjustElement(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (isEduAccessElement(el)) return false;
    if (el.closest?.('script,style,noscript,svg,canvas,iframe,video,audio')) return false;
    if (!isVisible(el)) return false;
    const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label'));
    if (text.length < 2) return false;
    return true;
  }

  function adjustmentElements() {
    const root = document.body;
    const items = collectDeepElements(root, textSelector).filter(shouldAdjustElement);
    return [...new Set(items)].slice(0, 2500);
  }

  function applyPageTextAdjustments() {
    const scale = Math.max(0.85, Math.min(1.8, (Number(options.fontSizeValue) || defaults.fontSizeValue) / 100));
    const spacing = Math.max(1.1, Math.min(2.6, Number(options.spacingValue) || defaults.spacingValue));
    const elements = adjustmentElements();

    for (const el of elements) {
      if (options.fontSize) {
        if (el.dataset.eaFontBase === undefined) {
          const computed = parseFloat(getComputedStyle(el).fontSize) || 16;
          el.dataset.eaFontBase = String(computed);
          rememberInline(el, 'font-size', 'eaFontInline', 'eaFontPriority');
        }
        const base = parseFloat(el.dataset.eaFontBase) || 16;
        el.style.setProperty('font-size', `${Math.max(10, Math.round(base * scale * 100) / 100)}px`, 'important');
      } else if (el.dataset.eaFontBase !== undefined) {
        restoreInline(el, 'font-size', 'eaFontInline', 'eaFontPriority');
        delete el.dataset.eaFontBase;
        delete el.dataset.eaFontInline;
        delete el.dataset.eaFontPriority;
      }

      if (options.spacing) {
        rememberInline(el, 'line-height', 'eaLineInline', 'eaLinePriority');
        rememberInline(el, 'letter-spacing', 'eaLetterInline', 'eaLetterPriority');
        el.style.setProperty('line-height', String(spacing), 'important');
        el.style.setProperty('letter-spacing', '.015em', 'important');
      } else if (el.dataset.eaLineInline !== undefined || el.dataset.eaLetterInline !== undefined) {
        restoreInline(el, 'line-height', 'eaLineInline', 'eaLinePriority');
        restoreInline(el, 'letter-spacing', 'eaLetterInline', 'eaLetterPriority');
        delete el.dataset.eaLineInline;
        delete el.dataset.eaLinePriority;
        delete el.dataset.eaLetterInline;
        delete el.dataset.eaLetterPriority;
      }
    }
  }

  function clearMark() {
    const all = collectDeepElements(document.body, '.ea-mark,[data-ea-marked="true"]');
    for (const el of all) {
      el.classList?.remove('ea-mark');
      if (el.dataset?.eaMarked === 'true') {
        restoreInline(el, 'outline', 'eaOutlineInline', 'eaOutlinePriority');
        restoreInline(el, 'box-shadow', 'eaShadowInline', 'eaShadowPriority');
        restoreInline(el, 'background-color', 'eaBgInline', 'eaBgPriority');
        delete el.dataset.eaMarked;
        delete el.dataset.eaOutlineInline;
        delete el.dataset.eaOutlinePriority;
        delete el.dataset.eaShadowInline;
        delete el.dataset.eaShadowPriority;
        delete el.dataset.eaBgInline;
        delete el.dataset.eaBgPriority;
      }
    }
    sendToPanel({ type: 'EA_MARK_STATUS', text: '' });
  }

  function markInline(el) {
    rememberInline(el, 'outline', 'eaOutlineInline', 'eaOutlinePriority');
    rememberInline(el, 'box-shadow', 'eaShadowInline', 'eaShadowPriority');
    rememberInline(el, 'background-color', 'eaBgInline', 'eaBgPriority');
    el.dataset.eaMarked = 'true';
    el.style.setProperty('outline', '4px solid #37ad60', 'important');
    el.style.setProperty('box-shadow', '0 0 0 5px rgba(124,255,155,.28)', 'important');
    el.style.setProperty('background-color', 'rgba(124,255,155,.12)', 'important');
  }

  function choose(el) {
    if (!el) return;
    clearMark();
    el.classList?.add('ea-mark');
    markInline(el);
    el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    sendToPanel({ type: 'EA_MARK_STATUS', text: 'Elemento marcado en la página.' });
  }

  function smallestSearchElement(el, q) {
    let current = el;
    let changed = true;
    while (changed && current) {
      changed = false;
      for (const child of current.children || []) {
        if (canSearch(child) && normalizeSearch(child.innerText || child.textContent || child.getAttribute('aria-label')).includes(q)) {
          current = child;
          changed = true;
          break;
        }
      }
    }
    return current || el;
  }

  function findInCurrentPage(query) {
    const q = normalizeSearch(query);
    if (!q) return [];

    const root = searchSource();
    const candidates = collectDeepElements(root, textSelector).filter(canSearch);
    const results = [];
    const seenElements = new Set();
    const seenLabels = new Set();

    for (const candidate of candidates) {
      if (results.length >= 80) break;
      const text = normalizeSearch(candidate.innerText || candidate.textContent || candidate.getAttribute('aria-label'));
      if (!text.includes(q)) continue;

      const el = smallestSearchElement(candidate, q);
      if (!el || seenElements.has(el) || !canSearch(el)) continue;

      const label = itemLabel(el);
      const labelKey = normalizeSearch(label).slice(0, 180);
      if (seenLabels.has(labelKey)) continue;

      seenElements.add(el);
      seenLabels.add(labelKey);
      results.push(el);
    }

    if (!results.length) {
      const pageText = normalizeSearch(root.innerText || root.textContent || '');
      if (pageText.includes(q) && root instanceof Element && canSearch(root)) results.push(root);
    }

    return results;
  }

  function itemLabel(el) {
    return normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || el.href || 'Elemento').slice(0, 160);
  }

  function collectPanelData(query = '') {
    const root = source();
    const titles = collectDeepElements(root, 'h1,h2,h3,h4,[role="heading"]')
      .filter((el) => normalize(el.innerText || el.textContent) && canUseEduAccessElementForSearch(el) && isVisible(el))
      .slice(0, 50);
    const links = collectDeepElements(root, 'a[href],button,[role="button"]')
      .filter((el) => {
        const insideReader = isInsideReaderContent(el);
        return normalize(el.innerText || el.textContent || el.getAttribute('aria-label')) &&
          (insideReader || !el.closest?.(excluded)) &&
          canUseEduAccessElementForSearch(el) &&
          isVisible(el);
      })
      .slice(0, 60);
    const cleanQuery = normalize(query);
    const results = cleanQuery.length >= 2 ? findInCurrentPage(cleanQuery) : [];

    cachedPanelItems = { titles, links, results };

    return {
      type: 'EA_PANEL_DATA',
      query: cleanQuery,
      readingMode: Boolean(reader),
      titlesCount: titles.length,
      linksCount: links.length,
      resultsCount: results.length,
      results: results.slice(0, 40).map(itemLabel),
      titles: titles.slice(0, 40).map(itemLabel),
      links: links.slice(0, 40).map(itemLabel)
    };
  }

  function applyVariables() {
    const font = Number(options.fontSizeValue) || defaults.fontSizeValue;
    const spacing = Number(options.spacingValue) || defaults.spacingValue;
    document.documentElement.style.setProperty('--eduaccess-font-size', font + '%');
    document.documentElement.style.setProperty('--eduaccess-reader-font', Math.round(18 * font / 110) + 'px');
    document.documentElement.style.setProperty('--eduaccess-line-height', String(spacing));
    sendPanelState();
  }

  function panelHtml() {
    const fontValue = Number(options.fontSizeValue) || defaults.fontSizeValue;
    const spacingValue = Number(options.spacingValue) || defaults.spacingValue;
    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{--ea-bg:#0d1712;--ea-panel:#131e17;--ea-card:#203c29;--ea-border:#447551;--ea-green:#7cff9b;--ea-green-2:#b9f2ae;--ea-text:#eaf3e9}
  *{box-sizing:border-box;font-family:system-ui,sans-serif}
  html,body{margin:0;width:100%;height:100%;background:transparent;color:var(--ea-text);overflow:hidden}
  .panel{height:100vh;display:flex;flex-direction:column;background:var(--ea-panel);border:1px solid var(--ea-border);border-radius:18px;box-shadow:0 18px 55px #0009;overflow:hidden}
  header{display:flex;justify-content:space-between;align-items:center;background:linear-gradient(135deg,#203c29,#102016);padding:14px 16px;color:var(--ea-green-2);cursor:move;user-select:none;font-weight:800;border-bottom:1px solid #335c3f}
  button{cursor:pointer}
  .x{background:#0e1913;color:#ebf5e9;border:1px solid #61886a;border-radius:9px;padding:5px 10px;font-weight:700}
  .body{padding:15px;overflow:auto;min-height:0;flex:1;scrollbar-width:thin}
  .searchbar{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}
  input[type="search"]{width:100%;border:1px solid #4c7154;background:#101b14;color:#fff;border-radius:10px;padding:11px 12px;outline:none;font-size:14px}
  .searchbar button{border:1px solid #60a875;background:#176a35;color:#fff;border-radius:10px;padding:11px 13px;font-weight:800}
  .searchbar button:hover{background:#22964e}
  h3{color:var(--ea-green-2);font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin:17px 0 8px}
  .note{color:#a9c7ad;font-size:12px;margin:6px 0 0}
  .item{display:block;width:100%;text-align:left;background:#223428;color:#eff8ec;border:1px solid #3b5941;border-radius:11px;padding:9px 11px;margin:7px 0;font-size:13px;line-height:1.4;overflow-wrap:anywhere}
  .item:hover,.item.active{border-color:var(--ea-green);box-shadow:0 0 0 2px rgba(124,255,155,.14)}
  .empty{color:#b7cbbb;font-size:12px}
  .controls{border-top:1px solid #335c3f;background:#101b14;padding:13px 15px 15px;position:sticky;bottom:0;z-index:1}
  .controls-title{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--ea-green-2);font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px}
  .controls-actions{display:flex;gap:6px;align-items:center}
  .range-row{display:grid;grid-template-columns:72px 1fr 46px;gap:10px;align-items:center;color:#dcefe0;font-size:12px;margin:8px 0}
  input[type="range"]{width:100%;accent-color:var(--ea-green)}
  .mini-button{border:1px solid #4c7154;background:#203c29;color:#eaf3e9;border-radius:8px;padding:6px 8px;font-size:12px}
  .mini-button:hover{border-color:var(--ea-green)}
  .mark-status{font-size:12px;color:#a9c7ad;margin:8px 0 0;min-height:18px}
</style>
</head>
<body>
  <div class="panel">
    <header id="drag"><span>✳ EduAccess · Ayuda</span><button class="x" id="close">Cerrar</button></header>
    <div class="body">
      <div class="searchbar">
        <input id="q" type="search" placeholder="Buscar dentro de esta página…" autocomplete="off" spellcheck="false" value="${escapeHtml(panelSearchQuery)}">
        <button id="search" type="button">Buscar</button>
      </div>
      <div id="results"></div>
    </div>
    <div class="controls">
      <div class="controls-title"><span>Ajustes rápidos</span><div class="controls-actions"><button class="mini-button" id="reset">Por defecto</button><button class="mini-button" id="clear">Limpiar marca</button></div></div>
      <label class="range-row"><span>Tamaño</span><input id="font" type="range" min="90" max="160" step="5" value="${fontValue}"><strong id="fontValue">${fontValue}%</strong></label>
      <label class="range-row"><span>Espaciado</span><input id="spacing" type="range" min="1.2" max="2.4" step="0.05" value="${spacingValue}"><strong id="spacingValue">${spacingValue}</strong></label>
      <p class="mark-status" id="status"></p>
    </div>
  </div>
<script>
  const input = document.getElementById('q');
  const results = document.getElementById('results');
  const status = document.getElementById('status');
  const font = document.getElementById('font');
  const spacing = document.getElementById('spacing');
  const fontValue = document.getElementById('fontValue');
  const spacingValue = document.getElementById('spacingValue');
  const defaultFont = ${defaults.fontSizeValue};
  const defaultSpacing = ${defaults.spacingValue};

  function send(message){ parent.postMessage({ source:'EduAccessPanel', ...message }, '*'); }
  function runSearch(){ send({ type:'search', query: input.value }); }
  function esc(text){ return String(text || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); runSearch(); }
  });
  input.addEventListener('keyup', (event) => event.stopPropagation());
  input.addEventListener('keypress', (event) => event.stopPropagation());
  input.addEventListener('input', (event) => { event.stopPropagation(); send({ type:'queryUpdate', query: input.value }); });
  document.getElementById('search').addEventListener('click', runSearch);
  document.getElementById('close').addEventListener('click', () => send({ type:'close' }));
  document.getElementById('clear').addEventListener('click', () => send({ type:'clear' }));
  document.getElementById('reset').addEventListener('click', () => {
    font.value = defaultFont;
    spacing.value = defaultSpacing;
    fontValue.textContent = defaultFont + '%';
    spacingValue.textContent = defaultSpacing;
    send({ type:'resetAdjustments' });
  });

  font.addEventListener('input', () => { fontValue.textContent = font.value + '%'; send({ type:'font', value:Number(font.value) }); });
  spacing.addEventListener('input', () => { spacingValue.textContent = spacing.value; send({ type:'spacing', value:Number(spacing.value) }); });

  function section(title, group, items){
    let html = '<h3>' + esc(title) + '</h3>';
    if (!items.length) return html + '<p class="empty">Sin resultados</p>';
    return html + items.map((text, index) => '<button class="item" data-group="' + group + '" data-index="' + index + '">' + esc(text) + '</button>').join('');
  }

  function render(data){
    const q = data.query || '';
    let html = '';
    html += '<p class="note">' + (data.readingMode ? 'Buscando dentro del modo lectura simple.' : 'Buscando dentro de la página actual.') + '</p>';
    html += '<p class="note">Títulos: ' + data.titlesCount + ' · Acciones: ' + data.linksCount + '</p>';
    if (q.length === 1) html += '<p class="note">Escribí al menos 2 letras y tocá Buscar.</p>';
    if (q.length >= 2) {
      html += '<p class="note">Resultados para "' + esc(q) + '": ' + data.resultsCount + '</p>';
      html += section('Resultados de búsqueda', 'results', data.results || []);
    }
    html += section('Títulos detectados', 'titles', data.titles || []);
    html += section('Enlaces y acciones', 'links', data.links || []);
    results.innerHTML = html;
  }

  results.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-group]');
    if (!button) return;
    send({ type:'choose', group: button.dataset.group, index: Number(button.dataset.index) });
  });

  let drag = null;
  const header = document.getElementById('drag');
  header.addEventListener('pointerdown', (event) => {
    if (event.target.id === 'close') return;
    drag = { x:event.clientX, y:event.clientY };
    header.setPointerCapture(event.pointerId);
    send({ type:'dragStart', x:event.clientX, y:event.clientY });
  });
  header.addEventListener('pointermove', (event) => {
    if (!drag) return;
    send({ type:'dragMove', x:event.clientX, y:event.clientY });
  });
  header.addEventListener('pointerup', () => { drag = null; send({ type:'dragEnd' }); });
  header.addEventListener('pointercancel', () => { drag = null; send({ type:'dragEnd' }); });

  window.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'EA_PANEL_DATA') render(data);
    if (data.type === 'EA_MARK_STATUS') status.textContent = data.text || '';
    if (data.type === 'EA_PANEL_STATE') {
      if (typeof data.fontSizeValue === 'number') { font.value = data.fontSizeValue; fontValue.textContent = data.fontSizeValue + '%'; }
      if (typeof data.spacingValue === 'number') { spacing.value = data.spacingValue; spacingValue.textContent = data.spacingValue; }
    }
  });

  send({ type:'ready' });
  input.focus();
<\/script>
</body>
</html>`;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function sendToPanel(message) {
    if (panelFrame?.contentWindow) panelFrame.contentWindow.postMessage(message, '*');
  }

  function sendPanelData(query = panelSearchQuery) {
    if (!panelFrame?.contentWindow) return;
    sendToPanel(collectPanelData(query));
  }

  function sendPanelState() {
    sendToPanel({
      type: 'EA_PANEL_STATE',
      fontSizeValue: Number(options.fontSizeValue) || defaults.fontSizeValue,
      spacingValue: Number(options.spacingValue) || defaults.spacingValue
    });
  }

  function openPanel() {
    if (panelFrame) return;
    panelFrame = document.createElement('iframe');
    panelFrame.id = 'eduaccess-help-frame';
    panelFrame.setAttribute('title', 'Panel de ayuda EduAccess');
    panelFrame.setAttribute('sandbox', 'allow-scripts');
    panelFrame.srcdoc = panelHtml();
    Object.assign(panelFrame.style, {
      position: 'fixed',
      top: '76px',
      right: '24px',
      width: 'min(420px, calc(100vw - 28px))',
      height: 'min(80vh, 720px)',
      border: '0',
      background: 'transparent',
      zIndex: '2147483647',
      colorScheme: 'normal'
    });
    document.body.append(panelFrame);
  }

  function closePanel() {
    if (!panelFrame) return;
    const oldPanel = panelFrame;
    panelFrame = null;
    oldPanel.remove();
    clearMark();
  }

  function handlePanelMessage(event) {
    if (!panelFrame || event.source !== panelFrame.contentWindow) return;
    const message = event.data || {};
    if (message.source !== 'EduAccessPanel') return;

    if (message.type === 'ready') {
      sendPanelState();
      sendPanelData(panelSearchQuery);
      return;
    }

    if (message.type === 'queryUpdate') {
      panelSearchQuery = String(message.query || '');
      return;
    }

    if (message.type === 'search') {
      panelSearchQuery = String(message.query || '');
      sendPanelData(panelSearchQuery);
      return;
    }

    if (message.type === 'choose') {
      const group = String(message.group || '');
      const index = Number(message.index);
      const list = cachedPanelItems[group] || [];
      choose(list[index]);
      return;
    }

    if (message.type === 'clear') {
      clearMark();
      return;
    }

    if (message.type === 'resetAdjustments') {
      updateAndSave({ fontSize: true, spacing: true, fontSizeValue: defaults.fontSizeValue, spacingValue: defaults.spacingValue });
      sendToPanel({ type: 'EA_MARK_STATUS', text: 'Ajustes restablecidos.' });
      return;
    }

    if (message.type === 'close') {
      updateAndSave({ help: false });
      return;
    }

    if (message.type === 'font') {
      const value = Math.max(90, Math.min(160, Number(message.value) || defaults.fontSizeValue));
      updateAndSave({ fontSize: true, fontSizeValue: value });
      return;
    }

    if (message.type === 'spacing') {
      const value = Math.max(1.2, Math.min(2.4, Number(message.value) || defaults.spacingValue));
      updateAndSave({ spacing: true, spacingValue: value });
      return;
    }

    if (message.type === 'dragStart') {
      const rect = panelFrame.getBoundingClientRect();
      dragState = { x: Number(message.x) || 0, y: Number(message.y) || 0, left: rect.left, top: rect.top };
      return;
    }

    if (message.type === 'dragMove' && dragState) {
      const nextLeft = dragState.left + ((Number(message.x) || 0) - dragState.x);
      const nextTop = dragState.top + ((Number(message.y) || 0) - dragState.y);
      panelFrame.style.left = Math.max(0, Math.min(window.innerWidth - panelFrame.offsetWidth, nextLeft)) + 'px';
      panelFrame.style.top = Math.max(0, Math.min(window.innerHeight - 42, nextTop)) + 'px';
      panelFrame.style.right = 'auto';
      return;
    }

    if (message.type === 'dragEnd') {
      dragState = null;
    }
  }

  function scheduleReapply() {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      if (options.fontSize || options.spacing) applyPageTextAdjustments();
      if (options.help) sendPanelData(panelSearchQuery);
    }, 350);
  }

  function apply(next) {
    options = { ...options, ...next };
    applyVariables();
    document.documentElement.classList.toggle('eduaccess-font', options.fontSize);
    document.documentElement.classList.toggle('eduaccess-spacing', options.spacing);
    applyPageTextAdjustments();
    if (options.reader) createReader(); else closeReader();
    if (options.help) openPanel(); else closePanel();
  }

  window.addEventListener('message', handlePanelMessage);

  const observer = new MutationObserver((mutations) => {
    if (!options.fontSize && !options.spacing && !options.help) return;
    if (mutations.some((m) => [...m.addedNodes].some((n) => n.nodeType === Node.ELEMENT_NODE && n.id !== 'eduaccess-help-frame'))) {
      scheduleReapply();
    }
  });

  chrome.storage.local.get(defaults, (stored) => {
    apply(stored);
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const next = {};
    for (const [key, value] of Object.entries(changes)) {
      if (key in defaults) next[key] = value.newValue;
    }
    apply(next);
  });
})();
