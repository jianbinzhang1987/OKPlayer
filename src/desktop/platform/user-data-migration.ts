import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  DATABASE_FILENAME,
  LEGACY_DATABASE_FILENAMES,
  LEGACY_PRODUCT_NAMES,
  PRODUCT_NAME,
} from "./platform-runtime.ts";

export interface ElectronAppPathLike {
  getPath(name: "appData" | "userData"): string;
  setPath(name: "userData", value: string): void;
  setName(value: string): void;
}

export interface UserDataMigrationReport {
  userDataPath: string;
  legacyPaths: string[];
  copiedEntries: string[];
  databaseMigrated: boolean;
}

export function hasExplicitUserDataDirectory(argv: readonly string[]): boolean {
  return argv.some((argument) => argument === "--user-data-dir" || argument.startsWith("--user-data-dir="));
}

export function configureDesktopUserDataPath(
  electronApp: ElectronAppPathLike,
  argv: readonly string[] = process.argv,
): { userDataPath: string; legacyPaths: string[] } {
  const appData = electronApp.getPath("appData");
  const existingUserData = electronApp.getPath("userData");
  electronApp.setName(PRODUCT_NAME);

  if (hasExplicitUserDataDirectory(argv)) {
    return { userDataPath: existingUserData, legacyPaths: [] };
  }

  const userDataPath = path.join(appData, PRODUCT_NAME);
  electronApp.setPath("userData", userDataPath);
  const legacyPaths = LEGACY_PRODUCT_NAMES
    .map((name) => path.join(appData, name))
    .filter((candidate) => path.resolve(candidate) !== path.resolve(userDataPath));
  return { userDataPath, legacyPaths };
}

export async function migrateLegacyUserData(
  userDataPath: string,
  legacyPaths: readonly string[],
): Promise<UserDataMigrationReport> {
  await mkdir(userDataPath, { recursive: true });
  const copiedEntries: string[] = [];

  for (const legacyPath of legacyPaths) {
    if (!(await exists(legacyPath))) continue;
    for (const entry of await readdir(legacyPath)) {
      if (isTransientElectronEntry(entry)) continue;
      const source = path.join(legacyPath, entry);
      const target = path.join(userDataPath, entry);
      if (await exists(target)) continue;
      await cp(source, target, { recursive: true, force: false, errorOnExist: false });
      copiedEntries.push(entry);
    }
  }

  const databaseMigrated = await migrateDatabaseName(userDataPath);
  return {
    userDataPath,
    legacyPaths: [...legacyPaths],
    copiedEntries,
    databaseMigrated,
  };
}

async function migrateDatabaseName(userDataPath: string): Promise<boolean> {
  const target = path.join(userDataPath, DATABASE_FILENAME);
  if (await exists(target)) return false;

  for (const legacyName of LEGACY_DATABASE_FILENAMES) {
    const source = path.join(userDataPath, legacyName);
    if (!(await exists(source))) continue;
    await cp(source, target, { force: false, errorOnExist: true });
    for (const suffix of ["-wal", "-shm"]) {
      const companion = `${source}${suffix}`;
      if (await exists(companion)) await cp(companion, `${target}${suffix}`, { force: false, errorOnExist: false });
    }
    return true;
  }
  return false;
}

async function exists(value: string): Promise<boolean> {
  return stat(value).then(() => true, () => false);
}

function isTransientElectronEntry(name: string): boolean {
  return ["SingletonCookie", "SingletonLock", "SingletonSocket"].includes(name);
}
