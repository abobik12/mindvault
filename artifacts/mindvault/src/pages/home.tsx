import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { 
  useListGeminiConversations, 
  useCreateGeminiConversation, 
  useClassifyContent,
  useGetGeminiConversation,
  getListGeminiConversationsQueryKey,
  useUploadFile
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Plus, Paperclip, Loader2, Bot, User, Trash2, Folder as FolderIcon, Bell, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { format } from "date-fns";

export default function Home() {
  const queryClient = useQueryClient();
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: conversations = [], isLoading: isConversationsLoading } = useListGeminiConversations();
  
  const { data: activeConversation, isLoading: isConversationLoading } = useGetGeminiConversation(
    activeConversationId as number,
    { query: { enabled: activeConversationId !== null } }
  );

  const createConversation = useCreateGeminiConversation({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListGeminiConversationsQueryKey() });
        setActiveConversationId(data.id);
      }
    }
  });

  const classifyContent = useClassifyContent();
  const uploadFile = useUploadFile();

  useEffect(() => {
    if (conversations.length > 0 && !activeConversationId) {
      setActiveConversationId(conversations[0].id);
    }
  }, [conversations, activeConversationId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeConversation?.messages, streamingMessage]);

  const handleNewChat = () => {
    createConversation.mutate({ data: { title: "New Conversation" } });
  };

  const handleSend = async () => {
    if (!input.trim() || !activeConversationId || isStreaming) return;

    const messageContent = input.trim();
    setInput("");

    // Optimistically add user message
    queryClient.setQueryData(
      [`/api/gemini/conversations/${activeConversationId}`],
      (old: any) => {
        if (!old) return old;
        return {
          ...old,
          messages: [
            ...old.messages,
            { id: Date.now(), role: "user", content: messageContent, createdAt: new Date().toISOString() }
          ]
        };
      }
    );

    // Classify first
    try {
      const classification = await classifyContent.mutateAsync({ 
        data: { content: messageContent, conversationId: activeConversationId } 
      });

      if (classification.type !== 'chat') {
        let actionMsg = "";
        if (classification.type === 'note') actionMsg = `Saved a note: "${classification.title}"`;
        if (classification.type === 'reminder') actionMsg = `Created reminder: "${classification.title}"`;
        toast.success(actionMsg, {
          description: classification.message
        });
      }
    } catch (e) {
      console.error("Classification error", e);
    }

    // Now send to SSE
    setIsStreaming(true);
    setStreamingMessage("");

    try {
      const token = localStorage.getItem("mindvault_token");
      const response = await fetch(`/api/gemini/conversations/${activeConversationId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ content: messageContent })
      });

      if (!response.ok) throw new Error("Stream failed");

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.text) {
                  setStreamingMessage(prev => prev + parsed.text);
                }
              } catch (e) {}
            }
          }
        }
      }
      
      // Invalidate to get the final message from DB
      queryClient.invalidateQueries({ queryKey: [`/api/gemini/conversations/${activeConversationId}`] });
    } catch (error) {
      console.error("Stream error:", error);
      toast.error("Failed to get response");
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
      const base64 = (event.target?.result as string).split(',')[1];
      
      toast.promise(
        uploadFile.mutateAsync({
          data: {
            filename: file.name,
            mimeType: file.type,
            fileSize: file.size,
            fileData: base64
          }
        }),
        {
          loading: 'Uploading file...',
          success: 'File uploaded successfully',
          error: 'Failed to upload file'
        }
      );
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="flex h-full w-full">
      {/* Conversations List Sidebar */}
      <div className="w-64 border-r border-border bg-card/30 flex flex-col">
        <div className="p-4 border-b border-border/50">
          <Button onClick={handleNewChat} className="w-full gap-2 shadow-sm" variant="default">
            <Plus className="w-4 h-4" />
            New Chat
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {isConversationsLoading ? (
              <div className="p-4 text-center text-sm text-muted-foreground">Loading...</div>
            ) : conversations.map((conv) => (
              <div
                key={conv.id}
                onClick={() => setActiveConversationId(conv.id)}
                className={cn(
                  "flex items-center gap-2 p-3 rounded-lg text-sm cursor-pointer transition-colors",
                  activeConversationId === conv.id
                    ? "bg-accent text-accent-foreground font-medium"
                    : "hover:bg-accent/50 text-muted-foreground"
                )}
              >
                <MessageSquare className="w-4 h-4 shrink-0" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="truncate">{conv.title || "New Chat"}</span>
                  <span className="text-[10px] opacity-70">{format(new Date(conv.createdAt), "MMM d, yyyy")}</span>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative bg-card/10">
        {!activeConversationId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Select or start a conversation
          </div>
        ) : (
          <>
            <ScrollArea className="flex-1 p-4" ref={scrollRef}>
              <div className="max-w-3xl mx-auto space-y-6 pb-20">
                {activeConversation?.messages.map((msg, i) => (
                  <div key={msg.id || i} className={cn(
                    "flex gap-4",
                    msg.role === "user" ? "flex-row-reverse" : ""
                  )}>
                    <div className={cn(
                      "w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1 shadow-sm",
                      msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
                    )}>
                      {msg.role === "user" ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                    </div>
                    <div className={cn(
                      "flex flex-col max-w-[80%]",
                      msg.role === "user" ? "items-end" : "items-start"
                    )}>
                      <div className={cn(
                        "px-4 py-3 rounded-2xl shadow-sm text-sm whitespace-pre-wrap leading-relaxed",
                        msg.role === "user" 
                          ? "bg-primary text-primary-foreground rounded-tr-sm" 
                          : "bg-card border border-border/50 text-card-foreground rounded-tl-sm"
                      )}>
                        {msg.content}
                      </div>
                      <span className="text-[10px] text-muted-foreground mt-1 px-1">
                        {msg.createdAt ? format(new Date(msg.createdAt), "h:mm a") : "Just now"}
                      </span>
                    </div>
                  </div>
                ))}
                
                {isStreaming && streamingMessage && (
                  <div className="flex gap-4">
                    <div className="w-8 h-8 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center shrink-0 mt-1 shadow-sm">
                      <Bot className="w-4 h-4" />
                    </div>
                    <div className="flex flex-col max-w-[80%] items-start">
                      <div className="px-4 py-3 rounded-2xl shadow-sm text-sm whitespace-pre-wrap leading-relaxed bg-card border border-border/50 text-card-foreground rounded-tl-sm">
                        {streamingMessage}<span className="inline-block w-1 h-4 ml-1 bg-primary animate-pulse" />
                      </div>
                    </div>
                  </div>
                )}
                {isStreaming && !streamingMessage && (
                  <div className="flex gap-4">
                    <div className="w-8 h-8 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center shrink-0 mt-1 shadow-sm">
                      <Bot className="w-4 h-4 animate-pulse" />
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>

            {/* Input Area */}
            <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-background via-background to-transparent pt-10">
              <div className="max-w-3xl mx-auto relative flex items-end gap-2 bg-card rounded-2xl border border-border/50 shadow-lg p-2 focus-within:ring-1 focus-within:ring-primary/50 transition-all">
                <input
                  type="file"
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 rounded-xl text-muted-foreground hover:text-foreground h-10 w-10"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStreaming}
                >
                  <Paperclip className="w-5 h-5" />
                </Button>
                
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Chat or save a note..."
                  className="min-h-[44px] max-h-[200px] resize-none border-0 focus-visible:ring-0 shadow-none bg-transparent p-3 text-sm"
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
              <div className="max-w-3xl mx-auto mt-2 text-center">
                <span className="text-[10px] text-muted-foreground">Shift+Enter to add a new line. Content is automatically categorized.</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
