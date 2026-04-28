import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetFolder,
  useListItems,
  useListFolders,
  useCreateItem,
  useUploadFile,
  useUpdateItem,
  useDeleteItem,
  getListItemsQueryKey,
  getListFoldersQueryKey,
  getGetFolderQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Folder as FolderIcon,
  FileText,
  HardDrive,
  Clock,
  Loader2,
  Plus,
  Search,
  UploadCloud,
  Download,
  Trash2,
  Circle,
  CheckCircle2,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { formatMoscowDateTime, parseMoscowDateTimeLocalToIso } from "@/lib/time";

const noteSchema = z.object({
  title: z.string().min(1, "Введите заголовок"),
  content: z.string().min(1, "Введите текст заметки"),
});

const reminderSchema = z.object({
  title: z.string().min(1, "Введите название напоминания"),
  reminderAt: z.string().min(1, "Укажите дату и время"),
});

function getFileTypeSuffix(mimeType: string | null): string {
  if (!mimeType) return "FILE";
  return (mimeType.split("/")[1] || "FILE").toUpperCase();
}

function getTypeMeta(type: "note" | "file" | "reminder") {
  if (type === "note") return { label: "Заметка", icon: FileText };
  if (type === "file") return { label: "Файл", icon: HardDrive };
  return { label: "Напоминание", icon: Clock };
}

export default function FolderPage() {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const folderIdMatch = location.match(/^\/folders\/(\d+)\/?$/);
  const folderId = folderIdMatch ? Number.parseInt(folderIdMatch[1], 10) : Number.NaN;
  const isFolderIdValid = Number.isInteger(folderId) && folderId > 0;

  const [search, setSearch] = useState("");
  const [isCreateNoteOpen, setIsCreateNoteOpen] = useState(false);
  const [isCreateReminderOpen, setIsCreateReminderOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: folder, isLoading: isFolderLoading, isError: isFolderError } = useGetFolder(folderId, {
    query: {
      enabled: isFolderIdValid,
      retry: false,
    },
  });

  const { data: folders = [] } = useListFolders({
    query: {
      enabled: !!folder,
    },
  });

  const { data: items = [], isLoading: isItemsLoading } = useListItems(
    isFolderIdValid ? { folderId } : undefined,
    {
      query: {
        enabled: !!folder,
      },
    },
  );

  const noteForm = useForm<z.infer<typeof noteSchema>>({
    resolver: zodResolver(noteSchema),
    defaultValues: { title: "", content: "" },
  });

  const reminderForm = useForm<z.infer<typeof reminderSchema>>({
    resolver: zodResolver(reminderSchema),
    defaultValues: { title: "", reminderAt: "" },
  });

  const invalidateFolderData = () => {
    queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetFolderQueryKey(folderId) });
  };

  const createItem = useCreateItem({
    mutation: {
      onSuccess: () => {
        invalidateFolderData();
      },
      onError: () => {
        toast.error("Не удалось создать объект");
      },
    },
  });

  const uploadFile = useUploadFile({
    mutation: {
      onSuccess: () => {
        invalidateFolderData();
        toast.success("Файл загружен в папку");
      },
      onError: () => {
        toast.error("Не удалось загрузить файл");
      },
    },
  });

  const updateItem = useUpdateItem({
    mutation: {
      onSuccess: () => {
        invalidateFolderData();
      },
      onError: () => {
        toast.error("Не удалось обновить объект");
      },
    },
  });

  const deleteItem = useDeleteItem({
    mutation: {
      onSuccess: () => {
        invalidateFolderData();
        toast.success("Объект удален");
      },
      onError: () => {
        toast.error("Не удалось удалить объект");
      },
    },
  });

  const visibleItems = useMemo(() => {
    const sorted = [...items].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    if (!search.trim()) return sorted;

    const searchLower = search.toLowerCase();
    return sorted.filter((item) => {
      const inTitle = item.title.toLowerCase().includes(searchLower);
      const inContent = item.content?.toLowerCase().includes(searchLower);
      const inFilename = item.originalFilename?.toLowerCase().includes(searchLower);
      const inSummary = item.summary?.toLowerCase().includes(searchLower);
      return inTitle || inContent || inFilename || inSummary;
    });
  }, [items, search]);

  const movableFolders = folders.filter((entry) => !entry.isSystem);

  const onCreateNote = (values: z.infer<typeof noteSchema>) => {
    createItem.mutate(
      {
        data: {
          type: "note",
          title: values.title,
          content: values.content,
          folderId,
        },
      },
      {
        onSuccess: () => {
          noteForm.reset();
          setIsCreateNoteOpen(false);
          toast.success("Заметка сохранена в текущую папку");
        },
      },
    );
  };

  const onCreateReminder = (values: z.infer<typeof reminderSchema>) => {
    try {
      const reminderAtIso = parseMoscowDateTimeLocalToIso(values.reminderAt);

      createItem.mutate(
        {
          data: {
            type: "reminder",
            title: values.title,
            reminderAt: reminderAtIso,
            folderId,
          },
        },
        {
          onSuccess: () => {
            reminderForm.reset();
            setIsCreateReminderOpen(false);
            toast.success("Напоминание сохранено в текущую папку");
          },
        },
      );
    } catch {
      toast.error("Не удалось обработать дату и время");
    }
  };

  const onUploadFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = (e.target?.result as string).split(",")[1];

      uploadFile.mutate({
        data: {
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          fileSize: file.size,
          fileData: base64,
          folderId,
        },
      });
    };

    reader.readAsDataURL(file);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const onMoveItem = (itemId: number, newFolderValue: string, currentFolderId: number | null) => {
    const nextFolderId = newFolderValue === "none" ? null : Number.parseInt(newFolderValue, 10);
    if (Number.isNaN(nextFolderId as number)) return;
    if ((currentFolderId ?? null) === nextFolderId) return;

    updateItem.mutate(
      {
        id: itemId,
        data: { folderId: nextFolderId },
      },
      {
        onSuccess: () => {
          toast.success("Объект перемещен");
        },
      },
    );
  };

  const onToggleReminderStatus = (item: (typeof items)[number]) => {
    if (item.type !== "reminder") return;

    const nextStatus = item.status === "completed" ? "active" : "completed";
    updateItem.mutate({
      id: item.id,
      data: { status: nextStatus },
    });
  };

  const onDownloadFile = (fileItem: (typeof items)[number]) => {
    if (fileItem.type !== "file" || !fileItem.fileData) {
      toast.error("Файл недоступен для скачивания");
      return;
    }

    try {
      const byteCharacters = atob(fileItem.fileData);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }

      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], {
        type: fileItem.mimeType || "application/octet-stream",
      });

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileItem.originalFilename || fileItem.title;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Не удалось скачать файл");
    }
  };

  const openSectionForItem = (item: (typeof items)[number]) => {
    if (item.type === "note") {
      setLocation("/notes");
      return;
    }

    if (item.type === "file") {
      setLocation("/files");
      return;
    }

    setLocation("/reminders");
  };

  if (!isFolderIdValid) {
    return (
      <div className="h-full p-6 flex items-center justify-center">
        <Card className="max-w-md w-full border-border/50">
          <CardContent className="p-6 text-center space-y-3">
            <p className="text-lg font-semibold">Неверный адрес папки</p>
            <p className="text-sm text-muted-foreground">Проверьте ссылку и попробуйте снова.</p>
            <Button onClick={() => setLocation("/")}>Вернуться на главную</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isFolderLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isFolderError || !folder) {
    return (
      <div className="h-full p-6 flex items-center justify-center">
        <Card className="max-w-md w-full border-border/50">
          <CardContent className="p-6 text-center space-y-3">
            <p className="text-lg font-semibold">Папка не найдена</p>
            <p className="text-sm text-muted-foreground">
              Возможно, папка удалена или у вас нет доступа к ней.
            </p>
            <Button onClick={() => setLocation("/")}>Вернуться на главную</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6 bg-slate-50/50 dark:bg-transparent overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight text-foreground flex items-center gap-2">
            <FolderIcon className="w-7 h-7 text-primary" />
            {folder.name}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            В папке {folder.itemCount} {folder.itemCount === 1 ? "объект" : folder.itemCount < 5 ? "объекта" : "объектов"}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Dialog open={isCreateNoteOpen} onOpenChange={setIsCreateNoteOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Plus className="w-4 h-4" />
                Заметка
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[600px]">
              <DialogHeader>
                <DialogTitle>Новая заметка в папке «{folder.name}»</DialogTitle>
              </DialogHeader>
              <form onSubmit={noteForm.handleSubmit(onCreateNote)} className="space-y-4">
                <Input placeholder="Заголовок" {...noteForm.register("title")} />
                {noteForm.formState.errors.title && (
                  <p className="text-destructive text-xs">{noteForm.formState.errors.title.message}</p>
                )}
                <Textarea placeholder="Текст заметки" className="min-h-[180px]" {...noteForm.register("content")} />
                {noteForm.formState.errors.content && (
                  <p className="text-destructive text-xs">{noteForm.formState.errors.content.message}</p>
                )}
                <DialogFooter>
                  <Button type="submit" disabled={createItem.isPending}>
                    {createItem.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                    Сохранить
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={isCreateReminderOpen} onOpenChange={setIsCreateReminderOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Clock className="w-4 h-4" />
                Напоминание
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>Новое напоминание в папке «{folder.name}»</DialogTitle>
              </DialogHeader>
              <form onSubmit={reminderForm.handleSubmit(onCreateReminder)} className="space-y-4">
                <Input placeholder="Название напоминания" {...reminderForm.register("title")} />
                {reminderForm.formState.errors.title && (
                  <p className="text-destructive text-xs">{reminderForm.formState.errors.title.message}</p>
                )}
                <Input type="datetime-local" {...reminderForm.register("reminderAt")} />
                <p className="text-[11px] text-muted-foreground">Время указывается в часовом поясе Москвы.</p>
                {reminderForm.formState.errors.reminderAt && (
                  <p className="text-destructive text-xs">{reminderForm.formState.errors.reminderAt.message}</p>
                )}
                <DialogFooter>
                  <Button type="submit" disabled={createItem.isPending}>
                    {createItem.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                    Сохранить
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          <input type="file" ref={fileInputRef} className="hidden" onChange={onUploadFile} />
          <Button className="gap-2" onClick={() => fileInputRef.current?.click()} disabled={uploadFile.isPending}>
            {uploadFile.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
            Загрузить файл
          </Button>
        </div>
      </div>

      <div className="relative mb-4 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Поиск внутри папки"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="pl-9 bg-card border-border/50 shadow-sm"
        />
      </div>

      {isItemsLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : visibleItems.length === 0 ? (
        <Card className="border-dashed border-border/70 bg-card/70">
          <CardContent className="p-10 text-center space-y-3">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-muted flex items-center justify-center">
              <FolderIcon className="w-7 h-7 text-muted-foreground/60" />
            </div>
            <p className="text-lg font-semibold">
              {search.trim() ? "Ничего не найдено" : "В этой папке пока нет объектов"}
            </p>
            <p className="text-sm text-muted-foreground">
              {search.trim()
                ? "Попробуйте изменить запрос поиска."
                : "Создайте заметку, добавьте напоминание или загрузите файл в эту папку."}
            </p>
            {!search.trim() && (
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <Button variant="outline" onClick={() => setIsCreateNoteOpen(true)}>
                  Создать заметку
                </Button>
                <Button variant="outline" onClick={() => setIsCreateReminderOpen(true)}>
                  Добавить напоминание
                </Button>
                <Button onClick={() => fileInputRef.current?.click()}>Загрузить файл</Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3 pb-12">
          {visibleItems.map((item) => {
            const { label, icon: ItemIcon } = getTypeMeta(item.type);

            return (
              <Card key={item.id} className="border-border/50 shadow-sm">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-base flex items-center gap-2 min-w-0">
                        <span className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                          <ItemIcon className="w-4 h-4" />
                        </span>
                        <span className="truncate">{item.title}</span>
                      </CardTitle>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Badge variant="secondary">{label}</Badge>
                        {item.type === "reminder" && item.status === "completed" && (
                          <Badge variant="outline">Выполнено</Badge>
                        )}
                        {item.type === "file" && (
                          <Badge variant="outline">{getFileTypeSuffix(item.mimeType)}</Badge>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={item.folderId ? String(item.folderId) : "none"}
                        onValueChange={(value) => onMoveItem(item.id, value, item.folderId)}
                      >
                        <SelectTrigger className="w-[180px] h-8">
                          <SelectValue placeholder="Переместить" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Без папки</SelectItem>
                          {movableFolders.map((entry) => (
                            <SelectItem key={entry.id} value={String(entry.id)}>
                              {entry.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openSectionForItem(item)}>
                        <ArrowUpRight className="w-4 h-4" />
                      </Button>

                      {item.type === "file" && item.fileData && (
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onDownloadFile(item)}>
                          <Download className="w-4 h-4" />
                        </Button>
                      )}

                      {item.type === "reminder" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => onToggleReminderStatus(item)}
                        >
                          {item.status === "completed" ? (
                            <CheckCircle2 className="w-4 h-4 text-primary" />
                          ) : (
                            <Circle className="w-4 h-4" />
                          )}
                        </Button>
                      )}

                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          if (window.confirm("Удалить объект?")) {
                            deleteItem.mutate({ id: item.id });
                          }
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="pt-0">
                  {item.type === "note" && (item.summary || item.content) && (
                    <p className="text-sm text-muted-foreground line-clamp-3">{item.summary || item.content}</p>
                  )}

                  {item.type === "reminder" && (
                    <p className="text-sm text-muted-foreground">
                      {item.reminderAt ? `Срок: ${formatMoscowDateTime(item.reminderAt)}` : "Дата не указана"}
                    </p>
                  )}

                  {item.type === "file" && (
                    <p className="text-sm text-muted-foreground line-clamp-1">{item.originalFilename || item.title}</p>
                  )}

                  <div className="mt-3 text-xs text-muted-foreground flex flex-wrap gap-4">
                    <span>Создан: {formatMoscowDateTime(item.createdAt)}</span>
                    <span>Обновлен: {formatMoscowDateTime(item.updatedAt)}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
