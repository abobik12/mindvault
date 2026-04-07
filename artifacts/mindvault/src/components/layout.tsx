import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Brain, FileText, Folder as FolderIcon, HardDrive, Settings, MessageSquare, Plus, Loader2, FolderPlus, Trash2, Edit2, LogOut, CheckCircle2, Clock } from "lucide-react";
import { useGetMe, useListFolders, useGetWorkspaceStats, useGetUpcomingReminders } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useCreateFolder, getListFoldersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

const folderSchema = z.object({
  name: z.string().min(1, "Name is required"),
});

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data: user, isLoading: isUserLoading, isError: isUserError } = useGetMe({
    query: {
      retry: false,
    }
  });

  useEffect(() => {
    if (isUserError) {
      localStorage.removeItem("mindvault_token");
      setLocation("/auth");
    }
  }, [isUserError, setLocation]);

  const { data: folders = [] } = useListFolders({ query: { enabled: !!user } });
  const { data: stats } = useGetWorkspaceStats({ query: { enabled: !!user } });
  const { data: upcomingReminders = [] } = useGetUpcomingReminders({ query: { enabled: !!user } });

  const createFolderForm = useForm<z.infer<typeof folderSchema>>({
    resolver: zodResolver(folderSchema),
    defaultValues: { name: "" },
  });

  const createFolderMutation = useCreateFolder({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
        createFolderForm.reset();
        document.getElementById("close-folder-dialog")?.click();
        toast.success("Folder created");
      },
    },
  });

  const handleCreateFolder = (values: z.infer<typeof folderSchema>) => {
    createFolderMutation.mutate({ data: values });
  };

  const handleLogout = () => {
    localStorage.removeItem("mindvault_token");
    setLocation("/auth");
  };

  if (isUserLoading) {
    return <div className="h-screen w-full flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  if (!user) return null;

  const systemFolders = folders.filter((f) => f.isSystem);
  const userFolders = folders.filter((f) => !f.isSystem);

  const navItems = [
    { icon: MessageSquare, label: "Home", href: "/" },
    { icon: FileText, label: "Notes", href: "/notes" },
    { icon: HardDrive, label: "Files", href: "/files" },
    { 
      icon: Clock, 
      label: "Reminders", 
      href: "/reminders",
      badge: upcomingReminders.length > 0 ? upcomingReminders.length : undefined
    },
  ];

  return (
    <div className="flex h-screen bg-background overflow-hidden text-foreground">
      {/* Sidebar */}
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
              const isActive = location === item.href || (location.startsWith(item.href) && item.href !== "/");
              return (
                <Link key={item.href} href={item.href} className="block">
                  <div
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                      isActive
                        ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    )}
                  >
                    <item.icon className="w-4 h-4" />
                    <span>{item.label}</span>
                    {item.badge && (
                      <span className="ml-auto bg-destructive text-destructive-foreground text-[10px] font-bold px-2 py-0.5 rounded-full">
                        {item.badge}
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>

          <div className="mb-4 flex items-center justify-between px-2">
            <h3 className="text-xs font-semibold text-sidebar-foreground/50 uppercase tracking-wider">Your Folders</h3>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-sidebar-foreground/50 hover:text-sidebar-foreground">
                  <Plus className="h-4 w-4" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Folder</DialogTitle>
                  <DialogDescription>Organize your notes and files.</DialogDescription>
                </DialogHeader>
                <Form {...createFolderForm}>
                  <form onSubmit={createFolderForm.handleSubmit(handleCreateFolder)} className="space-y-4">
                    <FormField
                      control={createFolderForm.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <Input placeholder="Folder name..." {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <DialogFooter>
                      <DialogTrigger id="close-folder-dialog" asChild>
                        <Button variant="outline" type="button">Cancel</Button>
                      </DialogTrigger>
                      <Button type="submit" disabled={createFolderMutation.isPending}>
                        {createFolderMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                        Create
                      </Button>
                    </DialogFooter>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </div>

          <div className="space-y-1">
            {userFolders.map((folder) => (
              <Link key={folder.id} href={`/notes?folderId=${folder.id}`} className="block">
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                    location.includes(`folderId=${folder.id}`)
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )}
                >
                  <FolderIcon className="w-4 h-4 text-sidebar-foreground/40" />
                  <span className="truncate">{folder.name}</span>
                  <span className="ml-auto text-xs text-sidebar-foreground/40">{folder.itemCount}</span>
                </div>
              </Link>
            ))}
            {userFolders.length === 0 && (
              <div className="px-3 py-2 text-xs text-sidebar-foreground/40 text-center">
                No folders yet.
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="p-4 border-t border-border/50">
          <Link href="/settings" className="block">
            <div className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors mb-2",
              location === "/settings"
                ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            )}>
              <Settings className="w-4 h-4" />
              <span>Settings</span>
            </div>
          </Link>
          <div 
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-sidebar-foreground/70 hover:bg-destructive/10 hover:text-destructive cursor-pointer"
            onClick={handleLogout}
          >
            <LogOut className="w-4 h-4" />
            <span>Logout</span>
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

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        {children}
      </main>
    </div>
  );
}
