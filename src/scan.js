// Filesystem side: walk a corpus folder, hash files, look up git provenance.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseMarkdown, sha256 } from './parse.js';
import { lifecycleOf, loadConfig, workItemOf } from './lifecycle.js';

const SKIP_DIRS = new Set(['node_modules', '.git']);

export function listMarkdown(root) {
  const out = [];
  const walkDir = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walkDir(p);
      else if (/\.md$/i.test(name)) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walkDir(root);
  return out.sort();
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse every markdown file under dir. Returns { name, root, commit, config, docs }.
 * { git: false } skips the per-file git lookups (commit is null everywhere); for read-only tools that do not need provenance.
 */
export function loadCorpus(dir, name, { git: useGit = true } = {}) {
  const root = resolve(dir);
  const config = loadConfig(root);
  const commit = useGit ? git(root, ['rev-parse', 'HEAD']) || null : null;
  const docs = listMarkdown(root).map((path) => {
    const raw = readFileSync(join(root, path), 'utf8');
    const doc = parseMarkdown(raw, path);
    doc.hash = sha256(raw);
    // Last commit that touched the file; null when untracked or not in a git repo.
    doc.commit = useGit ? git(root, ['log', '-1', '--format=%H', '--', path]) || null : null;
    doc.lifecycle = lifecycleOf(doc.frontmatter);
    doc.workItem = workItemOf(path, doc.lifecycle, config);
    return doc;
  });
  return { name: name || basename(root), root, commit, config, docs };
}

export const fileExists = (root, relPath) => existsSync(join(root, relPath));
