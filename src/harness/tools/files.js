// File tools. Read-only ones run in the loop; side-effecting ones only ever queue into a plan.
import * as fs from '../../fs/index.js';
import { fmtBytes } from '../../ui/dom.js';

function listing(ctx) {
  return ctx.store.get().listing;
}

export function registerFileTools(registry) {
  registry.register({
    name: 'list_files',
    description: 'List files in the connected folder. Optional filters: ext (e.g. ".pdf"), contains (substring of the name, case-insensitive), limit (default 100).',
    schema: { type: 'object', properties: { ext: { type: 'string' }, contains: { type: 'string' }, limit: { type: 'integer' } } },
    handler: (args, ctx) => {
      let files = listing(ctx).filter((f) => f.kind === 'file');
      if (args.ext) files = files.filter((f) => f.ext === String(args.ext).toLowerCase().replace(/^([^.])/, '.$1'));
      if (args.contains) files = files.filter((f) => f.name.toLowerCase().includes(String(args.contains).toLowerCase()));
      const limit = Math.min(Number(args.limit) || 100, 500);
      return { total: files.length, files: files.slice(0, limit).map((f) => ({ path: f.path, size: f.size, modified: new Date(f.lastModified).toISOString().slice(0, 10) })) };
    },
  });
  registry.register({
    name: 'read_excerpt',
    description: 'Read the beginning of a text file. Arguments: path (as listed), bytes (default 500, max 4000).',
    schema: { type: 'object', properties: { path: { type: 'string' }, bytes: { type: 'integer' } }, required: ['path'] },
    handler: async (args, ctx) => {
      const { folder } = ctx.store.get();
      const f = listing(ctx).find((x) => x.path === args.path && x.kind === 'file');
      if (!f) return { error: 'no such file in the listing' };
      const bytes = Math.min(Number(args.bytes) || 500, 4000);
      return { path: f.path, excerpt: await fs.readExcerpt(folder.handle, f.path, bytes) };
    },
  });
  registry.register({
    name: 'get_stats',
    description: 'Summary of the connected folder: counts by extension, total size, oldest and newest modification dates, subfolders.',
    handler: (args, ctx) => {
      const all = listing(ctx);
      const files = all.filter((f) => f.kind === 'file');
      const byExt = {};
      let size = 0, oldest = Infinity, newest = 0;
      for (const f of files) { byExt[f.ext || '(none)'] = (byExt[f.ext || '(none)'] ?? 0) + 1; size += f.size; oldest = Math.min(oldest, f.lastModified); newest = Math.max(newest, f.lastModified); }
      return { files: files.length, folders: all.filter((f) => f.kind === 'directory').map((d) => d.path), totalSize: fmtBytes(size), byExtension: byExt, oldest: files.length ? new Date(oldest).toISOString().slice(0, 10) : null, newest: files.length ? new Date(newest).toISOString().slice(0, 10) : null };
    },
  });
  registry.register({
    name: 'rename',
    description: 'Rename a file in place. Arguments: from (current path), to (new name or path), reason.',
    schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, reason: { type: 'string' } }, required: ['from', 'to'] },
    sideEffects: true,
    handler: () => { throw new Error('side-effecting tools never execute from the loop'); },
  });
  registry.register({
    name: 'move',
    description: 'Move a file into a folder. Arguments: from (current path), to (destination path including the folder), reason.',
    schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, reason: { type: 'string' } }, required: ['from', 'to'] },
    sideEffects: true,
    handler: () => { throw new Error('side-effecting tools never execute from the loop'); },
  });
  registry.register({
    name: 'create_folder',
    description: 'Create a new folder. Arguments: path.',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    sideEffects: true,
    handler: () => { throw new Error('side-effecting tools never execute from the loop'); },
  });
  return registry;
}

/** Convert queued side-effecting calls into plan operations for validation/review. */
export function queuedToOps(queued) {
  const ops = [];
  for (const q of queued) {
    const a = q.arguments ?? {};
    if (q.name === 'rename' || q.name === 'move') ops.push({ type: q.name, from: a.from, to: a.to, reason: a.reason ?? `agent: ${q.name}` });
    else if (q.name === 'create_folder') ops.push({ type: 'create_folder', to: a.path ?? a.to ?? a.name, reason: 'agent: create_folder' });
  }
  return ops;
}
