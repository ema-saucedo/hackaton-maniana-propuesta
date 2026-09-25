import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './converter.js';

const features = [
  ['Tamaño de letra', 'Ampliá el texto para leer con mayor comodidad.'],
  ['Espaciado', 'Dale más aire a las líneas y los párrafos.'],
  ['Lectura simple', 'Leé contenido principal sin distracciones.'],
  ['Panel de ayuda', 'Encontrá títulos, enlaces y resultados, con ajustes en tiempo real.'],
  ['Convertidor local', 'Transformá documentos educativos a formatos más utilizables.'],
  ['Asistente de documentos', 'Resumen y explicación simple como prueba inicial de IA.']
];

const modes = [
  ['pdfdocx', 'PDF a Word', '.pdf'],
  ['docxpdf', 'Word a PDF', '.docx'],
  ['pptxdocx', 'PowerPoint a Word', '.pptx']
];

function App() {
  const [prefs, setPrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem('eduaccess-profile')) || {}; } catch { return {}; }
  });
  const [saved, setSaved] = useState(false);
  const [profileNotice, setProfileNotice] = useState('Guardado en este dispositivo.');
  const [mode, setMode] = useState('pdfdocx');
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [useOcr, setUseOcr] = useState(false);
  const [aiFile, setAiFile] = useState(null);
  const [aiStatus, setAiStatus] = useState('');
  const [aiResult, setAiResult] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [useAiOcr, setUseAiOcr] = useState(false);
  const [useGemini, setUseGemini] = useState(true);

  useEffect(() => {
    document.querySelector('.ea-site')?.classList.toggle('ea-profile-large', !!prefs.fontSize);
    document.querySelector('.ea-site')?.classList.toggle('ea-profile-spaced', !!prefs.spacing);
  }, [prefs.fontSize, prefs.spacing]);


  useEffect(() => {
    function handleExtensionMessage(event) {
      const message = event.data || {};
      if (message.source === 'EduAccessExtension' && message.type === 'EA_PROFILE_APPLIED') {
        setProfileNotice('Perfil aplicado también en la extensión.');
      }
    }
    window.addEventListener('message', handleExtensionMessage);
    window.postMessage({ source: 'EduAccessWeb', type: 'EA_GET_EXTENSION_STATUS' }, '*');
    return () => window.removeEventListener('message', handleExtensionMessage);
  }, []);

  function saveProfile() {
    const profile = {
      fontSize: Boolean(prefs.fontSize),
      spacing: Boolean(prefs.spacing),
      reader: Boolean(prefs.reader),
      help: Boolean(prefs.help),
      fontSizeValue: prefs.fontSize ? 125 : 110,
      spacingValue: prefs.spacing ? 1.9 : 1.75
    };

    localStorage.setItem('eduaccess-profile', JSON.stringify(profile));
    setPrefs(profile);
    setSaved(true);
    setProfileNotice('Perfil guardado en esta página. Si la extensión está instalada, también se aplicará.');
    window.postMessage({ source: 'EduAccessWeb', type: 'EA_APPLY_PROFILE', profile }, '*');
  }

  async function convert(e) {
    e.preventDefault();
    if (!file) { setStatus('Seleccioná un documento primero.'); return; }
    setBusy(true);
    setStatus('Convirtiendo…');
    try {
      const result = await window.EduAccessConverter.convert(file, mode, { ocr: useOcr, onProgress: setStatus });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(result.blob);
      a.download = result.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 15000);
      setStatus('Documento descargado.');
    } catch (e) {
      setStatus(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function analyze(e) {
    e.preventDefault();
    if (!aiFile) { setAiStatus('Seleccioná un documento para analizar.'); return; }
    setAiBusy(true);
    setAiStatus('Extrayendo texto del documento…');
    setAiResult(null);
    try {
      const localResult = await window.EduAccessConverter.analyzeDocument(aiFile, { ocr: useAiOcr, onProgress: setAiStatus });

      if (!useGemini) {
        setAiResult({ ...localResult, source: 'local' });
        setAiStatus('Resumen local generado.');
        return;
      }

      setAiStatus('Texto extraído. Generando resumen con Google AI Studio…');
      const response = await fetch('/api/gemini-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: aiFile.name,
          text: localResult.text
        })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'No se pudo conectar con la IA.');
      }

      setAiResult({ ...localResult, ...data, source: 'gemini' });
      setAiStatus('Resumen generado con IA.');
    } catch (error) {
      try {
        const fallback = await window.EduAccessConverter.analyzeDocument(aiFile, { ocr: useAiOcr, onProgress: setAiStatus });
        setAiResult({ ...fallback, source: 'local' });
        setAiStatus('IA no disponible: se generó un resumen local. ' + error.message);
      } catch (fallbackError) {
        setAiStatus(fallbackError.message || error.message);
      }
    } finally {
      setAiBusy(false);
    }
  }

  return <div className="ea-site">
    <header className="ea-nav">
      <a href="#inicio" className="ea-logo"><img src="/favicon.svg" alt="" /> EduAccess<span className="ea-logo-dot">.</span></a>
      <nav>
        <a href="#problema">Proyecto</a>
        <a href="#funciones">Funciones</a>
        <a href="#perfil">Mi perfil</a>
        <a href="#convertidor">Convertidor</a>
        <a href="#asistente">Asistente</a>
        <a href="#manual">Manual</a>
      </nav>
      <a className="ea-nav-cta" href="/eduaccess-extension-v6.zip" download>Descargar extensión ↗</a>
    </header>

    <main>
      <section className="ea-hero" id="inicio">
        <div className="ea-hero-copy">
          <span className="ea-eyebrow">✳ EDUCACIÓN MÁS ACCESIBLE, PARA TODOS</span>
          <h1>Aprender no debería tener <em>barreras.</em></h1>
          <p>EduAccess acompaña tu manera de leer, explorar, convertir y aprovechar contenidos educativos en la web.</p>
          <div className="ea-hero-actions">
            <a className="ea-button" href="/eduaccess-extension-v6.zip" download>Descargar extensión</a>
            <a className="ea-text-link" href="#funciones">Explorar funciones ↗</a>
          </div>
          <div className="ea-hero-foot"><span>01 / UNA WEB</span><span>02 / UNA EXTENSIÓN</span><span>03 / TU RITMO</span></div>
        </div>
        <div className="ea-hero-visual">
          <div className="ea-preview-top"><i/><i/><i/><span>recurso educativo</span></div>
          <div className="ea-preview-content">
            <div className="ea-preview-pill">✳ PANEL DE AYUDA</div>
            <div className="ea-preview-title">El conocimiento<br/>a tu manera<span>.</span></div>
            <div className="ea-preview-line wide"/><div className="ea-preview-line"/><div className="ea-preview-line short"/>
            <div className="ea-preview-card">✳ <div><strong>Ajustes en tiempo real</strong><small>Tamaño y espaciado desde el panel.</small></div><span>ACTIVO</span></div>
          </div>
        </div>
      </section>

      <section className="ea-intro" id="problema">
        <div><span className="ea-kicker">POR QUÉ EXISTIMOS</span><h2>La educación digital no siempre <em>incluye a todos.</em></h2></div>
        <div className="ea-intro-copy">
          <p>Las personas aprenden, leen e interactúan de formas distintas. Muchos recursos educativos digitales aún ofrecen una sola manera de acceder al contenido.</p>
          <p><strong>EduAccess crea una capa de accesibilidad</strong> para leer mejor, encontrar lo importante, transformar documentos y preparar una futura asistencia con IA.</p>
        </div>
      </section>

      <section className="ea-section" id="funciones">
        <div className="ea-section-head"><div><span className="ea-kicker">HERRAMIENTAS</span><h2>Pequeños cambios.<br/><em>Más posibilidades.</em></h2></div><p>Elegí las herramientas que necesitás, sin complicar tu experiencia.</p></div>
        <div className="ea-feature-grid">{features.map(([title, description], i) => <article className="ea-feature" key={title}><span className="ea-feature-number">0{i+1}</span><div className="ea-feature-icon">✳</div><h3>{title}</h3><p>{description}</p></article>)}</div>
      </section>

      <section className="ea-section ea-profile-wrap" id="perfil">
        <div className="ea-section-head"><div><span className="ea-kicker">TU EXPERIENCIA</span><h2>Un espacio hecho<br/><em>para vos.</em></h2></div><p>Tus elecciones se guardan solo en este navegador.</p></div>
        <div className="ea-profile-card">
          <div className="ea-profile-heading"><div className="ea-profile-icon">✳</div><div><h3>Mi perfil de accesibilidad</h3><p>Elegí cómo te gusta interactuar.</p></div></div>
          <div className="ea-settings">{[['fontSize','Texto más grande'],['spacing','Más espacio'],['reader','Prefiero lectura simple'],['help','Quiero ayuda al navegar']].map(([key,label]) => <label className="ea-setting" key={key}><span><strong>{label}</strong></span><input aria-label={label} type="checkbox" checked={!!prefs[key]} onChange={() => { setPrefs({...prefs,[key]:!prefs[key]}); setSaved(false); }} /><span className="ea-toggle"/></label>)}</div>
          <div className="ea-profile-bottom"><span>{saved ? profileNotice : 'Guardado en este dispositivo.'}</span><button className="ea-button ea-button-small" onClick={saveProfile}>Guardar y aplicar perfil</button></div>
        </div>
      </section>

      <section className="ea-section" id="convertidor">
        <div className="ea-section-head"><div><span className="ea-kicker">CONVERTIDOR</span><h2>Tu contenido,<br/><em>en otro formato.</em></h2></div><p>Una prueba local. Tus archivos no salen de tu dispositivo.</p></div>
        <form className="ea-convert-card" onSubmit={convert}>
          <div className="ea-convert-top"><div className="ea-feature-icon">⇄</div><div><h3>Convertir documento</h3><p>Elegí un formato y un archivo.</p></div></div>
          <div className="ea-convert-fields"><label>Tipo de conversión<select value={mode} onChange={e => { setMode(e.target.value); setFile(null); setStatus(''); setUseOcr(false); }}>{modes.map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>Tu documento<input type="file" key={mode} accept={modes.find(x => x[0] === mode)[2]} onChange={e => setFile(e.target.files[0])}/></label></div>{mode === 'pdfdocx' && <label className="ea-ocr-option"><input type="checkbox" checked={useOcr} onChange={e => setUseOcr(e.target.checked)} /> Usar OCR si el PDF no tiene texto seleccionable</label>}
          <div className="ea-convert-bottom"><div>Solo texto · Hasta 15 MB · Sin subir archivos</div><button className="ea-button ea-button-small" disabled={busy}>Convertir y descargar</button></div>
          <p className="ea-form-status" role="status">{status}</p><p className="ea-fineprint">No conserva diseños complejos. PDF.js lee texto seleccionable; OCR intenta leer PDFs escaneados, pero puede tardar.</p>
        </form>
      </section>

      <section className="ea-section" id="asistente">
        <div className="ea-section-head"><div><span className="ea-kicker">ASISTENTE IA</span><h2>Resumir y explicar<br/><em>documentos.</em></h2></div><p>Usa Google AI Studio mediante una función segura de Netlify. Si no hay API key, queda el resumen local como respaldo.</p></div>
        <form className="ea-convert-card" onSubmit={analyze}>
          <div className="ea-convert-top"><div className="ea-feature-icon">IA</div><div><h3>Asistente de documentos</h3><p>Subí PDF, Word o PowerPoint para obtener un resumen, explicación, palabras clave y preguntas.</p></div></div>
          <div className="ea-convert-fields"><label>Documento<input type="file" accept=".pdf,.docx,.pptx" onChange={e => { setAiFile(e.target.files[0]); setAiResult(null); setAiStatus(''); setUseAiOcr(false); }}/></label></div>
          <label className="ea-ocr-option"><input type="checkbox" checked={useGemini} onChange={e => setUseGemini(e.target.checked)} /> Usar IA de Google AI Studio para generar el resumen</label>
          {aiFile?.name?.toLowerCase().endsWith('.pdf') && <label className="ea-ocr-option"><input type="checkbox" checked={useAiOcr} onChange={e => setUseAiOcr(e.target.checked)} /> Usar OCR si el PDF no tiene texto seleccionable</label>}
          <div className="ea-convert-bottom"><div>{useGemini ? 'IA vía Netlify Function · API key protegida' : 'Resumen local sin IA'}</div><button className="ea-button ea-button-small" disabled={aiBusy}>Resumir y explicar</button></div>
          <p className="ea-form-status" role="status">{aiStatus}</p>
          {aiResult && <div className="ea-ai-result">
            <h3>Resumen {aiResult.source === 'gemini' ? 'con IA' : 'local'}</h3>
            <p>{aiResult.summary}</p>
            <h3>Explicación simple</h3>
            <p>{aiResult.explanation}</p>
            <h3>Palabras clave</h3>
            <p>{Array.isArray(aiResult.keywords) ? aiResult.keywords.join(', ') : aiResult.keywords}</p>
            {Array.isArray(aiResult.questions) && aiResult.questions.length > 0 && <><h3>Preguntas de estudio</h3><ul>{aiResult.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></>}
          </div>}
        </form>
      </section>

      <section className="ea-section ea-install" id="instalacion">
        <div className="ea-section-head"><div><span className="ea-kicker">EMPEZÁ HOY</span><h2>Tu nueva forma<br/><em>de navegar.</em></h2></div><p>La extensión funciona localmente en Chrome y Edge.</p></div>
        <div className="ea-steps"><div><span>01</span><h3>Descomprimí</h3><p>Descargá el ZIP de la extensión desde esta página y descomprimilo.</p></div><div><span>02</span><h3>Activá</h3><p>Abrí <code>chrome://extensions</code> o <code>edge://extensions</code> y activá Modo desarrollador.</p></div><div><span>03</span><h3>Usala</h3><p>Elegí “Cargar descomprimida” y seleccioná la carpeta descomprimida de la extensión.</p></div></div>
        <div className="ea-install-action"><a className="ea-button ea-button-small" href="/eduaccess-extension-v6.zip" download>Descargar ZIP de la extensión</a><span>Después descomprimilo antes de cargarlo en Chrome o Edge.</span></div>
      </section>

      <section className="ea-section ea-manual" id="manual">
        <div className="ea-section-head"><div><span className="ea-kicker">GUÍA RÁPIDA</span><h2>Simple desde<br/><em>el primer clic.</em></h2></div></div>
        <div className="ea-manual-grid">{[['01 / CONFIGURÁ','Elegí tus herramientas','Activá letra, espaciado, modo lectura y panel desde el icono.'],['02 / AJUSTÁ','Cambiá en tiempo real','Desde el panel podés mover tamaño y espaciado sin cerrar la página.'],['03 / ENCONTRÁ','Orientate en la página','Abrí el panel, buscá o seleccioná un título. Arrastralo desde el encabezado.'],['04 / TRANSFORMÁ','Convertí o resumí','Usá el convertidor y el asistente de documentos como apoyo educativo.']].map(([step,title,description]) => <article key={step}><span>{step}</span><h3>{title}</h3><p>{description}</p></article>)}</div>
      </section>
    </main>

    <footer className="ea-footer"><a className="ea-logo" href="#inicio"><img src="/favicon.svg" alt=""/> EduAccess.</a><span>Educación más abierta. Un clic a la vez.</span><a href="#inicio">Volver arriba ↑</a></footer>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
