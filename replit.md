# MindVault — AI Personal Workspace

## Overview

A full-stack AI-powered personal workspace web application where users chat with an AI assistant to save notes, upload files, create reminders, and have everything automatically organized into smart folders.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui
- **Routing**: Wouter
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: Gemini (via Replit AI integrations — no user API key required)
- **Auth**: JWT tokens stored in localStorage

## Architecture

- `artifacts/mindvault/` — React + Vite frontend (chat UI, notes, files, reminders, settings)
- `artifacts/api-server/` — Express REST API with all routes
- `lib/db/` — Drizzle ORM schema (users, folders, items, conversations, messages)
- `lib/api-spec/` — OpenAPI spec (source of truth)
- `lib/api-client-react/` — Generated React Query hooks
- `lib/api-zod/` — Generated Zod validation schemas
- `lib/integrations-gemini-ai/` — Gemini AI client

## Key Features

- **Chat-first interface** — ChatGPT-style AI assistant that auto-classifies and saves content
- **AI classification** — Gemini analyzes messages and saves them as notes/reminders with smart folders and tags
- **Notes CRUD** — Create, edit, delete, search notes
- **File upload** — Upload files (base64), view/download, AI tagging
- **Reminders** — Natural language reminder creation from chat, upcoming reminders view
- **Folder system** — System folders (Inbox, Notes, Files, Reminders) + user-created folders
- **Real-time chat streaming** — SSE streaming for AI responses
- **Per-user isolation** — All data is scoped to the authenticated user
- **JWT authentication** — Register/login with email and password

## Database Tables

- `users` — email, password hash, full name, avatar
- `folders` — user folders with color, icon, system flag
- `items` — universal items (notes, files, reminders) with AI metadata
- `conversations` — AI chat conversations per user
- `messages` — chat messages within conversations

## Key Commands

- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/mindvault run dev` — run frontend locally

## Auth Flow

- JWT stored in `localStorage` as `mindvault_token`
- Passed as `Authorization: Bearer <token>` header on all requests
- Custom fetch in `lib/api-client-react/src/custom-fetch.ts` handles this automatically
- On 401 response, token is cleared and user is redirected to `/auth`

## Environment Variables

- `AI_INTEGRATIONS_GEMINI_BASE_URL` — auto-set by Replit Gemini integration
- `AI_INTEGRATIONS_GEMINI_API_KEY` — auto-set by Replit Gemini integration
- `DATABASE_URL` — PostgreSQL connection string (auto-set by Replit DB)
- `SESSION_SECRET` — JWT signing secret (set in Replit secrets)
