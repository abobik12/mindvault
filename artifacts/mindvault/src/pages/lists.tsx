import { type FormEvent, useMemo, useState } from "react";
import {
  useListItems,
  useCreateItem,
  useUpdateItem,
  useDeleteItem,
  getListItemsQueryKey,
  getListFoldersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Search, ListChecks, Plus, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatMoscowDateShort } from "@/lib/time";

type TodoListEntry = {
  id: string;
  text: string;
  done: boolean;
};

function readTodoItems(content?: string | null): TodoListEntry[] {
  if (!content) return [];

  try {
    const parsed = JSON.parse(content) as { kind?: string; items?: unknown };
    if (parsed.kind !== "todo-list" || !Array.isArray(parsed.items)) return [];

    return parsed.items
      .map((entry, index) => {
        if (!entry || typeof entry !== "object") return null;
        const source = entry as Record<string, unknown>;
        if (typeof source.text !== "string" || !source.text.trim()) return null;
        return {
          id: typeof source.id === "string" ? source.id : `item-${index}`,
          text: source.text,
          done: source.done === true,
        };
      })
      .filter((entry): entry is TodoListEntry => Boolean(entry));
  } catch {
    return [];
  }
}

function writeTodoItems(items: TodoListEntry[]): string {
  return JSON.stringify({ kind: "todo-list", items });
}

function parseListItems(value: string): TodoListEntry[] {
  return value
    .split(/[\n;,]+/g)
    .map((entry) => entry.trim().replace(/^[-*•\d.)\s]+/, ""))
    .filter(Boolean)
    .map((text, index) => ({
      id: `item-${Date.now()}-${index}`,
      text,
      done: false,
    }));
}

export default function ListsPage() {
  const [search, setSearch] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newListTitle, setNewListTitle] = useState("");
  const [newListItems, setNewListItems] = useState("");
  const queryClient = useQueryClient();

  const { data: lists = [], isLoading } = useListItems(
    { type: "list", status: "active" },
    { query: { queryKey: getListItemsQueryKey({ type: "list", status: "active" }) } },
  );

  const createItem = useCreateItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
        setIsCreateOpen(false);
        setNewListTitle("");
        setNewListItems("");
        toast.success("Список создан");
      },
      onError: () => toast.error("Не удалось создать список"),
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
        toast.success("Список удален");
      },
    },
  });

  const visibleLists = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return lists;

    return lists.filter((list) => {
      const itemsText = readTodoItems(list.content).map((entry) => entry.text).join(" ");
      return `${list.title} ${itemsText}`.toLowerCase().includes(query);
    });
  }, [lists, search]);

  const handleToggle = async (list: (typeof lists)[number], entryId: string) => {
    const nextItems = readTodoItems(list.content).map((entry) =>
      entry.id === entryId ? { ...entry, done: !entry.done } : entry,
    );

    try {
      await updateItem.mutateAsync({ id: list.id, data: { content: writeTodoItems(nextItems) } });
    } catch {
      toast.error("Не удалось обновить пункт");
    }
  };

  const handleAddItem = async (list: (typeof lists)[number]) => {
    const text = window.prompt("Новый пункт списка");
    const normalized = text?.trim();
    if (!normalized) return;

    const nextItems = [
      ...readTodoItems(list.content),
      { id: `item-${Date.now()}`, text: normalized, done: false },
    ];

    try {
      await updateItem.mutateAsync({ id: list.id, data: { content: writeTodoItems(nextItems) } });
      toast.success("Пункт добавлен");
    } catch {
      toast.error("Не удалось добавить пункт");
    }
  };

  const handleDeleteList = (list: (typeof lists)[number]) => {
    const confirmed = window.confirm(`Удалить список «${list.title}»?`);
    if (!confirmed) return;
    deleteItem.mutate({ id: list.id });
  };

  const handleCreateList = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = newListTitle.trim() || "Список";
    const items = parseListItems(newListItems);

    if (items.length === 0) {
      toast.error("Добавьте хотя бы один пункт списка");
      return;
    }

    createItem.mutate({
      data: {
        type: "list",
        title,
        content: writeTodoItems(items),
      },
    });
  };

  return (
    <div className="h-full min-h-0 flex flex-col p-4 sm:p-6 bg-slate-50/50 dark:bg-transparent overflow-y-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 sm:mb-8">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">Списки</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Здесь хранятся ваши списки дел, покупок и задач. Создавайте их через чат или вручную.
          </p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="w-full sm:w-auto shadow-md shadow-primary/20 gap-2">
              <Plus className="w-4 h-4" />
              Создать список
            </Button>
          </DialogTrigger>
          <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-[560px]">
            <DialogHeader>
              <DialogTitle>Создать список</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreateList} className="space-y-4">
              <Input
                placeholder="Название списка"
                value={newListTitle}
                onChange={(event) => setNewListTitle(event.target.value)}
                className="text-lg font-medium"
              />
              <Textarea
                placeholder={"Пункты списка через запятую или с новой строки\nхлеб\nмолоко\nяйца"}
                value={newListItems}
                onChange={(event) => setNewListItems(event.target.value)}
                className="min-h-[180px] resize-y"
              />
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

      <div className="relative mb-6 w-full max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Поиск по спискам..."
          className="pl-9 bg-card border-border/50 shadow-sm"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : visibleLists.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
          <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mb-4">
            <ListChecks className="w-8 h-8 text-muted-foreground/50" />
          </div>
          <p className="font-medium">Списков пока нет</p>
          <p className="max-w-md text-center text-sm opacity-70">
            Создайте список дел, покупок или задач через чат командой «список ...» или нажмите кнопку «Создать список».
          </p>
          <Button className="mt-4 shadow-md shadow-primary/20 gap-2" onClick={() => setIsCreateOpen(true)}>
            <Plus className="w-4 h-4" />
            Создать список
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 pb-12">
          {visibleLists.map((list) => {
            const items = readTodoItems(list.content);
            const doneCount = items.filter((entry) => entry.done).length;

            return (
              <Card key={list.id} className="border-border/50 shadow-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <CardTitle className="min-w-0 text-lg leading-tight">
                      <span className="line-clamp-2">{list.title}</span>
                    </CardTitle>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDeleteList(list)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">{doneCount}/{items.length} выполнено</Badge>
                    {list.folderName ? <Badge variant="outline">{list.folderName}</Badge> : null}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-2">
                    {items.length > 0 ? (
                      items.map((entry) => (
                        <label key={entry.id} className="flex cursor-pointer items-start gap-2 rounded-lg p-1 hover:bg-accent/40">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 rounded border-border"
                            checked={entry.done}
                            disabled={updateItem.isPending}
                            onChange={() => handleToggle(list, entry.id)}
                          />
                          <span className={cn("min-w-0 break-words text-sm", entry.done && "text-muted-foreground line-through")}>
                            {entry.text}
                          </span>
                        </label>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">Пункты списка пустые.</p>
                    )}
                  </div>

                  <div className="flex items-center justify-between border-t border-border/50 pt-3">
                    <span className="text-xs text-muted-foreground">{formatMoscowDateShort(list.updatedAt)}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-lg text-xs"
                      onClick={() => handleAddItem(list)}
                      disabled={updateItem.isPending}
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Пункт
                    </Button>
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
