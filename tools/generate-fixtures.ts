/**
 * Generates octi-web's canonical wire-format fixtures under `src/__interop__/published/`.
 *
 * Run via `pnpm fixtures:generate`. The output is deterministic — same canonical inputs
 * + same serializers → same bytes. `src/__interop__/published-self-check.test.ts` is the
 * round-trip gate: it re-runs `buildAllFixtures()` on every `pnpm test` and asserts the
 * committed files are byte-equal to what the generator would emit today.
 *
 * Consumers (app-main, octi-desktop in Phase B2/B3) fetch the committed `octi-web-*.json`
 * files at a SHA pinned in their own `fixture-lock.json`, then decode each `payloadJson`
 * vector through their production decoder and assert field-level shape.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLIPBOARD_MODULE_ID,
  serializeClipboardInfo,
  type ClipboardInfo,
} from "../src/modules/clipboard";
import {
  FILES_MODULE_ID,
  serializeFileShareInfo,
  type FileShareInfo,
} from "../src/modules/files";
import {
  META_MODULE_ID,
  serializeMetaInfo,
  type MetaInfo,
} from "../src/modules/meta";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const PUBLISHED_DIR = resolve(REPO_ROOT, "src", "__interop__", "published");

const SCHEMA_VERSION = 1;
const PRODUCER = "d4rken-org/octi-web";
const GENERATOR = "tools/generate-fixtures.ts";

/** Per-vector wire pin: `payloadJson` is the literal byte output of `serializeXxx(input)`. */
export interface PublishedVector {
  name: string;
  payloadJson: string;
  sha256: string;
  byteLength: number;
}

export interface PublishedModuleFixture {
  schemaVersion: number;
  module: string;
  producer: string;
  note: string;
  vectors: PublishedVector[];
}

export interface ManifestEntry {
  sha256: string;
  byteLength: number;
}

export interface PublishedManifest {
  schemaVersion: number;
  source: string;
  generator: string;
  files: Record<string, ManifestEntry>;
}

export interface GeneratedFixtures {
  manifest: PublishedManifest;
  files: Array<{ name: string; bytes: Uint8Array; content: PublishedModuleFixture }>;
}

/* ─────────────────────── Canonical inputs ─────────────────────── */

const FAUX_DEVICE_ID = "11111111-2222-3333-4444-555555555555";
const FAUX_CONNECTOR =
  "kserver-prod.kserver.octi.darken.eu-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// Meta: 3 vectors covering full / minimal / unicode-label. These are the typed
// MetaInfo objects we'd actually publish; verify tests re-serialize and check bytes.
const META_VECTORS: Array<{ name: string; input: MetaInfo }> = [
  {
    name: "full",
    input: {
      // "full" here means every field web ACTUALLY emits at publish time.
      // `deviceBootedAt` is deliberately null — buildOwnMetaInfo hardcodes it
      // null for browsers (no equivalent to Android's `android.os.SystemClock.elapsedRealtime`).
      // Consumers can rely on web never sending it.
      deviceLabel: "Test Browser",
      deviceId: { id: FAUX_DEVICE_ID },
      octiVersionName: "0.0.0-test",
      octiGitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      deviceManufacturer: "Mozilla",
      deviceName: "Firefox 134.0 on Linux",
      deviceType: "BROWSER",
      deviceBootedAt: null,
      androidVersionName: null,
      androidApiLevel: null,
      androidSecurityPatch: null,
      osType: "linux",
      osVersionName: "6.8.0",
    },
  },
  {
    name: "minimal",
    input: {
      // Required fields only; null/absent optional fields exercise the
      // serialize-strips-nulls rule the Android strict decoder relies on.
      deviceLabel: null,
      deviceId: { id: FAUX_DEVICE_ID },
      octiVersionName: "0.0.0-test",
      octiGitSha: "dev",
      deviceManufacturer: "Mozilla",
      deviceName: "Browser",
      deviceType: "BROWSER",
    },
  },
  {
    name: "unicode-label",
    input: {
      // Mixed UTF-8 — emoji + CJK + Arabic — to pin the byte encoding pathway.
      deviceLabel: "ブラウザ 👋 العربية",
      deviceId: { id: FAUX_DEVICE_ID },
      octiVersionName: "0.0.0-test",
      octiGitSha: "dev",
      deviceManufacturer: "Mozilla",
      deviceName: "Firefox",
      deviceType: "BROWSER",
      osType: "linux",
    },
  },
];

// Clipboard: EMPTY, short text, unicode text. `clipboard-near-cap` was considered
// but deliberately omitted — a 32 KiB payload would inflate the fixture file past
// our 32 KiB per-file ceiling without proving anything cross-platform (the
// boundary is producer-side validation, not wire format). The relevant assertion
// lives in clipboard.test.ts.
const CLIPBOARD_VECTORS: Array<{ name: string; input: ClipboardInfo }> = [
  {
    name: "EMPTY",
    input: { type: "EMPTY", data: new Uint8Array(0) },
  },
  {
    name: "SIMPLE_TEXT_short",
    input: { type: "SIMPLE_TEXT", data: new TextEncoder().encode("hello clipboard") },
  },
  {
    name: "SIMPLE_TEXT_unicode",
    input: {
      type: "SIMPLE_TEXT",
      data: new TextEncoder().encode("café 👋 你好 — العربية"),
    },
  },
];

// Files: empty, single, multiple, with delete requests, large-size edge case.
const FILES_VECTORS: Array<{ name: string; input: FileShareInfo }> = [
  {
    name: "empty",
    input: { files: [], deleteRequests: [] },
  },
  {
    name: "single-file",
    input: {
      files: [
        {
          name: "notes.txt",
          mimeType: "text/plain",
          size: 1234,
          blobKey: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
          checksum: "0000000000000000000000000000000000000000000000000000000000000001",
          sharedAt: "2026-05-01T12:00:00Z",
          expiresAt: "2026-05-31T12:00:00Z",
          availableOn: [FAUX_CONNECTOR],
          connectorRefs: { [FAUX_CONNECTOR]: "blob-id-aaaa" },
        },
      ],
      deleteRequests: [],
    },
  },
  {
    name: "with-multiple-files",
    input: {
      files: [
        {
          name: "alpha.bin",
          mimeType: "application/octet-stream",
          size: 256,
          blobKey: "sha256:0000000000000000000000000000000000000000000000000000000000000002",
          checksum: "0000000000000000000000000000000000000000000000000000000000000002",
          sharedAt: "2026-05-01T12:00:00Z",
          expiresAt: "2026-05-31T12:00:00Z",
          availableOn: [FAUX_CONNECTOR],
          connectorRefs: { [FAUX_CONNECTOR]: "blob-id-bbbb" },
        },
        {
          name: "beta.pdf",
          mimeType: "application/pdf",
          size: 4096,
          blobKey: "sha256:0000000000000000000000000000000000000000000000000000000000000003",
          checksum: "0000000000000000000000000000000000000000000000000000000000000003",
          sharedAt: "2026-05-01T13:00:00Z",
          expiresAt: "2026-05-31T13:00:00Z",
          availableOn: [FAUX_CONNECTOR],
          connectorRefs: { [FAUX_CONNECTOR]: "blob-id-cccc" },
        },
      ],
      deleteRequests: [],
    },
  },
  {
    name: "with-delete-requests",
    input: {
      files: [
        {
          name: "shared.txt",
          mimeType: "text/plain",
          size: 100,
          blobKey: "sha256:0000000000000000000000000000000000000000000000000000000000000004",
          checksum: "0000000000000000000000000000000000000000000000000000000000000004",
          sharedAt: "2026-05-01T12:00:00Z",
          expiresAt: "2026-05-31T12:00:00Z",
          availableOn: [FAUX_CONNECTOR],
          connectorRefs: { [FAUX_CONNECTOR]: "blob-id-dddd" },
        },
      ],
      deleteRequests: [
        {
          targetDeviceId: "99999999-8888-7777-6666-555555555555",
          blobKey: "sha256:0000000000000000000000000000000000000000000000000000000000000005",
          requestedAt: "2026-05-10T00:00:00Z",
          retainUntil: "2026-05-17T00:00:00Z",
        },
      ],
    },
  },
  {
    name: "multi-connector",
    // Two connectors hosting the same blobKey — pins the multi-connector wire
    // shape (availableOn list + connectorRefs map keyed by connector id). The
    // dashboard's connector-merge code reads connectorRefs[connector.connectorId]
    // on download; a single-connector vector wouldn't catch a future bug where
    // that lookup hardcoded the wrong key.
    input: {
      files: [
        {
          name: "shared-across.bin",
          mimeType: "application/octet-stream",
          size: 512,
          blobKey: "sha256:0000000000000000000000000000000000000000000000000000000000000007",
          checksum: "0000000000000000000000000000000000000000000000000000000000000007",
          sharedAt: "2026-05-01T12:00:00Z",
          expiresAt: "2026-05-31T12:00:00Z",
          availableOn: [
            "kserver-prod.kserver.octi.darken.eu-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "kserver-beta.kserver.octi.darken.eu-ffffffff-1111-2222-3333-444444444444",
          ],
          connectorRefs: {
            "kserver-prod.kserver.octi.darken.eu-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee":
              "blob-id-prod-7777",
            "kserver-beta.kserver.octi.darken.eu-ffffffff-1111-2222-3333-444444444444":
              "blob-id-beta-7777",
          },
        },
      ],
      deleteRequests: [],
    },
  },
  {
    name: "files-large",
    input: {
      // size > Int.MAX_VALUE (2^31 - 1 = 2147483647). Codex follow-up: catch
      // any Int-vs-Long bug on the Android-side decoder for large file sizes.
      // 8 GB is comfortably above the boundary; JS number is double, so the
      // value is exact through ~2^53.
      files: [
        {
          name: "big.iso",
          mimeType: "application/octet-stream",
          size: 8_000_000_000,
          blobKey: "sha256:0000000000000000000000000000000000000000000000000000000000000006",
          checksum: "0000000000000000000000000000000000000000000000000000000000000006",
          sharedAt: "2026-05-01T12:00:00Z",
          expiresAt: "2026-05-31T12:00:00Z",
          availableOn: [FAUX_CONNECTOR],
          connectorRefs: { [FAUX_CONNECTOR]: "blob-id-eeee" },
        },
      ],
      deleteRequests: [],
    },
  },
];

/* ─────────────────────── Build ─────────────────────── */

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildVector<T>(
  name: string,
  input: T,
  serialize: (info: T) => Uint8Array,
): PublishedVector {
  const bytes = serialize(input);
  const payloadJson = new TextDecoder().decode(bytes);
  return {
    name,
    payloadJson,
    sha256: sha256Hex(bytes),
    byteLength: bytes.length,
  };
}

function buildModuleFixture<T>(
  fileName: string,
  moduleId: string,
  note: string,
  vectors: Array<{ name: string; input: T }>,
  serialize: (info: T) => Uint8Array,
): { name: string; bytes: Uint8Array; content: PublishedModuleFixture } {
  const built: PublishedVector[] = vectors.map((v) =>
    buildVector(v.name, v.input, serialize),
  );
  const content: PublishedModuleFixture = {
    schemaVersion: SCHEMA_VERSION,
    module: moduleId,
    producer: PRODUCER,
    note,
    vectors: built,
  };
  // Pretty-print so reviewers see one vector per line block. Order matters for
  // byte-stability: JSON.stringify is deterministic on an object-literal key
  // order, and we control that here.
  const json = JSON.stringify(content, null, 2) + "\n";
  return { name: fileName, bytes: new TextEncoder().encode(json), content };
}

/**
 * Pure: build the manifest + all per-module fixture bytes. Called both by
 * the generator's main() and by `published-self-check.test.ts`.
 */
export function buildAllFixtures(): GeneratedFixtures {
  const files = [
    buildModuleFixture(
      "octi-web-meta.json",
      META_MODULE_ID,
      "Canonical MetaInfo payloads octi-web emits. Consumers (octi, octi-desktop) " +
        "must decode each `payloadJson` through their `kotlinx.serialization` MetaInfo.",
      META_VECTORS,
      serializeMetaInfo,
    ),
    buildModuleFixture(
      "octi-web-clipboard.json",
      CLIPBOARD_MODULE_ID,
      "Canonical ClipboardInfo payloads octi-web emits. Pin: type+data base64 wire shape.",
      CLIPBOARD_VECTORS,
      serializeClipboardInfo,
    ),
    buildModuleFixture(
      "octi-web-files.json",
      FILES_MODULE_ID,
      "Canonical FileShareInfo payloads octi-web emits. Includes a >Int.MAX_VALUE size " +
        "vector to pin Long handling on the JVM consumers.",
      FILES_VECTORS,
      serializeFileShareInfo,
    ),
  ];

  // Manifest sorted by filename so the JSON is order-stable across regenerations.
  // Use bytewise (codepoint) compare, not localeCompare — locale-aware sort is
  // determinism-fragile across Node ICU builds.
  const sortedFiles = [...files].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const manifestFiles: Record<string, ManifestEntry> = {};
  for (const f of sortedFiles) {
    manifestFiles[f.name] = { sha256: sha256Hex(f.bytes), byteLength: f.bytes.length };
  }

  const manifest: PublishedManifest = {
    schemaVersion: SCHEMA_VERSION,
    source: PRODUCER,
    generator: GENERATOR,
    files: manifestFiles,
  };

  return { manifest, files };
}

/** Per-file size ceiling. Codex follow-up: enforce so a vector accidentally inflated to
 * many MB doesn't blow up the consumer fetch + cache. */
export const FIXTURE_FILE_SIZE_CEILING = 32 * 1024;

function writeFixtures(): void {
  const generated = buildAllFixtures();
  mkdirSync(PUBLISHED_DIR, { recursive: true });

  for (const file of generated.files) {
    if (file.bytes.length > FIXTURE_FILE_SIZE_CEILING) {
      throw new Error(
        `fixture ${file.name} is ${file.bytes.length} bytes, exceeds ceiling ${FIXTURE_FILE_SIZE_CEILING}`,
      );
    }
    writeFileSync(resolve(PUBLISHED_DIR, file.name), file.bytes);
    console.log(`  wrote ${file.name} (${file.bytes.length} bytes)`);
  }

  const manifestBytes = new TextEncoder().encode(
    JSON.stringify(generated.manifest, null, 2) + "\n",
  );
  writeFileSync(resolve(PUBLISHED_DIR, "manifest.json"), manifestBytes);
  console.log(`  wrote manifest.json (${manifestBytes.length} bytes)`);
  console.log(`fixtures written to ${PUBLISHED_DIR}`);
}

/** Exported for the verify test to read committed files. */
export function publishedDir(): string {
  return PUBLISHED_DIR;
}

/** Re-read a committed file as bytes. Used by the verify test. */
export function readCommittedFile(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(PUBLISHED_DIR, name)));
}

// CLI entrypoint.
const invokedAsCli =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    writeFixtures();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
