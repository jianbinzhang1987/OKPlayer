import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareHttpRequest, type PreparedHttpRequest } from "../http-auth.ts";
import type {
  CatVodBundleManifest,
  CatVodBundleVersion,
  CatVodRemoteBundle,
  CatVodUpdateResult,
} from "./catvod-types.ts";

const MD5_PATTERN = /^[a-f0-9]{32}$/i;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_SCRIPT_BYTES = 32 * 1024 * 1024;

export interface CatVodBundleManagerOptions {
  rootDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxScriptBytes?: number;
}

interface AuthenticatedCatVodRemoteBundle extends CatVodRemoteBundle {
  authorization?: string;
}

export class CatVodBundleManager {
  readonly rootDir: string;
  readonly versionsDir: string;
  readonly runtimeDir: string;
  readonly logsDir: string;
  readonly manifestPath: string;

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxScriptBytes: number;

  constructor(options: CatVodBundleManagerOptions) {
    this.rootDir = options.rootDir;
    this.versionsDir = path.join(this.rootDir, "versions");
    this.runtimeDir = path.join(this.rootDir, "runtime-data");
    this.logsDir = path.join(this.rootDir, "logs");
    this.manifestPath = path.join(this.rootDir, "manifest.json");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxScriptBytes = options.maxScriptBytes ?? DEFAULT_MAX_SCRIPT_BYTES;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.versionsDir, { recursive: true }),
      mkdir(this.runtimeDir, { recursive: true }),
      mkdir(this.logsDir, { recursive: true }),
    ]);
  }

  async inspectRemote(sourceMd5Url: string): Promise<AuthenticatedCatVodRemoteBundle> {
    const request = prepareCatVodHttpRequest(sourceMd5Url, {
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: "text/plain,application/octet-stream;q=0.9,*/*;q=0.1" },
    });
    const response = await this.fetchImpl(request.url, request.init);
    if (!response.ok) throw new Error(`CatVod MD5 请求失败：HTTP ${response.status}`);
    const md5 = (await response.text()).trim().toLowerCase();
    if (!MD5_PATTERN.test(md5)) throw new Error("CatVod MD5 响应不是有效的 32 位十六进制值");

    const scriptUrl = new URL(request.url);
    if (!scriptUrl.pathname.endsWith(".md5")) throw new Error("CatVod MD5 地址必须以 .md5 结尾");
    scriptUrl.pathname = scriptUrl.pathname.slice(0, -4);
    const authorization = new Headers(request.init.headers).get("authorization") ?? undefined;
    return {
      sourceMd5Url: request.url,
      scriptUrl: scriptUrl.toString(),
      md5,
      ...(authorization ? { authorization } : {}),
    };
  }

  async ensureCurrent(sourceMd5Url: string): Promise<CatVodBundleVersion> {
    await this.initialize();
    const normalizedSource = normalizeCatVodHttpUrl(sourceMd5Url);
    const manifest = await this.readManifest(normalizedSource);
    if (manifest.sourceMd5Url === normalizedSource && manifest.current && await this.versionValid(manifest.current.md5)) return manifest.current;

    const remote = await this.inspectRemote(sourceMd5Url);
    const version = await this.downloadVersion(remote);
    await this.writeManifest({
      sourceMd5Url: remote.sourceMd5Url,
      current: { ...version, activatedAt: Date.now() },
      updatedAt: Date.now(),
    });
    return { ...version, activatedAt: Date.now() };
  }

  async checkForUpdate(sourceMd5Url: string): Promise<CatVodUpdateResult> {
    await this.initialize();
    const normalizedSource = normalizeCatVodHttpUrl(sourceMd5Url);
    const manifest = await this.readManifest(normalizedSource);
    const remote = await this.inspectRemote(sourceMd5Url);
    if (manifest.sourceMd5Url === normalizedSource && manifest.current?.md5 === remote.md5 && await this.versionValid(remote.md5)) {
      return {
        state: "current",
        current: manifest.current,
        previous: manifest.previous,
        message: "当前已经是最新的 CatVod 版本",
      };
    }

    const candidate = await this.downloadVersion(remote);
    const next: CatVodBundleManifest = {
      ...manifest,
      sourceMd5Url: remote.sourceMd5Url,
      candidate,
      updatedAt: Date.now(),
    };
    await this.writeManifest(next);
    return {
      state: "downloaded",
      current: next.current,
      candidate,
      previous: next.previous,
      message: `已下载候选版本 ${candidate.md5}，尚未激活`,
    };
  }

  async activateCandidate(sourceMd5Url: string): Promise<CatVodUpdateResult> {
    const manifest = await this.readManifest(sourceMd5Url);
    if (!manifest.candidate) throw new Error("当前没有可激活的 CatVod 候选版本");
    if (!await this.versionValid(manifest.candidate.md5)) throw new Error("CatVod 候选版本文件不存在或完整性校验失败");

    const activated: CatVodBundleVersion = { ...manifest.candidate, activatedAt: Date.now() };
    const next: CatVodBundleManifest = {
      sourceMd5Url: manifest.sourceMd5Url,
      current: activated,
      previous: manifest.current,
      updatedAt: Date.now(),
    };
    await this.writeManifest(next);
    return {
      state: "activated",
      current: activated,
      previous: next.previous,
      message: `已激活 CatVod 版本 ${activated.md5}`,
    };
  }

  async rollback(sourceMd5Url: string): Promise<CatVodUpdateResult> {
    const manifest = await this.readManifest(sourceMd5Url);
    if (!manifest.previous) throw new Error("当前没有可回滚的 CatVod 版本");
    if (!await this.versionValid(manifest.previous.md5)) throw new Error("CatVod 回滚版本文件不存在或完整性校验失败");

    const restored: CatVodBundleVersion = { ...manifest.previous, activatedAt: Date.now() };
    const next: CatVodBundleManifest = {
      sourceMd5Url: manifest.sourceMd5Url,
      current: restored,
      previous: manifest.current,
      candidate: manifest.candidate,
      updatedAt: Date.now(),
    };
    await this.writeManifest(next);
    return {
      state: "rolled-back",
      current: restored,
      previous: next.previous,
      candidate: next.candidate,
      message: `已回滚到 CatVod 版本 ${restored.md5}`,
    };
  }

  async currentVersion(sourceMd5Url: string): Promise<CatVodBundleVersion | undefined> {
    const normalizedSource = normalizeCatVodHttpUrl(sourceMd5Url);
    const manifest = await this.readManifest(normalizedSource);
    return manifest.sourceMd5Url === normalizedSource && manifest.current && await this.versionValid(manifest.current.md5)
      ? manifest.current
      : undefined;
  }

  async readManifest(sourceMd5Url = ""): Promise<CatVodBundleManifest> {
    await this.initialize();
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath, "utf8")) as CatVodBundleManifest;
      if (!parsed || typeof parsed !== "object") throw new Error("manifest invalid");
      return {
        sourceMd5Url: parsed.sourceMd5Url || sourceMd5Url,
        ...(parsed.current ? { current: parsed.current } : {}),
        ...(parsed.previous ? { previous: parsed.previous } : {}),
        ...(parsed.candidate ? { candidate: parsed.candidate } : {}),
        updatedAt: Number(parsed.updatedAt) || 0,
      };
    } catch {
      try {
        await access(this.manifestPath);
        await rename(this.manifestPath, `${this.manifestPath}.corrupt-${Date.now()}`);
      } catch {
        // Missing manifests are normal on first start; an unreadable file is preserved when possible.
      }
      return { sourceMd5Url, updatedAt: 0 };
    }
  }

  scriptPath(version: CatVodBundleVersion | string): string {
    const md5 = typeof version === "string" ? version : version.md5;
    return path.join(this.versionsDir, md5, "index.js");
  }

  private async downloadVersion(remote: AuthenticatedCatVodRemoteBundle): Promise<CatVodBundleVersion> {
    if (await this.versionValid(remote.md5)) {
      const script = await readFile(this.scriptPath(remote.md5));
      return {
        md5: remote.md5,
        sha256: digest("sha256", script),
        scriptUrl: remote.scriptUrl,
        downloadedAt: Date.now(),
      };
    }
    await rm(path.dirname(this.scriptPath(remote.md5)), { recursive: true, force: true });

    const response = await this.fetchImpl(remote.scriptUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        accept: "text/javascript,application/javascript,application/octet-stream;q=0.9,*/*;q=0.1",
        ...(remote.authorization ? { authorization: remote.authorization } : {}),
      },
    });
    if (!response.ok) throw new Error(`CatVod 脚本下载失败：HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > this.maxScriptBytes) throw new Error("CatVod 脚本超过允许的最大大小");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("CatVod 脚本内容为空");
    if (bytes.length > this.maxScriptBytes) throw new Error("CatVod 脚本超过允许的最大大小");

    const actualMd5 = digest("md5", bytes);
    if (actualMd5 !== remote.md5) {
      throw new Error(`CatVod 脚本 MD5 校验失败：期望 ${remote.md5}，实际 ${actualMd5}`);
    }

    const versionDir = path.join(this.versionsDir, remote.md5);
    const temporaryDir = `${versionDir}.download-${process.pid}-${Date.now()}`;
    await rm(temporaryDir, { recursive: true, force: true });
    await mkdir(temporaryDir, { recursive: true });
    await writeFile(path.join(temporaryDir, "index.js"), bytes, { mode: 0o600 });
    await rm(versionDir, { recursive: true, force: true });
    await rename(temporaryDir, versionDir);

    return {
      md5: remote.md5,
      sha256: digest("sha256", bytes),
      scriptUrl: remote.scriptUrl,
      downloadedAt: Date.now(),
    };
  }

  private async versionValid(md5: string): Promise<boolean> {
    if (!MD5_PATTERN.test(md5)) return false;
    try {
      await access(this.scriptPath(md5));
      const script = await readFile(this.scriptPath(md5));
      return digest("md5", script) === md5;
    } catch {
      return false;
    }
  }

  private async writeManifest(manifest: CatVodBundleManifest): Promise<void> {
    await this.initialize();
    const temporary = `${this.manifestPath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.manifestPath);
  }
}

function prepareCatVodHttpRequest(value: string, init: RequestInit = {}): PreparedHttpRequest {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("CatVod MD5 地址不能为空");
  const url = new URL(trimmed);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("CatVod MD5 地址仅支持 HTTP/HTTPS");
  return prepareHttpRequest(url, init);
}

function normalizeCatVodHttpUrl(value: string): string {
  return prepareCatVodHttpRequest(value).url;
}

function digest(algorithm: "md5" | "sha256", value: Buffer): string {
  return createHash(algorithm).update(value).digest("hex");
}
