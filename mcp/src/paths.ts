import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Eklavya keeps all state in one directory so it is trivially inspectable and
 * deletable. `EKLAVYA_HOME` exists so tests never touch the real learner's data.
 */
export function eklavyaHome(): string {
  return process.env.EKLAVYA_HOME ?? path.join(os.homedir(), '.eklavya');
}

export function dbPath(): string {
  return process.env.EKLAVYA_DB ?? path.join(eklavyaHome(), 'knowledge.db');
}

export function globalConfigPath(): string {
  return path.join(eklavyaHome(), 'config.json');
}

/** Directory of this module — `src/` under tsx, `dist/` after a build. */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function migrationsDir(): string {
  return path.join(moduleDir, 'migrations');
}

export function seedDir(): string {
  return path.join(moduleDir, 'seed');
}

/**
 * Per-project settings, kept **outside** the checkout.
 *
 * Eklavya used to read `<repo>/.eklavya.json`, a file you committed. That was
 * wrong in the ordinary case: a project's settings are how *you* want to be
 * taught in that codebase, and a committed file makes one person's choice
 * everybody's. It also made every clone a configuration file from a stranger,
 * which cost a whole security boundary to contain.
 *
 * So project settings live beside the global ones, keyed by the checkout's
 * absolute path, the way `~/.claude/projects/` does it:
 *
 *   ~/.eklavya/config.json                         you, everywhere
 *   ~/.eklavya/projects/<slug>/config.json         you, on one project
 *
 * Nothing Eklavya writes ever lands in a repository again — concept packs
 * included; see `projectPacksDir` below, which moved for the same reason. The
 * pre-move directories are still *read* so nothing breaks on upgrade, and the
 * settings file is deleted from the checkout while a pack is not, because a
 * committed pack is authored content somebody reviewed.
 */
export function projectsDir(): string {
  return path.join(eklavyaHome(), 'projects');
}

/**
 * The directory name for a checkout: its absolute path with the separators
 * turned into dashes, which is what `~/.claude/projects/` does and what makes
 * the directory identifiable at a glance. Readability is the whole point —
 * somebody looking for "the settings for this repo" has to be able to find
 * them without a lookup table.
 *
 * It is lossy, and deliberately so: `/a/b-c` and `/a-b/c` both slug to
 * `-a-b-c`. The collision is caught rather than avoided — `projectConfigPath`'s
 * file records the path it belongs to, and `loadConfig` ignores a file whose
 * `project` names a different checkout. A rare wrong-directory read is worth a
 * name you can recognise; a silent one would not be.
 */
export function projectSlug(repoRoot: string): string {
  return repoRoot.replace(/[/\\:]/g, '-');
}

export function projectConfigPath(repoRoot: string): string {
  return path.join(projectsDir(), projectSlug(repoRoot), 'config.json');
}

/**
 * A project's concept packs, kept outside the checkout like its settings.
 *
 * Packs used to live at `<repo>/.eklavya/packs/`, committed, and that was the
 * last thing Eklavya wrote into a repository. The argument for keeping them
 * there was real — a pack is a shared concept graph, the same for everyone —
 * but it lost to a simpler rule: Eklavya creates no files in your project.
 *
 * `loadPacks` still *reads* the old location, so a repository that already
 * ships one keeps working, and nothing deletes it. That asymmetry with the
 * settings file is deliberate: a settings file was a mistake to undo, while a
 * committed pack is authored content somebody reviewed, and relocating it is
 * their decision rather than ours.
 */
export function projectPacksDir(repoRoot: string): string {
  return path.join(projectsDir(), projectSlug(repoRoot), 'packs');
}

/**
 * Explainer pages and other artifacts, one folder per project, named with the
 * same slug as `projects/`. Outside the checkout for the same reason settings
 * and packs are: Eklavya creates no files in your project.
 */
export function artifactsDir(): string {
  return path.join(eklavyaHome(), 'artifacts');
}

/**
 * Private to the person whose history it is.
 *
 * `~/.eklavya` holds every prompt, edit and answer Eklavya has seen, and it was
 * created 0755 with a 0644 database: readable by every other account on a
 * shared machine. The directory is now 0700 and the files in it 0600.
 *
 * Existing installs are tightened on the next open, but only when the path is
 * ours (a directory somebody pointed `EKLAVYA_HOME` at on purpose, owned by
 * another account, is left as found) and never at the cost of a failure: a
 * filesystem that refuses `chmod` (Windows, some network mounts) still gets a
 * working Eklavya.
 */
export function makePrivate(target: string, wanted: number): void {
  try {
    const st = fs.statSync(target);
    const uid = process.getuid?.();
    if (uid === undefined || st.uid !== uid) return;
    if ((st.mode & 0o777 & ~wanted) !== 0) fs.chmodSync(target, st.mode & 0o777 & wanted);
  } catch {
    // Best effort, by design: see above.
  }
}

/** Creates `~/.eklavya` 0700 if it is missing, and tightens it if it is looser. */
export function ensureEklavyaHome(): string {
  const home = eklavyaHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  makePrivate(home, 0o700);
  return home;
}

/**
 * High, unassigned, and deliberately boring to collide with.
 *
 * The low 5000s are where every dev server lands — Vite alone walks 5173, 5174,
 * 5175 upward as it finds ports taken — so a default down there is a default
 * you have to override. This sits above the registered services in /etc/services
 * and below the 49152+ ephemeral range the OS hands out for outbound sockets,
 * so neither end can claim it first. (1729 is the Hardy–Ramanujan number, which
 * is as good a reason as any to remember it.)
 *
 * Lives here, not in `dashboard.ts`, because the SessionStart hook probes it on
 * every session and importing the dashboard module drags in zod and the memory
 * worker for one number.
 */
export const DEFAULT_PORT = 41729;
