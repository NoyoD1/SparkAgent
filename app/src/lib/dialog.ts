/**
 * Dialog wrapper — Tauri 文件/文件夹选择
 *
 * 用 tauri-plugin-dialog:
 *   - pickFolder(): 让用户选一个本地文件夹作为 workspace
 *   - pickFile():   让用户选一个已存在的文件 (给 import 用, 按 filter 限定类型)
 *   - pickSavePath(): 让用户选保存路径 (给 export 用)
 */
import { open, save } from '@tauri-apps/plugin-dialog';

export async function pickFolder(title = '选择工作区文件夹'): Promise<string | null> {
  try {
    const result = await open({
      directory: true,
      multiple: false,
      title,
    });
    if (typeof result === 'string') return result;
    return null;
  } catch (e) {
    console.error('[dialog] pickFolder failed', e);
    return null;
  }
}

/** pickFile — 选已存在的文件, e.g. import tool 时选 .json 或 .zip */
export async function pickFile(opts: {
  title?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  multiple?: boolean;
} = {}): Promise<string | string[] | null> {
  try {
    const result = await open({
      directory: false,
      multiple: opts.multiple ?? false,
      title: opts.title,
      filters: opts.filters,
    });
    return result;
  } catch (e) {
    console.error('[dialog] pickFile failed', e);
    return null;
  }
}

/** pickSavePath — 选保存路径, e.g. export tool 时选 .json 或 .zip 落地 */
export async function pickSavePath(opts: {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
} = {}): Promise<string | null> {
  try {
    const result = await save({
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
    });
    return typeof result === 'string' ? result : null;
  } catch (e) {
    console.error('[dialog] pickSavePath failed', e);
    return null;
  }
}
