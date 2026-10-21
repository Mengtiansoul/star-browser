// ============================================================
// lib/edge.mjs — 自适应找 Edge（换机器不用改代码）
//
// 顺序：env(STAR_BROWSER_EDGE) → 常见安装路径 → PATH 里的 msedge
// 都没有就抛一条能照着做的错误，而不是让 Playwright 报 ENOENT。
// ============================================================
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exists = (p) => {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
};

/** 用 where/which 在 PATH 里找 */
function fromPath(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [cmd], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const hit = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).find(exists);
    return hit || null;
  } catch {
    return null;
  }
}

/** 各平台常见安装位置（按可能性排序） */
function candidates() {
  if (process.platform === 'win32') {
    const out = [];
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    out.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    out.push(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    out.push(path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    return out;
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(os.homedir(), 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
    ];
  }
  return [
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/microsoft-edge-beta',
    '/opt/microsoft/msedge/msedge',
    '/snap/bin/microsoft-edge',
  ];
}

export function findEdge() {
  const explicit = (process.env.STAR_BROWSER_EDGE || '').trim();
  if (explicit) {
    if (!exists(explicit)) {
      throw new Error(
        `STAR_BROWSER_EDGE 指向的文件不存在: ${explicit}\n` +
        '请改成 msedge/msedge.exe 的完整路径，或清掉这个环境变量让它自动探测。'
      );
    }
    return explicit;
  }
  for (const c of candidates()) if (exists(c)) return c;
  const viaPath = fromPath('msedge') || fromPath('microsoft-edge') || fromPath('microsoft-edge-stable');
  if (viaPath) return viaPath;

  throw new Error(
    [
      '没找到 Microsoft Edge。',
      '这个管家是驱动 Edge 的（不是 Chromium 自带内核），需要先装 Edge：',
      '  Windows: https://www.microsoft.com/edge   （装完通常是 C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe）',
      '  macOS:   brew install --cask microsoft-edge',
      '  Linux:   https://packages.microsoft.com/ （或发行版仓库里的 microsoft-edge-stable）',
      '装好还找不到的话，用环境变量指定路径：',
      '  STAR_BROWSER_EDGE="C:\\path\\to\\msedge.exe" star-browser',
      '',
      `已尝试: ${[...candidates()].join(' | ')} 以及 PATH 里的 msedge / microsoft-edge`,
    ].join('\n')
  );
}

/** 探测一下能不能用（cli --doctor 用） */
export function probeEdge() {
  try {
    const p = findEdge();
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
