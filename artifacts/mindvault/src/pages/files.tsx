import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  Eye,
  Sparkles,
  Copy,
  FileCode,
  FileSpreadsheet,
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
const CODE_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "css", "html", "xml", "yaml", "yml", "sql"]);
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
  fileSize?: number | null;
  folderId?: number | null;
  folderName?: string | null;
  createdAt?: string;
  updatedAt?: string;
  content?: string | null;
  summary?: string | null;
};

type FileKind =
  | "pdf"
  | "image"
  | "docx"
  | "spreadsheet"
  | "csv"
  | "json"
  | "code"
  | "text"
  | "archive"
  | "unknown";

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

function getFileKind(file: FileLike): FileKind {
  const mime = normalizeMime(file.mimeType);
  const extension = getFileExtension(file.originalFilename || file.title);

  if (mime.startsWith("image/")) return "image";
  if (mime.includes("pdf") || extension === "pdf") return "pdf";
  if (extension === "docx" || mime.includes("wordprocessingml") || mime.includes("msword")) return "docx";
  if (["xls", "xlsx"].includes(extension) || mime.includes("spreadsheet") || mime.includes("excel")) return "spreadsheet";
  if (mime.includes("csv") || extension === "csv") return "csv";
  if (mime.includes("json") || extension === "json") return "json";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (TEXT_EXTENSIONS.has(extension) || mime.startsWith("text/")) return "text";
  if (mime.includes("zip") || mime.includes("rar") || mime.includes("tar") || ["zip", "rar", "7z", "gz"].includes(extension)) return "archive";
  return "unknown";
}

function getFileTypeLabel(file: FileLike): string {
  const extension = getFileExtension(file.originalFilename || file.title);
  if (extension) return extension.toUpperCase();
  const mime = normalizeMime(file.mimeType);
  return (mime.split("/")[1] || "FILE").toUpperCase();
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

function getFilePreviewText(file: FileLike, maxChars = TEXT_PREVIEW_MAX_CHARS): string {
  const fromContent = file.content?.trim();
  if (fromContent) {
    if (getFileKind(file) === "json") {
      try {
        const pretty = JSON.stringify(JSON.parse(fromContent), null, 2);
        return pretty.length > maxChars ? `${pretty.slice(0, maxChars)}…` : pretty;
      } catch {
        return fromContent.length > maxChars ? `${fromContent.slice(0, maxChars)}…` : fromContent;
      }
    }
    return fromContent.length > maxChars ? `${fromContent.slice(0, maxChars)}…` : fromContent;
  }

  if (!file.fileData || !isTextLikeFile(file)) return "";
  const decoded = decodeBase64TextChunk(file.fileData, TEXT_PREVIEW_MAX_BYTES);
  if (!decoded) return "";
  return decoded.length > maxChars ? `${decoded.slice(0, maxChars)}…` : decoded;
}

function buildDataUrl(file: FileLike): string | null {
  if (!file.fileData) return null;
  return `data:${normalizeMime(file.mimeType)};base64,${file.fileData}`;
}

function canPreviewInline(file: FileLike): boolean {
  const kind = getFileKind(file);
  if ((kind === "pdf" || kind === "image") && file.fileData) return true;
  return Boolean(getFilePreviewText(file, 20));
}

function getFileSearchText(file: FileLike): string {
  const content = file.content?.trim();
  if (content) return content;
  if (!file.fileData || !isTextLikeFile(file)) return "";
  return decodeBase64TextChunk(file.fileData, 100 * 1024) || "";
}

function getFileIcon(file: FileLike) {
  const kind = getFileKind(file);
  if (kind === "image") return ImageIcon;
  if (kind === "spreadsheet" || kind === "csv") return FileSpreadsheet;
  if (kind === "code" || kind === "json") return FileCode;
  if (kind === "archive") return FileArchive;
  if (kind === "pdf" || kind === "docx" || kind === "text") return FileText;
  return File;
}

function getFileKindLabel(file: FileLike): string {
  const kind = getFileKind(file);
  if (kind === "pdf") return "PDF";
  if (kind === "image") return "Изображение";
  if (kind === "docx") return "DOCX";
  if (kind === "spreadsheet") return "Таблица";
  if (kind === "csv") return "CSV";
  if (kind === "json") return "JSON";
  if (kind === "code") return "Код";
  if (kind === "text") return "Текст";
  if (kind === "archive") return "Архив";
  return "Файл";
}

function getExtractionStatus(file: FileLike): { label: string; className: string } {
  const summary = file.summary ?? "";

  if (file.content?.trim()) {
    return {
      label: "Текст извлечен",
      className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    };
  }

  if (summary.includes("extractionStatus:unsupported")) {
    return {
      label: "Формат не поддерживается",
      className: "border-slate-200 bg-slate-50 text-slate-600",
    };
  }

  if (summary.includes("extractionStatus:failed")) {
    return {
      label: "Ошибка обработки",
      className: "border-amber-200 bg-amber-50 text-amber-700",
    };
  }

  return {
    label: "Текст пока не извлечен",
    className: "border-slate-200 bg-slate-50 text-slate-600",
  };
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
  const [selectedFile, setSelectedFile] = useState<FileLike | null>(null);
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
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
      const inMime = file.mimeType?.toLowerCase().includes(query) ?? false;
      const inFolder = file.folderName?.toLowerCase().includes(query) ?? false;
      const inContent = file.content?.toLowerCase().includes(query) ?? false;
      const inSummary = file.summary?.toLowerCase().includes(query) ?? false;
      const inDecodedText = searchableTextMap.get(file.id)?.includes(query) ?? false;

      return inTitle || inFilename || inMime || inFolder || inContent || inSummary || inDecodedText;
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

  const handleCopyExtractedText = async (file: FileLike) => {
    const text = getFilePreviewText(file, 80_000);
    if (!text.trim()) {
      toast.error("В этом файле пока нет извлеченного текста");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      toast.success("Текст файла скопирован");
    } catch {
      toast.error("Не удалось скопировать текст");
    }
  };

  const handleAskAi = (file: FileLike) => {
    const name = file.originalFilename || file.title;
    localStorage.setItem(
      "mindvault_pending_file_question",
      JSON.stringify({
        prompt: `Кратко перескажи файл «${name}»`,
        attachments: [
          {
            id: file.id,
            name,
            mimeType: file.mimeType ?? null,
            fileSize: file.fileSize ?? null,
            folderId: file.folderId ?? null,
            folderName: file.folderName ?? null,
            textPreview: file.content ? file.content.slice(0, 2000) : null,
            createdAt: file.createdAt ?? new Date().toISOString(),
          },
        ],
      }),
    );
    toast.success("Файл добавлен в вопрос ассистенту");
    setLocation("/");
  };

  const renderTextPreview = (file: FileLike, className?: string) => {
    const text = getFilePreviewText(file);
    if (!text) return null;

    if (isCsvFile(file)) {
      const rows = getCsvRows(text, 4, 5);
      if (rows.length > 0) {
        return (
          <div className={cn("overflow-hidden rounded-lg border border-border/40 bg-background", className)}>
            <table className="min-w-full text-[11px] border-collapse">
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={`${file.id}-preview-row-${rowIndex}`} className={rowIndex === 0 ? "bg-muted/60" : ""}>
                    {row.map((cell, cellIndex) => (
                      <td key={`${file.id}-preview-cell-${rowIndex}-${cellIndex}`} className="border border-border/30 px-2 py-1 align-top max-w-[120px] truncate">
                        {cell || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
    }

    return (
      <pre className={cn("line-clamp-4 whitespace-pre-wrap break-words rounded-lg border border-border/40 bg-muted/20 p-2 text-[11px] leading-relaxed text-muted-foreground", getFileKind(file) === "code" || getFileKind(file) === "json" ? "font-mono" : "font-sans", className)}>
        {text}
      </pre>
    );
  };

  const renderLargePreview = (file: FileLike) => {
    const kind = getFileKind(file);
    const dataUrl = buildDataUrl(file);
    const text = getFilePreviewText(file, 80_000);

    if (kind === "pdf" && dataUrl) {
      return (
        <object data={dataUrl} type="application/pdf" className="h-[70dvh] min-h-[420px] w-full rounded-lg border border-border bg-background">
          <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
            <FileText className="h-10 w-10" />
            <p>Встроенный просмотр PDF недоступен в этом браузере.</p>
            <Button variant="outline" onClick={() => handleDownload(file)}>
              <Download className="mr-2 h-4 w-4" />
              Скачать файл
            </Button>
          </div>
        </object>
      );
    }

    if (kind === "image" && dataUrl) {
      return (
        <div className="flex h-[70dvh] min-h-[360px] items-center justify-center rounded-lg border border-border bg-muted/20 p-3">
          <img src={dataUrl} alt={file.originalFilename || file.title} className="max-h-full max-w-full object-contain" />
        </div>
      );
    }

    if (isCsvFile(file) && text) {
      const rows = getCsvRows(text, 40, 10);
      if (rows.length > 0) {
        return (
          <div className="h-[70dvh] min-h-[360px] overflow-auto rounded-lg border border-border bg-background">
            <table className="min-w-full text-sm border-collapse">
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={`${file.id}-large-row-${rowIndex}`} className={rowIndex === 0 ? "bg-muted/70 font-medium" : ""}>
                    {row.map((cell, cellIndex) => (
                      <td key={`${file.id}-large-cell-${rowIndex}-${cellIndex}`} className="border border-border/40 px-3 py-2 align-top">
                        {cell || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
    }

    if (text) {
      return (
        <pre className={cn("h-[70dvh] min-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-4 text-sm leading-relaxed", kind === "code" || kind === "json" ? "font-mono" : "font-sans")}>
          {text}
        </pre>
      );
    }

    return (
      <div className="flex h-[70dvh] min-h-[360px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-4 text-center text-sm text-muted-foreground">
        <File className="h-10 w-10" />
        <p>
          {kind === "docx"
            ? "Предпросмотр DOCX недоступен: текст еще не извлечен."
            : kind === "spreadsheet"
              ? "Предпросмотр таблицы недоступен. Если текст будет извлечен, он появится здесь."
              : "Предпросмотр для этого формата недоступен."}
        </p>
        <Button variant="outline" onClick={() => handleDownload(file)}>
          <Download className="mr-2 h-4 w-4" />
          Скачать файл
        </Button>
      </div>
    );
  };

  return (
    <>
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
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">Файлы</h1>
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
            const fileLike = file as FileLike;
            const Icon = getFileIcon(fileLike);
            const preview: FilePreview = previewMap.get(file.id) ?? { kind: "none", message: "Предпросмотр недоступен" };
            const imagePreviewFailed = Boolean(failedImagePreviews[file.id]);
            const previewText = getFilePreviewText(fileLike, 360);
            const status = getExtractionStatus(fileLike);

            return (
              <Card
                key={file.id}
                className="group cursor-pointer hover:shadow-md transition-all border-border/50 hover:border-primary/30 flex flex-col"
                onClick={() => setSelectedFile(fileLike)}
              >
                <CardHeader className="pb-3 px-4 pt-4 relative min-w-0">
                  <div className="flex items-start gap-3 pr-16">
                    <div className="w-12 h-12 bg-primary/10 text-primary rounded-xl flex items-center justify-center shrink-0">
                      <Icon className="w-6 h-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-base leading-tight line-clamp-2 min-w-0 break-words" title={file.originalFilename || file.title}>
                        {file.originalFilename || file.title}
                      </CardTitle>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatBytes(file.fileSize || 0)} • {getFileTypeLabel(fileLike)}
                      </p>
                    </div>
                  </div>
                  <div className="absolute top-3 right-3 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-primary bg-background/50 backdrop-blur-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedFile(fileLike);
                      }}
                      title="Открыть"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </Button>
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
                  <div className="min-h-[116px] rounded-xl border border-border/40 bg-muted/20 overflow-hidden">
                    {preview.kind === "image" && !imagePreviewFailed ? (
                      <img
                        src={preview.src}
                        alt={file.originalFilename || file.title}
                        className="h-32 w-full object-cover"
                        loading="lazy"
                        onError={() => {
                          setFailedImagePreviews((prev) => ({ ...prev, [file.id]: true }));
                        }}
                      />
                    ) : previewText ? (
                      <div className="p-2">
                        {renderTextPreview(fileLike, "border-0 bg-transparent p-0")}
                      </div>
                    ) : (
                      <div className="flex h-32 flex-col items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground">
                        <Icon className="h-7 w-7 opacity-70" />
                        <span>
                          {getFileKind(fileLike) === "pdf"
                            ? "PDF откроется в большом просмотре"
                            : getFileKind(fileLike) === "docx"
                              ? "DOCX: текст появится после извлечения"
                              : getFileKind(fileLike) === "spreadsheet"
                                ? "Предпросмотр таблицы недоступен"
                                : imagePreviewFailed
                                  ? "Не удалось загрузить миниатюру"
                                  : "Предпросмотр недоступен"}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className={cn("max-w-full text-[10px] font-medium", status.className)}>
                      {status.label}
                    </Badge>
                    <Badge variant="secondary" className="max-w-full text-[10px] font-medium">
                      {getFileKindLabel(fileLike)}
                    </Badge>
                  </div>
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

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 rounded-lg text-xs"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedFile(fileLike);
                      }}
                    >
                      <Eye className="mr-1.5 h-3.5 w-3.5" />
                      Открыть
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 rounded-lg text-xs"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleAskAi(fileLike);
                      }}
                    >
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      Спросить AI
                    </Button>
                  </div>

                  <div onClick={(event) => event.stopPropagation()}>
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
                  </div>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </div>

    <Dialog open={Boolean(selectedFile)} onOpenChange={(open) => !open && setSelectedFile(null)}>
      <DialogContent className="flex h-[92dvh] w-[calc(100vw-1rem)] max-w-6xl flex-col overflow-hidden p-0 sm:h-[88dvh]">
        {selectedFile ? (
          <>
            <DialogHeader className="border-b border-border/60 px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-start justify-between gap-3 pr-8">
                <div className="min-w-0">
                  <DialogTitle className="truncate text-base sm:text-lg" title={selectedFile.originalFilename || selectedFile.title}>
                    {selectedFile.originalFilename || selectedFile.title}
                  </DialogTitle>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{getFileKindLabel(selectedFile)}</span>
                    <span>•</span>
                    <span>{formatBytes(selectedFile.fileSize || 0)}</span>
                    <span>•</span>
                    <span>{getFileTypeLabel(selectedFile)}</span>
                    {selectedFile.folderName ? (
                      <>
                        <span>•</span>
                        <span>{selectedFile.folderName}</span>
                      </>
                    ) : null}
                    {selectedFile.createdAt ? (
                      <>
                        <span>•</span>
                        <span>{formatMoscowDateShort(selectedFile.createdAt)}</span>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            </DialogHeader>

            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="min-h-0 overflow-auto bg-muted/20 p-3 sm:p-4">{renderLargePreview(selectedFile)}</div>

              <aside className="min-h-0 overflow-auto border-t border-border/60 bg-background p-4 lg:border-l lg:border-t-0">
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline" className={cn("text-[10px] font-medium", getExtractionStatus(selectedFile).className)}>
                      {getExtractionStatus(selectedFile).label}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] font-medium">
                      {canPreviewInline(selectedFile) ? "Preview" : "Metadata"}
                    </Badge>
                  </div>

                  <div className="space-y-2 text-sm">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Действия</div>
                    <div className="grid grid-cols-1 gap-2">
                      <Button variant="outline" className="justify-start gap-2" onClick={() => handleDownload(selectedFile)}>
                        <Download className="h-4 w-4" />
                        Скачать
                      </Button>
                      <Button variant="outline" className="justify-start gap-2" onClick={() => handleAskAi(selectedFile)}>
                        <Sparkles className="h-4 w-4" />
                        Спросить AI по файлу
                      </Button>
                      <Button
                        variant="outline"
                        className="justify-start gap-2"
                        onClick={() => handleCopyExtractedText(selectedFile)}
                        disabled={!getFilePreviewText(selectedFile, 20)}
                      >
                        <Copy className="h-4 w-4" />
                        Скопировать текст
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Извлеченный текст</div>
                    {getFilePreviewText(selectedFile, 1200) ? (
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/40 bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
                        {getFilePreviewText(selectedFile, 1200)}
                      </pre>
                    ) : (
                      <p className="rounded-lg border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
                        Текстового preview пока нет. Файл можно открыть крупно, скачать или передать ассистенту как контекст по имени и метаданным.
                      </p>
                    )}
                  </div>

                  <div className="space-y-1 text-xs text-muted-foreground">
                    <div className="font-medium text-foreground">Метаданные</div>
                    <div>MIME: {selectedFile.mimeType || "unknown"}</div>
                    <div>Размер: {formatBytes(selectedFile.fileSize || 0)}</div>
                    <div>Папка: {selectedFile.folderName || "Без папки"}</div>
                  </div>
                </div>
              </aside>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
    </>
  );
}

