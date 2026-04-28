FROM node:24-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY . .

RUN pnpm install --no-frozen-lockfile
