/**
 * Dialog wrapper — Tauri 文件/文件夹选择
 *
 * 用 tauri-plugin-dialog:
 *   - pickFolder(): 让用户选一个本地文件夹作为 workspace
 */
import { open } from '@tauri-apps/plugin-dialog';

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
