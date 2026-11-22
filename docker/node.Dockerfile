# Shared image for all Node.js workspaces (backend, emulator, attack tools).
# The service to run is chosen by the `command:` in docker-compose.yml.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY . .
# Full install (tsx and typescript are needed at runtime: we run TS directly).
RUN npm ci --include=dev --no-audit --no-fund
USER node
