// Publish dist/ to the gh-pages branch, for GitHub Pages "Deploy from a branch".
// Needs no GitHub Actions minutes. Run: npm run deploy:pages
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BRANCH = 'gh-pages';
const git = (...args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

if (!existsSync('dist/index.html')) {
  console.error('dist/ is missing or incomplete. Run `npm run build` first.');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'sift-ghp-'));
try {
  // A detached worktree, then an orphan branch, so the published history holds only the site.
  git('worktree', 'add', '-q', '--detach', work);
  execFileSync('git', ['checkout', '-q', '--orphan', BRANCH], { cwd: work, stdio: 'inherit' });
  execFileSync('git', ['reset', '-q'], { cwd: work, stdio: 'inherit' });
  for (const entry of readdirSync(work)) {
    if (entry !== '.git') rmSync(join(work, entry), { recursive: true, force: true });
  }
  cpSync('dist', work, { recursive: true });
  execFileSync('git', ['add', '-A'], { cwd: work, stdio: 'inherit' });

  const staged = execFileSync('git', ['status', '--short'], { cwd: work }).toString().trim().split('\n').filter(Boolean);
  console.log(`publishing ${staged.length} files to ${BRANCH}`);

  const sha = git('rev-parse', '--short', 'HEAD');
  execFileSync('git', ['commit', '-q', '-m', `Built site from ${sha}`], { cwd: work, stdio: 'inherit' });
  // Force: the branch carries only the current build, never an accumulating history of artifacts.
  execFileSync('git', ['push', '-q', '--force', 'origin', BRANCH], { cwd: work, stdio: 'inherit' });
  console.log(`pushed ${BRANCH}. Settings > Pages > Deploy from a branch > ${BRANCH} / (root)`);
} finally {
  try { execFileSync('git', ['worktree', 'remove', '--force', work], { stdio: 'ignore' }); } catch {}
  try { execFileSync('git', ['worktree', 'prune'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('git', ['branch', '-D', BRANCH], { stdio: 'ignore' }); } catch {}
  rmSync(work, { recursive: true, force: true });
}
