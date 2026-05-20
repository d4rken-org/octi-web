import { readFileSync } from "node:fs";

/**
 * Shape of the JSON file the bootstrap-peer emits. The Playwright specs read
 * this from {@code BOOTSTRAP_PEER_FILE} (default: bootstrap-peer.json at cwd).
 *
 * Each share code is one-time-use on the sync-server, so the file holds an
 * array — Playwright picks one per project. Specs that paste multiple times
 * in a single run consume multiple entries.
 */
export interface BootstrapPeer {
  linkingDataBlobs: string[];
  serverAddress: { domain: string; protocol: "http" | "https"; port: number };
  accountId: string;
  /** Server-assigned device id of the fake phone — assert it appears in the dashboard. */
  deviceId: string;
}

export function loadBootstrapPeer(): BootstrapPeer {
  const path = process.env.BOOTSTRAP_PEER_FILE ?? "bootstrap-peer.json";
  const peer = JSON.parse(readFileSync(path, "utf8")) as BootstrapPeer;
  if (!Array.isArray(peer.linkingDataBlobs) || peer.linkingDataBlobs.length === 0) {
    throw new Error(
      `bootstrap-peer.json must contain a non-empty linkingDataBlobs array. ` +
        `Re-run bootstrap-peer with SHARE_CODES_COUNT >= the number of Playwright projects.`,
    );
  }
  return peer;
}

/**
 * Pick the share-code blob for the current Playwright project. Returns by
 * index so two projects never collide on the same one-time-use code.
 */
export function blobForProject(peer: BootstrapPeer, projectName: string): string {
  const index = ["desktop", "mobile"].indexOf(projectName);
  if (index < 0) {
    throw new Error(`Unknown Playwright project "${projectName}" — extend blobForProject() if added`);
  }
  if (index >= peer.linkingDataBlobs.length) {
    throw new Error(
      `bootstrap-peer.json only has ${peer.linkingDataBlobs.length} share codes; ` +
        `project "${projectName}" (index ${index}) needs one. ` +
        `Re-run bootstrap-peer with a higher SHARE_CODES_COUNT.`,
    );
  }
  return peer.linkingDataBlobs[index];
}
