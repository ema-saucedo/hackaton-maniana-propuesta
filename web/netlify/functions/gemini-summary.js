const MAX_TEXT_CHARS = 24000;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(body)
  };
}

function safeParseJson(text) {
  if (!text) return null;
  const clean = String(text)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

function normalizeAiResult(value) {
  const data = value && typeof value === 'object' ? value : {};
  const keywords = Array.isArray(data.keywords)
    ? data.keywords.map(String).slice(0, 10)
    : String(data.keywords || '').split(/,|\n/).map((x) => x.trim()).filter(Boolean).slice(0, 10);
  const questions = Array.isArray(data.questions)
    ? data.questions.map(String).slice(0, 6)
    : String(data.questions || '').split(/\n/).map((x) => x.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean).slice(0, 6);

  return {
    summary: String(data.summary || '').trim(),
    explanation: String(data.explanation || '').trim(),
    keywords,
    questions,
    source: 'gemini'
  };
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Método no permitido.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Falta configurar GEMINI_API_KEY en Netlify.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Solicitud inválida.' });
  }

  const fileName = String(payload.fileName || 'documento');
  const text = String(payload.text || '').trim();
  if (text.length < 40) {
    return json(400, { error: 'No hay texto suficiente para resumir.' });
  }

  const clipped = text.slice(0, MAX_TEXT_CHARS);
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const prompt = `Actuá como asistente educativo de accesibilidad. Tu objetivo es ayudar a un estudiante a entender el documento sin inventar información.

Archivo: ${fileName}

Reglas importantes:
- Respondé en español claro y directo.
- Usá solamente la información que aparece en el texto.
- Si el documento es una consigna, guía práctica, trabajo o ejercicio, resumí QUÉ HAY QUE HACER, qué evidencias se piden y qué comandos/rutas/entregables aparecen.
- No hagas un resumen genérico del tipo "trata sobre captura, sistema, archivos".
- No repitas palabras clave como si fueran explicación.
- Mantené comandos, rutas y nombres importantes exactamente como aparezcan, por ejemplo /etc, /bin, /tmp, whoami.
- Si hay pasos o ejercicios, ordenalos de forma útil.

Devolvé SOLO JSON válido con esta estructura exacta:
{
  "summary": "Un resumen descriptivo de 4 a 7 oraciones completas. Debe explicar el propósito del documento y las tareas o ideas principales.",
  "explanation": "Una explicación simple de 2 a 4 oraciones, pensada para alguien que no entendió la consigna.",
  "keywords": ["6 a 10 palabras o conceptos importantes"],
  "questions": ["4 a 6 preguntas de estudio o control relacionadas con el contenido"]
}

Texto del documento:
${clipped}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1200,
          responseMimeType: 'application/json'
        }
      })
    });
  } catch {
    return json(502, { error: 'No se pudo conectar con Google AI Studio.' });
  }

  const raw = await response.text();
  if (!response.ok) {
    return json(response.status, { error: 'Google AI Studio rechazó la solicitud.', detail: raw.slice(0, 500) });
  }

  let apiData;
  try {
    apiData = JSON.parse(raw);
  } catch {
    return json(502, { error: 'Respuesta inválida de Google AI Studio.' });
  }

  const outputText = apiData?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n').trim();
  const parsed = safeParseJson(outputText);
  if (!parsed) {
    return json(502, { error: 'La IA respondió, pero no devolvió JSON válido.', detail: outputText?.slice(0, 500) || '' });
  }

  const result = normalizeAiResult(parsed);
  if (!result.summary || !result.explanation) {
    return json(502, { error: 'La IA no devolvió un resumen completo.' });
  }

  return json(200, result);
}
