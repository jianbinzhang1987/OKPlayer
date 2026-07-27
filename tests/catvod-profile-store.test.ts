import assert from "node:assert/strict";
import test from "node:test";
import {
  CatVodProfileStore,
  isCatVodProtectedSettingKey,
  type CatVodProfileEncryption,
  type CatVodProfileSettingsStore,
} from "../src/desktop/catvod-profile-store.ts";

class MemorySettings implements CatVodProfileSettingsStore {
  readonly values = new Map<string, unknown>();

  getSetting<T>(key: string, fallback: T): T {
    return this.values.has(key) ? this.values.get(key) as T : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }

  deleteSetting(key: string): void {
    this.values.delete(key);
  }
}

class FakeEncryption implements CatVodProfileEncryption {
  private readonly available: boolean;

  constructor(available = true) {
    this.available = available;
  }

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(value: string): Buffer {
    return Buffer.from(`encrypted:${Buffer.from(value, "utf8").toString("base64")}`, "utf8");
  }

  decryptString(value: Buffer): string {
    const encoded = value.toString("utf8").replace(/^encrypted:/, "");
    return Buffer.from(encoded, "base64").toString("utf8");
  }
}

test("CatVod profile migrates from plaintext settings into encrypted storage", () => {
  const settings = new MemorySettings();
  settings.setSetting("catVodProfile", {
    account: "fixture-user",
    token: "top-secret-token",
    nested: { deviceId: "device-secret" },
  });
  const store = new CatVodProfileStore(settings, new FakeEncryption());

  const loaded = store.load();
  assert.equal(loaded.account, "fixture-user");
  assert.equal(loaded.token, "top-secret-token");
  assert.equal(settings.values.has("catVodProfile"), false);

  const envelope = settings.values.get("catVodProfileEncryptedV1");
  assert.equal(typeof envelope, "object");
  const serializedEnvelope = JSON.stringify(envelope);
  assert.equal(serializedEnvelope.includes("top-secret-token"), false);
  assert.equal(serializedEnvelope.includes("device-secret"), false);

  assert.deepEqual(store.load(), loaded);
});

test("CatVod profile save replaces encrypted value without writing plaintext", () => {
  const settings = new MemorySettings();
  const store = new CatVodProfileStore(settings, new FakeEncryption());

  store.save({ provider: "pan", cookie: "cookie-secret" });

  assert.equal(settings.values.has("catVodProfile"), false);
  assert.equal(JSON.stringify(settings.values.get("catVodProfileEncryptedV1")).includes("cookie-secret"), false);
  assert.deepEqual(store.load(), { provider: "pan", cookie: "cookie-secret" });
});

test("CatVod profile refuses plaintext fallback when secure storage is unavailable", () => {
  const settings = new MemorySettings();
  const store = new CatVodProfileStore(settings, new FakeEncryption(false));

  assert.throws(() => store.save({ token: "must-not-leak" }), /系统安全存储不可用/);
  assert.equal(settings.values.has("catVodProfile"), false);
  assert.equal(settings.values.has("catVodProfileEncryptedV1"), false);
});

test("CatVod profile archives an inaccessible native envelope without retrying it", () => {
  const settings = new MemorySettings();
  const inaccessibleEnvelope = {
    version: 1,
    algorithm: "catvod-protected-storage-v1",
    ciphertext: Buffer.from("SAFE1\0legacy-native-ciphertext", "utf8").toString("base64"),
  };
  settings.setSetting("catVodProfileEncryptedV1", inaccessibleEnvelope);
  let decryptCalls = 0;
  const encryption: CatVodProfileEncryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: () => {
      decryptCalls += 1;
      throw new Error("CatVod Profile 使用了不可访问的旧钥匙串密文");
    },
  };
  const store = new CatVodProfileStore(settings, encryption);

  assert.deepEqual(store.load(), {});
  assert.equal(decryptCalls, 1);
  assert.equal(settings.values.has("catVodProfileEncryptedV1"), false);
  assert.deepEqual(settings.values.get("catVodProfileEncryptedRecoveryV1"), inaccessibleEnvelope);
  assert.deepEqual(store.load(), {});
  assert.equal(decryptCalls, 1);
});

test("CatVod profile keys are protected from generic renderer settings IPC", () => {
  assert.equal(isCatVodProtectedSettingKey("catVodProfile"), true);
  assert.equal(isCatVodProtectedSettingKey("catVodProfileEncryptedV1"), true);
  assert.equal(isCatVodProtectedSettingKey("catVodProfileEncryptedV2"), true);
  assert.equal(isCatVodProtectedSettingKey("catVodProfileEncryptedRecoveryV1"), true);
  assert.equal(isCatVodProtectedSettingKey("catVodMd5Url"), false);
  assert.equal(isCatVodProtectedSettingKey("defaultSite"), false);
});
