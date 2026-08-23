/**
 * useAttachmentPreview — 全局附件预览弹层 (singleton)
 *
 * ADR-0022 v3.8 (2026-08-23):
 *   共享 image / file 预览 state, 给 Composer + ChatMessage + TaskDrawer 复用
 *   跟 useChipPreview 一样的 singleton 模式 (避免每组件各管一份 state)
 *
 * v3.9 (2026-08-23): 加 openImageFromPath — 从 savedPath 重新读完整图 (reload 后用)
 *   之前 v3.8 的 openImage 要求 data (base64), 但 message.images[].data 被持久化前会 strip,
 *   reload 后 data 变 undefined, 必须从 savedPath 重新 read 一次.
 *
 * 用法:
 *   // 打开 image 预览 (大图, in-memory base64)
 *   const { openImage } = useAttachmentPreview();
 *   openImage({ data: base64, mimeType: 'image/png' });
 *
 *   // 打开 image 预览 (从 savedPath 重读, reload 后用)
 *   const { openImageFromPath } = useAttachmentPreview();
 *   openImageFromPath('/path/to/image.jpg');  // 内部调 Tauri command
 *
 *   // 打开 file 预览 (text 前 200 行 + mime 推断)
 *   const { openFile } = useAttachmentPreview();
 *   openFile({ path: '/...', filename: 'a.ts', mimeType: 'text/typescript' });
 *
 *   // App.vue mount 一次
 *   <AttachmentPreview />
 */
import { ref, type Ref } from 'vue';

export type AttachmentPreviewState =
  | { kind: 'image'; data: string; mimeType: string }
  | {
      kind: 'file';
      path: string;
      filename: string;
      mimeType: string;
      bytes: number;
      /** 文本前 200 行 (text/* mime 才有, binary 显示 "binary file" 占位) */
      preview: string;
      loading: boolean;
      truncated: boolean;
    }
  /** v3.9: image 加载中 (从 savedPath 读 base64 期间), 区别于 image 已就绪 */
  | { kind: 'image-loading'; path: string };

const current = ref<AttachmentPreviewState | null>(null);

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_LIKE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc',
  'md', 'markdown', 'txt', 'log',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg',
  'rs', 'py', 'go', 'java', 'cs', 'cpp', 'c', 'h', 'hpp',
  'sh', 'bash', 'zsh', 'fish', 'ps1',
  'sql', 'graphql', 'gql',
  'css', 'scss', 'sass', 'less',
  'html', 'htm', 'xml', 'svg', 'vue', 'svelte', 'jsx',
  'csv', 'tsv',
  'env', 'gitignore', 'editorconfig', 'prettierrc',
]);
const MAX_PREVIEW_LINES = 200;

function isTextLike(filename: string, mimeType: string): boolean {
  if (TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) return true;
  if (mimeType === 'application/json' || mimeType === 'application/xml') return true;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_LIKE_EXTENSIONS.has(ext);
}

export function useAttachmentPreview(): {
  current: Ref<AttachmentPreviewState | null>;
  openImage: (img: { data: string; mimeType: string }) => void;
  /** v3.9: 从 savedPath 重读图片 (用于 reload 后, data 已被持久化 strip) */
  openImageFromPath: (path: string) => Promise<void>;
  openFile: (file: { path: string; filename: string; mimeType: string; bytes: number }) => Promise<void>;
  close: () => void;
} {
  function close() {
    current.value = null;
  }
  function openImage(img: { data: string; mimeType: string }) {
    current.value = { kind: 'image', data: img.data, mimeType: img.mimeType };
  }
  async function openImageFromPath(path: string) {
    if (!path) return;
    current.value = { kind: 'image-loading', path };
    try {
      const { piTauri } = await import('@/lib/tauri');
      const { data, mimeType } = await piTauri.readImageAsDataUrl(path);
      // 检查 current 没被新调用覆盖 (用户可能快速点开多个不同 image)
      if (current.value?.kind === 'image-loading' && current.value.path === path) {
        current.value = { kind: 'image', data, mimeType };
      }
    } catch (e) {
      console.error('[useAttachmentPreview] openImageFromPath failed', e);
      if (current.value?.kind === 'image-loading' && current.value.path === path) {
        // 错误状态: 改用 file kind 显示错误信息 (复用 file 渲染, 但有特殊 title)
        current.value = {
          kind: 'file',
          path,
          filename: path.split(/[/\\]/).pop() || path,
          mimeType: 'image/*',
          bytes: 0,
          preview: `⚠ 图片读取失败: ${e instanceof Error ? e.message : String(e)}`,
          loading: false,
          truncated: false,
        };
      }
    }
  }
  async function openFile(file: {
    path: string;
    filename: string;
    mimeType: string;
    bytes: number;
  }) {
    if (!isTextLike(file.filename, file.mimeType)) {
      // binary 直接展示 "binary file" (用户看不到 raw bytes)
      current.value = {
        kind: 'file',
        path: file.path,
        filename: file.filename,
        mimeType: file.mimeType,
        bytes: file.bytes,
        preview: '⚠ 二进制文件, 暂不支持直接预览 (后续会调系统默认 app 打开)',
        loading: false,
        truncated: false,
      };
      return;
    }
    // text 加载
    current.value = {
      kind: 'file',
      path: file.path,
      filename: file.filename,
      mimeType: file.mimeType,
      bytes: file.bytes,
      preview: '',
      loading: true,
      truncated: false,
    };
    try {
      const { piTauri } = await import('@/lib/tauri');
      const content = await piTauri.readTextFilePreview(file.path, MAX_PREVIEW_LINES);
      const lines = content.split('\n');
      const truncated = lines.length > MAX_PREVIEW_LINES;
      // 检查 current 状态没被新调用覆盖
      if (current.value?.kind === 'file' && current.value.path === file.path) {
        current.value = {
          ...current.value,
          preview: content,
          loading: false,
          truncated,
        };
      }
    } catch (e) {
      if (current.value?.kind === 'file' && current.value.path === file.path) {
        current.value = {
          ...current.value,
          preview: `读取失败: ${e instanceof Error ? e.message : String(e)}`,
          loading: false,
          truncated: false,
        };
      }
    }
  }
  return { current, openImage, openImageFromPath, openFile, close };
}
