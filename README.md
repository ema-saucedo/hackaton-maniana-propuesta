# EduAccess v6 + Google AI Studio

EduAccess es una página web y una extensión de navegador para apoyar la accesibilidad educativa.

Esta versión mantiene la línea v6 y agrega IA real al Asistente de documentos mediante Google AI Studio, sin exponer la API key en el frontend.

## Contenido

```txt
web/        Página React + Vite
extension/  Extensión Chrome/Edge
netlify.toml Configuración de Netlify
```

## IA en el asistente de documentos

El asistente puede analizar PDF, DOCX o PPTX. Primero extrae el texto del documento y después lo envía a una Netlify Function segura. La Function llama a Google AI Studio con la variable `GEMINI_API_KEY`.

El resultado incluye:

- resumen descriptivo;
- explicación simple;
- palabras clave;
- preguntas de estudio.

## Configuración en Netlify

```txt
Base directory: web
Build command: npm run build
Publish directory: dist
```

Variable obligatoria:

```txt
GEMINI_API_KEY=tu_api_key_de_google_ai_studio
```

Variable opcional:

```txt
GEMINI_MODEL=gemini-2.0-flash
```

## Extensión

La extensión se descarga desde la página y se instala manualmente desde:

```txt
chrome://extensions
Modo desarrollador
Cargar descomprimida
```
