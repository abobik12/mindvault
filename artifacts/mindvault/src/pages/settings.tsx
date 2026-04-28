import {
  useGetMe,
  useUpdateProfile,
  useGetWorkspaceStats,
  useGetRecentItems,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { LogOut, User, Folder as FolderIcon, FileText, HardDrive, Clock, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { formatMoscowDateTime, formatMoscowMonthYear } from "@/lib/time";

const profileSchema = z.object({
  fullName: z.string().min(2, "Введите имя"),
  avatarUrl: z.string().url("Укажите корректную ссылку").optional().or(z.literal("")),
});

export default function SettingsPage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data: user, isLoading: isUserLoading } = useGetMe();
  const { data: stats } = useGetWorkspaceStats();
  const { data: recentItems = [] } = useGetRecentItems();

  const updateProfile = useUpdateProfile({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetMeQueryKey(), data);
        toast.success("Профиль обновлен");
      },
    },
  });

  const form = useForm<z.infer<typeof profileSchema>>({
    resolver: zodResolver(profileSchema),
    values: {
      fullName: user?.fullName || "",
      avatarUrl: user?.avatarUrl || "",
    },
  });

  const onSubmit = (values: z.infer<typeof profileSchema>) => {
    updateProfile.mutate({
      data: {
        fullName: values.fullName,
        avatarUrl: values.avatarUrl || null,
      },
    });
  };

  const handleLogout = () => {
    localStorage.removeItem("mindvault_token");
    setLocation("/auth");
  };

  if (isUserLoading || !user) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col p-4 sm:p-6 bg-slate-50/50 dark:bg-transparent overflow-y-auto">
      <div className="mb-6 sm:mb-8 shrink-0">
        <h1 className="text-2xl sm:text-3xl font-serif font-bold tracking-tight text-foreground">Настройки</h1>
        <p className="text-muted-foreground text-sm mt-1">Управляйте профилем и просматривайте статистику рабочего кабинета.</p>
      </div>

      <div className="max-w-4xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8 pb-12 min-w-0">
        <div className="lg:col-span-1 space-y-6">
          <Card className="border-border/50 shadow-sm overflow-hidden">
            <div className="h-24 bg-primary/10 w-full relative">
              <div className="absolute -bottom-10 left-6">
                <Avatar className="h-20 w-20 border-4 border-card shadow-sm">
                  <AvatarImage src={user.avatarUrl || undefined} />
                  <AvatarFallback className="bg-primary/20 text-primary text-xl font-bold">
                    {user.fullName.substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </div>
            </div>
            <CardHeader className="pt-12 pb-4">
              <CardTitle>{user.fullName}</CardTitle>
              <CardDescription>{user.email}</CardDescription>
              <p className="text-xs text-muted-foreground mt-2">
                В сервисе с {formatMoscowMonthYear(user.createdAt)}
              </p>
            </CardHeader>
          </Card>

          <Card className="border-border/50 shadow-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <User className="w-4 h-4" />
                Редактирование профиля
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form id="profile-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="space-y-2">
                  <Label>Имя</Label>
                  <Input {...form.register("fullName")} />
                  {form.formState.errors.fullName && (
                    <p className="text-destructive text-xs">{form.formState.errors.fullName.message}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Ссылка на аватар (необязательно)</Label>
                  <Input {...form.register("avatarUrl")} placeholder="https://..." />
                  {form.formState.errors.avatarUrl && (
                    <p className="text-destructive text-xs">{form.formState.errors.avatarUrl.message}</p>
                  )}
                </div>
              </form>
            </CardContent>
            <CardFooter className="bg-muted/30 border-t border-border/50 justify-between py-3">
              <Button variant="ghost" className="text-destructive hover:text-destructive hover:bg-destructive/10" onClick={handleLogout}>
                <LogOut className="w-4 h-4 mr-2" />
                Выйти
              </Button>
              <Button type="submit" form="profile-form" disabled={updateProfile.isPending}>
                {updateProfile.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Сохранить
              </Button>
            </CardFooter>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <h3 className="text-lg font-semibold tracking-tight">Обзор рабочего кабинета</h3>

          <div className="grid grid-cols-1 min-[380px]:grid-cols-2 sm:grid-cols-4 gap-4">
            <Card className="border-border/50 shadow-sm">
              <CardContent className="p-4 flex flex-col items-center text-center">
                <div className="w-10 h-10 bg-primary/10 text-primary rounded-full flex items-center justify-center mb-2">
                  <FileText className="w-5 h-5" />
                </div>
                <span className="text-2xl font-bold">{stats?.totalNotes || 0}</span>
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Заметки</span>
              </CardContent>
            </Card>
            <Card className="border-border/50 shadow-sm">
              <CardContent className="p-4 flex flex-col items-center text-center">
                <div className="w-10 h-10 bg-secondary/10 text-secondary rounded-full flex items-center justify-center mb-2">
                  <HardDrive className="w-5 h-5" />
                </div>
                <span className="text-2xl font-bold">{stats?.totalFiles || 0}</span>
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Файлы</span>
              </CardContent>
            </Card>
            <Card className="border-border/50 shadow-sm">
              <CardContent className="p-4 flex flex-col items-center text-center">
                <div className="w-10 h-10 bg-amber-500/10 text-amber-500 rounded-full flex items-center justify-center mb-2">
                  <Clock className="w-5 h-5" />
                </div>
                <span className="text-2xl font-bold">{stats?.pendingReminders || 0}</span>
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Задачи</span>
              </CardContent>
            </Card>
            <Card className="border-border/50 shadow-sm">
              <CardContent className="p-4 flex flex-col items-center text-center">
                <div className="w-10 h-10 bg-emerald-500/10 text-emerald-500 rounded-full flex items-center justify-center mb-2">
                  <FolderIcon className="w-5 h-5" />
                </div>
                <span className="text-2xl font-bold">{stats?.totalFolders || 0}</span>
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Папки</span>
              </CardContent>
            </Card>
          </div>

          <Card className="border-border/50 shadow-sm">
            <CardHeader className="pb-3 border-b border-border/50">
              <CardTitle className="text-base">Последняя активность</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {recentItems.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">Пока нет активности.</div>
              ) : (
                <div className="divide-y divide-border/50">
                  {recentItems.map((item) => (
                    <div key={item.id} className="p-4 flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-4 hover:bg-muted/50 transition-colors">
                      <div className="w-8 h-8 rounded-full bg-card border border-border/50 flex items-center justify-center shrink-0">
                        {item.type === "note" && <FileText className="w-4 h-4 text-primary" />}
                        {item.type === "file" && <HardDrive className="w-4 h-4 text-secondary" />}
                        {item.type === "reminder" && <Clock className="w-4 h-4 text-amber-500" />}
                      </div>
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-sm font-medium truncate text-foreground">{item.title}</span>
                        <span className="text-xs text-muted-foreground mt-0.5">
                          {item.type === "note" && "Обновлена заметка"}
                          {item.type === "file" && "Загружен файл"}
                          {item.type === "reminder" && "Создано напоминание"}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground shrink-0 sm:text-right">{formatMoscowDateTime(item.updatedAt)}</div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
