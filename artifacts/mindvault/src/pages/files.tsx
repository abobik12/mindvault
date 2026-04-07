import { useState, useRef } from "react";
import { format } from "date-fns";
import { 
  useListItems, 
  useUploadFile,
  useDeleteItem,
  getListItemsQueryKey,
  useListFolders
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Search, HardDrive, Trash2, Folder as FolderIcon, Loader2, Download, File, Image as ImageIcon, FileText, FileArchive, UploadCloud } from "lucide-react";
import { toast } from "sonner";

function getFileIcon(mimeType: string | null) {
  if (!mimeType) return File;
  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType.includes('pdf')) return FileText;
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('rar')) return FileArchive;
  if (mimeType.includes('word') || mimeType.includes('document')) return FileText;
  return File;
}

function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export default function FilesPage() {
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: items = [], isLoading } = useListItems({ query: { queryKey: getListItemsQueryKey() } });
  const { data: folders = [] } = useListFolders();
  
  const files = items.filter(i => i.type === 'file' && i.status === 'active');
  
  const filteredFiles = search 
    ? files.filter(f => f.title.toLowerCase().includes(search.toLowerCase()) || f.originalFilename?.toLowerCase().includes(search.toLowerCase()))
    : files;

  const uploadFile = useUploadFile({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        toast.success("File uploaded");
      }
    }
  });

  const deleteItem = useDeleteItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
        toast.success("File deleted");
      }
    }
  });

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
            mimeType: file.type || "application/octet-stream",
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

  const handleDownload = (file: any) => {
    if (!file.fileData) {
      toast.error("File data not found");
      return;
    }
    
    // In a real app, fileData might be a URL or base64. 
    // Assuming base64 for this example, we need to convert it back to a blob to download.
    try {
      const byteCharacters = atob(file.fileData);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: file.mimeType || 'application/octet-stream' });
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.originalFilename || file.title;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Download failed", e);
      toast.error("Failed to download file");
    }
  };

  return (
    <div className="h-full flex flex-col p-6 bg-slate-50/50 dark:bg-transparent overflow-y-auto">
      <div className="flex items-center justify-between mb-8 shrink-0">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight text-foreground">Files</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage your uploaded documents and assets.</p>
        </div>
        
        <div>
          <input
            type="file"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileUpload}
          />
          <Button className="shadow-md shadow-primary/20 gap-2" onClick={() => fileInputRef.current?.click()} disabled={uploadFile.isPending}>
            {uploadFile.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
            Upload File
          </Button>
        </div>
      </div>

      <div className="relative mb-6 max-w-md shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input 
          placeholder="Search files..." 
          className="pl-9 bg-card border-border/50 shadow-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : filteredFiles.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
          <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mb-4">
            <HardDrive className="w-8 h-8 text-muted-foreground/50" />
          </div>
          <p className="font-medium">No files found</p>
          <p className="text-sm opacity-70">Upload your first file to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 pb-12">
          {filteredFiles.map(file => {
            const Icon = getFileIcon(file.mimeType || "");
            return (
              <Card key={file.id} className="group hover:shadow-md transition-all border-border/50 hover:border-primary/30 flex flex-col">
                <CardHeader className="pb-3 px-4 pt-4 relative">
                  <div className="w-12 h-12 bg-primary/10 text-primary rounded-xl flex items-center justify-center mb-3">
                    <Icon className="w-6 h-6" />
                  </div>
                  <CardTitle className="text-base leading-tight line-clamp-1 pr-6" title={file.originalFilename || file.title}>
                    {file.originalFilename || file.title}
                  </CardTitle>
                  <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-7 w-7 text-muted-foreground hover:text-primary bg-background/50 backdrop-blur-sm"
                      onClick={(e) => { e.stopPropagation(); handleDownload(file); }}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-7 w-7 text-muted-foreground hover:text-destructive bg-background/50 backdrop-blur-sm"
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        if(confirm("Delete this file?")) deleteItem.mutate({ id: file.id }); 
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 px-4 pb-4">
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(file.fileSize || 0)} • {file.mimeType?.split('/')[1]?.toUpperCase() || 'FILE'}
                  </p>
                </CardContent>
                <CardFooter className="px-4 pb-3 pt-0 flex flex-wrap gap-2 items-center justify-between border-t border-border/10 pt-3 mt-auto">
                  {file.folderName && (
                    <Badge variant="secondary" className="bg-secondary/10 text-secondary-foreground hover:bg-secondary/20 text-[10px] gap-1 px-1.5">
                      <FolderIcon className="w-3 h-3" />
                      {file.folderName}
                    </Badge>
                  )}
                  <span className="text-[10px] text-muted-foreground ml-auto font-medium">
                    {format(new Date(file.createdAt), "MMM d")}
                  </span>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
