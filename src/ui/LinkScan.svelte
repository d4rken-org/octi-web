<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { createOrJoinAccount } from "../protocol/octi-api";
  import { decodeLinkingData } from "../linking/linking-data";
  import { openCameraStream, scanQrFromVideo } from "../linking/qr";
  import { credentialsRepo, type CredentialRecord } from "../storage/credentials-repo";

  let { onDone }: { onDone: () => void } = $props();

  let videoEl: HTMLVideoElement | undefined = $state();
  let stream: MediaStream | null = null;
  let abort: AbortController | null = null;

  let deviceLabel = $state("Browser");
  let status = $state<"idle" | "scanning" | "joining">("idle");
  let error = $state<string | null>(null);

  async function startScan() {
    if (status !== "idle") return;
    error = null;
    try {
      stream = await openCameraStream();
      if (!videoEl) throw new Error("Video element not mounted yet");
      videoEl.srcObject = stream;
      await videoEl.play();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return;
    }
    status = "scanning";
    abort = new AbortController();
    try {
      const decoded = await scanQrFromVideo(videoEl!, abort.signal);
      await join(decoded);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        error = e instanceof Error ? e.message : String(e);
      }
      status = "idle";
    } finally {
      stopCamera();
    }
  }

  async function join(encodedLink: string) {
    status = "joining";
    const link = decodeLinkingData(encodedLink);
    const deviceId = crypto.randomUUID();
    const account = await createOrJoinAccount({
      server: link.serverAddress,
      deviceId,
      deviceTag: { version: "octi-web/0.0.0", label: deviceLabel.trim() || "Browser" },
      shareCode: link.shareCode.code,
    });
    const record: CredentialRecord = {
      accountId: account.accountID,
      devicePassword: account.password,
      ownDeviceId: deviceId,
      deviceLabel: deviceLabel.trim() || "Browser",
      serverAddress: link.serverAddress,
      encryptionKeyset: link.encryptionKeySet.key, // inherited, see LinkPaste comment
      createdAt: Date.now(),
    };
    await credentialsRepo.save(record);
    onDone();
  }

  function cancel() {
    abort?.abort();
  }

  function stopCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (videoEl) videoEl.srcObject = null;
  }

  onMount(() => {
    // Auto-start: most users land on this screen intending to scan immediately.
    startScan();
  });

  onDestroy(() => {
    abort?.abort();
    stopCamera();
  });
</script>

<section>
  <h1>Link by QR scan</h1>
  <p style="opacity: 0.75; font-size: 0.9rem;">
    Show the QR code from your other Octi device in front of this device's camera.
  </p>

  <label>
    <span>Label for this browser</span>
    <input bind:value={deviceLabel} placeholder="Browser" />
  </label>

  <!-- svelte-ignore a11y_media_has_caption — camera preview has no audio track -->
  <video
    bind:this={videoEl}
    playsinline
    muted
    style="width: 100%; max-width: 320px; background: #000; border-radius: 6px; margin-top: 1rem;"
  ></video>

  <p style="margin-top: 0.5rem; opacity: 0.8; font-size: 0.85rem;">
    {#if status === "scanning"}
      Looking for a QR code…
    {:else if status === "joining"}
      Joining account…
    {:else}
      Camera idle.
    {/if}
  </p>

  <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem;">
    {#if status === "scanning"}
      <button onclick={cancel}>Cancel</button>
    {:else}
      <button onclick={startScan} disabled={status === "joining"}>Start camera</button>
    {/if}
  </div>

  {#if error}
    <p style="margin-top: 0.75rem; color: #ff8a8a;">{error}</p>
  {/if}
</section>
