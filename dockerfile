FROM node:24-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY . .

RUN npm_config_user_agent=pnpm/docker pnpm install --no-frozen-lockfile
