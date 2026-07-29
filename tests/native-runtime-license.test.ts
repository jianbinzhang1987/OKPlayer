import assert from "node:assert/strict";
import test from "node:test";
import {
  renderNativeRuntimeNotice,
  runtimeLicensingFromEnvironment,
  validateNativeRuntimeLicensing,
} from "../scripts/lib/native-runtime-license.mjs";

test("runtime licensing defaults to explicit unverified declarations for test packages", () => {
  const licensing = runtimeLicensingFromEnvironment(["libmpv.2.dylib", "libavcodec.62.dylib"], {});
  assert.equal(licensing.libmpv.bundled, true);
  assert.equal(licensing.libmpv.version, "unverified");
  assert.equal(licensing.ffmpeg.bundled, true);
  const validation = validateNativeRuntimeLicensing(licensing);
  assert.equal(validation.valid, false);
  assert.match(validation.issues.join("\n"), /libmpv: 缺少已核验的 version/);
  assert.match(validation.issues.join("\n"), /ffmpeg: 缺少已核验的 sourceUrl/);
});

test("complete libmpv and FFmpeg declarations pass formal validation", () => {
  const licensing = runtimeLicensingFromEnvironment(
    ["mpv-2.dll", "avcodec-62.dll"],
    {
      FONGMI_LIBMPV_VERSION: "0.41.0",
      FONGMI_LIBMPV_LICENSE: "GPL-2.0-or-later",
      FONGMI_LIBMPV_SOURCE_URL: "https://example.org/mpv-source",
      FONGMI_FFMPEG_VERSION: "8.0",
      FONGMI_FFMPEG_LICENSE: "GPL-2.0-or-later",
      FONGMI_FFMPEG_SOURCE_URL: "https://example.org/ffmpeg-source",
    },
  );
  const validation = validateNativeRuntimeLicensing(licensing);
  assert.deepEqual(validation, { valid: true, issues: [] });
  const notice = renderNativeRuntimeNotice(licensing);
  assert.match(notice, /mpv \/ libmpv/);
  assert.match(notice, /FFmpeg/i);
  assert.match(notice, /GPL-2.0-or-later/);
});

test("invalid source URL is rejected", () => {
  const validation = validateNativeRuntimeLicensing({
    libmpv: {
      bundled: true,
      version: "0.41.0",
      license: "LGPL-2.1-or-later",
      sourceUrl: "/local/source",
    },
    ffmpeg: { bundled: false },
  });
  assert.equal(validation.valid, false);
  assert.match(validation.issues.join("\n"), /sourceUrl 必须是 HTTP\(S\) 地址/);
});

test("FFmpeg declaration is optional only when FFmpeg libraries are not bundled", () => {
  const licensing = runtimeLicensingFromEnvironment(
    ["libmpv.so.2"],
    {
      FONGMI_LIBMPV_VERSION: "0.41.0",
      FONGMI_LIBMPV_LICENSE: "LGPL-2.1-or-later",
      FONGMI_LIBMPV_SOURCE_URL: "https://example.org/mpv-source",
    },
  );
  assert.deepEqual(licensing.ffmpeg, { bundled: false });
  assert.equal(validateNativeRuntimeLicensing(licensing).valid, true);
});
