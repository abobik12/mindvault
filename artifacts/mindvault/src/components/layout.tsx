import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Brain,
  FileText,
  Folder as FolderIcon,
  HardDrive,
  Settings,
  MessageSquare,
  Plus,
  Loader2,
  LogOut,
  Clock,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  useGetMe,
  useListFolders,
  useGetUpcomingReminders,
  useCreateFolder,
  useUpdateFolder,
  useDeleteFolder,
  getListFoldersQueryKey,
  getGetFolderQueryKey,
  getListItemsQueryKey,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const folderSchema = z.object({
  name: z.string().min(1, "Введите название папки"),
});

const navItems = [
  { icon: MessageSquare, label: "Главная", href: "/" },
  { icon: FileText, label: "Все заметки", href: "/notes" },
  { icon: HardDrive, label: "Все файлы", href: "/files" },
  { icon: Clock, label: "Все напоминания", href: "/reminders" },
] as const;

function getFolderIdFromLocation(location: string): number | null {
  const match = location.match(/^\/folders\/(\d+)\/?$/);
  if (!match) return null;

  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
  const [isRenameFolderOpen, setIsRenameFolderOpen] = useState(false);
  const [deletingFolder, setDeletingFolder] = useState<{ id: number; name: string } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<{ id: number; name: string } | null>(null);

  const { data: user, isLoading: isUserLoading, isError: isUserError } = useGetMe({
    query: {
      retry: false,
    },
  });

  useEffect(() => {
    if (isUserError) {
      localStorage.removeItem("mindvault_token");
      setLocation("/auth");
    }
  }, [isUserError, setLocation]);

  const { data: folders = [] } = useListFolders({ query: { enabled: !!user } });
  const { data: upcomingReminders = [] } = useGetUpcomingReminders({
    query: { enabled: !!user },
  });

  const createFolderForm = useForm<z.infer<typeof folderSchema>>({
    resolver: zodResolver(folderSchema),
    defaultValues: { name: "" },
  });

  const renameFolderForm = useForm<z.infer<typeof folderSchema>>({
    resolver: zodResolver(folderSchema),
    defaultValues: { name: "" },
  });

  const invalidateFolderRelatedQueries = (folderId?: number) => {
    queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });

    if (folderId) {
      queryClient.invalidateQueries({ queryKey: getGetFolderQueryKey(folderId) });
    }
  };

  const createFolderMutation = useCreateFolder({
    mutation: {
      onSuccess: (createdFolder) => {
        invalidateFolderRelatedQueries(createdFolder.id);
        createFolderForm.reset();
        setIsCreateFolderOpen(false);
        setLocation(`/folders/${createdFolder.id}`);
        toast.success(`Папка «${createdFolder.name}» создана`);
      },
      onError: () => {
        toast.error("Не удалось создать папку");
      },
    },
  });

  const updateFolderMutation = useUpdateFolder({
    mutation: {
      onSuccess: (updatedFolder) => {
        invalidateFolderRelatedQueries(updatedFolder.id);
        setIsRenameFolderOpen(false);
        setRenamingFolder(null);
        toast.success(`Папка переименована: «${updatedFolder.name}»`);
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Не удалось переименовать папку");
      },
    },
  });

  const deleteFolderMutation = useDeleteFolder({
    mutation: {
      onSuccess: (_, variables) => {
        invalidateFolderRelatedQueries(variables.id);
        const deletedFolderId = variables.id;
        const deletedFolderName = deletingFolder?.name;
        setDeletingFolder(null);

        if (activeFolderId === deletedFolderId) {
          setLocation("/");
        }

        toast.success(
          deletedFolderName
            ? `Папка «${deletedFolderName}» удалена. Объекты сохранены без папки.`
            : "Папка удалена. Объекты сохранены без папки.",
        );
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Не удалось удалить папку");
      },
    },
  });

  const handleCreateFolder = (values: z.infer<typeof folderSchema>) => {
    createFolderMutation.mutate({ data: values });
  };

  const handleOpenRenameFolder = (folder: { id: number; name: string }) => {
    setRenamingFolder(folder);
    renameFolderForm.reset({ name: folder.name });
    setIsRenameFolderOpen(true);
  };

  const handleRenameFolder = (values: z.infer<typeof folderSchema>) => {
    if (!renamingFolder) return;

    updateFolderMutation.mutate({
      id: renamingFolder.id,
      data: { name: values.name.trim() },
    });
  };

  const handleDeleteFolder = () => {
    if (!deletingFolder) return;
    deleteFolderMutation.mutate({ id: deletingFolder.id });
  };

  const handleLogout = () => {
    localStorage.removeItem("mindvault_token");
    setLocation("/auth");
  };

  const activeFolderId = useMemo(() => getFolderIdFromLocation(location), [location]);

  if (isUserLoading) {
    return (
      <div className="h-screen w-full flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) return null;

  const userFolders = folders.filter((folder) => !folder.isSystem);

  return (
    <div className="flex h-screen bg-background overflow-hidden text-foreground">
      <aside className="w-64 border-r border-border bg-sidebar/50 backdrop-blur-xl flex flex-col hidden md:flex">
        <div className="h-16 px-6 flex items-center gap-3 border-b border-border/50">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center shadow-md shadow-primary/20">
            <Brain className="text-primary-foreground w-5 h-5" />
          </div>
          <span className="font-bold text-lg tracking-tight">MindVault</span>
        </div>

        <ScrollArea className="flex-1 px-4 py-4">
          <div className="space-y-1 mb-8">
            {navItems.map((item) => {
              const isActive =
                item.href === "/"
                  ? location === "/"
                  : location === item.href || location.startsWith(`${item.href}/`);

              const badge =
                item.href === "/reminders" && upcomingReminders.length > 0
                  ? upcomingReminders.length
                  : undefined;

              return (
                <Link key={item.href} href={item.href} className="block">
                  <div
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                      isActive
                        ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <item.icon className="w-4 h-4" />
                    <span>{item.label}</span>
                    {badge && (
                      <span className="ml-auto bg-destructive text-destructive-foreground text-[10px] font-bold px-2 py-0.5 rounded-full">
                        {badge}
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>

          <div className="mb-4 flex items-center justify-between px-2">
            <h3 className="text-xs font-semibold text-sidebar-foreground/50 uppercase tracking-wider">
              Ваши папки
            </h3>
            <Dialog open={isCreateFolderOpen} onOpenChange={setIsCreateFolderOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-sidebar-foreground/50 hover:text-sidebar-foreground"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Создать папку</DialogTitle>
                  <DialogDescription>
                    Добавьте папку, чтобы удобно группировать заметки, файлы и напоминания.
                  </DialogDescription>
                </DialogHeader>
                <Form {...createFolderForm}>
                  <form
                    onSubmit={createFolderForm.handleSubmit(handleCreateFolder)}
                    className="space-y-4"
                  >
                    <FormField
                      control={createFolderForm.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <Input placeholder="Название папки" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <DialogFooter>
                      <Button variant="outline" type="button" onClick={() => setIsCreateFolderOpen(false)}>
                        Отмена
                      </Button>
                      <Button type="submit" disabled={createFolderMutation.isPending}>
                        {createFolderMutation.isPending ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : null}
                        Создать
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </div>

          <div className="space-y-1">
            {userFolders.map((folder) => {
              const isFolderActive = activeFolderId === folder.id;

              return (
                <div
                  key={folder.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-lg transition-colors",
                    isFolderActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )}
                >
                  <Link href={`/folders/${folder.id}`} className="block flex-1 min-w-0">
                    <div className="flex items-center gap-3 px-3 py-2 text-sm">
                      <FolderIcon className="w-4 h-4 text-sidebar-foreground/40" />
                      <span className={cn("truncate", isFolderActive && "font-medium")}>{folder.name}</span>
                      <span className="ml-auto text-xs text-sidebar-foreground/40">{folder.itemCount}</span>
                    </div>
                  </Link>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "h-7 w-7 mr-1 text-sidebar-foreground/50 hover:text-sidebar-foreground",
                          !isFolderActive && "opacity-0 group-hover:opacity-100",
                        )}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="right">
                      <DropdownMenuItem
                        onClick={(event) => {
                          event.preventDefault();
                          handleOpenRenameFolder({ id: folder.id, name: folder.name });
                        }}
                      >
                        <Pencil className="w-4 h-4" />
                        Переименовать
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={(event) => {
                          event.preventDefault();
                          setDeletingFolder({ id: folder.id, name: folder.name });
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                        Удалить
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
            {userFolders.length === 0 && (
              <div className="px-3 py-2 text-xs text-sidebar-foreground/40 text-center">
                У вас пока нет пользовательских папок.
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="p-4 border-t border-border/50">
          <Link href="/settings" className="block">
            <div
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors mb-2",
                location === "/settings"
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <Settings className="w-4 h-4" />
              <span>Настройки</span>
            </div>
          </Link>

          <div
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-sidebar-foreground/70 hover:bg-destructive/10 hover:text-destructive cursor-pointer"
            onClick={handleLogout}
          >
            <LogOut className="w-4 h-4" />
            <span>Выйти</span>
          </div>

          <div className="mt-4 flex items-center gap-3 px-2">
            <Avatar className="h-8 w-8">
              <AvatarImage src={user.avatarUrl || undefined} />
              <AvatarFallback className="bg-primary/10 text-primary text-xs font-bold">
                {user.fullName.substring(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium truncate text-sidebar-foreground">{user.fullName}</span>
              <span className="text-xs text-sidebar-foreground/50 truncate">{user.email}</span>
            </div>
          </div>
        </div>
      </aside>

      <Dialog
        open={isRenameFolderOpen}
        onOpenChange={(open) => {
          setIsRenameFolderOpen(open);
          if (!open) {
            setRenamingFolder(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Переименовать папку</DialogTitle>
            <DialogDescription>Введите новое название папки.</DialogDescription>
          </DialogHeader>
          <Form {...renameFolderForm}>
            <form onSubmit={renameFolderForm.handleSubmit(handleRenameFolder)} className="space-y-4">
              <FormField
                control={renameFolderForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input placeholder="Название папки" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setIsRenameFolderOpen(false)}>
                  Отмена
                </Button>
                <Button type="submit" disabled={updateFolderMutation.isPending}>
                  {updateFolderMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : null}
                  Сохранить
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deletingFolder)} onOpenChange={(open) => !open && setDeletingFolder(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить папку?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingFolder
                ? `Папка «${deletingFolder.name}» будет удалена. Объекты внутри не потеряются и останутся без папки.`
                : "Папка будет удалена. Объекты внутри не потеряются и останутся без папки."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                handleDeleteFolder();
              }}
              disabled={deleteFolderMutation.isPending}
            >
              {deleteFolderMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <main className="flex-1 flex flex-col overflow-hidden relative">{children}</main>
    </div>
  );
}
