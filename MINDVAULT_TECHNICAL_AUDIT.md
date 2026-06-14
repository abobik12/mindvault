# Технический аудит MindVault

Дата проверки: 14 июня 2026 года.

## Обновление: второй слой AI intent

После детерминированного парсера добавлен отдельный AI-классификатор намерений:

1. regex/parser первым обрабатывает точные команды;
2. необработанное сообщение передается модели только для классификации;
3. ответ модели разбирается как JSON и проверяется строгой Zod-схемой;
4. разрешены только `create_note`, `create_list`, `create_reminder`, `search_items`,
   `move_item_to_folder`, `create_folder`, `rename_folder`, `delete_item`,
   `chat_general`, `clarify`;
5. модель не получает доступ к Drizzle или PostgreSQL;
6. валидированный intent исполняет `executeValidatedAssistantIntent` на backend;
7. низкая уверенность, неизвестный JSON и опасные действия приводят к уточнению;
8. подтверждение успеха формируется только после успешного `returning()` из БД.

При недоступности AI детерминированные команды продолжают работать. Для обычного чата
используется существующий честный офлайн-ответ, сообщающий о недоступности провайдера.

Живая HTTP-проверка подтвердила:

- `сохрани идею: добавить раздел про ИИ` создает note через AI intent;
- `запиши мысль о новой структуре диплома` создает note;
- `напомни 29 июня поздравить Даню` создает reminder на 29 июня 2026 года, 09:00 МСК;
- обычный вопрос о подготовке к защите получает `chat_general` и не создает item;
- тестовые записи после проверки удалены;
- typecheck, build и 15 автоматических тестов прошли успешно.

Основание: фактический код проекта, Docker Compose, автоматические тесты,
ручная HTTP-проверка и визуальная проверка web-интерфейса. Дополнительно
проверен приложенный файл `D:\Univer\ДИПЛОМ\ГОТОВЫЙ_ДИПЛОМ.pdf`
(93 страницы). Его SHA-256 не совпадает с PDF-копиями внутри репозитория,
поэтому он рассматривался как отдельная финальная версия.

## 1. Краткий вывод

MindVault является работающим TypeScript-монорепозиторием:

- frontend: React, Vite, Wouter, TanStack Query;
- backend: Express 5;
- база данных: PostgreSQL и Drizzle ORM;
- авторизация: JWT Bearer token;
- AI: OpenAI/OpenRouter-compatible Chat Completions API;
- запуск: Docker Compose.

Заметки, списки и напоминания действительно создаются в PostgreSQL. AI не
имеет прямого соединения с базой и не выполняет SQL. Изменения данных
выполняет backend-функция `classifyAndExecuteAssistantAction`, а модель
используется для обычного ответа и ответа на основе подготовленного
backend-контекста.

До исправлений чат работал в два HTTP-шага: frontend сначала вызывал
`/api/gemini/classify`, а затем отправлял полученный `assistantContext` в
endpoint сообщений. Endpoint сообщений доверял этому объекту. Это создавало
разрыв между фактической операцией и текстом подтверждения.

После исправлений основная цепочка выполняется одним серверным запросом:

1. frontend отправляет сообщение в endpoint диалога;
2. backend сохраняет пользовательское сообщение;
3. backend сам запускает action-логику;
4. backend выполняет INSERT/UPDATE/DELETE;
5. только после успешной операции формируется ответ с `success: true`;
6. ответ ассистента сохраняется в `messages` и возвращается через SSE.

Legacy endpoint `/api/gemini/classify` теперь отвечает HTTP 410 и не
выполняет побочных действий.

## 2. Frontend

### 2.1. Основные страницы

Маршруты определены в `artifacts/mindvault/src/App.tsx`:

- `/auth` - авторизация и регистрация;
- `/` - чат;
- `/notes` - заметки;
- `/lists` - списки;
- `/files` - файлы;
- `/reminders` - напоминания;
- `/folders/:id` - содержимое папки;
- `/settings` - настройки.

`ProtectedRoute` проверяет наличие `mindvault_token` в `localStorage`.
Фактическая проверка подписи JWT выполняется не frontend, а middleware
backend.

### 2.2. Передача токена

Generated API hooks используют
`lib/api-client-react/src/custom-fetch.ts`. Функция `customFetch` читает
`mindvault_token` из `localStorage` и добавляет:

```http
Authorization: Bearer <JWT>
```

Чат использует прямой `fetch` в
`artifacts/mindvault/src/pages/home.tsx`, но передает тот же Bearer token.

### 2.3. Отправка сообщения

Основная функция - `handleSend` в
`artifacts/mindvault/src/pages/home.tsx:1181`.

Порядок действий:

1. Берется текст из `input`.
2. При наличии файлов сначала вызывается `/api/items/upload`.
3. Сообщение оптимистично добавляется в кэш текущего диалога.
4. Выполняется POST:

```http
POST /api/gemini/conversations/:id/messages
Content-Type: application/json
Authorization: Bearer <JWT>
```

Тело содержит:

```json
{
  "content": "текст сообщения",
  "attachments": [],
  "folderId": null
}
```

5. Frontend читает SSE-поток.
6. В последнем SSE-событии backend передает `assistantContext`.
7. Зеленый toast показывается только при
   `assistantContext.actionResult.success === true`.
8. Кэши items, folders и conversation инвалидируются.

### 2.4. Обновление интерфейса

После завершения запроса frontend повторно получает сообщения диалога. Для
созданного объекта metadata содержит `savedItem`. На его основе интерфейс
показывает тип, название, папку и кнопки действий.

Исправлена навигация списка: объект `list` теперь открывает `/lists`, а не
`/notes`.

## 3. Backend

### 3.1. Общий вход

`artifacts/api-server/src/app.ts` подключает:

- Pino HTTP logging;
- CORS;
- JSON parser до 25 МБ;
- общий router с префиксом `/api`.

### 3.2. Основные routes

Авторизация:

- `POST /api/auth/register`;
- `POST /api/auth/login`;
- `GET /api/auth/me`;
- `PATCH /api/auth/me/profile`.

Папки:

- `GET /api/folders`;
- `POST /api/folders`;
- `GET /api/folders/:id`;
- `PATCH /api/folders/:id`;
- `DELETE /api/folders/:id`.

Items:

- `GET /api/items`;
- `POST /api/items`;
- `POST /api/items/upload`;
- `GET /api/items/:id`;
- `PATCH /api/items/:id`;
- `DELETE /api/items/:id`;
- `GET /api/search`;
- endpoints статистики.

Чат:

- `GET/POST/DELETE /api/gemini/conversations...`;
- `POST /api/gemini/conversations/:id/messages`;
- `GET/DELETE` сообщений;
- `/api/gemini/classify` оставлен только как HTTP 410 для старых клиентов.

### 3.3. Авторизация пользователя

`requireAuth` находится в
`artifacts/api-server/src/middlewares/auth.ts:33`.

Middleware:

1. читает `Authorization`;
2. требует префикс `Bearer `;
3. проверяет JWT функцией `verifyToken`;
4. записывает `{ userId, email }` в `req.auth`.

Далее routes используют `req.auth!.userId`. Запросы к items, folders и
conversations содержат условие по `userId`, поэтому данные разделены между
пользователями.

### 3.4. Новый путь сообщения

Endpoint находится в
`artifacts/api-server/src/routes/gemini.ts:690`.

Фактический порядок:

1. Zod проверяет `content`.
2. Backend проверяет принадлежность conversation текущему user.
3. Если передан `folderId`, проверяется принадлежность папки user.
4. Вложения проверяются по `userId` и `type = file`.
5. Пользовательское сообщение вставляется в `messages`.
6. Backend вызывает `classifyAndExecuteAssistantAction`
   (`gemini.ts:767`).
7. Action-логика либо выполняет операцию, либо возвращает clarification,
   search result или `reply_only`.
8. Backend формирует пользовательский контекст.
9. Для детерминированного результата backend сохраняет готовый ответ без
   обращения к LLM.
10. Для `reply_only` вызывается AI API.
11. Ответ ассистента вставляется в `messages`.
12. SSE передает текст и финальный `assistantContext`.

Клиентский `assistantContext` больше не является источником истины.

## 4. База данных

Схема находится в `lib/db/src/schema`.

### 4.1. `users`

Файл: `users.ts`.

Поля:

- `id`;
- `email`;
- `passwordHash`;
- `fullName`;
- `avatarUrl`;
- `createdAt`;
- `updatedAt`.

### 4.2. `folders`

Файл: `folders.ts`.

Поля:

- `id`;
- `userId`;
- `name`;
- `color`;
- `icon`;
- `isSystem`;
- даты.

При регистрации создаются системные папки. После исправления чат при
автовыборе связывает:

- note с системной папкой `Заметки`;
- reminder с `Напоминания`;
- list с `Входящие`.

### 4.3. `items`

Файл: `items.ts`.

`item_type`:

- `note`;
- `file`;
- `reminder`;
- `list`.

Общие поля:

- `id`;
- `userId`;
- `folderId`;
- `type`;
- `title`;
- `content`;
- `status`;
- AI metadata;
- даты.

Специализированные поля:

- file: `originalFilename`, `mimeType`, `fileSize`, `fileData`, `summary`;
- reminder: `reminderAt`;
- list: JSON в `content`.

Список хранится так:

```json
{
  "kind": "todo-list",
  "items": [
    {
      "id": "item-...",
      "text": "молоко",
      "done": false
    }
  ]
}
```

### 4.4. `conversations` и `messages`

`conversations.userId` связывает диалог с пользователем.

`messages` содержит:

- `conversationId`;
- `role`;
- `content`;
- `metadata`;
- `createdAt`.

`metadata` хранит attachments, sources, savedItem, pendingAction и
actionResult.

В `messages` нет отдельного `userId`. Изоляция обеспечивается через
принадлежность conversation пользователю.

## 5. AI-интеграция

Клиент находится в
`lib/integrations-gemini-ai/src/client.ts`.

Несмотря на имя пакета, используется не Gemini SDK, а совместимый с OpenAI
endpoint:

```http
POST <baseUrl>/chat/completions
```

### 5.1. Выбор провайдера

`resolveProviderConfig`:

1. проверяет `OPENROUTER_API_KEY`;
2. затем `OPENAI_API_KEY`;
3. выбирает base URL, model и headers;
4. для OpenRouter добавляет `HTTP-Referer` и `X-Title`.

Переменные:

- `OPENROUTER_API_KEY`;
- `OPENROUTER_BASE_URL`;
- `OPENROUTER_MODEL`;
- `OPENROUTER_SITE_URL`;
- `OPENROUTER_APP_NAME`;
- `OPENAI_API_KEY`;
- `OPENAI_BASE_URL`;
- `OPENAI_MODEL`;
- `ASSISTANT_SYSTEM_PROMPT`.

Исправлена ошибка выбора модели: при наличии OpenRouter route теперь
использует `OPENROUTER_MODEL`, а не безусловный `OPENAI_MODEL`.

### 5.2. Prompt и контекст

System prompt находится в `gemini.ts`.

Он запрещает модели утверждать, что объект создан/изменен/удален, если
backend-action не подтвердил success.

`buildAssistantContext` в `lib/ai-context.ts`:

- получает items и folders текущего user;
- собирает последние заметки, файлы, списки и напоминания;
- ищет совпадения по title, content, summary, filename, folder, tags;
- добавляет релевантные старые сообщения;
- формирует текстовый блок для prompt.

Это лексический поиск. Embeddings и векторная база отсутствуют.

### 5.3. Что делает модель

Модель:

- формулирует обычный ответ;
- использует переданный контекст;
- отвечает по извлеченному тексту файлов;
- не получает SQL credentials;
- не вызывает Drizzle;
- не выполняет INSERT/UPDATE/DELETE.

### 5.4. Что делает backend

Backend:

- определяет пользователя;
- выбирает данные только по `userId`;
- распознает детерминированные команды;
- выполняет изменения через Drizzle;
- проверяет возвращенную запись;
- формирует подтверждение;
- передает модели только подготовленный текстовый контекст.

## 6. Создание заметки через чат

Пример:

```text
создай заметку купить молоко
```

Пошагово:

1. `handleSend` отправляет POST в endpoint messages.
2. `requireAuth` получает `userId` из JWT.
3. Backend проверяет conversation.
4. Сообщение сохраняется как `role = user`.
5. `getKeywordCommand` распознает `kind = note`.
6. `executeKeywordCommand` формирует values:

```text
userId = текущий пользователь
type = note
title = купить молоко
content = купить молоко
folderId = системная папка Заметки
status = active
aiTags = []
```

7. `databasePersistence.insertItem` выполняет Drizzle INSERT.
8. Возвращенная запись преобразуется в `savedItem`.
9. Только после INSERT создается `actionResult.success = true`.
10. Ответ `Заметка сохранена: купить молоко` вставляется в `messages`.
11. SSE передает ответ и metadata.
12. Frontend показывает success toast и инвалидирует items.
13. `/notes` получает item через `GET /api/items?type=note`.

Создание является фактическим, а не текстовой имитацией.

## 7. Создание напоминания

Пример:

```text
напоминание день рождения Дани 29 июня
```

Пошагово:

1. `getKeywordCommand` возвращает `kind = reminder`.
2. `parseReminderCommand` распознает `29 июня`.
3. Если год не указан, выбирается ближайшая будущая дата.
4. Если время не указано, используется 09:00 по Москве.
5. Из текста удаляется дата; остается `день рождения Дани`.
6. Выполняется INSERT:

```text
type = reminder
title = день рождения Дани
content = день рождения Дани
reminderAt = 2026-06-29T06:00:00.000Z
folderId = системная папка Напоминания
status = active
```

`06:00Z` соответствует `09:00 Europe/Moscow`.

7. Backend возвращает success только после INSERT.
8. Раздел `/reminders` показывает `29.06.2026, 09:00`.

## 8. Причина исходного сбоя с `29 июня`

В проверенном коде до текущих исправлений существовали несколько
взаимосвязанных рисков:

1. Допускались только команды, начинавшиеся буквально с `заметка`,
   `напоминание` или `список`. Формы `создай заметку`, `напомни`,
   `создай напоминание` не считались прямыми командами.
2. Frontend отдельно вызывал `/gemini/classify`, а затем передавал
   `assistantContext` во второй endpoint.
3. Endpoint сообщений доверял присланному контексту.
4. `baseResponse` по умолчанию ставил `success = true`, поэтому некоторые
   ветки `не найдено` или `нужно уточнение` технически выглядели успешными.
5. Pending action искался среди последних сообщений и мог пережить несколько
   неудачных отправок.
6. Frontend показывал success toast для любого `action_executed`, не проверяя
   `actionResult.success`.

Из-за этого текстовое подтверждение и фактический INSERT могли расходиться.

После исправлений точный кейс проверен через Docker, HTTP и браузер. Запись
появляется в `items` и в разделе напоминаний.

## 9. Исправления

1. Расширены команды:
   - `заметка ...`;
   - `создай заметку ...`;
   - `сохрани заметку ...`;
   - `запиши: ...`;
   - `список ...`;
   - `создай список ...`;
   - `чеклист ...`;
   - `напоминание ...`;
   - `напомни ...`;
   - `создай напоминание ...`.
2. Время для даты без времени: 09:00 Europe/Moscow.
3. Добавлена проверка диапазона часов и минут.
4. Action выполняется внутри endpoint сообщений.
5. Клиентский assistantContext больше не принимается как доказательство.
6. Добавлен `failureResponse` с `success = false`.
7. Success toast зависит от backend success.
8. Pending action ограничен ближайшим логическим ходом.
9. Поиск фильтрует items по тексту запроса.
10. Исправлен переход списка на `/lists`.
11. Исправлен выбор OpenRouter model.
12. Добавлен серверный выбор системной папки.
13. Legacy `/gemini/classify` возвращает 410.
14. Добавлены action-logic tests с подменяемой persistence-функцией.

## 10. Автоматические проверки

Выполнено:

```text
corepack pnpm run typecheck
```

Результат: успешно для libraries, api-server, mindvault,
mockup-sandbox и scripts.

Выполнено:

```text
corepack pnpm --filter @workspace/api-server test
```

Результат: 8 тестов, 8 успешно.

Покрыты:

- явные команды заметки;
- варианты списка;
- дата напоминания в начале и конце;
- дата без времени;
- `напомни`;
- `создай напоминание`;
- обычный вопрос;
- подготовка INSERT-данных note/list/reminder;
- отсутствие success при неполном reminder.

## 11. Docker и ручная проверка

Выполнено:

```text
docker compose up -d --build
```

Состояние:

- PostgreSQL healthy;
- API запущен на 8080;
- Vite frontend запущен на 18174.

HTTP-проверка:

- note создан;
- list создан с пунктами `молоко, хлеб, сыр`;
- reminder создан;
- reminder отображается как `2026-06-29 09:00`;
- обычный вопрос не создает item;
- SSE содержит backend `success: true`;
- legacy classify возвращает 410.

Browser-проверка:

- авторизация работает;
- команда создания заметки показывает сохраненный объект;
- toast появляется после success;
- кейс `29 июня` отображается в чате;
- reminder появляется в `/reminders`;
- console errors отсутствуют.

## 12. Расхождения с приложенным дипломом

В PDF корректно указано:

- фактический OpenAI/OpenRouter-compatible `/chat/completions`;
- отсутствие векторного поиска;
- наличие `classifyAndExecuteAssistantAction`;
- `LEGACY_AUTO_SAVE_ENABLED = false`;
- модель `gpt-4.1-mini` для OpenAI и `openai/gpt-4o-mini` как default
  OpenRouter.

После исправлений необходимо обновить описание потока:

- PDF описывает frontend-вызов `/api/gemini/classify`;
- актуальный frontend больше не вызывает этот endpoint;
- action-логика выполняется в
  `POST /api/gemini/conversations/:id/messages`;
- `/api/gemini/classify` возвращает 410;
- confirmation приходит из того же серверного запроса после операции.

Также фраза о командах, которые должны начинаться только с ключевого слова,
устарела. Поддерживаются естественные явные формы `создай`, `сохрани`,
`запиши`, `напомни`, `чеклист`.

## 13. Оставшиеся ограничения и риски

### Критично

1. В локальном `.env` находится реальный OpenRouter API key. Файл исключен
   из Git, но ключ нужно отозвать и выпустить новый, поскольку он уже хранится
   открытым текстом на диске и мог попасть в архивы/скриншоты.
2. `SESSION_SECRET` имеет fallback
   `mindvault-dev-secret-change-in-prod`. В production запуск без явно
   заданного секрета должен завершаться ошибкой.

### Средний риск

1. OpenAPI schema `SendGeminiMessageBody` не описывает `attachments` и
   `folderId`, хотя runtime их использует.
2. Запись user message, изменение item и запись assistant message не
   объединены в одну транзакцию. При редком сбое между шагами история может
   быть неполной, хотя ложное подтверждение уже исключено.
3. AI-классификация требует отдельного запроса к модели перед обычным ответом
   `chat_general`, поэтому такие сообщения имеют дополнительную задержку и стоимость.
4. Поиск лексический, без морфологии, embeddings и vector index.

### Функциональные ограничения

1. Reminder хранится и отображается, но нет фонового scheduler, push и Web
   Notifications.
2. Файлы хранятся base64 в PostgreSQL; это плохо масштабируется.
3. OCR изображений отсутствует.
4. Нет совместной работы и ролей.
5. Временная зона жестко ориентирована на Москву.
6. Lists хранят пункты в JSON одного поля, а не в нормализованной таблице.

## 14. Как объяснить на защите

### Как подключен AI

Backend использует собственный адаптер OpenAI/OpenRouter-compatible API.
Адаптер отправляет запрос на `/chat/completions`. Провайдер и модель
выбираются из environment variables. Модель получает историю чата,
system prompt и текстовый контекст, собранный backend.

### Как backend управляет данными

JWT middleware определяет `userId`. Все запросы к PostgreSQL фильтруются по
этому идентификатору. CRUD выполняется Express routes и Drizzle ORM.

### Почему AI не пишет в БД

У модели нет объекта `db`, строки подключения и SQL tool. Она получает
только текст. INSERT/UPDATE/DELETE выполняет TypeScript-код backend.

### Как создается заметка или напоминание

Backend распознает явную команду, формирует строго типизированные values,
выполняет Drizzle INSERT и получает созданную запись через `returning`.
Только после этого формируется подтверждение.

### Как исключено ложное `создано`

Источник истины - `actionResult.success`, сформированный backend после
операции. Frontend не может прислать готовое подтверждение как доказательство
успеха. Зеленое уведомление показывается только при server success.

### Честная формулировка ограничений

MindVault реализует хранение и отображение reminders, но не системные
уведомления. Поиск контекстный и лексический, но не векторный. AI помогает
формулировать ответы, однако все изменения пользовательских данных выполняет
backend-код.
