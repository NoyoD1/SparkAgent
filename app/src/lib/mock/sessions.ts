import type { MockWorkspace, MockSession } from './types';

// Workspaces (mirrors chat.html's sidebar 5 workspaces + 1 expanded)
export const mockWorkspaces: MockWorkspace[] = [
  {
    id: 'ws-1',
    name: 'NX_Photovoltaic',
    tag: '能源',
    files: [
      { path: 'NX_Photovoltaic/README.md', name: 'README.md', kind: 'file' },
      { path: 'NX_Photovoltaic/src/main.ts', name: 'src/main.ts', kind: 'file' },
      { path: 'NX_Photovoltaic/package.json', name: 'package.json', kind: 'file' },
    ],
    createdAt: '2025-08-10T09:12:00Z',
  },
  {
    id: 'ws-2',
    name: 'QA',
    tag: '测试',
    files: [
      { path: 'QA/tests.spec.ts', name: 'tests.spec.ts', kind: 'file' },
      { path: 'QA/fixtures/data.json', name: 'fixtures/data.json', kind: 'file' },
    ],
    createdAt: '2025-08-08T14:30:00Z',
  },
  {
    id: 'ws-3',
    name: 'EditTools',
    tag: '工具',
    files: [
      { path: 'EditTools/editor.tsx', name: 'editor.tsx', kind: 'file' },
      { path: 'EditTools/utils.ts', name: 'utils.ts', kind: 'file' },
    ],
    createdAt: '2025-08-05T11:20:00Z',
  },
  {
    id: 'ws-4',
    name: 'Energy',
    tag: '能源',
    files: [
      { path: 'Energy/model.py', name: 'model.py', kind: 'file' },
      { path: 'Energy/config.yaml', name: 'config.yaml', kind: 'file' },
    ],
    createdAt: '2025-08-01T16:45:00Z',
  },
  {
    id: 'ws-5',
    name: 'PostalParkProject_new',
    tag: '交管',
    files: [
      { path: 'PostalParkProject_new/index.html', name: 'index.html', kind: 'file' },
      { path: 'PostalParkProject_new/app.js', name: 'app.js', kind: 'file' },
    ],
    createdAt: '2025-07-28T10:00:00Z',
  },
];

// Sessions (the "active" session is "你好" in chat.html)
export const mockSessions: MockSession[] = [
  {
    id: 'sess-1',
    workspaceId: 'ws-1',
    title: '你好',
    createdAt: '2025-07-29T17:38:00Z',
    updatedAt: '2025-07-29T17:38:00Z',
  },
  {
    id: 'sess-2',
    workspaceId: 'ws-1',
    title: '光伏采集数据接入与前端展示',
    createdAt: '2025-07-28T14:20:00Z',
    updatedAt: '2025-07-29T11:05:00Z',
  },
];
