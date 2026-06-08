#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

command -v python3 >/dev/null 2>&1 || {
  echo "python3 is required but was not found." >&2
  exit 1
}

command -v node >/dev/null 2>&1 || {
  echo "Node.js is required but was not found." >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || {
  echo "npm is required but was not found." >&2
  exit 1
}

python3 -m venv .venv
"$APP_DIR/.venv/bin/python" -m pip install --upgrade pip
"$APP_DIR/.venv/bin/python" -m pip install -r requirements.txt

npm --prefix frontend install

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Add your OPENAI_API_KEY before chatting."
fi

cat <<'EOF'

AI Assistant is installed.

Start the backend:
  cd ai-assistant
  source .venv/bin/activate
  uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000

Start the frontend in another terminal:
  cd ai-assistant/frontend
  npm run dev

Open http://localhost:3100.
EOF
