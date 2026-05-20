<script lang="ts">
  import { createOrJoinAccount } from "../protocol/octi-api";
  import { decodeLinkingData } from "../linking/linking-data";
  import { credentialsRepo, type CredentialRecord } from "../storage/credentials-repo";
  import { OCTI_WEB_VERSION } from "../version";

  let pasted = $state("");
  let deviceLabel = $state("Browser");
  let submitting = $state(false);
  let error = $state<string | null>(null);

  let { onDone }: { onDone: () => void } = $props();

  async function submit() {
    error = null;
    if (!pasted.trim()) {
      error = "Paste the link data first.";
      return;
    }
    submitting = true;
    try {
      const link = decodeLinkingData(pasted);
      const deviceId = crypto.randomUUID();
      const account = await createOrJoinAccount({
        server: link.serverAddress,
        deviceId,
        deviceTag: { version: OCTI_WEB_VERSION, label: deviceLabel.trim() || "Browser" },
        shareCode: link.shareCode.code,
      });
      const record: CredentialRecord = {
        accountId: account.account,
        devicePassword: account.password,
        ownDeviceId: deviceId,
        deviceLabel: deviceLabel.trim() || "Browser",
        serverAddress: link.serverAddress,
        // CRITICAL: inherit the account's shared keyset — generating a fresh one here
        // would let us authenticate but make every other device's data undecryptable.
        encryptionKeyset: link.encryptionKeySet.key,
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
  <h1>Link by paste</h1>
  <p style="opacity: 0.75; font-size: 0.9rem;">
    On another Octi device, generate a link/share code and paste its full payload
    here. The code expires in ~60 minutes.
  </p>

  <label>
    <span>Linking data</span>
    <textarea
      bind:value={pasted}
      rows="5"
      placeholder="Paste the base64 link payload from your other device"
      data-testid="paste-textarea"
    ></textarea>
  </label>

  <label>
    <span>Label for this browser</span>
    <input bind:value={deviceLabel} placeholder="Browser" />
  </label>

  <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
    <button data-testid="paste-submit" onclick={submit} disabled={submitting}>
      {submitting ? "Joining…" : "Join account"}
    </button>
  </div>

  {#if error}
    <p style="margin-top: 0.75rem; color: #ff8a8a;">{error}</p>
  {/if}
</section>
