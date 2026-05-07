# ============================
# Stage 1: Build backend
# ============================
FROM node:26-bookworm AS backend-builder

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY scripts/trace-processor-pin.env /app/scripts/trace-processor-pin.env
COPY backend/ ./
COPY backend/data/perfettoSqlIndex.light.json backend/data/perfettoSqlIndex.json backend/data/perfettoStdlibSymbols.json ./data/
RUN npm run build

# Remove devDependencies to drastically reduce the final image size
RUN npm prune --production

# ============================
# Stage 2: Build Rust flamegraph analyzer
# ============================
FROM rust:1-bookworm AS flamegraph-analyzer-builder

WORKDIR /app/rust/flamegraph-analyzer
COPY rust/flamegraph-analyzer/Cargo.toml rust/flamegraph-analyzer/Cargo.lock ./
COPY rust/flamegraph-analyzer/src ./src
RUN cargo build --release

# ============================
# Stage 3: Download trace_processor_shell
# ============================
# Pinned to PERFETTO_VERSION + per-platform SHA256 from
# scripts/trace-processor-pin.env (single source of truth across
# start-dev.sh, this Dockerfile, and the CI workflow). LUCI artifacts URL
# is version-locked; do NOT switch back to get.perfetto.dev/trace_processor
# (latest, unpinned — drifts from the generated SQL stdlib index).
FROM debian:bookworm-slim AS tp-downloader

ARG TRACE_PROCESSOR_DOWNLOAD_BASE=
ARG TRACE_PROCESSOR_DOWNLOAD_URL=

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/trace-processor-pin.env /tmp/pin.env

RUN . /tmp/pin.env && \
    ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64)  PLAT=linux-amd64; SHA="$PERFETTO_SHELL_SHA256_LINUX_AMD64" ;; \
      aarch64) PLAT=linux-arm64; SHA="$PERFETTO_SHELL_SHA256_LINUX_ARM64" ;; \
      *) echo "Unsupported architecture: $ARCH" && exit 1 ;; \
    esac && \
    URL_BASE="${TRACE_PROCESSOR_DOWNLOAD_BASE:-$PERFETTO_LUCI_URL_BASE}" && \
    URL="${TRACE_PROCESSOR_DOWNLOAD_URL:-${URL_BASE%/}/${PERFETTO_VERSION}/${PLAT}/trace_processor_shell}" && \
    curl -fL --max-time 120 -o /tmp/trace_processor_shell \
      "$URL" && \
    echo "${SHA}  /tmp/trace_processor_shell" | sha256sum -c - && \
    chmod +x /tmp/trace_processor_shell && \
    /tmp/trace_processor_shell --version | head -n 1

# ============================
# Stage 4: Runtime
# ============================
FROM node:26-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy trace_processor_shell
COPY --from=tp-downloader /tmp/trace_processor_shell /app/perfetto/out/ui/trace_processor_shell

# Copy backend (built + node_modules)
COPY --from=backend-builder /app/backend/dist ./backend/dist
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules
COPY --from=backend-builder /app/backend/package.json ./backend/
COPY --from=backend-builder /app/backend/data/perfettoSqlIndex.light.json ./backend/data/perfettoSqlIndex.light.json
COPY --from=backend-builder /app/backend/data/perfettoSqlIndex.json ./backend/data/perfettoSqlIndex.json
COPY --from=backend-builder /app/backend/data/perfettoStdlibSymbols.json ./backend/data/perfettoStdlibSymbols.json

# Copy Rust flamegraph analyzer. The backend auto-discovers this path before
# falling back to TypeScript analysis.
COPY --from=flamegraph-analyzer-builder /app/rust/flamegraph-analyzer/target/release/flamegraph-analyzer ./rust/flamegraph-analyzer/target/release/flamegraph-analyzer

# Copy backend runtime files (skills, strategies, SQL packages, templates)
COPY backend/skills ./backend/skills
COPY backend/strategies ./backend/strategies
# SmartPerfetto PerfettoSQL package (Spark Plan 03). Loader resolves from
# `dist/services/../../sql/smartperfetto`, which lands on this path.
COPY backend/sql ./backend/sql

# Copy pre-built Perfetto UI shipped in the repository.
# Refresh this directory with scripts/update-frontend.sh before publishing UI changes.
COPY frontend ./perfetto/out/ui/ui

# Create required directories and fix ownership for non-root user
RUN mkdir -p backend/uploads backend/logs/sessions backend/data && \
    chown -R node:node /app

# Environment defaults
ENV PORT=3000
ENV NODE_ENV=production
ENV FRONTEND_URL=http://localhost:10000

EXPOSE 3000 10000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start both services
COPY scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && chown node:node /app/docker-entrypoint.sh

USER node

ENTRYPOINT ["/app/docker-entrypoint.sh"]
