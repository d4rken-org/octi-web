/**
 * Self-check for the wire-format fixtures octi-web publishes for app-main and
 * octi-desktop to consume.
 *
 * Runs as part of `pnpm test`. Reads the committed `src/__interop__/published/*.json`
 * files, re-runs the generator (a pure function), and asserts byte-equality for every
 * file plus structural correctness for the manifest. Catches drift between (a) the
 * generator's canonical inputs, (b) what the serializers actually produce, and (c)
 * what's committed on disk.
 *
 * Regenerate fixtures with `pnpm fixtures:generate` whenever any of those three legs
 * is intentionally moved.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  buildAllFixtures,
  FIXTURE_FILE_SIZE_CEILING,
  readCommittedFile,
  type PublishedManifest,
  type PublishedModuleFixture,
} from "../../tools/generate-fixtures";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const EXPECTED_FILES = [
  "octi-web-clipboard.json",
  "octi-web-files.json",
  "octi-web-meta.json",
];

const generated = buildAllFixtures();

describe("published fixtures self-check", () => {
  it("manifest matches committed bytes", () => {
    const committed = readCommittedFile("manifest.json");
    const expected = new TextEncoder().encode(
      JSON.stringify(generated.manifest, null, 2) + "\n",
    );
    expect(committed).toEqual(expected);
  });

  it("manifest references exactly the expected file set", () => {
    const committed = JSON.parse(
      new TextDecoder().decode(readCommittedFile("manifest.json")),
    ) as PublishedManifest;
    expect(committed.schemaVersion).toBe(1);
    expect(committed.source).toBe("d4rken-org/octi-web");
    expect(Object.keys(committed.files).sort()).toEqual(EXPECTED_FILES);
    for (const [, entry] of Object.entries(committed.files)) {
      expect(entry.sha256).toMatch(SHA256_RE);
      expect(entry.byteLength).toBeGreaterThan(0);
    }
  });

  for (const file of generated.files) {
    it(`per-module file matches committed bytes: ${file.name}`, () => {
      const committed = readCommittedFile(file.name);
      // Byte-equality: re-serialize must produce the same JSON the committed file holds.
      // Failing here means a canonical input, a serializer's output, or the committed
      // file drifted — regenerate with `pnpm fixtures:generate` after confirming the
      // change is intentional.
      expect(committed).toEqual(file.bytes);
    });

    it(`per-module manifest entry matches: ${file.name}`, () => {
      const committed = readCommittedFile(file.name);
      const manifest = JSON.parse(
        new TextDecoder().decode(readCommittedFile("manifest.json")),
      ) as PublishedManifest;
      const entry = manifest.files[file.name]!;
      expect(entry.sha256).toBe(sha256Hex(committed));
      expect(entry.byteLength).toBe(committed.length);
    });

    it(`per-module file is under the size ceiling: ${file.name}`, () => {
      const committed = readCommittedFile(file.name);
      expect(committed.length).toBeLessThanOrEqual(FIXTURE_FILE_SIZE_CEILING);
    });

    it(`vector schema invariants: ${file.name}`, () => {
      const parsed = JSON.parse(
        new TextDecoder().decode(file.bytes),
      ) as PublishedModuleFixture;

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.module).toMatch(/^eu\.darken\.octi\.module\.core\.[a-z]+$/);
      expect(parsed.producer).toBe("d4rken-org/octi-web");
      expect(parsed.note.length).toBeGreaterThan(0);
      expect(parsed.vectors.length).toBeGreaterThan(0);

      const names = parsed.vectors.map((v) => v.name);
      expect(names.length).toBe(new Set(names).size);

      for (const v of parsed.vectors) {
        expect(v.name.length).toBeGreaterThan(0);
        expect(typeof v.payloadJson).toBe("string");
        expect(() => JSON.parse(v.payloadJson)).not.toThrow();
        expect(v.sha256).toMatch(SHA256_RE);
        expect(v.byteLength).toBeGreaterThanOrEqual(0);
        // Self-consistency: declared sha256 + byteLength match the payload bytes.
        const bytes = new TextEncoder().encode(v.payloadJson);
        expect(v.byteLength).toBe(bytes.length);
        expect(v.sha256).toBe(sha256Hex(bytes));
      }
    });
  }
});
