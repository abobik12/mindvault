import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useClassifyContent,
  useGetGeminiConversation,
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
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Send,
  Paperclip,
  Bot,
  User,
  Loader2,
  FolderInput,
  CalendarClock,
  Pencil,
  Trash2,
  FolderOpen,
  ArrowDown,
  MoreHorizontal,
  Copy,
  Save,
  X,
  FileText,
  Eraser,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import MarkdownMessage from "@/components/markdown-message";
import { formatMoscowTime, parseMoscowDateTimeLocalToIso } from "@/lib/time";

type IntentType =
  | "chat_only"
  | "save_note"
  | "save_reminder"
  | "save_file"
  | "action_on_existing"
  | "chat_general"
  | "search_user_content"
  | "answer_about_user_content"
  | "create_note"
  | "update_note"
  | "delete_note"
  | "create_reminder"
  | "update_reminder"
  | "delete_reminder"
  | "search_reminders"
  | "search_files"
  | "answer_about_file"
  | "move_item_to_folder"
  | "create_folder"
  | "rename_folder"
  | "delete_folder"
  | "save_message_as_note"
  | "clear_chat"
  | "unknown_or_ambiguous";
type ResponseMode = "reply_only" | "saved" | "suggest_actions" | "action_executed";
type ItemType = "note" | "file" | "reminder";
type SuggestedAction = "save_note" | "save_reminder" | "ignore";
type SourceType = "note" | "file" | "reminder" | "folder" | "message";

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
  pendingAction?: PendingAction | null;
  actionResult?: ActionResult | null;
};

type ChatMessage = {
  id: number;
  role: "user" | "assistant" | string;
  content: string;
  createdAt?: string;
  metadata?: unknown;
};

type ChatAttachment = {
  id: number;
  name: string;
  mimeType: string | null;
  fileSize: number | null;
  folderId: number | null;
  folderName: string | null;
  textPreview: string | null;
  createdAt: string;
};

type MessageSource = {
  id: number | null;
  type: SourceType;
  title: string;
  snippet: string;
  folderName: string | null;
  date: string | null;
  score: number | undefined;
};

type PendingAction =
  | {
      action: "delete_item";
      itemId: number;
      itemType: ItemType;
      title: string;
    }
  | {
      action: "delete_folder";
      folderId: number;
      title: string;
    }
  | {
      action: "clear_chat";
      conversationId: number;
    };

type ActionResult = {
  success: boolean;
  action: string;
  error?: string;
};

const MAX_CHAT_ATTACHMENT_SIZE = 20 * 1024 * 1024;

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

  if (typeof intentType !== "string") {
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

  let pendingAction: PendingAction | null = null;
  const rawPendingAction = source.pendingAction;
  if (rawPendingAction && typeof rawPendingAction === "object") {
    const action = rawPendingAction as Record<string, unknown>;
    if (
      action.action === "delete_item" &&
      typeof action.itemId === "number" &&
      (action.itemType === "note" || action.itemType === "file" || action.itemType === "reminder") &&
      typeof action.title === "string"
    ) {
      pendingAction = {
        action: "delete_item",
        itemId: action.itemId,
        itemType: action.itemType,
        title: action.title,
      };
    } else if (action.action === "delete_folder" && typeof action.folderId === "number" && typeof action.title === "string") {
      pendingAction = {
        action: "delete_folder",
        folderId: action.folderId,
        title: action.title,
      };
    } else if (action.action === "clear_chat" && typeof action.conversationId === "number") {
      pendingAction = {
        action: "clear_chat",
        conversationId: action.conversationId,
      };
    }
  }

  let actionResult: ActionResult | null = null;
  const rawActionResult = source.actionResult;
  if (rawActionResult && typeof rawActionResult === "object") {
    const result = rawActionResult as Record<string, unknown>;
    if (typeof result.success === "boolean" && typeof result.action === "string") {
      actionResult = {
        success: result.success,
        action: result.action,
        error: typeof result.error === "string" ? result.error : undefined,
      };
    }
  }

  return {
    intentType: intentType as IntentType,
    responseMode,
    autoSaved: source.autoSaved === true,
    assistantReply: typeof source.assistantReply === "string" ? source.assistantReply : undefined,
    savedItem,
    suggestedActions,
    pendingAction,
    actionResult,
  };
}

function readMessageAttachments(raw: unknown): ChatAttachment[] {
  if (!raw || typeof raw !== "object") return [];
  const attachments = (raw as Record<string, unknown>).attachments;
  if (!Array.isArray(attachments)) return [];

  return attachments
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const source = entry as Record<string, unknown>;
      if (typeof source.id !== "number" || typeof source.name !== "string") return null;
      return {
        id: source.id,
        name: source.name,
        mimeType: typeof source.mimeType === "string" ? source.mimeType : null,
        fileSize: typeof source.fileSize === "number" ? source.fileSize : null,
        folderId: typeof source.folderId === "number" ? source.folderId : null,
        folderName: typeof source.folderName === "string" ? source.folderName : null,
        textPreview: typeof source.textPreview === "string" ? source.textPreview : null,
        createdAt: typeof source.createdAt === "string" ? source.createdAt : "",
      } satisfies ChatAttachment;
    })
    .filter((entry): entry is ChatAttachment => entry !== null);
}

function readMessageSources(raw: unknown): MessageSource[] {
  if (!raw || typeof raw !== "object") return [];
  const sources = (raw as Record<string, unknown>).sources;
  if (!Array.isArray(sources)) return [];

  return sources
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const source = entry as Record<string, unknown>;
      if (
        typeof source.title !== "string" ||
        (source.type !== "note" &&
          source.type !== "file" &&
          source.type !== "reminder" &&
          source.type !== "folder" &&
          source.type !== "message")
      ) {
        return null;
      }

      return {
        id: typeof source.id === "number" ? source.id : null,
        type: source.type,
        title: source.title,
        snippet: typeof source.snippet === "string" ? source.snippet : "",
        folderName: typeof source.folderName === "string" ? source.folderName : null,
        date: typeof source.date === "string" ? source.date : null,
        score: typeof source.score === "number" ? source.score : undefined,
      } satisfies MessageSource;
    })
    .filter((entry): entry is MessageSource => entry !== null);
}

function formatBytes(bytes?: number | null, decimals = 1) {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (typeof result !== "string") {
        reject(new Error("Invalid file data"));
        return;
      }
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
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
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [pendingFileAttachments, setPendingFileAttachments] = useState<ChatAttachment[]>([]);
  const [isLoadingDefaultChat, setIsLoadingDefaultChat] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const composerAreaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [composerHeight, setComposerHeight] = useState(160);

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
    let cancelled = false;

    const loadDefaultConversation = async () => {
      setIsLoadingDefaultChat(true);
      try {
        const token = localStorage.getItem("mindvault_token");
        const response = await fetch("/api/gemini/conversations/default", {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });

        if (!response.ok) throw new Error("Default chat loading failed");

        const conversation = await response.json();
        if (cancelled) return;

        setActiveConversationId(conversation.id);
        queryClient.setQueryData(getGetGeminiConversationQueryKey(conversation.id), conversation);
      } catch {
        if (!cancelled) {
          toast.error("Не удалось загрузить главный чат");
        }
      } finally {
        if (!cancelled) setIsLoadingDefaultChat(false);
      }
    };

    loadDefaultConversation();

    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  useEffect(() => {
    if (!activeConversationId) return;
    const raw = localStorage.getItem("mindvault_pending_file_question");
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as { prompt?: unknown; attachments?: unknown };
      const attachments = Array.isArray(parsed.attachments)
        ? parsed.attachments
            .map((entry) => {
              if (!entry || typeof entry !== "object") return null;
              const source = entry as Record<string, unknown>;
              if (typeof source.id !== "number" || typeof source.name !== "string") return null;
              return {
                id: source.id,
                name: source.name,
                mimeType: typeof source.mimeType === "string" ? source.mimeType : null,
                fileSize: typeof source.fileSize === "number" ? source.fileSize : null,
                folderId: typeof source.folderId === "number" ? source.folderId : null,
                folderName: typeof source.folderName === "string" ? source.folderName : null,
                textPreview: typeof source.textPreview === "string" ? source.textPreview : null,
                createdAt: typeof source.createdAt === "string" ? source.createdAt : new Date().toISOString(),
              } satisfies ChatAttachment;
            })
            .filter((entry): entry is ChatAttachment => entry !== null)
        : [];

      if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
        setInput(parsed.prompt.trim());
      }
      if (attachments.length > 0) {
        setPendingFileAttachments(attachments);
      }
      localStorage.removeItem("mindvault_pending_file_question");
    } catch {
      localStorage.removeItem("mindvault_pending_file_question");
    }
  }, [activeConversationId]);

  useEffect(() => {
    const element = composerAreaRef.current;
    if (!element) return;

    const updateComposerHeight = () => {
      setComposerHeight(Math.ceil(element.getBoundingClientRect().height));
    };

    updateComposerHeight();
    const frame = window.requestAnimationFrame(updateComposerHeight);

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateComposerHeight);
      return () => {
        window.cancelAnimationFrame(frame);
        window.removeEventListener("resize", updateComposerHeight);
      };
    }

    const observer = new ResizeObserver(updateComposerHeight);
    observer.observe(element);
    window.addEventListener("resize", updateComposerHeight);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", updateComposerHeight);
    };
  }, [activeConversationId, isLoadingDefaultChat]);

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
  };

  const handleMessagesScroll = () => {
    const nearBottom = getIsNearBottom();
    setIsNearBottom(nearBottom);
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

  const uploadSelectedFiles = async (files: File[]): Promise<ChatAttachment[]> => {
    const folderId = toFolderIdFromContext(saveFolderContext);
    const uploadedAttachments: ChatAttachment[] = [];

    for (const file of files) {
      const base64 = await fileToBase64(file);
      const uploaded = (await uploadFile.mutateAsync({
        data: {
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          fileSize: file.size,
          fileData: base64,
          folderId,
        },
      })) as any;

      uploadedAttachments.push({
        id: uploaded.id,
        name: uploaded.originalFilename || uploaded.title || file.name,
        mimeType: uploaded.mimeType || file.type || null,
        fileSize: uploaded.fileSize ?? file.size,
        folderId: uploaded.folderId ?? null,
        folderName: uploaded.folderName ?? null,
        textPreview: typeof uploaded.content === "string" ? uploaded.content : null,
        createdAt: uploaded.createdAt || new Date().toISOString(),
      });
    }

    queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
    return uploadedAttachments;
  };

  const handleCopyMessage = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      toast.success("Сообщение скопировано");
    } catch {
      toast.error("Не удалось скопировать сообщение");
    }
  };

  const handleDeleteMessage = async (message: ChatMessage) => {
    if (!window.confirm("Удалить это сообщение из истории чата?")) return;

    try {
      const token = localStorage.getItem("mindvault_token");
      const response = await fetch(`/api/gemini/messages/${message.id}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

      if (!response.ok) throw new Error("Delete failed");

      if (activeConversationId) {
        queryClient.setQueryData(getGetGeminiConversationQueryKey(activeConversationId), (old: any) => {
          if (!old || !Array.isArray(old.messages)) return old;
          return {
            ...old,
            messages: old.messages.filter((entry: ChatMessage) => entry.id !== message.id),
          };
        });
      }
      toast.success("Сообщение удалено");
    } catch {
      toast.error("Не удалось удалить сообщение");
    }
  };

  const handleSaveMessageAsNote = async (message: ChatMessage) => {
    const content = message.content.trim();
    if (!content) return;

    try {
      await createItem.mutateAsync({
        data: {
          type: "note",
          title: buildTitleFromText(content, "Заметка из чата"),
          content,
          folderId: toFolderIdFromContext(saveFolderContext),
        },
      });
      toast.success("Сохранено в заметки");
    } catch {
      toast.error("Не удалось сохранить заметку");
    }
  };

  const handleClearChat = async () => {
    if (!activeConversationId) return;
    if (!window.confirm("Очистить историю чата? Это действие нельзя отменить.")) return;

    try {
      const token = localStorage.getItem("mindvault_token");
      const response = await fetch(`/api/gemini/conversations/${activeConversationId}/messages`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

      if (!response.ok) throw new Error("Clear failed");

      queryClient.setQueryData(getGetGeminiConversationQueryKey(activeConversationId), (old: any) =>
        old ? { ...old, messages: [] } : old,
      );
      setStreamingMessage("");
      toast.success("История чата очищена");
    } catch {
      toast.error("Не удалось очистить историю чата");
    }
  };

  const handleSend = async (overrideContent?: string) => {
    const isOverrideMessage = typeof overrideContent === "string";
    const trimmedInput = isOverrideMessage ? overrideContent.trim() : input.trim();
    const filesToUpload = isOverrideMessage ? [] : selectedFiles;
    const existingAttachments = isOverrideMessage ? [] : pendingFileAttachments;
    if ((!trimmedInput && filesToUpload.length === 0 && existingAttachments.length === 0) || !activeConversationId || isStreaming) return;

    const messageContent =
      trimmedInput ||
      `Прикреплен файл: ${[...existingAttachments.map((file) => file.name), ...filesToUpload.map((file) => file.name)].join(", ")}`;
    if (!isOverrideMessage) {
      setInput("");
      setSelectedFiles([]);
      setPendingFileAttachments([]);
    }
    setIsNearBottom(true);

    let attachments: ChatAttachment[] = [...existingAttachments];
    if (filesToUpload.length > 0) {
      try {
        const uploadPromise = uploadSelectedFiles(filesToUpload);
        toast.promise(uploadPromise, {
          loading: "Загружаем файл...",
          success: "Файл сохранен",
          error: "Не удалось загрузить файл",
        });
        attachments = await uploadPromise;
      } catch {
        if (!isOverrideMessage) {
          setInput(messageContent);
          setSelectedFiles(filesToUpload);
          setPendingFileAttachments(existingAttachments);
        }
        return;
      }
    }

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
            metadata: attachments.length > 0 ? { attachments } : null,
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
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
      } else if (
        classification?.responseMode === "action_executed" &&
        typeof classification?.message === "string" &&
        classification.message.trim()
      ) {
        toast.success(classification.message);
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
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
          attachments,
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
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    const oversized = files.find((file) => file.size > MAX_CHAT_ATTACHMENT_SIZE);
    if (oversized) {
      toast.error(`Файл "${oversized.name}" больше ${formatBytes(MAX_CHAT_ATTACHMENT_SIZE)}`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setSelectedFiles((current) => [...current, ...files].slice(0, 5));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const renderAttachmentCards = (attachments: ChatAttachment[]) => {
    if (attachments.length === 0) return null;

    return (
      <div className="mt-2 flex w-full flex-col gap-1.5">
        {attachments.map((attachment) => (
          <button
            key={attachment.id}
            type="button"
            className="flex max-w-full items-center gap-2 rounded-xl border border-border/50 bg-background/70 px-3 py-2 text-left text-xs text-foreground shadow-sm transition-colors hover:bg-accent/40"
            onClick={() => setLocation("/files")}
            title={attachment.name}
          >
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{attachment.name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {attachment.mimeType || "file"} • {formatBytes(attachment.fileSize)}
              </span>
            </span>
          </button>
        ))}
      </div>
    );
  };

  const sourceTypeLabel = (type: SourceType) => {
    if (type === "note") return "Заметка";
    if (type === "file") return "Файл";
    if (type === "reminder") return "Напоминание";
    if (type === "folder") return "Папка";
    return "Чат";
  };

  const handleOpenSource = (source: MessageSource) => {
    if (source.type === "note") setLocation("/notes");
    if (source.type === "file") setLocation("/files");
    if (source.type === "reminder") setLocation("/reminders");
    if (source.type === "folder" && source.id) setLocation(`/folders/${source.id}`);
  };

  const renderSourceCards = (sources: MessageSource[]) => {
    if (sources.length === 0) return null;

    return (
      <div className="mt-2 w-full max-w-full rounded-xl border border-border/50 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
        <div className="mb-1 font-medium text-foreground">Использовано:</div>
        <div className="flex flex-wrap gap-1.5">
          {sources.slice(0, 6).map((source, index) => {
            const clickable = source.type !== "message";
            return (
              <button
                key={`${source.type}-${source.id ?? source.title}-${index}`}
                type="button"
                className={cn(
                  "max-w-full rounded-lg border border-border/50 bg-card px-2 py-1 text-left text-[11px] transition-colors",
                  clickable ? "hover:border-primary/40 hover:text-foreground" : "cursor-default",
                )}
                onClick={() => {
                  if (clickable) handleOpenSource(source);
                }}
              >
                <span className="font-medium">{sourceTypeLabel(source.type)} </span>
                <span className="break-words">«{source.title}»</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const renderPendingActionCard = (context: AssistantMessageContext | null) => {
    const pending = context?.pendingAction;
    if (!pending) return null;

    const title =
      pending.action === "clear_chat"
        ? "Очистить историю чата?"
        : pending.action === "delete_folder"
          ? `Удалить папку «${pending.title}»?`
          : `Удалить ${pending.itemType === "file" ? "файл" : pending.itemType === "reminder" ? "напоминание" : "заметку"} «${pending.title}»?`;
    const hint =
      pending.action === "clear_chat"
        ? "Заметки, файлы, папки и напоминания не будут удалены."
        : "Действие будет выполнено только после подтверждения.";

    return (
      <div className="mt-2 w-full rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs text-amber-950">
        <div className="font-medium">{title}</div>
        <div className="mt-0.5 text-amber-900/80">{hint}</div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            className="h-7 rounded-lg px-2.5 text-[11px]"
            onClick={() => handleSend("да")}
            disabled={isStreaming}
          >
            Подтвердить
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 rounded-lg px-2.5 text-[11px] bg-background/60"
            onClick={() => handleSend("отмена")}
            disabled={isStreaming}
          >
            Отмена
          </Button>
        </div>
      </div>
    );
  };

  const renderMessageActions = (message: ChatMessage, index: number) => {
    const messageMenu = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg text-muted-foreground">
            <MoreHorizontal className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={message.role === "user" ? "end" : "start"}>
          <DropdownMenuItem onClick={() => handleCopyMessage(message)}>
            <Copy className="w-4 h-4" />
            Скопировать
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleSaveMessageAsNote(message)}>
            <Save className="w-4 h-4" />
            Сохранить как заметку
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleDeleteMessage(message)}>
            <Trash2 className="w-4 h-4" />
            Удалить сообщение
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    if (message.role !== "assistant") {
      return <div className="mt-1 flex px-1">{messageMenu}</div>;
    }

    const context = readAssistantContext((message as any).metadata);
    if (!context) return <div className="mt-1 flex px-1">{messageMenu}</div>;

    const savedItem = context.savedItem ?? null;
    const hasSuggestedActions = !savedItem && (context.suggestedActions?.length ?? 0) > 0;
    if (!savedItem && !hasSuggestedActions) return <div className="mt-1 flex px-1">{messageMenu}</div>;

    const sourceUserContent = getPreviousUserMessage(conversationMessages, index);
    const actionsDisabled =
      updateItem.isPending || deleteItem.isPending || isConvertingType || isSavingSuggested;

    return (
      <div className="mt-2 flex flex-wrap gap-1.5 px-1">
        {messageMenu}
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
      <div className="flex-1 min-w-0 flex flex-col relative bg-card/10">
        {isLoadingDefaultChat || !activeConversationId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Загрузка чата...
          </div>
        ) : (
          <>
            <div
              ref={messagesContainerRef}
              onScroll={handleMessagesScroll}
              className="flex-1 min-h-0 overflow-y-auto px-3 py-4 sm:px-4"
            >
              <div
                className="max-w-5xl mx-auto space-y-5 sm:space-y-6"
                style={{ paddingBottom: `${composerHeight + 24}px` }}
              >
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
                    <div className={cn("flex flex-col max-w-[88%] sm:max-w-[82%] min-w-0", msg.role === "user" ? "items-end" : "items-start")}>
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
                      {renderAttachmentCards(readMessageAttachments(msg.metadata))}
                      {msg.role === "assistant" ? renderSourceCards(readMessageSources(msg.metadata)) : null}
                      {msg.role === "assistant" ? renderPendingActionCard(readAssistantContext(msg.metadata)) : null}
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
                    <div className="flex flex-col max-w-[88%] sm:max-w-[82%] min-w-0 items-start">
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
                    <div className="flex flex-col max-w-[88%] sm:max-w-[82%] min-w-0 items-start">
                      <div className="px-4 py-3 rounded-2xl shadow-sm text-sm leading-relaxed bg-card border border-border/50 text-card-foreground rounded-tl-sm">
                        ИИ печатает...
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {!isNearBottom ? (
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label="Прокрутить к последнему сообщению"
                title="Вниз"
                className="absolute left-1/2 z-20 h-10 w-10 -translate-x-1/2 rounded-full border-border/60 bg-background/95 p-0 text-foreground shadow-lg shadow-black/10 backdrop-blur transition hover:bg-secondary"
                style={{ bottom: `${composerHeight + 12}px` }}
                onClick={() => scrollToBottom(true)}
              >
                <ArrowDown className="w-4 h-4" />
              </Button>
            ) : null}

            <div
              ref={composerAreaRef}
              className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background via-background to-transparent px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-10 pointer-events-none sm:p-4 sm:pt-10"
            >
              {pendingFileAttachments.length > 0 ? (
                <div className="mx-auto mb-2 flex max-w-5xl flex-col gap-2 pointer-events-auto">
                  {pendingFileAttachments.map((attachment) => (
                    <div
                      key={`existing-${attachment.id}`}
                      className="flex items-center gap-2 rounded-xl border border-border/50 bg-card px-3 py-2 text-xs shadow-sm"
                    >
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{attachment.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          Уже в файлах • {attachment.mimeType || "file"} • {formatBytes(attachment.fileSize)}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 rounded-lg"
                        onClick={() => setPendingFileAttachments((current) => current.filter((entry) => entry.id !== attachment.id))}
                        disabled={isStreaming}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
              {selectedFiles.length > 0 ? (
                <div className="mx-auto mb-2 flex max-w-5xl flex-col gap-2 pointer-events-auto">
                  {selectedFiles.map((file, index) => (
                    <div
                      key={`${file.name}-${file.size}-${index}`}
                      className="flex items-center gap-2 rounded-xl border border-border/50 bg-card px-3 py-2 text-xs shadow-sm"
                    >
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{file.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {file.type || "file"} • {formatBytes(file.size)}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 rounded-lg"
                        onClick={() => setSelectedFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}
                        disabled={isStreaming}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="max-w-5xl mx-auto relative flex flex-wrap sm:flex-nowrap items-end gap-2 bg-card rounded-2xl border border-border/50 shadow-lg p-2 focus-within:ring-1 focus-within:ring-primary/50 transition-all pointer-events-auto">
                <input type="file" className="hidden" ref={fileInputRef} onChange={handleFileUpload} multiple />
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 rounded-xl text-muted-foreground hover:text-foreground h-10 w-10"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStreaming}
                >
                  <Paperclip className="w-5 h-5" />
                </Button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0 rounded-xl text-muted-foreground hover:text-foreground h-10 w-10"
                      disabled={isStreaming}
                    >
                      <MoreHorizontal className="w-5 h-5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" className="w-48">
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      disabled={isStreaming || conversationMessages.length === 0}
                      onClick={handleClearChat}
                    >
                      <Eraser className="w-4 h-4" />
                      Очистить чат
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <Select value={saveFolderContext} onValueChange={setSaveFolderContext}>
                  <SelectTrigger className="w-[calc(100vw-10.5rem)] sm:w-[210px] h-10 border-border/40 bg-background/60 text-xs shrink-0">
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
                  onClick={() => handleSend()}
                  disabled={(!input.trim() && selectedFiles.length === 0 && pendingFileAttachments.length === 0) || isStreaming}
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
              <div className="max-w-5xl mx-auto mt-2 text-center pointer-events-auto">
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
