# Отчёт по архитектуре ассистента MindVault

Дата: 14 июня 2026 года.

## 1. Изученные файлы

- `artifacts/mindvault/src/pages/home.tsx` — отправка сообщений, SSE, кнопки, источники.
- `artifacts/api-server/src/routes/gemini.ts` — основной route чата, сохранение сообщений, вызов AI.
- `artifacts/api-server/src/assistant/actions.ts` — backend-действия над items и folders.
- `artifacts/api-server/src/assistant/command-parser.ts` — deterministic fallback.
- `artifacts/api-server/src/assistant/ai-intent-classifier.ts` — вызов AI-классификатора.
- `artifacts/api-server/src/assistant/assistant-intent.ts` — строгая Zod-схема.
- `artifacts/api-server/src/lib/ai-context.ts` — поиск контекста и релевантных источников.
- `lib/db/src/schema` — таблицы users, folders, items, conversations и messages.
- тесты модулей ассистента и Docker Compose проекта.

## 2. Как логика работала раньше

Сообщение сначала проходило deterministic parser. Только необработанный текст
передавался AI-классификатору. Pending-сценарии частично хранились в metadata,
а часть подсказок была только текстом. Контекст пользователя собирался почти для
любого ответа, поэтому интерфейс мог показывать нерелевантные источники.

## 3. Основные проблемы

- Parser-first режим мешал понимать естественные русские фразы.
- Классификация, выполнение и fallback были разделены между несколькими ветками.
- Не было полного набора update-intent и единого поиска кандидатов.
- Кнопки уточнений не всегда передавали структурированный выбор.
- Источники модели и видимые пользователю источники не разделялись.
- Обычный вопрос мог получить личный контекст без необходимости.

## 4. Что изменено

Добавлен единый `handleAssistantMessage`. Он сначала обрабатывает активный
pending action, затем вызывает AI intent classifier. Deterministic parser
используется только при недоступном AI API.

Расширена строгая Zod-схема intent:

- `create_note`, `create_list`, `create_reminder`;
- `update_note`, `update_list`, `update_reminder`;
- `delete_item`, `move_item_to_folder`;
- `search_items`, `answer_from_sources`;
- `chat_general`, `clarify`, `cancel`;
- операции с папками, сохранённые для совместимости приложения.

Backend получил поиск кандидатов `findActionTargets`, обновление заметок,
списков и напоминаний, выбор цели, обязательное подтверждение удаления и
короткие русские ответы после фактической операции в PostgreSQL.

## 5. Изменённые файлы

- `artifacts/api-server/src/assistant/assistant-contract.ts`
- `artifacts/api-server/src/assistant/assistant-handler.ts`
- `artifacts/api-server/src/assistant/assistant-intent.ts`
- `artifacts/api-server/src/assistant/ai-intent-classifier.ts`
- `artifacts/api-server/src/assistant/actions.ts`
- `artifacts/api-server/src/assistant/assistant-sources.ts`
- `artifacts/api-server/src/assistant/command-parser.ts`
- `artifacts/api-server/src/routes/gemini.ts`
- `artifacts/mindvault/src/pages/home.tsx`
- тесты перечисленных модулей и `artifacts/api-server/package.json`

## 6. Основной AI-режим

Классификатор получает исходный текст, текущую дату, список допустимых intent,
папки пользователя и краткое описание pending action. Ответ принимается только
как JSON, прошедший строгую Zod-валидацию. Модель не имеет доступа к `db` и не
подтверждает выполнение операций. INSERT, UPDATE и DELETE делает backend.

Невалидный JSON не запускает действие: пользователь получает короткое русское
уточнение.

## 7. Fallback-режим

Fallback включается только при недоступном AI API. Он распознаёт базовые формы:

- «создай заметку», «сохрани мысль», «запиши идею»;
- «напомни», «напоминание», «не забыть»;
- «список», «создай список», «чеклист»;
- базовый поиск «найди», «покажи», «где», «когда».

Для даты без времени используется 09:00 по Москве. Для даты без года выбирается
ближайшая будущая дата.

## 8. Pending actions

Структурированный pending action сохраняется в metadata сообщения ассистента
на 30 минут. Он содержит исходный текст, intent, кандидатов, payload и id.

Поддерживаются:

- выбор intent для неоднозначного сообщения;
- выбор одного объекта из нескольких кандидатов;
- подтверждение удаления;
- отмена.

Frontend показывает настоящие кнопки и отправляет `pendingActionId`,
`selectedIntent`, `selectedItemId`, `confirm` или `cancel`. При выборе типа
объекта используется исходное сообщение, повторно вводить текст не нужно.

## 9. Источники

Контекст для модели и видимые источники разделены. Личные данные загружаются
только для `answer_from_sources` и поисковых intent. Создание, изменение,
перемещение, удаление, уточнение и обычный чат источники не показывают.

Видимые источники проходят фильтр релевантности и выводятся в свёрнутом блоке
`Источники: N`.

## 10. Проверки

Успешно выполнены:

```text
npm.cmd test
21 tests passed, 0 failed

npm.cmd run typecheck
api-server: passed
mindvault: passed

git diff --check
passed
```

Покрыты создание заметок, списков и напоминаний, дата 29 июня и 09:00,
естественные формы fallback, строгая схема intent, обычный чат без INSERT,
подтверждение удаления, неоднозначное обновление списка, pending-кнопки,
отмена и фильтрация источников.

## 11. Оставшиеся ограничения

- Pending action хранится в metadata сообщений, а не в отдельной таблице.
- Поиск кандидатов лексический, без embeddings и морфологического индекса.
- Ответ `chat_general` требует второго AI-вызова после классификации.
- Провайдер не возвращает точные citation spans, поэтому видимые источники
  выбираются backend-фильтром релевантности.
- OpenAPI-схему payload кнопок следует отдельно синхронизировать с runtime.
- В текущей сессии Docker-пересборка и визуальная проверка localhost
  заблокированы правами среды; проверены unit-тесты и TypeScript-контракты.
