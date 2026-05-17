<script lang="ts">
  import { createOrJoinAccount } from "../protocol/octi-api";
  import { OFFICIAL_SERVERS, type ServerAddress } from "../protocol/models";
  import { generateAesGcmSivKeyset } from "../crypto/tink-keyset";
  import { credentialsRepo, type CredentialRecord } from "../storage/credentials-repo";

  type Choice = "PROD" | "BETA" | "CUSTOM";

  let serverChoice = $state<Choice>("PROD");
  let customDomain = $state("");
  let customProtocol = $state<"http" | "https">("https");
  let customPort = $state(443);

  let deviceLabel = $state("Browser");

  let submitting = $state(false);
  let error = $state<string | null>(null);

  let { onDone }: { onDone: () => void } = $props();

  function resolveServer(): ServerAddress {
    if (serverChoice === "PROD") return OFFICIAL_SERVERS.PROD;
    if (serverChoice === "BETA") return OFFICIAL_SERVERS.BETA;
    return { domain: customDomain.trim(), protocol: customProtocol, port: customPort };
  }

  async function submit() {
    error = null;
    const server = resolveServer();
    if (!server.domain) {
      error = "Domain is required.";
      return;
    }
    if (!deviceLabel.trim()) {
      error = "Device label is required.";
      return;
    }

    submitting = true;
    try {
      const deviceId = crypto.randomUUID();
      const { bytes: keysetBytes } = generateAesGcmSivKeyset();
      const account = await createOrJoinAccount({
        server,
        deviceId,
        deviceTag: { version: "octi-web/0.0.0", label: deviceLabel.trim() },
      });
      const record: CredentialRecord = {
        accountId: account.accountID,
        devicePassword: account.password,
        ownDeviceId: deviceId,
        deviceLabel: deviceLabel.trim(),
        serverAddress: server,
        encryptionKeyset: keysetBytes,
        createdAt: Date.now(),
      };
      await credentialsRepo.save(record);
      onDone();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }
</script>

<section>
  <h1>Create a new Octi account</h1>
  <p style="opacity: 0.75; font-size: 0.9rem;">
    This generates a fresh encryption key and registers this browser as the
    first device on a new account. To add your phone or another device later,
    use "Generate a share code" from the dashboard.
  </p>

  <h2>Sync server</h2>
  <label>
    <span>Server</span>
    <select bind:value={serverChoice}>
      <option value="PROD">prod.kserver.octi.darken.eu (official)</option>
      <option value="BETA">beta.kserver.octi.darken.eu (beta)</option>
      <option value="CUSTOM">Custom…</option>
    </select>
  </label>

  {#if serverChoice === "CUSTOM"}
    <label>
      <span>Domain</span>
      <input bind:value={customDomain} placeholder="octi.example.com" />
    </label>
    <div style="display: flex; gap: 0.75rem;">
      <label style="flex: 0 0 8rem;">
        <span>Protocol</span>
        <select bind:value={customProtocol}>
          <option value="https">https</option>
          <option value="http">http</option>
        </select>
      </label>
      <label style="flex: 1;">
        <span>Port</span>
        <input type="number" min="1" max="65535" bind:value={customPort} />
      </label>
    </div>
  {/if}

  <h2>This device</h2>
  <label>
    <span>Device label (shown on your other devices)</span>
    <input bind:value={deviceLabel} placeholder="Browser" />
  </label>

  <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
    <button onclick={submit} disabled={submitting}>
      {submitting ? "Creating…" : "Create account"}
    </button>
  </div>

  {#if error}
    <p style="margin-top: 0.75rem; color: #ff8a8a;">{error}</p>
  {/if}
</section>
