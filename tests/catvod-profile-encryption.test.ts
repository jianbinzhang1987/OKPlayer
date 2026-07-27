import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CatVodProfileEncryptionProvider,
  type NativeSafeStorageLike,
} from "../src/desktop/catvod-profile-encryption.ts";

class FakeNativeStorage implements NativeSafeStorageLike {
  readonly available: boolean;
  readonly failEncryption: boolean;

  constructor(available: boolean, failEncryption = false) {
    this.available = available;
    this.failEncryption = failEncryption;
  }

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(value: string): Buffer {
    if (this.failEncryption) throw new Error("native storage unavailable");
    return Buffer.from(value.split("").reverse().join(""), "utf8");
  }

  decryptString(value: Buffer): string {
    return value.toString("utf8").split("").reverse().join("");
  }
}

test("CatVod profile encryption can use native secure storage when explicitly enabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "catvod-profile-safe-"));
  const keyPath = path.join(directory, "profile.key");
  const provider = new CatVodProfileEncryptionProvider(new FakeNativeStorage(true), keyPath, {
    useNativeForNewData: true,
    allowNativeDecrypt: true,
  });
  const secret = "native-secret-value";

  const encrypted = provider.encryptString(secret);
  assert.equal(encrypted.toString("latin1").includes(secret), false);
  assert.match(encrypted.subarray(0, 6).toString("utf8"), /^SAFE1/);
  assert.equal(provider.decryptString(encrypted), secret);
  await assert.rejects(readFile(keyPath), /ENOENT/);
});

test("CatVod profile encryption defaults to AES-256-GCM with a private key file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "catvod-profile-aes-"));
  const keyPath = path.join(directory, "profile.key");
  const secret = "fallback-secret-value";
  const provider = new CatVodProfileEncryptionProvider(new FakeNativeStorage(true), keyPath);

  const encrypted = provider.encryptString(secret);
  assert.equal(encrypted.toString("latin1").includes(secret), false);
  assert.match(encrypted.subarray(0, 6).toString("utf8"), /^AESG1/);
  assert.equal(provider.decryptString(encrypted), secret);

  const key = await readFile(keyPath);
  const keyStat = await stat(keyPath);
  assert.equal(key.length, 32);
  assert.equal(keyStat.mode & 0o777, 0o600);

  const afterRestart = new CatVodProfileEncryptionProvider(new FakeNativeStorage(true), keyPath);
  assert.equal(afterRestart.decryptString(encrypted), secret);
});

test("CatVod profile encryption uses AES fallback when explicitly enabled native encryption throws", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "catvod-profile-native-failure-"));
  const keyPath = path.join(directory, "profile.key");
  const provider = new CatVodProfileEncryptionProvider(new FakeNativeStorage(true, true), keyPath, {
    useNativeForNewData: true,
    allowNativeDecrypt: true,
  });

  const encrypted = provider.encryptString("recoverable");
  assert.match(encrypted.subarray(0, 6).toString("utf8"), /^AESG1/);
  assert.equal(provider.decryptString(encrypted), "recoverable");
});

test("default profile encryption never queries native Keychain storage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "catvod-profile-no-keychain-"));
  const keyPath = path.join(directory, "profile.key");
  let nativeCalls = 0;
  const native: NativeSafeStorageLike = {
    isEncryptionAvailable() {
      nativeCalls += 1;
      throw new Error("Keychain must not be queried");
    },
    encryptString() {
      nativeCalls += 1;
      throw new Error("Keychain must not be queried");
    },
    decryptString() {
      nativeCalls += 1;
      throw new Error("Keychain must not be queried");
    },
  };
  const provider = new CatVodProfileEncryptionProvider(native, keyPath);
  const encrypted = provider.encryptString("local-only");

  assert.match(encrypted.subarray(0, 6).toString("utf8"), /^AESG1/);
  assert.equal(provider.decryptString(encrypted), "local-only");
  assert.equal(nativeCalls, 0);
  assert.throws(
    () => provider.decryptString(Buffer.concat([Buffer.from("SAFE1\0"), Buffer.from("legacy")])),
    /旧钥匙串密文/,
  );
  assert.equal(nativeCalls, 0);
});
