/**
 * Composer Attachments store — ADR-0022 v3.5 (2026-08-23)
 *
 * 管理 user 在 composer 里粘贴/拖拽的图片/文件:
 *   - pendingImages: ImageContent[] — Pi SDK 原生 images 字段 (vision model 看图)
 *   - pendingFiles: PendingFile[] — 普通文件, message text 拼 <file path="..." /> (LLM 调 read 工具看内容)
 *
 * 流程:
 *   1. paste/drop handler 拿 blob
 *   2. blob -> upload_to_tauri(saveUploadedFile) -> 拿绝对路径
 *   3. image 类型 -> pendingImages.add({ data: base64, mimeType })
 *      file 类型 -> pendingFiles.add({ path, filename })
 *   4. sendPrompt 时 images=pendingImages, message text 拼 file paths
 *   5. 发送后 clear()
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface PendingImage {
  // local preview URL (URL.createObjectURL), FE 渲染缩略图
  previewUrl: string;
  // base64 data (no data URL prefix) — Tauri saveUploadedFile 后, 不直接 base64 走 Pi SDK
  // 实际: 我们让 Tauri 存盘后, 返绝对路径, FE 把 path 拼到 message text
  //       但 Pi SDK 期望 base64 data 字段. 所以保留原始 base64 + path
  base64: string;
  mimeType: string;
  // 字节数 (用来显示 "<image> 2.3 MB")
  bytes: number;
  // Tauri 存盘后的绝对路径 (file tag 用)
  savedPath?: string;
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
   *   - image/* (PNG/JPG/GIF/WEBP) -> upload -> pendingImages
   *   - 其他 -> upload -> pendingFiles
   * 限制: 10 MB / 块, 错误信息推到 uploadError
   */
  async function addFile(file: File): Promise<void> {
    uploadError.value = null;
    if (file.size > MAX_FILE_BYTES) {
      uploadError.value = `${file.name}: 超过 10 MB 限制 (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const savedPath = await import('@/lib/tauri').then((m) =>
        m.piTauri.saveUploadedFile(bytes, file.name),
      );
      if (isImage(file.type)) {
        // image: 同时保留 base64 给 Pi SDK images[], path 给 file tag (后端 fallback)
        const base64 = bytesToBase64(bytes);
        pendingImages.value = [
          ...pendingImages.value,
          {
            previewUrl: URL.createObjectURL(file),
            base64,
            mimeType: file.type,
            bytes: file.size,
            savedPath,
          },
        ];
      } else {
        // file: 仅 path, 拼到 message text
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
 * Uint8Array -> base64 string (no data URL prefix)
 * 跟 Tauri saveUploadedFile 不同: 这个是给 Pi SDK images 字段用的, 必须 in-memory
 * 不能走文件 (因为 Pi SDK 0.84.2 ImageContent.data 期望 base64 string)
 */
function bytesToBase64(bytes: Uint8Array): string {
  // chunked 编码避免超大字符串 stack overflow
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}
