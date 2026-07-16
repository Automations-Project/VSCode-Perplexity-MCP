import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression tests for issue #11:
//
//   Code.exe - Bad Image
//   ...\dist\node_modules\keytar\build\Release\keytar.node is either not designed
//   to run on Windows or it contains an error ... Error status 0xc000012f.
//
// Root causes:
//   1. keytar 7.9.0 uses prebuild-install, not optionalDependencies-per-platform:
//      `npm ci` materializes exactly ONE build/Release/keytar.node, for the BUILD
//      machine's platform.
//   2. prepare-package-deps.mjs listed keytar in the generic `rootPackages` array,
//      which blind-copies whatever is in the builder's node_modules.
//   3. release.yml packs a universal VSIX (no `vsce --target`) on ubuntu-latest.
//
// Compose them and every Windows/macOS Marketplace user was shipped a Linux ELF.
// keytar never loads -> vault can never seal/unseal -> every login silently stays
// Anonymous -> all Pro tools fail. A total auth outage, not a degraded mode.
//
// NOTE: 0xC000012F is STATUS_INVALID_IMAGE_NOT_MZ — the Windows loader literally
// reporting "no initial MZ header", i.e. the ELF-instead-of-PE condition.
//
// These tests assert on BYTES, not paths. The ngrok sibling test checks only
// package.json os/cpu, which is exactly the kind of check that cannot catch a
// wrong-platform binary sitting at a right-looking path.

const extensionRoot = join(__dirname, "..");
const keytarRoot = join(extensionRoot, "dist", "node_modules", "keytar");
const keytarReleaseDir = join(keytarRoot, "build", "Release");
const keytarLoader = join(keytarRoot, "lib", "keytar.js");

/**
 * Source-of-truth matrix — must match SUPPORTED_KEYTAR_VARIANTS in
 * scripts/prepare-package-deps.mjs exactly. If one changes, change both.
 */
const SUPPORTED_KEYTAR_VARIANTS: ReadonlyArray<{
  platform: string;
  arch: string;
  magic: string;
}> = [
  { platform: "linux", arch: "x64", magic: "ELF" },
  { platform: "darwin", arch: "x64", magic: "MACHO" },
  { platform: "darwin", arch: "arm64", magic: "MACHO" },
  { platform: "win32", arch: "x64", magic: "PE" },
];

const MAGIC_SIGNATURES: Record<string, number[][]> = {
  PE: [[0x4d, 0x5a]],
  ELF: [[0x7f, 0x45, 0x4c, 0x46]],
  MACHO: [
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
  ],
};

function detectMagic(buf: Buffer): string {
  for (const [name, signatures] of Object.entries(MAGIC_SIGNATURES)) {
    for (const signature of signatures) {
      if (signature.every((byte, i) => buf[i] === byte)) return name;
    }
  }
  const hex = [...buf.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return `unknown(${hex})`;
}

function hasPreparedDeps(): boolean {
  return existsSync(keytarReleaseDir);
}

describe("packaged VSIX ships a correct keytar prebuild per platform (issue #11)", () => {
  it.skipIf(!hasPreparedDeps())(
    "every supported platform has a keytar.node whose magic bytes match that platform",
    () => {
      expect(SUPPORTED_KEYTAR_VARIANTS.length).toBe(4);

      const missing: string[] = [];
      const wrongFormat: string[] = [];

      for (const { platform, arch, magic: expected } of SUPPORTED_KEYTAR_VARIANTS) {
        const binary = join(keytarReleaseDir, `${platform}-${arch}`, "keytar.node");
        if (!existsSync(binary)) {
          missing.push(`${platform}-${arch}`);
          continue;
        }
        const actual = detectMagic(readFileSync(binary));
        if (actual !== expected) {
          wrongFormat.push(`${platform}-${arch}: expected ${expected}, got ${actual}`);
        }
      }

      expect(
        missing,
        `Missing keytar prebuilds in dist/node_modules — users on these platforms cannot ` +
          `seal/unseal the vault and every login stays Anonymous:\n  ${missing.join("\n  ")}`,
      ).toEqual([]);
      expect(
        wrongFormat,
        `keytar prebuilds have the WRONG BINARY FORMAT — this is the issue #11 outage ` +
          `(a Linux ELF shipped to Windows/macOS):\n  ${wrongFormat.join("\n  ")}`,
      ).toEqual([]);
    },
  );

  it.skipIf(!hasPreparedDeps())(
    "does not ship the build machine's own prebuild at the stock require path",
    () => {
      // npm ci puts the builder's binary at exactly the path the stock loader
      // requires. Leaving it means a Linux-built VSIX keeps loading the ELF on
      // Windows even with the correct binaries sitting right beside it.
      const builderPrebuild = join(keytarReleaseDir, "keytar.node");
      expect(
        existsSync(builderPrebuild),
        `${builderPrebuild} exists. That is the build machine's own single-platform ` +
          `prebuild — prepare-package-deps.mjs must delete it after materializing the ` +
          `per-platform tree, or issue #11 reopens.`,
      ).toBe(false);
    },
  );

  it.skipIf(!hasPreparedDeps())("patches keytar's loader to resolve per-platform", () => {
    const source = readFileSync(keytarLoader, "utf8");
    // keytar's stock lib/keytar.js hardcodes a single path with no platform
    // dispatch, so side-by-side prebuilds are inert without this patch.
    expect(
      source.includes("${process.platform}-${process.arch}"),
      `${keytarLoader} was not patched for per-platform resolution. Without it the ` +
        `per-platform tree is dead weight and keytar resolves nothing.`,
    ).toBe(true);
    expect(source).not.toContain("require('../build/Release/keytar.node')");
  });

  it.skipIf(!hasPreparedDeps())("resolves the current platform's binary at runtime", () => {
    // The end-to-end check: whatever platform CI runs on, the patched loader
    // must find a real binary of the right format for it.
    const binary = join(keytarReleaseDir, `${process.platform}-${process.arch}`, "keytar.node");
    const supported = SUPPORTED_KEYTAR_VARIANTS.some(
      (v) => v.platform === process.platform && v.arch === process.arch,
    );
    if (!supported) return; // Off-matrix runner: the vault falls back to passphrase/TTY.

    expect(
      existsSync(binary),
      `No keytar prebuild for this runner (${process.platform}-${process.arch}) at ${binary}.`,
    ).toBe(true);

    const expected = SUPPORTED_KEYTAR_VARIANTS.find(
      (v) => v.platform === process.platform && v.arch === process.arch,
    )!.magic;
    expect(detectMagic(readFileSync(binary))).toBe(expected);
  });

  it.skipIf(hasPreparedDeps())(
    "skipped: run `npm run prepare:package-deps -w perplexity-vscode` first to enable the keytar packaging smoke",
    () => {
      expect(true).toBe(true);
    },
  );
});
