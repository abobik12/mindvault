import { useState } from "react";
import { format, isPast, isToday } from "date-fns";
import { 
  useListItems, 
  useCreateItem,
  useUpdateItem,
  useDeleteItem,
  useGetUpcomingReminders,
  getListItemsQueryKey,
  getGetUpcomingRemindersQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Calendar as CalendarIcon, Clock, Plus, Trash2, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { cn } from "@/lib/utils";

const reminderSchema = z.object({
  title: z.string().min(1, "Title is required"),
  reminderAt: z.string().min(1, "Date/Time is required"),
});

export default function RemindersPage() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: items = [], isLoading } = useListItems({ query: { queryKey: getListItemsQueryKey() } });
  const { data: upcomingReminders = [], isLoading: isUpcomingLoading } = useGetUpcomingReminders();
  
  const reminders = items
    .filter(i => i.type === 'reminder')
    .sort((a, b) => {
      // Sort by status (active first), then by date
      if (a.status !== b.status) {
        return a.status === 'active' ? -1 : 1;
      }
      return new Date(a.reminderAt || 0).getTime() - new Date(b.reminderAt || 0).getTime();
    });

  const createItem = useCreateItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetUpcomingRemindersQueryKey() });
        setIsCreateOpen(false);
        form.reset();
        toast.success("Reminder created");
      }
    }
  });

  const updateItem = useUpdateItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetUpcomingRemindersQueryKey() });
      }
    }
  });

  const deleteItem = useDeleteItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetUpcomingRemindersQueryKey() });
        toast.success("Reminder deleted");
      }
    }
  });

  const form = useForm<z.infer<typeof reminderSchema>>({
    resolver: zodResolver(reminderSchema),
    defaultValues: { title: "", reminderAt: "" },
  });

  const onSubmitCreate = (values: z.infer<typeof reminderSchema>) => {
    createItem.mutate({
      data: {
        type: 'reminder',
        title: values.title,
        reminderAt: new Date(values.reminderAt).toISOString(),
      }
    });
  };

  const toggleStatus = (reminder: any) => {
    const newStatus = reminder.status === 'active' ? 'completed' : 'active';
    updateItem.mutate({
      id: reminder.id,
      data: {
        status: newStatus
      }
    });
  };

  return (
    <div className="h-full flex flex-col p-6 bg-slate-50/50 dark:bg-transparent overflow-y-auto">
      <div className="flex items-center justify-between mb-8 shrink-0">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight text-foreground">Reminders</h1>
          <p className="text-muted-foreground text-sm mt-1">Stay on top of your tasks.</p>
        </div>
        
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="shadow-md shadow-primary/20 gap-2">
              <Plus className="w-4 h-4" />
              New Reminder
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create Reminder</DialogTitle>
            </DialogHeader>
            <form onSubmit={form.handleSubmit(onSubmitCreate)} className="space-y-4">
              <div className="space-y-2">
                <Input placeholder="What do you need to remember?" {...form.register("title")} />
                {form.formState.errors.title && <p className="text-destructive text-xs">{form.formState.errors.title.message}</p>}
              </div>
              <div className="space-y-2">
                <Input type="datetime-local" {...form.register("reminderAt")} />
                {form.formState.errors.reminderAt && <p className="text-destructive text-xs">{form.formState.errors.reminderAt.message}</p>}
              </div>
              <DialogFooter>
                <Button type="submit" disabled={createItem.isPending}>
                  {createItem.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Save Reminder
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
              <Clock className="w-4 h-4" /> Upcoming Soon
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {upcomingReminders.map(reminder => (
                <Card key={reminder.id} className="border-primary/20 bg-primary/5 shadow-sm">
                  <CardHeader className="p-4 pb-2">
                    <CardTitle className="text-base flex items-start justify-between">
                      <span className="line-clamp-2">{reminder.title}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 pt-0 flex justify-between items-end">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                      <CalendarIcon className="w-3.5 h-3.5" />
                      {format(new Date(reminder.reminderAt!), "MMM d, h:mm a")}
                    </div>
                    <Button size="sm" onClick={() => toggleStatus(reminder)} className="h-8">
                      Complete
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">All Reminders</h2>
          
          {isLoading ? (
            <div className="flex items-center justify-center p-12">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : reminders.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground bg-card rounded-2xl border border-border/50">
              <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mb-4">
                <Clock className="w-8 h-8 text-muted-foreground/50" />
              </div>
              <p className="font-medium">No reminders</p>
              <p className="text-sm opacity-70">Create a reminder to keep track of tasks.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {reminders.map(reminder => {
                const isCompleted = reminder.status === 'completed';
                const reminderDate = new Date(reminder.reminderAt || 0);
                const overdue = reminder.status === 'active' && isPast(reminderDate) && !isToday(reminderDate);

                return (
                  <div 
                    key={reminder.id} 
                    className={cn(
                      "group flex items-center gap-4 p-4 bg-card rounded-xl border transition-all",
                      isCompleted ? "border-border/40 opacity-60" : overdue ? "border-destructive/30 bg-destructive/5" : "border-border/50 hover:border-primary/30 hover:shadow-sm"
                    )}
                  >
                    <button 
                      onClick={() => toggleStatus(reminder)}
                      className={cn(
                        "shrink-0 transition-colors",
                        isCompleted ? "text-primary" : "text-muted-foreground hover:text-primary"
                      )}
                    >
                      {isCompleted ? <CheckCircle2 className="w-6 h-6" /> : <Circle className="w-6 h-6" />}
                    </button>
                    
                    <div className="flex-1 min-w-0">
                      <p className={cn(
                        "text-sm font-medium truncate",
                        isCompleted ? "line-through text-muted-foreground" : "text-foreground"
                      )}>
                        {reminder.title}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1">
                        <CalendarIcon className={cn("w-3.5 h-3.5", overdue ? "text-destructive" : "text-muted-foreground")} />
                        <span className={cn(
                          "text-xs",
                          overdue ? "text-destructive font-medium" : "text-muted-foreground"
                        )}>
                          {reminder.reminderAt ? format(reminderDate, "MMM d, yyyy h:mm a") : "No date"}
                          {overdue && " (Overdue)"}
                        </span>
                      </div>
                    </div>

                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      onClick={() => { 
                        if(confirm("Delete this reminder?")) deleteItem.mutate({ id: reminder.id }); 
                      }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
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
