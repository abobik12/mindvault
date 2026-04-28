import { useMemo, useRef, useState } from "react";
import {
  useListItems,
  useUploadFile,
  useDeleteItem,
  useUpdateItem,
  useListFolders,
  getListItemsQueryKey,
  getListFoldersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Search,
  HardDrive,
  Trash2,
  Folder as FolderIcon,
  Loader2,
  Download,
  File,
  Image as ImageIcon,
  FileText,
  FileArchive,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import { formatMoscowDateShort } from "@/lib/time";
import { cn } from "@/lib/utils";

const TEXT_PREVIEW_MAX_CHARS = 700;
const TEXT_PREVIEW_MAX_BYTES = 140 * 1024;
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "csv",
  "json",
  "xml",
  "yml",
  "yaml",
  "log",
  "html",
  "css",
  "js",
  "ts",
  "jsx",
  "tsx",
  "sql",
]);
const EXPLICIT_BINARY_EXTENSIONS = new Set([
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "zip",
  "rar",
  "7z",
  "gz",
  "bz2",
  "exe",
  "dll",
  "bin",
  "dmg",
  "iso",
]);
const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/sql",
  "text/csv",
]);
const EXPLICIT_BINARY_MIME_PREFIXES = [
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-",
  "application/msword",
  "application/vnd.oasis.opendocument",
  "application/vnd.apple",
  "application/zip",
  "application/x-zip",
  "application/x-rar",
  "application/octet-stream",
];

type FileLike = {
  id: number;
  title: string;
  originalFilename: string | null;
  mimeType: string | null;
  fileData: string | null;
  content?: string | null;
  summary?: string | null;
};

type FilePreview =
  | { kind: "image"; src: string }
  | { kind: "pdf"; src: string }
  | { kind: "csv"; rows: string[][] }
  | { kind: "text"; text: string }
  | { kind: "none"; message: string };

function getFileExtension(filename: string | null | undefined): string {
  if (!filename) return "";
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex < 0) return "";
  return filename.slice(dotIndex + 1).toLowerCase();
}

function normalizeMime(mimeType: string | null | undefined): string {
  return (mimeType || "application/octet-stream").toLowerCase();
}

function isImageFile(file: FileLike): boolean {
  return normalizeMime(file.mimeType).startsWith("image/");
}

function isPdfFile(file: FileLike): boolean {
  return normalizeMime(file.mimeType).includes("pdf");
}

function isCsvFile(file: FileLike): boolean {
  const mime = normalizeMime(file.mimeType);
  const extension = getFileExtension(file.originalFilename || file.title);
  return mime.includes("csv") || extension === "csv";
}

function isOfficeLikeFile(file: FileLike): boolean {
  const mime = normalizeMime(file.mimeType);
  const extension = getFileExtension(file.originalFilename || file.title);

  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods"].includes(extension)) {
    return true;
  }

  return (
    mime.startsWith("application/vnd.openxmlformats-officedocument") ||
    mime.startsWith("application/vnd.ms-") ||
    mime.startsWith("application/msword") ||
    mime.startsWith("application/vnd.oasis.opendocument")
  );
}

function isExplicitBinaryFile(file: FileLike): boolean {
  const mime = normalizeMime(file.mimeType);
  const extension = getFileExtension(file.originalFilename || file.title);

  if (TEXT_EXTENSIONS.has(extension)) return false;
  if (EXPLICIT_BINARY_EXTENSIONS.has(extension)) return true;
  return EXPLICIT_BINARY_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function isTextLikeFile(file: FileLike): boolean {
  const mime = normalizeMime(file.mimeType);
  const extension = getFileExtension(file.originalFilename || file.title);

  if (isExplicitBinaryFile(file)) return false;
  if (TEXT_EXTENSIONS.has(extension)) return true;
  if (mime.startsWith("text/")) return true;
  if (TEXT_MIME_EXACT.has(mime)) return true;

  return false;
}

function readBase64Signature(fileData: string, byteCount = 8): number[] {
  try {
    const maxBase64Length = Math.ceil((byteCount * 4) / 3) + 4;
    let chunk = fileData.slice(0, maxBase64Length);
    const remainder = chunk.length % 4;
    if (remainder > 0) {
      chunk = chunk.slice(0, chunk.length - remainder);
    }
    if (!chunk) return [];

    const binary = atob(chunk);
    const bytes: number[] = [];
    const limit = Math.min(byteCount, binary.length);
    for (let i = 0; i < limit; i += 1) {
      bytes.push(binary.charCodeAt(i));
    }
    return bytes;
  } catch {
    return [];
  }
}

function hasContainerBinarySignature(fileData: string): boolean {
  const sig = readBase64Signature(fileData, 8);
  if (sig.length < 4) return false;

  const isZip = sig[0] === 0x50 && sig[1] === 0x4b && sig[2] === 0x03 && sig[3] === 0x04;
  const isOle =
    sig[0] === 0xd0 &&
    sig[1] === 0xcf &&
    sig[2] === 0x11 &&
    sig[3] === 0xe0 &&
    sig[4] === 0xa1 &&
    sig[5] === 0xb1 &&
    sig[6] === 0x1a &&
    sig[7] === 0xe1;

  return isZip || isOle;
}

function parseCsvLine(line: string, delimiter: "," | ";"): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === delimiter) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function getCsvRows(text: string, maxRows = 5, maxCols = 6): string[][] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxRows);

  if (lines.length === 0) return [];

  const header = lines[0];
  const commaCount = (header.match(/,/g) || []).length;
  const semicolonCount = (header.match(/;/g) || []).length;
  const delimiter: "," | ";" = semicolonCount > commaCount ? ";" : ",";

  return lines.map((line) => {
    const parsed = parseCsvLine(line, delimiter);
    if (parsed.length <= maxCols) return parsed;
    return [...parsed.slice(0, maxCols - 1), "…"];
  });
}

function decodeBase64TextChunk(base64: string, maxBytes = TEXT_PREVIEW_MAX_BYTES): string | null {
  try {
    const maxChars = Math.floor((maxBytes * 4) / 3);
    let chunk = base64.slice(0, maxChars);
    const remainder = chunk.length % 4;
    if (remainder > 0) {
      chunk = chunk.slice(0, chunk.length - remainder);
    }
    if (!chunk) return null;

    const binary = atob(chunk);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const normalized = decoded.replace(/\u0000/g, "").trim();
    if (!normalized.length) return null;

    const controlChars =
      normalized.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g)?.length ?? 0;
    const replacementChars = normalized.match(/\uFFFD/g)?.length ?? 0;
    const total = normalized.length;

    const controlRatio = controlChars / total;
    const replacementRatio = replacementChars / total;

    if (controlRatio > 0.02 || replacementRatio > 0.01) {
      return null;
    }

    return normalized;
  } catch {
    return null;
  }
}

function buildFilePreview(file: FileLike): FilePreview {
  if (!file.fileData) {
    return { kind: "none", message: "Предпросмотр недоступен" };
  }

  const mime = normalizeMime(file.mimeType);
  const dataUrl = `data:${mime};base64,${file.fileData}`;

  if (isImageFile(file)) {
    return { kind: "image", src: dataUrl };
  }

  if (isPdfFile(file)) {
    return { kind: "pdf", src: dataUrl };
  }

  if (hasContainerBinarySignature(file.fileData)) {
    return { kind: "none", message: "Предпросмотр недоступен. Откройте или скачайте файл." };
  }

  if (isOfficeLikeFile(file)) {
    return { kind: "none", message: "Предпросмотр недоступен. Откройте или скачайте файл." };
  }

  if (isTextLikeFile(file)) {
    const decoded = decodeBase64TextChunk(file.fileData);
    if (!decoded) {
      return { kind: "none", message: "Предпросмотр недоступен" };
    }

    if (isCsvFile(file)) {
      const rows = getCsvRows(decoded);
      if (rows.length > 0) {
        return { kind: "csv", rows };
      }
    }

    const shortText =
      decoded.length > TEXT_PREVIEW_MAX_CHARS
        ? `${decoded.slice(0, TEXT_PREVIEW_MAX_CHARS)}…`
        : decoded;
    return { kind: "text", text: shortText };
  }

  return { kind: "none", message: "Предпросмотр недоступен для этого формата" };
}

function getFileSearchText(file: FileLike): string {
  if (!file.fileData || !isTextLikeFile(file)) return "";
  return decodeBase64TextChunk(file.fileData, 100 * 1024) || "";
}

function getFileIcon(mimeType: string | null) {
  if (!mimeType) return File;
  if (mimeType.startsWith("image/")) return ImageIcon;
  if (mimeType.includes("pdf")) return FileText;
  if (mimeType.includes("zip") || mimeType.includes("tar") || mimeType.includes("rar")) return FileArchive;
  if (mimeType.includes("word") || mimeType.includes("document")) return FileText;
  return File;
}

function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes) return "0 Б";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Б", "КБ", "МБ", "ГБ", "ТБ", "ПБ"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export default function FilesPage() {
  const [search, setSearch] = useState("");
  const [uploadFolderId, setUploadFolderId] = useState("none");
  const [isDragging, setIsDragging] = useState(false);
  const [failedImagePreviews, setFailedImagePreviews] = useState<Record<number, true>>({});
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: files = [], isLoading } = useListItems(
    { type: "file", status: "active" },
    { query: { queryKey: getListItemsQueryKey({ type: "file", status: "active" }) } },
  );
  const { data: folders = [] } = useListFolders();

  const userFolders = folders.filter((folder) => !folder.isSystem);

  const previewMap = useMemo(() => {
    const map = new Map<number, FilePreview>();
    for (const file of files) {
      map.set(file.id, buildFilePreview(file as FileLike));
    }
    return map;
  }, [files]);

  const searchableTextMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const file of files) {
      const searchable = getFileSearchText(file as FileLike);
      if (searchable) {
        map.set(file.id, searchable.toLowerCase());
      }
    }
    return map;
  }, [files]);

  const filteredFiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return files;

    return files.filter((file) => {
      const inTitle = file.title.toLowerCase().includes(query);
      const inFilename = file.originalFilename?.toLowerCase().includes(query) ?? false;
      const inContent = file.content?.toLowerCase().includes(query) ?? false;
      const inSummary = file.summary?.toLowerCase().includes(query) ?? false;
      const inDecodedText = searchableTextMap.get(file.id)?.includes(query) ?? false;

      return inTitle || inFilename || inContent || inSummary || inDecodedText;
    });
  }, [files, search, searchableTextMap]);

  const invalidateData = () => {
    queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListFoldersQueryKey() });
  };

  const uploadFile = useUploadFile({
    mutation: {
      onSuccess: () => {
        invalidateData();
        toast.success("Файл загружен");
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
        toast.success("Файл удален");
      },
    },
  });

  const uploadSelectedFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = (event.target?.result as string).split(",")[1];

      const parsedFolderId = uploadFolderId === "none" ? null : Number.parseInt(uploadFolderId, 10);

      toast.promise(
        uploadFile.mutateAsync({
          data: {
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            fileSize: file.size,
            fileData: base64,
            folderId: parsedFolderId,
          },
        }),
        {
          loading: "Загружаем файл...",
          success: parsedFolderId ? "Файл успешно загружен в выбранную папку" : "Файл успешно загружен",
          error: "Не удалось загрузить файл",
        },
      );
    };
    reader.readAsDataURL(file);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    uploadSelectedFile(file);

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);

    const file = event.dataTransfer.files?.[0];
    if (!file) return;

    uploadSelectedFile(file);
  };

  const handleMoveFile = (fileId: number, value: string, currentFolderId: number | null) => {
    const nextFolderId = value === "none" ? null : Number.parseInt(value, 10);
    if (Number.isNaN(nextFolderId as number)) return;
    if ((currentFolderId ?? null) === nextFolderId) return;

    updateItem.mutate(
      {
        id: fileId,
        data: {
          folderId: nextFolderId,
        },
      },
      {
        onSuccess: () => {
          toast.success("Файл перемещен");
        },
      },
    );
  };

  const handleDownload = (file: any) => {
    if (!file.fileData) {
      toast.error("Данные файла не найдены");
      return;
    }

    try {
      const byteCharacters = atob(file.fileData);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: file.mimeType || "application/octet-stream" });

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.originalFilename || file.title;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Не удалось скачать файл");
    }
  };

  return (
    <div
      className={cn(
        "h-full min-h-0 flex flex-col p-4 sm:p-6 bg-slate-50/50 dark:bg-transparent overflow-y-auto transition-colors",
        isDragging && "bg-primary/5",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (event.currentTarget === event.target) {
          setIsDragging(false);
        }
      }}
      onDrop={handleFileDrop}
    >
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center justify-between gap-4 mb-6 sm:mb-8 shrink-0">
        <div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold tracking-tight text-foreground">Файлы</h1>
          <p className="text-muted-foreground text-sm mt-1">Храните документы и медиа в одном разделе.</p>
        </div>

        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2 w-full sm:w-auto">
          <Select value={uploadFolderId} onValueChange={setUploadFolderId}>
            <SelectTrigger className="w-full sm:w-[220px]">
              <SelectValue placeholder="Папка для загрузки" />
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

          <input type="file" className="hidden" ref={fileInputRef} onChange={handleFileUpload} />
          <Button
            className="w-full sm:w-auto shadow-md shadow-primary/20 gap-2"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadFile.isPending}
          >
            {uploadFile.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
            Загрузить файл
          </Button>
        </div>
      </div>

      {isDragging && (
        <div className="mb-4 rounded-xl border border-dashed border-primary/50 bg-primary/10 px-4 py-3 text-sm text-primary">
          Отпустите файл, чтобы загрузить его в текущую выбранную папку.
        </div>
      )}

      <div className="relative mb-6 w-full max-w-md shrink-0">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Поиск по имени и содержимому..."
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
          <p className="font-medium">Файлы не найдены</p>
          <p className="text-sm opacity-70">Загрузите первый файл, чтобы начать работу.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-4 pb-12">
          {filteredFiles.map((file) => {
            const Icon = getFileIcon(file.mimeType || "");
            const preview: FilePreview = previewMap.get(file.id) ?? { kind: "none", message: "Предпросмотр недоступен" };
            const imagePreviewFailed = Boolean(failedImagePreviews[file.id]);

            return (
              <Card key={file.id} className="group hover:shadow-md transition-all border-border/50 hover:border-primary/30 flex flex-col">
                <CardHeader className="pb-3 px-4 pt-4 relative min-w-0">
                  <div className="w-12 h-12 bg-primary/10 text-primary rounded-xl flex items-center justify-center mb-3">
                    <Icon className="w-6 h-6" />
                  </div>
                  <CardTitle className="text-base leading-tight line-clamp-1 pr-6 min-w-0 break-all" title={file.originalFilename || file.title}>
                    {file.originalFilename || file.title}
                  </CardTitle>
                  <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-primary bg-background/50 backdrop-blur-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownload(file);
                      }}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive bg-background/50 backdrop-blur-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm("Удалить файл?")) {
                          deleteItem.mutate({ id: file.id });
                        }
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardHeader>

                <CardContent className="flex-1 px-4 pb-4 space-y-3">
                  <div
                    className="mx-auto h-32 w-full max-w-36 shrink-0 rounded-lg border border-border/40 bg-muted/20 overflow-hidden"
                  >
                    {preview.kind === "image" && !imagePreviewFailed && (
                      <img
                        src={preview.src}
                        alt={file.originalFilename || file.title}
                        className="h-full w-full object-cover"
                        loading="lazy"
                        onError={() => {
                          setFailedImagePreviews((prev) => ({ ...prev, [file.id]: true }));
                        }}
                      />
                    )}

                    {preview.kind === "pdf" && (
                      <object data={preview.src} type="application/pdf" className="h-full w-full">
                        <div className="h-full w-full flex items-center justify-center px-3 text-xs text-muted-foreground text-center">
                          Предпросмотр PDF недоступен в текущем браузере.
                        </div>
                      </object>
                    )}

                    {preview.kind === "csv" && (
                      <div className="h-full w-full overflow-auto">
                        <table className="min-w-full text-xs border-collapse">
                          <tbody>
                            {preview.rows.map((row, rowIndex) => (
                              <tr key={`${file.id}-row-${rowIndex}`} className={rowIndex === 0 ? "bg-muted/60" : ""}>
                                {row.map((cell, cellIndex) => (
                                  <td
                                    key={`${file.id}-cell-${rowIndex}-${cellIndex}`}
                                    className="border border-border/30 px-2 py-1 align-top max-w-[110px] truncate"
                                    title={cell}
                                  >
                                    {cell || "—"}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {preview.kind === "text" && (
                      <div className="h-full w-full overflow-auto">
                        <pre className="p-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-words leading-relaxed font-mono">
                          {preview.text}
                        </pre>
                      </div>
                    )}

                    {(preview.kind === "none" || (preview.kind === "image" && imagePreviewFailed)) && (
                      <div className="h-full w-full flex items-center justify-center px-3 text-xs text-muted-foreground text-center">
                        {preview.kind === "image"
                          ? "Не удалось загрузить превью изображения"
                          : preview.message}
                      </div>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {formatBytes(file.fileSize || 0)} • {(file.mimeType?.split("/")[1] || "file").toUpperCase()}
                  </p>
                </CardContent>

                <CardFooter className="px-4 pb-3 pt-0 flex flex-col gap-2 items-stretch border-t border-border/10 pt-3 mt-auto">
                  <div className="flex items-center justify-between gap-2">
                    {file.folderName ? (
                      <Badge variant="secondary" className="bg-secondary/10 text-secondary-foreground hover:bg-secondary/20 text-[10px] gap-1 px-1.5">
                        <FolderIcon className="w-3 h-3" />
                        {file.folderName}
                      </Badge>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">Без папки</span>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto font-medium">
                      {formatMoscowDateShort(file.createdAt)}
                    </span>
                  </div>

                  <Select
                    value={file.folderId ? String(file.folderId) : "none"}
                    onValueChange={(value) => handleMoveFile(file.id, value, file.folderId ?? null)}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Переместить в папку" />
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
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

