import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CatVodProfileEncryption } from "./catvod-profile-store.ts";

const SAFE_STORAGE_PREFIX = Buffer.from("SAFE1\0", "utf8");
const LOCAL_AES_PREFIX = Buffer.from("AESG1\0", "utf8");
const LOCAL_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface NativeSafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface CatVodProfileEncryptionOptions {
  useNativeForNewData?: boolean;
  allowNativeDecrypt?: boolean;
  platform?: NodeJS.Platform;
}

export class CatVodProfileEncryptionProvider implements CatVodProfileEncryption {
  private readonly native: NativeSafeStorageLike;
  private readonly keyPath: string;
  private readonly useNativeForNewData: boolean;
  private readonly allowNativeDecrypt: boolean;
  private readonly platform: NodeJS.Platform;

  constructor(
    native: NativeSafeStorageLike,
    keyPath: string,
    options: CatVodProfileEncryptionOptions = {},
  ) {
    this.native = native;
    this.keyPath = keyPath;
    this.useNativeForNewData = options.useNativeForNewData === true;
    this.allowNativeDecrypt = options.allowNativeDecrypt === true;
    this.platform = options.platform ?? process.platform;
  }

  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(value: string): Buffer {
    if (this.useNativeForNewData && this.native.isEncryptionAvailable()) {
      try {
        return Buffer.concat([SAFE_STORAGE_PREFIX, this.native.encryptString(value)]);
      } catch {
        // Unsigned and test builds may not have a stable Keychain identity.
      }
    }
    return Buffer.concat([LOCAL_AES_PREFIX, this.encryptWithLocalKey(value)]);
  }

  decryptString(value: Buffer): string {
    if (startsWith(value, SAFE_STORAGE_PREFIX)) {
      if (!this.allowNativeDecrypt) {
        throw new Error("CatVod Profile 使用了不可访问的旧钥匙串密文");
      }
      return this.native.decryptString(value.subarray(SAFE_STORAGE_PREFIX.length));
    }
    if (startsWith(value, LOCAL_AES_PREFIX)) {
      return this.decryptWithLocalKey(value.subarray(LOCAL_AES_PREFIX.length));
    }
    if (!this.allowNativeDecrypt) {
      throw new Error("CatVod Profile 使用了不可访问的旧系统密文");
    }
    // Compatibility for an early envelope that stored native ciphertext without a prefix.
    return this.native.decryptString(value);
  }

  private encryptWithLocalKey(value: string): Buffer {
    const key = this.loadOrCreateLocalKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
  }

  private decryptWithLocalKey(value: Buffer): string {
    if (value.length < IV_BYTES + TAG_BYTES) throw new Error("CatVod Profile 密文格式无效");
    const key = this.loadOrCreateLocalKey();
    const iv = value.subarray(0, IV_BYTES);
    const tag = value.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const encrypted = value.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }

  private loadOrCreateLocalKey(): Buffer {
    try {
      const existing = readFileSync(this.keyPath);
      if (existing.length !== LOCAL_KEY_BYTES) throw new Error("CatVod Profile 本地密钥长度无效");
      protectLocalKeyFile(this.keyPath, this.platform);
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    mkdirSync(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    const generated = randomBytes(LOCAL_KEY_BYTES);
    try {
      writeFileSync(this.keyPath, generated, { flag: "wx", mode: 0o600 });
      return generated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readFileSync(this.keyPath);
      if (existing.length !== LOCAL_KEY_BYTES) throw new Error("CatVod Profile 本地密钥长度无效");
      protectLocalKeyFile(this.keyPath, this.platform);
      return existing;
    }
  }
}

export function protectLocalKeyFile(keyPath: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  chmodSync(keyPath, 0o600);
}

function startsWith(value: Buffer, prefix: Buffer): boolean {
  return value.length >= prefix.length && value.subarray(0, prefix.length).equals(prefix);
}
