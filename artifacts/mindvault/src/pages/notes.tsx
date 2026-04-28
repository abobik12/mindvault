import { useState } from "react";
import {
  useListItems,
  useCreateItem,
  useUpdateItem,
  useDeleteItem,
  getListItemsQueryKey,
  useListFolders,
  getListFoldersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Plus, FileText, Trash2, Folder as FolderIcon, Loader2, Tag, Pencil } from "lucide-react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { formatMoscowDateShort } from "@/lib/time";

const noteSchema = z.object({
  title: z.string().min(1, "Введите заголовок"),
  content: z.string().min(1, "Введите текст заметки"),
  folderId: z.string().optional(),
});

export default function NotesPage() {
  const [search, setSearch] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<any>(null);
  const queryClient = useQueryClient();

  const { data: notes = [], isLoading } = useListItems(
    { type: "note", status: "active" },
    { query: { queryKey: getListItemsQueryKey({ type: "note", status: "active" }) } },
  );
  const { data: folders = [] } = useListFolders();

  const filteredNotes = search
    ? notes.filter(
        (note) =>
          note.title.toLowerCase().includes(search.toLowerCase()) ||
          note.content?.toLowerCase().includes(search.toLowerCase()),
      )
    : notes;

  const createItem = useCreateItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
        setIsCreateOpen(false);
        form.reset();
        toast.success("Заметка создана");
      },
    },
  });

  const updateItem = useUpdateItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
        setEditingNote(null);
        toast.success("Заметка обновлена");
      },
    },
  });

  const deleteItem = useDeleteItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
        toast.success("Заметка удалена");
      },
    },
  });

  const form = useForm<z.infer<typeof noteSchema>>({
    resolver: zodResolver(noteSchema),
    defaultValues: { title: "", content: "", folderId: "none" },
  });

  const editForm = useForm<z.infer<typeof noteSchema>>({
    resolver: zodResolver(noteSchema),
    defaultValues: { title: "", content: "", folderId: "none" },
  });

  const onSubmitCreate = (values: z.infer<typeof noteSchema>) => {
    createItem.mutate({
      data: {
        type: "note",
        title: values.title,
        content: values.content,
        folderId: values.folderId === "none" ? null : parseInt(values.folderId || "0", 10),
      },
    });
  };

  const onSubmitEdit = (values: z.infer<typeof noteSchema>) => {
    if (!editingNote) return;

    updateItem.mutate({
      id: editingNote.id,
      data: {
        title: values.title,
        content: values.content,
        folderId: values.folderId === "none" ? null : parseInt(values.folderId || "0", 10),
      },
    });
  };

  const handleEditClick = (note: any) => {
    setEditingNote(note);
    editForm.reset({
      title: note.title,
      content: note.content || "",
      folderId: note.folderId ? String(note.folderId) : "none",
    });
  };

  return (
    <div className="h-full flex flex-col p-6 bg-slate-50/50 dark:bg-transparent">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight text-foreground">Заметки</h1>
          <p className="text-muted-foreground text-sm mt-1">Сохраняйте мысли, планы и идеи в одном месте.</p>
        </div>

        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="shadow-md shadow-primary/20 gap-2">
              <Plus className="w-4 h-4" />
              Новая заметка
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>Новая заметка</DialogTitle>
            </DialogHeader>
            <form onSubmit={form.handleSubmit(onSubmitCreate)} className="space-y-4">
              <div className="space-y-2">
                <Input placeholder="Заголовок заметки" {...form.register("title")} className="text-lg font-medium" />
                {form.formState.errors.title && (
                  <p className="text-destructive text-xs">{form.formState.errors.title.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Textarea
                  placeholder="Текст заметки..."
                  {...form.register("content")}
                  className="min-h-[200px] resize-y"
                />
                {form.formState.errors.content && (
                  <p className="text-destructive text-xs">{form.formState.errors.content.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Select onValueChange={(value) => form.setValue("folderId", value)} defaultValue="none">
                  <SelectTrigger>
                    <SelectValue placeholder="Выберите папку" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Без папки</SelectItem>
                    {folders
                      .filter((folder) => !folder.isSystem)
                      .map((folder) => (
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

      <div className="relative mb-6 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Поиск по заметкам..."
          className="pl-9 bg-card border-border/50 shadow-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
          <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mb-4">
            <FileText className="w-8 h-8 text-muted-foreground/50" />
          </div>
          <p className="font-medium">Заметок пока нет</p>
          <p className="text-sm opacity-70">Создайте первую заметку, чтобы начать работу.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-12">
          {filteredNotes.map((note) => (
            <Card
              key={note.id}
              className="group hover:shadow-md transition-all cursor-pointer border-border/50 hover:border-primary/30 flex flex-col h-[240px]"
            >
              <CardHeader className="pb-3 px-5 pt-5 relative">
                <div className="flex justify-between items-start">
                  <CardTitle className="text-lg leading-tight line-clamp-2 pr-6">{note.title}</CardTitle>
                </div>
                <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-primary bg-background/50 backdrop-blur-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEditClick(note);
                    }}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive bg-background/50 backdrop-blur-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm("Удалить заметку?")) {
                        deleteItem.mutate({ id: note.id });
                      }
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex-1 px-5 pb-4 overflow-hidden" onClick={() => handleEditClick(note)}>
                <p className="text-sm text-muted-foreground line-clamp-4 leading-relaxed">{note.summary || note.content}</p>
              </CardContent>
              <CardFooter className="px-5 pb-4 pt-0 flex flex-wrap gap-2 items-center justify-between border-t border-border/10 pt-3 mt-auto">
                <div className="flex flex-wrap gap-1.5">
                  {note.folderName && (
                    <Badge variant="secondary" className="bg-secondary/10 text-secondary-foreground hover:bg-secondary/20 text-[10px] gap-1 px-1.5">
                      <FolderIcon className="w-3 h-3" />
                      {note.folderName}
                    </Badge>
                  )}
                  {note.aiTags?.slice(0, 2).map((tag: string) => (
                    <Badge key={tag} variant="outline" className="text-[10px] text-muted-foreground bg-muted/50 border-0 gap-1 px-1.5">
                      <Tag className="w-2.5 h-2.5" />
                      {tag}
                    </Badge>
                  ))}
                </div>
                <span className="text-[10px] text-muted-foreground ml-auto font-medium">
                  {formatMoscowDateShort(note.createdAt)}
                </span>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!editingNote} onOpenChange={(open) => !open && setEditingNote(null)}>
        <DialogContent className="sm:max-w-[700px] h-[80vh] flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>Редактирование заметки</DialogTitle>
          </DialogHeader>
          <form onSubmit={editForm.handleSubmit(onSubmitEdit)} className="flex-1 flex flex-col min-h-0 space-y-4">
            <div className="space-y-2 shrink-0">
              <Input
                placeholder="Заголовок заметки"
                {...editForm.register("title")}
                className="text-xl font-bold border-0 bg-transparent px-0 focus-visible:ring-0 shadow-none"
              />
            </div>
            <div className="space-y-2 flex-1 min-h-0 flex flex-col">
              <Textarea
                placeholder="Текст заметки..."
                {...editForm.register("content")}
                className="flex-1 resize-none border-0 bg-transparent px-0 focus-visible:ring-0 shadow-none text-base leading-relaxed"
              />
            </div>
            <div className="space-y-2 shrink-0 pt-4 border-t border-border/50">
              <Select onValueChange={(value) => editForm.setValue("folderId", value)} value={editForm.watch("folderId")}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Выберите папку" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Без папки</SelectItem>
                  {folders
                    .filter((folder) => !folder.isSystem)
                    .map((folder) => (
                      <SelectItem key={folder.id} value={String(folder.id)}>
                        {folder.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter className="shrink-0 pt-2">
              <Button type="submit" disabled={updateItem.isPending}>
                {updateItem.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Сохранить изменения
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
