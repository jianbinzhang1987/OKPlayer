const LEGACY_PROFILE_KEY = "catVodProfile";
const ENCRYPTED_PROFILE_KEY = "catVodProfileEncryptedV1";
const RECOVERY_PROFILE_KEY = "catVodProfileEncryptedRecoveryV1";

export interface CatVodProfileSettingsStore {
  getSetting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
  deleteSetting(key: string): void;
}

export interface CatVodProfileEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface EncryptedProfileEnvelope {
  version: 1;
  algorithm: "catvod-protected-storage-v1" | "electron-safe-storage";
  ciphertext: string;
}

export class CatVodProfileStore {
  private readonly settings: CatVodProfileSettingsStore;
  private readonly encryption: CatVodProfileEncryption;

  constructor(settings: CatVodProfileSettingsStore, encryption: CatVodProfileEncryption) {
    this.settings = settings;
    this.encryption = encryption;
  }

  load(): Record<string, unknown> {
    const encrypted = this.settings.getSetting<EncryptedProfileEnvelope | null>(ENCRYPTED_PROFILE_KEY, null);
    if (isEncryptedEnvelope(encrypted)) {
      try {
        return parseProfile(this.encryption.decryptString(Buffer.from(encrypted.ciphertext, "base64")));
      } catch {
        // Preserve the inaccessible payload for a future signed build, but stop retrying it
        // on every query so unsigned builds never trigger repeated Keychain prompts.
        this.settings.setSetting(RECOVERY_PROFILE_KEY, encrypted);
        this.settings.deleteSetting(ENCRYPTED_PROFILE_KEY);
        return {};
      }
    }

    const legacy = asRecord(this.settings.getSetting<unknown>(LEGACY_PROFILE_KEY, {}));
    if (Object.keys(legacy).length > 0) this.save(legacy);
    else this.settings.deleteSetting(LEGACY_PROFILE_KEY);
    return legacy;
  }

  save(profile: unknown): void {
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，无法保存 CatVod Profile");
    }
    const normalized = asRecord(profile);
    const encrypted = this.encryption.encryptString(JSON.stringify(normalized));
    const envelope: EncryptedProfileEnvelope = {
      version: 1,
      algorithm: "catvod-protected-storage-v1",
      ciphertext: encrypted.toString("base64"),
    };
    this.settings.setSetting(ENCRYPTED_PROFILE_KEY, envelope);
    this.settings.deleteSetting(LEGACY_PROFILE_KEY);
  }
}

export function isCatVodProtectedSettingKey(key: unknown): boolean {
  if (typeof key !== "string") return false;
  return key === LEGACY_PROFILE_KEY || key.startsWith("catVodProfileEncrypted");
}

function isEncryptedEnvelope(value: unknown): value is EncryptedProfileEnvelope {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { version?: unknown }).version === 1
    && ["catvod-protected-storage-v1", "electron-safe-storage"].includes(String((value as { algorithm?: unknown }).algorithm ?? ""))
    && typeof (value as { ciphertext?: unknown }).ciphertext === "string";
}

function parseProfile(value: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    throw new Error("CatVod 加密 Profile 无法解析");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
