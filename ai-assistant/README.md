# AI Assistant

Standalone full-stack AI chatbot example built with:

- Next.js App Router frontend on `http://localhost:3100`
- FastAPI backend on `http://localhost:8000`
- OpenAI Chat Completions API configured through environment variables

This directory is intentionally isolated from the SmartPerfetto application
entry points. It can run next to the main project without using port 3000.

## Project layout

```text
ai-assistant/
  .env.example
  install.sh
  requirements.txt
  backend/
    main.py
  frontend/
    app/
      globals.css
      layout.tsx
      page.tsx
    package.json
  scripts/
    test-build.sh
```

## Environment

Copy the example file and set your API key:

```bash
cd ai-assistant
cp .env.example .env
```

Required:

- `OPENAI_API_KEY`: API key used by the FastAPI backend.

Optional:

- `OPENAI_MODEL`: defaults to `gpt-4o-mini`.
- `OPENAI_BASE_URL`: use when targeting an OpenAI-compatible endpoint.
- `CORS_ORIGINS`: comma-separated allowed browser origins.
- `NEXT_PUBLIC_API_BASE_URL`: frontend API URL. Defaults to
  `http://localhost:8000` in the Next.js app.

## Install

```bash
cd ai-assistant
./install.sh
```

The installer creates `.venv`, installs Python dependencies from
`requirements.txt`, installs the Next.js app dependencies, and creates `.env`
from `.env.example` if needed.

## Run

Start the backend:

```bash
cd ai-assistant
source .venv/bin/activate
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

Start the frontend in another terminal:

```bash
cd ai-assistant/frontend
npm run dev
```

Open `http://localhost:3100`.

## Verification

Run the standalone build smoke:

```bash
cd ai-assistant
./scripts/test-build.sh
```

The check compiles the FastAPI backend with Python `compileall`, installs the
frontend dependencies using `npm ci` when a lockfile exists, and runs
`next build`.
