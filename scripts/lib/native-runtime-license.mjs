const UNVERIFIED = "unverified";

export function runtimeLicensingFromEnvironment(files, environment = process.env) {
  const bundlesFfmpeg = files.some((file) => /(?:^|[/\\])(?:lib)?av(?:codec|format|util|filter|device|resample|scale)[^/\\]*\.(?:dylib|dll|so)/i.test(String(file)));
  return {
    libmpv: runtimeLicenseDeclaration("LIBMPV", environment),
    ffmpeg: bundlesFfmpeg ? runtimeLicenseDeclaration("FFMPEG", environment) : { bundled: false },
  };
}

export function validateNativeRuntimeLicensing(licensing) {
  const issues = [];
  for (const [component, declaration] of Object.entries(licensing || {})) {
    if (!declaration || declaration.bundled === false) continue;
    if (declaration.bundled !== true) {
      issues.push(`${component}: bundled 必须明确为 true 或 false`);
      continue;
    }
    for (const field of ["version", "license", "sourceUrl"]) {
      const value = String(declaration[field] || "").trim();
      if (!value || value.toLowerCase() === UNVERIFIED) issues.push(`${component}: 缺少已核验的 ${field}`);
    }
    const sourceUrl = String(declaration.sourceUrl || "").trim();
    if (sourceUrl && sourceUrl.toLowerCase() !== UNVERIFIED && !/^https?:\/\//i.test(sourceUrl)) {
      issues.push(`${component}: sourceUrl 必须是 HTTP(S) 地址`);
    }
  }
  if (!licensing?.libmpv || licensing.libmpv.bundled !== true) issues.push("libmpv: 缺少运行时许可证声明");
  return {
    valid: issues.length === 0,
    issues,
  };
}

export function renderNativeRuntimeNotice(licensing) {
  const lines = ["# Native Media Runtime Notices", ""];
  for (const [component, declaration] of Object.entries(licensing || {})) {
    if (!declaration || declaration.bundled === false) continue;
    lines.push(`## ${component === "libmpv" ? "mpv / libmpv" : component}`);
    lines.push("");
    lines.push(`- Version: ${declaration.version}`);
    lines.push(`- Declared license: ${declaration.license}`);
    lines.push(`- Corresponding source: ${declaration.sourceUrl}`);
    lines.push("");
  }
  lines.push("The declared license must match the exact distributed binary build and its enabled codecs/libraries.");
  lines.push("This file records release metadata; it does not replace the complete license texts or source-offer obligations required by the declared licenses.");
  lines.push("");
  return lines.join("\n");
}

function runtimeLicenseDeclaration(component, environment) {
  const prefix = `FONGMI_${component}_`;
  return {
    bundled: true,
    version: normalized(environment[`${prefix}VERSION`]),
    license: normalized(environment[`${prefix}LICENSE`]),
    sourceUrl: normalized(environment[`${prefix}SOURCE_URL`]),
  };
}

function normalized(value) {
  return String(value || UNVERIFIED).trim() || UNVERIFIED;
}
