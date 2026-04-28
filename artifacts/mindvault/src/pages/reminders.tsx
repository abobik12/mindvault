import { useState } from "react";
import {
  useListItems,
  useCreateItem,
  useUpdateItem,
  useDeleteItem,
  useGetUpcomingReminders,
  useListFolders,
  getListItemsQueryKey,
  getGetUpcomingRemindersQueryKey,
  getListFoldersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar as CalendarIcon, Clock, Plus, Trash2, CheckCircle2, Circle, Loader2, Folder as FolderIcon } from "lucide-react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { cn } from "@/lib/utils";
import { formatMoscowDateTime, isTodayInMoscow, parseMoscowDateTimeLocalToIso } from "@/lib/time";

const reminderSchema = z.object({
  title: z.string().min(1, "Введите название напоминания"),
  reminderAt: z.string().min(1, "Укажите дату и время"),
  folderId: z.string().optional(),
});

export default function RemindersPage() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: reminders = [], isLoading } = useListItems(
    { type: "reminder" },
    { query: { queryKey: getListItemsQueryKey({ type: "reminder" }) } },
  );
  const { data: upcomingReminders = [] } = useGetUpcomingReminders();
  const { data: folders = [] } = useListFolders();

  const userFolders = folders.filter((folder) => !folder.isSystem);

  const sortedReminders = [...reminders].sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "active" ? -1 : 1;
    }
    return new Date(a.reminderAt || 0).getTime() - new Date(b.reminderAt || 0).getTime();
  });

  const invalidateData = () => {
    queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetUpcomingRemindersQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
  };

  const createItem = useCreateItem({
    mutation: {
      onSuccess: () => {
        invalidateData();
        setIsCreateOpen(false);
        form.reset();
        toast.success("Напоминание создано");
      },
    },
  });

  const updateItem = useUpdateItem({
    mutation: {
      onSuccess: () => {
        invalidateData();
      },
    },
  });

  const deleteItem = useDeleteItem({
    mutation: {
      onSuccess: () => {
        invalidateData();
        toast.success("Напоминание удалено");
      },
    },
  });

  const form = useForm<z.infer<typeof reminderSchema>>({
    resolver: zodResolver(reminderSchema),
    defaultValues: { title: "", reminderAt: "", folderId: "none" },
  });

  const onSubmitCreate = (values: z.infer<typeof reminderSchema>) => {
    try {
      const reminderAtIso = parseMoscowDateTimeLocalToIso(values.reminderAt);

      createItem.mutate({
        data: {
          type: "reminder",
          title: values.title,
          reminderAt: reminderAtIso,
          folderId: values.folderId === "none" ? null : Number.parseInt(values.folderId || "0", 10),
        },
      });
    } catch {
      toast.error("Не удалось обработать дату и время");
    }
  };

  const toggleStatus = (reminder: any) => {
    const newStatus = reminder.status === "active" ? "completed" : "active";
    updateItem.mutate({
      id: reminder.id,
      data: { status: newStatus },
    });
  };

  const moveReminder = (reminder: any, value: string) => {
    const nextFolderId = value === "none" ? null : Number.parseInt(value, 10);
    if ((reminder.folderId ?? null) === nextFolderId) return;

    updateItem.mutate(
      {
        id: reminder.id,
        data: { folderId: nextFolderId },
      },
      {
        onSuccess: () => {
          toast.success("Напоминание перемещено");
        },
      },
    );
  };

  return (
    <div className="h-full flex flex-col p-6 bg-slate-50/50 dark:bg-transparent overflow-y-auto">
      <div className="flex items-center justify-between mb-8 shrink-0">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight text-foreground">Напоминания</h1>
          <p className="text-muted-foreground text-sm mt-1">Все даты и время отображаются по Москве (UTC+3).</p>
        </div>

        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="shadow-md shadow-primary/20 gap-2">
              <Plus className="w-4 h-4" />
              Новое напоминание
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Создать напоминание</DialogTitle>
            </DialogHeader>
            <form onSubmit={form.handleSubmit(onSubmitCreate)} className="space-y-4">
              <div className="space-y-2">
                <Input placeholder="Что нужно не забыть?" {...form.register("title")} />
                {form.formState.errors.title && (
                  <p className="text-destructive text-xs">{form.formState.errors.title.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Input type="datetime-local" {...form.register("reminderAt")} />
                <p className="text-[11px] text-muted-foreground">Время указывается в часовом поясе Москвы.</p>
                {form.formState.errors.reminderAt && (
                  <p className="text-destructive text-xs">{form.formState.errors.reminderAt.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Select onValueChange={(value) => form.setValue("folderId", value)} defaultValue="none">
                  <SelectTrigger>
                    <SelectValue placeholder="Папка" />
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
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createItem.isPending}>
                  {createItem.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Сохранить
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex-1 max-w-4xl mx-auto w-full space-y-8">
        {upcomingReminders.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-primary uppercase tracking-wider flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Ближайшие
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {upcomingReminders.map((reminder) => (
                <Card key={reminder.id} className="border-primary/20 bg-primary/5 shadow-sm">
                  <CardHeader className="p-4 pb-2">
                    <CardTitle className="text-base flex items-start justify-between">
                      <span className="line-clamp-2">{reminder.title}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 pt-0 flex justify-between items-end">
                    <div className="flex flex-col gap-1 text-xs font-medium text-primary">
                      <span className="flex items-center gap-1.5">
                        <CalendarIcon className="w-3.5 h-3.5" />
                        {reminder.reminderAt ? formatMoscowDateTime(reminder.reminderAt) : "Дата не указана"}
                      </span>
                      {reminder.folderName && (
                        <span className="flex items-center gap-1.5 text-[11px] text-primary/80">
                          <FolderIcon className="w-3 h-3" />
                          {reminder.folderName}
                        </span>
                      )}
                    </div>
                    <Button size="sm" onClick={() => toggleStatus(reminder)} className="h-8">
                      Выполнено
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Все напоминания</h2>

          {isLoading ? (
            <div className="flex items-center justify-center p-12">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : sortedReminders.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground bg-card rounded-2xl border border-border/50">
              <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mb-4">
                <Clock className="w-8 h-8 text-muted-foreground/50" />
              </div>
              <p className="font-medium">Напоминаний пока нет</p>
              <p className="text-sm opacity-70">Создайте напоминание, чтобы ничего не пропустить.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {sortedReminders.map((reminder) => {
                const reminderDate = reminder.reminderAt ? new Date(reminder.reminderAt) : null;
                const overdue =
                  reminder.status === "active" &&
                  !!reminderDate &&
                  reminderDate.getTime() < Date.now() &&
                  !isTodayInMoscow(reminderDate);

                return (
                  <div
                    key={reminder.id}
                    className={cn(
                      "group flex items-center gap-4 p-4 bg-card rounded-xl border transition-all",
                      reminder.status === "completed"
                        ? "border-border/40 opacity-60"
                        : overdue
                        ? "border-destructive/30 bg-destructive/5"
                        : "border-border/50 hover:border-primary/30 hover:shadow-sm",
                    )}
                  >
                    <button
                      onClick={() => toggleStatus(reminder)}
                      className={cn(
                        "shrink-0 transition-colors",
                        reminder.status === "completed"
                          ? "text-primary"
                          : "text-muted-foreground hover:text-primary",
                      )}
                    >
                      {reminder.status === "completed" ? (
                        <CheckCircle2 className="w-6 h-6" />
                      ) : (
                        <Circle className="w-6 h-6" />
                      )}
                    </button>

                    <div className="flex-1 min-w-0">
                      <p
                        className={cn(
                          "text-sm font-medium truncate",
                          reminder.status === "completed" ? "line-through text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {reminder.title}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1">
                        <CalendarIcon className={cn("w-3.5 h-3.5", overdue ? "text-destructive" : "text-muted-foreground")} />
                        <span className={cn("text-xs", overdue ? "text-destructive font-medium" : "text-muted-foreground")}>
                          {reminder.reminderAt ? formatMoscowDateTime(reminder.reminderAt) : "Дата не указана"}
                          {overdue && " (Просрочено)"}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        {reminder.folderName ? (
                          <Badge variant="secondary" className="text-[10px] gap-1 px-1.5">
                            <FolderIcon className="w-3 h-3" />
                            {reminder.folderName}
                          </Badge>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">Без папки</span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <Select
                        value={reminder.folderId ? String(reminder.folderId) : "none"}
                        onValueChange={(value) => moveReminder(reminder, value)}
                      >
                        <SelectTrigger className="w-[180px] h-8 text-xs">
                          <SelectValue placeholder="Переместить" />
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

                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => {
                          if (window.confirm("Удалить напоминание?")) {
                            deleteItem.mutate({ id: reminder.id });
                          }
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
