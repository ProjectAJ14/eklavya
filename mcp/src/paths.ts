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
 * Nothing Eklavya writes ever lands in a repository again. Concept packs are
 * the deliberate exception and stay at `<repo>/.eklavya/packs/` — a pack is a
 * shared concept graph for the codebase, the same for everyone by design, and
 * content rather than configuration.
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
