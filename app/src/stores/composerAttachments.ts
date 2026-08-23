/**
 * Composer Attachments store — ADR-0022 v3.5 (2026-08-23)
 * v3.9 (2026-08-23): image schema 改造
 *   - 加 thumbnail (200x200 JPEG base64, 持久化) + savedPath
 *   - 加 downscale 步骤 (max 1568px long edge, JPEG 0.85), 防 413 + 降 localStorage 占用
 *   - data 仍然是 in-memory base64, 给 Pi SDK 发送用; 但 message.images 持久化前会 strip
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface PendingImage {
  // local preview URL (URL.createObjectURL), FE 渲染缩略图 (composer chip 用)
  previewUrl: string;
  // 缩放后 base64 (no data URL prefix) — Pi SDK images 字段用 (in-memory only)
  // 缩放后 JPEG 0.85, 通常 100-500KB, 比原图小 50-80%
  base64: string;
  // 缩放后 JPEG mimeType
  mimeType: string;
  // 缩放后字节数
  bytes: number;
  // 200x200 JPEG thumbnail base64 (持久化用)
  thumbnail: string;
  // Tauri 存盘后的绝对路径 (持久化, reload 后从这里重读完整图)
  savedPath: string;
  // 原文件 mimeType (给 fallback / 日志用, 缩放后统一 image/jpeg)
  originalMimeType: string;
}

export interface PendingFile {
  // local preview URL
  previewUrl?: string;
  // 绝对路径 (Tauri saveUploadedFile 返)
  path: string;
  filename: string;
  // 字节数
  bytes: number;
  // MIME type (image/png 等也算 file, 但走 image path)
  mimeType: string;
}

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 跟 Rust 端 UPLOAD_MAX_BYTES 一致
/** v3.9: 缩放目标 — 1568px long edge, 跟 gpt-4o / Claude 3.5 推荐一致, 平衡清晰度 + 体积 */
const IMAGE_MAX_EDGE = 1568;
/** JPEG 编码质量 (0-1), 0.85 是肉眼无损 + 体积友好的甜点 */
const IMAGE_JPEG_QUALITY = 0.85;
/** 持久化 thumbnail 尺寸, 200x200 用于消息气泡 chip 渲染 */
const THUMB_MAX_EDGE = 200;
const THUMB_JPEG_QUALITY = 0.7;

function isImage(mime: string): boolean {
  return IMAGE_MIME.has(mime.toLowerCase());
}

export const useComposerAttachmentsStore = defineStore('composerAttachments', () => {
  const pendingImages = ref<PendingImage[]>([]);
  const pendingFiles = ref<PendingFile[]>([]);
  // 错误信息 (upload 失败时显示, user 重试或删)
  const uploadError = ref<string | null>(null);

  /**
   * 处理 paste/drop 的 File 对象:
   *   - image/* (PNG/JPG/GIF/WEBP) -> 缩放 + thumbnail + upload -> pendingImages
   *   - 其他 -> upload -> pendingFiles
   * 限制: 10 MB / 块 (原图), 错误信息推到 uploadError
   *
   * v3.9: image 走 downscaleImage, 缩放后用 JPEG 重编码, 体积通常 100-500KB
   */
  async function addFile(file: File): Promise<void> {
    uploadError.value = null;
    if (file.size > MAX_FILE_BYTES) {
      uploadError.value = `${file.name}: 超过 10 MB 限制 (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
      return;
    }
    try {
      if (isImage(file.type)) {
        // 1) 缩放原图到 1568px long edge, JPEG 0.85
        const downscaled = await downscaleImage(file, IMAGE_MAX_EDGE, IMAGE_JPEG_QUALITY);
        // 2) 生成 200x200 thumbnail
        const thumb = await downscaleImage(file, THUMB_MAX_EDGE, THUMB_JPEG_QUALITY);
        // 3) upload 缩放后的图 (full size 给 LLM 看) 拿 savedPath
        const downscaledBytes = base64ToBytes(downscaled.base64);
        const savedPath = await import('@/lib/tauri').then((m) =>
          m.piTauri.saveUploadedFile(downscaledBytes, replaceExt(file.name, 'jpg')),
        );
        // 4) previewUrl 用原图 (composing 时 user 想看自己原图, 不是缩放后的)
        pendingImages.value = [
          ...pendingImages.value,
          {
            previewUrl: URL.createObjectURL(file),
            base64: downscaled.base64,
            mimeType: 'image/jpeg',  // 缩放后统一 JPEG
            bytes: downscaled.bytes,
            thumbnail: thumb.base64,
            savedPath,
            originalMimeType: file.type,
          },
        ];
      } else {
        // file: 原图直接 upload, 拿 savedPath
        const bytes = new Uint8Array(await file.arrayBuffer());
        const savedPath = await import('@/lib/tauri').then((m) =>
          m.piTauri.saveUploadedFile(bytes, file.name),
        );
        pendingFiles.value = [
          ...pendingFiles.value,
          {
            path: savedPath,
            filename: file.name,
            bytes: file.size,
            mimeType: file.type || 'application/octet-stream',
          },
        ];
      }
    } catch (e) {
      uploadError.value = `${file.name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function removeImage(idx: number) {
    const img = pendingImages.value[idx];
    if (img) URL.revokeObjectURL(img.previewUrl);
    pendingImages.value = pendingImages.value.filter((_, i) => i !== idx);
  }
  function removeFile(idx: number) {
    pendingFiles.value = pendingFiles.value.filter((_, i) => i !== idx);
  }
  function clear() {
    // revoke 所有 preview URL
    for (const img of pendingImages.value) URL.revokeObjectURL(img.previewUrl);
    pendingImages.value = [];
    pendingFiles.value = [];
    uploadError.value = null;
  }

  /**
   * sendPrompt 用: 把 pending 拼成 LLM input
   *   - images = pendingImages.map(转 Pi SDK ImageContent schema)
   *   - textAppend = pendingFiles.map(f => `<file path="${f.path}" name="${f.filename}" />`).join('\n')
   *     (Pi SDK 不支持 file content block, 用 <file> tag 提示 LLM, LLM 调 read 工具读路径)
   */
  function buildForPrompt(): {
    images: Array<{ type: 'image'; data: string; mimeType: string }>;
    textAppend: string;
  } {
    const images = pendingImages.value.map((img) => ({
      type: 'image' as const,
      data: img.base64,
      mimeType: img.mimeType,
    }));
    const fileTags = pendingFiles.value
      .map(
        (f) =>
          `<file path="${f.path}" name="${f.filename}" size="${f.bytes}" mime="${f.mimeType}" />`,
      )
      .join('\n');
    return { images, textAppend: fileTags };
  }

  return {
    pendingImages,
    pendingFiles,
    uploadError,
    addFile,
    removeImage,
    removeFile,
    clear,
    buildForPrompt,
    isImage,
  };
});

/**
 * 缩放图片: 用 OffscreenCanvas (Worker / main thread) 或 <canvas> 退化
 *   - maxDim: 长边最大 px (按比例缩)
 *   - quality: JPEG 质量 0-1
 *   返回: { base64 (no prefix), bytes, mimeType (image/jpeg) }
 */
async function downscaleImage(
  file: File,
  maxDim: number,
  quality: number,
): Promise<{ base64: string; bytes: number }> {
  const img = await fileToImageBitmap(file);
  const { width, height } = scaleDimensions(img.width, img.height, maxDim);
  // 用 OffscreenCanvas 优先, 退化到 <canvas>
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d');
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d');
  }
  if (!ctx) throw new Error('无法创建 canvas 2d context');
  ctx.drawImage(img, 0, 0, width, height);
  // 转 Blob -> base64
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const base64 = bytesToBase64(bytes);
  img.close?.();  // ImageBitmap 可关闭
  return { base64, bytes: bytes.length };
}

function fileToImageBitmap(file: File): Promise<ImageBitmap> {
  // createImageBitmap 走专用解码路径, 比 new Image() 快
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  // 退化: new Image() 异步
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img as unknown as ImageBitmap);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    };
    img.src = url;
  });
}

function scaleDimensions(w: number, h: number, maxDim: number): { width: number; height: number } {
  if (w <= maxDim && h <= maxDim) return { width: w, height: h };
  const ratio = w > h ? maxDim / w : maxDim / h;
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob 返回 null'))),
      type,
      quality,
    );
  });
}

/** Uint8Array -> base64 string (no data URL prefix) */
function bytesToBase64(bytes: Uint8Array): string {
  // chunked 编码避免超大字符串 stack overflow
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/** base64 (no prefix) -> Uint8Array */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 替换文件扩展名, e.g. "foo.png" + "jpg" -> "foo.jpg" */
function replaceExt(name: string, newExt: string): string {
  const dot = name.lastIndexOf('.');
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (dot < 0 || dot < slash) return `${name}.${newExt}`;
  return `${name.slice(0, dot)}.${newExt}`;
}
