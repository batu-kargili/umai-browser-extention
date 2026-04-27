import type { AttachmentManifest, FileInspectionConfig } from "../../shared/types";

const TEXT_EXTENSIONS = new Set(["txt", "csv"]);
const SERVER_EXTENSIONS = new Set(["xlsx", "docx"]);

let pendingFiles: File[] = [];

function extensionFromName(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).trim().toLowerCase() : "";
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256File(file: File): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return bytesToHex(digest);
  } catch (_error) {
    return null;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function readTextFile(file: File, maxExtractedChars: number): Promise<{
  text: string;
  truncated: boolean;
}> {
  const bytes = await file.slice(0, maxExtractedChars + 1).arrayBuffer();
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return {
    text: text.slice(0, maxExtractedChars),
    truncated: text.length > maxExtractedChars || file.size > maxExtractedChars
  };
}

async function buildManifest(file: File, config: FileInspectionConfig): Promise<AttachmentManifest> {
  const extension = extensionFromName(file.name);
  const base = {
    filename: file.name,
    mime: file.type || "application/octet-stream",
    extension,
    size_bytes: file.size,
    sha256: await sha256File(file),
    extracted_chars: 0,
    truncated: false
  };

  if (!config.supportedTypes.includes(extension)) {
    return {
      ...base,
      inspection_status: "unsupported"
    };
  }

  if (file.size > config.maxFileBytes) {
    return {
      ...base,
      inspection_status: "too_large"
    };
  }

  try {
    if (TEXT_EXTENSIONS.has(extension)) {
      const extracted = await readTextFile(file, config.maxExtractedChars);
      return {
        ...base,
        inspection_status: extracted.truncated ? "truncated" : "extracted",
        extracted_chars: extracted.text.length,
        truncated: extracted.truncated,
        extracted_text: extracted.text
      };
    }

    if (SERVER_EXTENSIONS.has(extension)) {
      return {
        ...base,
        inspection_status: "server_required",
        content_b64: arrayBufferToBase64(await file.arrayBuffer())
      };
    }

    return {
      ...base,
      inspection_status: "unsupported"
    };
  } catch (error) {
    return {
      ...base,
      inspection_status: "extraction_failed",
      error: error instanceof Error ? error.message : "Attachment extraction failed."
    };
  }
}

function rememberFiles(files: FileList | File[]): void {
  pendingFiles = Array.from(files).filter((file) => file.size > 0);
}

export function startAttachmentCapture(): void {
  document.addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === "file" && target.files) {
        rememberFiles(target.files);
      }
    },
    true
  );

  document.addEventListener(
    "drop",
    (event) => {
      const files = event.dataTransfer?.files;
      if (files && files.length > 0) {
        rememberFiles(files);
      }
    },
    true
  );
}

export async function getPendingAttachmentManifests(
  config: FileInspectionConfig
): Promise<AttachmentManifest[]> {
  if (!config.enabled || pendingFiles.length === 0) {
    return [];
  }
  return Promise.all(pendingFiles.map((file) => buildManifest(file, config)));
}
