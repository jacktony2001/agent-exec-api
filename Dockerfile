# Shell backend for the rahmat-ai-bot agent.
# Alpine keeps the image small — important on a 256 MB free-tier server.
FROM node:22-alpine

# bash is required: the Worker sends commands expecting `bash -lc` semantics
# (pipes, redirects, globs, [[ ]]). sh/ash would break a subset of them.
RUN apk add --no-cache bash

WORKDIR /app
COPY package.json server.js ./

# Writable workspace: this is the default cwd for every command the agent runs,
# and where its read_file / write_file tools operate. `node` user owns it.
RUN mkdir -p /workspace && chown -R node:node /app /workspace

USER node
WORKDIR /workspace

ENV NODE_ENV=production \
    PORT=3000 \
    CMD_TIMEOUT_MS=20000 \
    MAX_OUTPUT=60000 \
    RATE_LIMIT_PER_MIN=30 \
    HEALTH_PATH=/health,/healthz

EXPOSE 3000

# Give the orchestrator a real health signal instead of guessing. Shell form so
# ${PORT} is expanded at runtime (hosts like Coolify inject their own PORT).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/health" || exit 1

CMD ["node", "/app/server.js"]
