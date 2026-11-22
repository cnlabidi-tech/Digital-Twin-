# Shared image for all Node.js workspaces (backend, emulator, attack tools).
# The service to run is chosen by the `command:` in docker-compose.yml.
FROM node:22-alpine
WORKDIR /app
COPY . .
# Full install (tsx and typescript are needed at runtime: we run TS directly).
RUN npm ci --no-audit --no-fund
# Build the dashboard; the backend serves apps/dashboard/dist at "/".
RUN npm run build -w @twin/dashboard
ENV NODE_ENV=production
USER node
