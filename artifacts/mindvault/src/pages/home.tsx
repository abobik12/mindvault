import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useListGeminiConversations,
  useCreateGeminiConversation,
  useClassifyContent,
  useGetGeminiConversation,
  getListGeminiConversationsQueryKey,
  getGetGeminiConversationQueryKey,
  useUploadFile,
  useListFolders,
  getListFoldersQueryKey,
  useCreateItem,
  useUpdateItem,
  useDeleteItem,
  getListItemsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Send,
  Plus,
  Paperclip,
  Bot,
  User,
  MessageSquare,
  Loader2,
  FolderInput,
  CalendarClock,
  Pencil,
  Trash2,
  FolderOpen,
  ArrowDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import MarkdownMessage from "@/components/markdown-message";
import { formatMoscowDate, formatMoscowTime, parseMoscowDateTimeLocalToIso } from "@/lib/time";

type IntentType = "chat_only" | "save_note" | "save_reminder" | "save_file" | "action_on_existing";
type ResponseMode = "reply_only" | "saved" | "suggest_actions" | "action_executed";
type ItemType = "note" | "file" | "reminder";
type SuggestedAction = "save_note" | "save_reminder" | "ignore";

type AssistantSavedItem = {
  id: number;
  type: ItemType;
  title: string;
  folderId: number | null;
  folderName: string | null;
  reminderAt?: string | null;
};

type AssistantMessageContext = {
  intentType: IntentType;
  responseMode: ResponseMode;
  autoSaved?: boolean;
  assistantReply?: string;
  savedItem?: AssistantSavedItem | null;
  suggestedActions?: SuggestedAction[];
};

type ChatMessage = {
  id: number;
  role: "user" | "assistant" | string;
  content: string;
  createdAt?: string;
  metadata?: unknown;
};

function getSectionPathByItemType(type: ItemType): string {
  if (type === "note") return "/notes";
  if (type === "reminder") return "/reminders";
  return "/files";
}

function buildTitleFromText(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function toFolderIdFromContext(folderContext: string): number | null {
  if (folderContext === "none" || folderContext === "auto") return null;
  const parsed = Number.parseInt(folderContext, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function toMoscowDatetimeLocalInput(isoString?: string | null): string {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  const hour = pick("hour");
  const minute = pick("minute");

  if (!year || !month || !day || !hour || !minute) return "";
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function getPreviousUserMessage(messages: ChatMessage[], assistantMessageIndex: number): string {
  for (let index = assistantMessageIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return messages[index].content ?? "";
    }
  }
  return "";
}

function readAssistantContext(raw: unknown): AssistantMessageContext | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;

  const intentType = source.intentType;
  const responseMode = source.responseMode;

  if (
    intentType !== "chat_only" &&
    intentType !== "save_note" &&
    intentType !== "save_reminder" &&
    intentType !== "save_file" &&
    intentType !== "action_on_existing"
  ) {
    return null;
  }

  if (
    responseMode !== "reply_only" &&
    responseMode !== "saved" &&
    responseMode !== "suggest_actions" &&
    responseMode !== "action_executed"
  ) {
    return null;
  }

  let savedItem: AssistantSavedItem | null = null;
  const rawSavedItem = source.savedItem;
  if (rawSavedItem && typeof rawSavedItem === "object") {
    const item = rawSavedItem as Record<string, unknown>;
    if (
      typeof item.id === "number" &&
      (item.type === "note" || item.type === "file" || item.type === "reminder") &&
      typeof item.title === "string"
    ) {
      savedItem = {
        id: item.id,
        type: item.type,
        title: item.title,
        folderId: typeof item.folderId === "number" ? item.folderId : null,
        folderName: typeof item.folderName === "string" ? item.folderName : null,
        reminderAt: typeof item.reminderAt === "string" ? item.reminderAt : null,
      };
    }
  }

  const suggestedActions = Array.isArray(source.suggestedActions)
    ? source.suggestedActions.filter(
        (entry): entry is SuggestedAction =>
          entry === "save_note" || entry === "save_reminder" || entry === "ignore",
      )
    : undefined;

  return {
    intentType,
    responseMode,
    autoSaved: source.autoSaved === true,
    assistantReply: typeof source.assistantReply === "string" ? source.assistantReply : undefined,
    savedItem,
    suggestedActions,
  };
}

export default function Home() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState("");
  const [saveFolderContext, setSaveFolderContext] = useState<string>("auto");

  const [movingItem, setMovingItem] = useState<AssistantSavedItem | null>(null);
  const [movingMessageId, setMovingMessageId] = useState<number | null>(null);
  const [movingFolderValue, setMovingFolderValue] = useState<string>("none");

  const [renamingItem, setRenamingItem] = useState<AssistantSavedItem | null>(null);
  const [renamingMessageId, setRenamingMessageId] = useState<number | null>(null);
  const [renamingValue, setRenamingValue] = useState("");

  const [editingReminderItem, setEditingReminderItem] = useState<AssistantSavedItem | null>(null);
  const [editingReminderMessageId, setEditingReminderMessageId] = useState<number | null>(null);
  const [editingReminderValue, setEditingReminderValue] = useState("");

  const [isConvertingType, setIsConvertingType] = useState(false);
  const [isSavingSuggested, setIsSavingSuggested] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [hasNewMessagesBelow, setHasNewMessagesBelow] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: conversations = [], isLoading: isConversationsLoading } = useListGeminiConversations();
  const { data: folders = [] } = useListFolders();

  const { data: activeConversation } = useGetGeminiConversation(activeConversationId as number, {
    query: {
      queryKey: getGetGeminiConversationQueryKey(activeConversationId as number),
      enabled: activeConversationId !== null,
    },
  });

  const conversationMessages = useMemo(
    () => ((activeConversation?.messages ?? []) as ChatMessage[]),
    [activeConversation?.messages],
  );
  const userFolders = useMemo(() => folders.filter((folder) => !folder.isSystem), [folders]);

  const createConversation = useCreateGeminiConversation({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListGeminiConversationsQueryKey() });
        setActiveConversationId(data.id);
      },
    },
  });

  const classifyContent = useClassifyContent();
  const uploadFile = useUploadFile();
  const createItem = useCreateItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
      },
    },
  });
  const updateItem = useUpdateItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
      },
    },
  });
  const deleteItem = useDeleteItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
      },
    },
  });

  useEffect(() => {
    if (conversations.length > 0 && !activeConversationId) {
      setActiveConversationId(conversations[0].id);
    }
  }, [conversations, activeConversationId]);

  const getIsNearBottom = () => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceFromBottom < 96;
  };

  const scrollToBottom = (smooth = false) => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    setIsNearBottom(true);
    setHasNewMessagesBelow(false);
  };

  const handleMessagesScroll = () => {
    const nearBottom = getIsNearBottom();
    setIsNearBottom(nearBottom);
    if (nearBottom) {
      setHasNewMessagesBelow(false);
    }
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => scrollToBottom(false));
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversationId, activeConversation?.id]);

  useEffect(() => {
    const shouldFollow = isNearBottom;
    const frame = window.requestAnimationFrame(() => {
      if (shouldFollow) {
        scrollToBottom(false);
      } else if (conversationMessages.length > 0 || streamingMessage) {
        setHasNewMessagesBelow(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversationMessages.length, streamingMessage, isNearBottom]);

  const patchMessageContext = (
    messageId: number,
    updater: (context: AssistantMessageContext | null) => AssistantMessageContext | null,
  ) => {
    if (!activeConversationId) return;
    queryClient.setQueryData(getGetGeminiConversationQueryKey(activeConversationId), (old: any) => {
      if (!old || !Array.isArray(old.messages)) return old;
      return {
        ...old,
        messages: old.messages.map((message: any) => {
          if (message?.id !== messageId) return message;
          const nextContext = updater(readAssistantContext(message.metadata));
          return { ...message, metadata: nextContext };
        }),
      };
    });
  };

  const handleNewChat = () => {
    createConversation.mutate({ data: { title: "Новый диалог" } });
  };

  const handleOpenItem = (item: AssistantSavedItem) => {
    setLocation(getSectionPathByItemType(item.type));
  };

  const handleOpenMoveDialog = (messageId: number, item: AssistantSavedItem) => {
    setMovingItem(item);
    setMovingMessageId(messageId);
    setMovingFolderValue(item.folderId ? String(item.folderId) : "none");
  };

  const handleOpenRenameDialog = (messageId: number, item: AssistantSavedItem) => {
    setRenamingItem(item);
    setRenamingMessageId(messageId);
    setRenamingValue(item.title);
  };

  const handleOpenReminderDialog = (messageId: number, item: AssistantSavedItem) => {
    setEditingReminderItem(item);
    setEditingReminderMessageId(messageId);
    setEditingReminderValue(toMoscowDatetimeLocalInput(item.reminderAt));
  };

  const handleMoveSubmit = async () => {
    if (!movingItem || movingMessageId === null) return;

    const nextFolderId = movingFolderValue === "none" ? null : Number.parseInt(movingFolderValue, 10);
    if (Number.isNaN(nextFolderId as number)) {
      toast.error("Выберите корректную папку");
      return;
    }

    try {
      await updateItem.mutateAsync({
        id: movingItem.id,
        data: { folderId: nextFolderId },
      });

      const folderName = nextFolderId ? userFolders.find((folder) => folder.id === nextFolderId)?.name ?? null : null;
      patchMessageContext(movingMessageId, (context) => {
        if (!context?.savedItem) return context;
        return {
          ...context,
          savedItem: {
            ...context.savedItem,
            folderId: nextFolderId,
            folderName,
          },
        };
      });

      toast.success("Объект перемещён");
      setMovingItem(null);
      setMovingMessageId(null);
    } catch {
      toast.error("Не удалось переместить объект");
    }
  };

  const handleRenameSubmit = async () => {
    if (!renamingItem || renamingMessageId === null) return;
    const nextTitle = renamingValue.trim();
    if (!nextTitle) {
      toast.error("Введите название");
      return;
    }

    try {
      await updateItem.mutateAsync({
        id: renamingItem.id,
        data: { title: nextTitle },
      });

      patchMessageContext(renamingMessageId, (context) => {
        if (!context?.savedItem) return context;
        return {
          ...context,
          savedItem: {
            ...context.savedItem,
            title: nextTitle,
          },
        };
      });

      toast.success("Название обновлено");
      setRenamingItem(null);
      setRenamingMessageId(null);
    } catch {
      toast.error("Не удалось обновить название");
    }
  };

  const handleReminderDateSubmit = async () => {
    if (!editingReminderItem || editingReminderMessageId === null) return;
    if (!editingReminderValue.trim()) {
      toast.error("Укажите дату и время");
      return;
    }

    try {
      const nextReminderAt = parseMoscowDateTimeLocalToIso(editingReminderValue);
      await updateItem.mutateAsync({
        id: editingReminderItem.id,
        data: { reminderAt: nextReminderAt },
      });

      patchMessageContext(editingReminderMessageId, (context) => {
        if (!context?.savedItem) return context;
        return {
          ...context,
          savedItem: {
            ...context.savedItem,
            reminderAt: nextReminderAt,
          },
        };
      });

      toast.success("Дата напоминания обновлена");
      setEditingReminderItem(null);
      setEditingReminderMessageId(null);
    } catch {
      toast.error("Не удалось обновить дату напоминания");
    }
  };

  const handleDeleteFromChat = async (messageId: number, item: AssistantSavedItem, autoSaved?: boolean) => {
    const shouldDelete = window.confirm(
      autoSaved ? "Отменить автоматическое сохранение этого объекта?" : "Удалить этот объект?",
    );
    if (!shouldDelete) return;

    try {
      await deleteItem.mutateAsync({ id: item.id });
      patchMessageContext(messageId, (context) => {
        if (!context) return context;
        return {
          ...context,
          savedItem: null,
          responseMode: "reply_only",
        };
      });
      toast.success(autoSaved ? "Автосохранение отменено" : "Объект удалён");
    } catch {
      toast.error("Не удалось удалить объект");
    }
  };

  const handleConvertItemType = async (messageId: number, item: AssistantSavedItem, targetType: ItemType) => {
    if (item.type === targetType) return;

    setIsConvertingType(true);
    try {
      const token = localStorage.getItem("mindvault_token");
      const response = await fetch(`/api/items/${item.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: targetType,
          ...(targetType === "note" ? { reminderAt: null } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error("Ошибка при смене типа объекта");
      }

      const updatedItem = (await response.json()) as {
        id: number;
        type: ItemType;
        title: string;
        folderId?: number | null;
        folderName?: string | null;
        reminderAt?: string | null;
      };

      patchMessageContext(messageId, (context) => {
        if (!context?.savedItem) return context;
        return {
          ...context,
          intentType: targetType === "reminder" ? "save_reminder" : "save_note",
          responseMode: "saved",
          savedItem: {
            id: updatedItem.id,
            type: updatedItem.type,
            title: updatedItem.title,
            folderId: updatedItem.folderId ?? null,
            folderName: updatedItem.folderName ?? null,
            reminderAt: updatedItem.reminderAt ?? null,
          },
        };
      });

      queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetGeminiConversationQueryKey(activeConversationId as number) });
      toast.success(targetType === "reminder" ? "Преобразовано в напоминание" : "Преобразовано в заметку");
    } catch {
      toast.error("Не удалось изменить тип объекта");
    } finally {
      setIsConvertingType(false);
    }
  };

  const handleSuggestedAction = async (
    messageId: number,
    action: SuggestedAction,
    sourceUserContent: string,
  ) => {
    if (action === "ignore") {
      patchMessageContext(messageId, (context) => {
        if (!context) return context;
        return {
          ...context,
          responseMode: "reply_only",
          suggestedActions: [],
        };
      });
      toast.success("Сообщение оставлено как обычный чат");
      return;
    }

    const contentToSave = sourceUserContent.trim();
    if (!contentToSave) {
      toast.error("Не удалось определить, что именно сохранить");
      return;
    }

    setIsSavingSuggested(true);
    try {
      const folderId = toFolderIdFromContext(saveFolderContext);
      const created = await createItem.mutateAsync({
        data: {
          type: action === "save_note" ? "note" : "reminder",
          title:
            action === "save_note"
              ? buildTitleFromText(contentToSave, "Новая заметка")
              : buildTitleFromText(contentToSave, "Новое напоминание"),
          content: contentToSave,
          folderId,
        },
      });

      patchMessageContext(messageId, (context) => ({
        intentType: action,
        responseMode: "saved",
        autoSaved: false,
        assistantReply: context?.assistantReply,
        suggestedActions: [],
        savedItem: {
          id: created.id,
          type: created.type,
          title: created.title,
          folderId: created.folderId ?? null,
          folderName: created.folderName ?? null,
          reminderAt: created.reminderAt ?? null,
        },
      }));

      toast.success(action === "save_note" ? "Сохранено как заметка" : "Создано напоминание");
    } catch {
      toast.error("Не удалось сохранить объект");
    } finally {
      setIsSavingSuggested(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || !activeConversationId || isStreaming) return;

    const messageContent = input.trim();
    setInput("");
    setIsNearBottom(true);
    setHasNewMessagesBelow(false);

    queryClient.setQueryData(getGetGeminiConversationQueryKey(activeConversationId), (old: any) => {
      if (!old) return old;
      return {
        ...old,
        messages: [
          ...old.messages,
          {
            id: Date.now(),
            role: "user",
            content: messageContent,
            metadata: null,
            createdAt: new Date().toISOString(),
          },
        ],
      };
    });
    window.requestAnimationFrame(() => scrollToBottom(false));

    let assistantContextForMessage: AssistantMessageContext | null = null;

    try {
      const classification = (await classifyContent.mutateAsync({
        data: {
          content: messageContent,
          conversationId: activeConversationId,
          folderId:
            saveFolderContext === "auto"
              ? undefined
              : saveFolderContext === "none"
              ? null
              : Number.parseInt(saveFolderContext, 10),
        },
      })) as any;

      assistantContextForMessage = readAssistantContext(classification?.assistantContext);
      if (assistantContextForMessage && typeof classification?.message === "string" && classification.message.trim()) {
        assistantContextForMessage = {
          ...assistantContextForMessage,
          assistantReply: classification.message,
        };
      }

      if (classification?.responseMode === "saved" && classification?.savedItem?.title) {
        const savedType = classification.savedItem.type;
        if (savedType === "reminder") {
          toast.success(`Создано напоминание: «${classification.savedItem.title}»`);
        } else if (savedType === "note") {
          toast.success(`Сохранена заметка: «${classification.savedItem.title}»`);
        }
      } else if (
        classification?.responseMode === "action_executed" &&
        typeof classification?.message === "string" &&
        classification.message.trim()
      ) {
        toast.success(classification.message);
      }
    } catch {
      assistantContextForMessage = null;
    }

    setIsStreaming(true);
    setStreamingMessage("");

    try {
      const token = localStorage.getItem("mindvault_token");
      const response = await fetch(`/api/gemini/conversations/${activeConversationId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          content: messageContent,
          assistantContext: assistantContextForMessage,
        }),
      });

      if (!response.ok) throw new Error("Ошибка потокового ответа");
      if (!response.body) throw new Error("Пустой поток ответа");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          const lines = event.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const payload = line.slice(6);
            if (payload === "[DONE]") continue;

            let parsed: any;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue;
            }

            if (typeof parsed.error === "string" && parsed.error.trim()) {
              throw new Error(parsed.error);
            }

            if (typeof parsed.content === "string") {
              setStreamingMessage((prev) => prev + parsed.content);
            } else if (typeof parsed.text === "string") {
              setStreamingMessage((prev) => prev + parsed.text);
            }
          }
        }
      }

      queryClient.invalidateQueries({ queryKey: getGetGeminiConversationQueryKey(activeConversationId) });
    } catch {
      toast.error("Не удалось получить ответ ассистента");
    } finally {
      setIsStreaming(false);
      setStreamingMessage("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = (event.target?.result as string).split(",")[1];

      toast.promise(
        uploadFile.mutateAsync({
          data: {
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            fileSize: file.size,
            fileData: base64,
          },
        }),
        {
          loading: "Загружаем файл...",
          success: "Файл загружен",
          error: "Не удалось загрузить файл",
        },
      );
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const renderMessageActions = (message: ChatMessage, index: number) => {
    if (message.role !== "assistant") return null;

    const context = readAssistantContext((message as any).metadata);
    if (!context) return null;

    const savedItem = context.savedItem ?? null;
    const hasSuggestedActions = !savedItem && (context.suggestedActions?.length ?? 0) > 0;
    if (!savedItem && !hasSuggestedActions) return null;

    const sourceUserContent = getPreviousUserMessage(conversationMessages, index);
    const actionsDisabled =
      updateItem.isPending || deleteItem.isPending || isConvertingType || isSavingSuggested;

    return (
      <div className="mt-2 flex flex-wrap gap-1.5 px-1">
        {savedItem ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-lg px-2.5 text-[11px]"
              onClick={() => handleOpenItem(savedItem)}
              disabled={actionsDisabled}
            >
              <FolderOpen className="w-3 h-3 mr-1" />
              Открыть
            </Button>

            {savedItem.type !== "reminder" ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 rounded-lg px-2.5 text-[11px]"
                onClick={() => handleOpenRenameDialog(message.id, savedItem)}
                disabled={actionsDisabled}
              >
                <Pencil className="w-3 h-3 mr-1" />
                {savedItem.type === "file" ? "Переименовать" : "Изменить"}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 rounded-lg px-2.5 text-[11px]"
                onClick={() => handleOpenReminderDialog(message.id, savedItem)}
                disabled={actionsDisabled}
              >
                <CalendarClock className="w-3 h-3 mr-1" />
                Изменить дату
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-lg px-2.5 text-[11px]"
              onClick={() => handleOpenMoveDialog(message.id, savedItem)}
              disabled={actionsDisabled}
            >
              <FolderInput className="w-3 h-3 mr-1" />
              Переместить
            </Button>

            {savedItem.type === "note" ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 rounded-lg px-2.5 text-[11px]"
                onClick={() => handleConvertItemType(message.id, savedItem, "reminder")}
                disabled={actionsDisabled}
              >
                Сделать напоминанием
              </Button>
            ) : null}

            {savedItem.type === "reminder" ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 rounded-lg px-2.5 text-[11px]"
                onClick={() => handleConvertItemType(message.id, savedItem, "note")}
                disabled={actionsDisabled}
              >
                Сделать заметкой
              </Button>
            ) : null}

            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-lg px-2.5 text-[11px] text-destructive border-destructive/40 hover:bg-destructive/10"
              onClick={() => handleDeleteFromChat(message.id, savedItem, context.autoSaved)}
              disabled={actionsDisabled}
            >
              <Trash2 className="w-3 h-3 mr-1" />
              {context.autoSaved ? "Отменить сохранение" : "Удалить"}
            </Button>
          </>
        ) : null}

        {hasSuggestedActions ? (
          <>
            {context.suggestedActions?.includes("save_note") ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 rounded-lg px-2.5 text-[11px]"
                onClick={() => handleSuggestedAction(message.id, "save_note", sourceUserContent)}
                disabled={actionsDisabled}
              >
                Сохранить как заметку
              </Button>
            ) : null}

            {context.suggestedActions?.includes("save_reminder") ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 rounded-lg px-2.5 text-[11px]"
                onClick={() => handleSuggestedAction(message.id, "save_reminder", sourceUserContent)}
                disabled={actionsDisabled}
              >
                Создать напоминание
              </Button>
            ) : null}

            {context.suggestedActions?.includes("ignore") ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 rounded-lg px-2.5 text-[11px]"
                onClick={() => handleSuggestedAction(message.id, "ignore", sourceUserContent)}
                disabled={actionsDisabled}
              >
                Не сохранять
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="flex h-full min-h-0 w-full">
      <div className="hidden lg:flex w-64 border-r border-border bg-card/30 flex-col">
        <div className="p-4 border-b border-border/50">
          <Button onClick={handleNewChat} className="w-full gap-2 shadow-sm" variant="default">
            <Plus className="w-4 h-4" />
            Новый чат
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {isConversationsLoading ? (
              <div className="p-4 text-center text-sm text-muted-foreground">Загрузка...</div>
            ) : (
              conversations.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => setActiveConversationId(conv.id)}
                  className={cn(
                    "flex items-center gap-2 p-3 rounded-lg text-sm cursor-pointer transition-colors",
                    activeConversationId === conv.id
                      ? "bg-accent text-accent-foreground font-medium"
                      : "hover:bg-accent/50 text-muted-foreground",
                  )}
                >
                  <MessageSquare className="w-4 h-4 shrink-0" />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="truncate">{conv.title || "Новый диалог"}</span>
                    <span className="text-[10px] opacity-70">{formatMoscowDate(conv.createdAt)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex-1 min-w-0 flex flex-col relative bg-card/10">
        {!activeConversationId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Выберите диалог или создайте новый
          </div>
        ) : (
          <>
            <div
              ref={messagesContainerRef}
              onScroll={handleMessagesScroll}
              className="flex-1 min-h-0 overflow-y-auto px-3 py-4 sm:px-4"
            >
              <div className="max-w-3xl mx-auto space-y-5 sm:space-y-6 pb-40 sm:pb-36">
                {conversationMessages.map((msg, i) => (
                  <div key={msg.id || i} className={cn("flex gap-3 sm:gap-4", msg.role === "user" ? "flex-row-reverse" : "")}> 
                    <div
                      className={cn(
                        "w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1 shadow-sm",
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-secondary-foreground",
                      )}
                    >
                      {msg.role === "user" ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                    </div>
                    <div className={cn("flex flex-col max-w-[85%] sm:max-w-[80%] min-w-0", msg.role === "user" ? "items-end" : "items-start")}>
                      <div
                        className={cn(
                          "px-4 py-3 rounded-2xl shadow-sm text-sm leading-relaxed break-words",
                          msg.role === "user"
                            ? "bg-primary text-primary-foreground rounded-tr-sm whitespace-pre-wrap"
                            : "bg-card border border-border/50 text-card-foreground rounded-tl-sm",
                        )}
                      >
                        {msg.role === "user" ? msg.content : <MarkdownMessage content={msg.content} />}
                      </div>
                      <span className="text-[10px] text-muted-foreground mt-1 px-1">
                        {msg.createdAt ? formatMoscowTime(msg.createdAt) : "Сейчас"}
                      </span>
                      {renderMessageActions(msg, i)}
                    </div>
                  </div>
                ))}

                {isStreaming && streamingMessage && (
                  <div className="flex gap-4">
                    <div className="w-8 h-8 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center shrink-0 mt-1 shadow-sm">
                      <Bot className="w-4 h-4" />
                    </div>
                    <div className="flex flex-col max-w-[85%] sm:max-w-[80%] min-w-0 items-start">
                      <div className="px-4 py-3 rounded-2xl shadow-sm text-sm leading-relaxed break-words bg-card border border-border/50 text-card-foreground rounded-tl-sm">
                        <MarkdownMessage content={streamingMessage} />
                        <span className="inline-block w-1 h-4 ml-1 bg-primary animate-pulse" />
                      </div>
                    </div>
                  </div>
                )}
                {isStreaming && !streamingMessage && (
                  <div className="flex gap-4">
                    <div className="w-8 h-8 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center shrink-0 mt-1 shadow-sm">
                      <Bot className="w-4 h-4 animate-pulse" />
                    </div>
                    <div className="flex flex-col max-w-[85%] sm:max-w-[80%] min-w-0 items-start">
                      <div className="px-4 py-3 rounded-2xl shadow-sm text-sm leading-relaxed bg-card border border-border/50 text-card-foreground rounded-tl-sm">
                        ИИ печатает...
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {hasNewMessagesBelow && !isNearBottom ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="absolute bottom-28 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-md gap-1.5"
                onClick={() => scrollToBottom(true)}
              >
                <ArrowDown className="w-4 h-4" />
                Вниз
              </Button>
            ) : null}

            <div className="absolute bottom-0 left-0 right-0 p-3 sm:p-4 bg-gradient-to-t from-background via-background to-transparent pt-10 pointer-events-none">
              <div className="max-w-3xl mx-auto relative flex flex-wrap sm:flex-nowrap items-end gap-2 bg-card rounded-2xl border border-border/50 shadow-lg p-2 focus-within:ring-1 focus-within:ring-primary/50 transition-all pointer-events-auto">
                <input type="file" className="hidden" ref={fileInputRef} onChange={handleFileUpload} />
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 rounded-xl text-muted-foreground hover:text-foreground h-10 w-10"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStreaming}
                >
                  <Paperclip className="w-5 h-5" />
                </Button>

                <Select value={saveFolderContext} onValueChange={setSaveFolderContext}>
                  <SelectTrigger className="w-[calc(100vw-7.5rem)] sm:w-[210px] h-10 border-border/40 bg-background/60 text-xs shrink-0">
                    <SelectValue placeholder="Папка для авто-сохранения" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Автовыбор папки</SelectItem>
                    <SelectItem value="none">Сохранять без папки</SelectItem>
                    {userFolders.map((folder) => (
                      <SelectItem key={folder.id} value={String(folder.id)}>
                        {folder.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Напишите сообщение или команду для сохранения..."
                  className="min-h-[44px] max-h-[32dvh] min-w-0 flex-1 resize-none border-0 focus-visible:ring-0 shadow-none bg-transparent p-3 text-sm"
                  rows={1}
                  disabled={isStreaming}
                />

                <Button
                  size="icon"
                  className="shrink-0 rounded-xl h-10 w-10 shadow-sm"
                  onClick={handleSend}
                  disabled={!input.trim() || isStreaming}
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
              <div className="max-w-3xl mx-auto mt-2 text-center pointer-events-auto">
                <span className="text-[10px] text-muted-foreground">
                  Shift+Enter — новая строка. Обычные сообщения не сохраняются автоматически.
                </span>
              </div>
            </div>
          </>
        )}
      </div>
      </div>

      <Dialog
        open={Boolean(renamingItem)}
        onOpenChange={(open) => {
          if (!open) {
            setRenamingItem(null);
            setRenamingMessageId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Изменить название</DialogTitle>
          </DialogHeader>
          <Input value={renamingValue} onChange={(e) => setRenamingValue(e.target.value)} placeholder="Новое название" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenamingItem(null)}>
              Отмена
            </Button>
            <Button onClick={handleRenameSubmit} disabled={updateItem.isPending || !renamingValue.trim()}>
              {updateItem.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(movingItem)}
        onOpenChange={(open) => {
          if (!open) {
            setMovingItem(null);
            setMovingMessageId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Переместить объект</DialogTitle>
          </DialogHeader>
          <Select value={movingFolderValue} onValueChange={setMovingFolderValue}>
            <SelectTrigger>
              <SelectValue placeholder="Выберите папку" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Без папки</SelectItem>
              {userFolders.map((folder) => (
                <SelectItem key={folder.id} value={String(folder.id)}>
                  {folder.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMovingItem(null)}>
              Отмена
            </Button>
            <Button onClick={handleMoveSubmit} disabled={updateItem.isPending}>
              {updateItem.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Переместить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editingReminderItem)}
        onOpenChange={(open) => {
          if (!open) {
            setEditingReminderItem(null);
            setEditingReminderMessageId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Изменить дату напоминания</DialogTitle>
          </DialogHeader>
          <Input
            type="datetime-local"
            value={editingReminderValue}
            onChange={(e) => setEditingReminderValue(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Время указывается в часовом поясе Москвы.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingReminderItem(null)}>
              Отмена
            </Button>
            <Button onClick={handleReminderDateSubmit} disabled={updateItem.isPending || !editingReminderValue.trim()}>
              {updateItem.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
