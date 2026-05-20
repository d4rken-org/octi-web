<script lang="ts">
  import { onMount } from "svelte";

  import CreateAccount from "./CreateAccount.svelte";
  import LinkPaste from "./LinkPaste.svelte";
  import LinkScan from "./LinkScan.svelte";

  type Mode = "choose" | "create" | "paste" | "scan";

  let mode = $state<Mode>("choose");

  let {
    onDone,
    manageScreenshotMarker = true,
  }: {
    onDone: () => void;
    /**
     * When true (default), `Onboarding` sets `data-screenshot-ready="onboarding"`
     * on mount and removes it on destroy. Set to false when the component is
     * mounted INSIDE another screen (e.g. the dashboard's "Add another sync
     * source" sheet) so the outer screen's screenshot marker stays in charge.
     */
    manageScreenshotMarker?: boolean;
  } = $props();

  // Marker for screenshot CI (Playwright). The mount path is synchronous; the
  // screen is ready as soon as the script runs.
  onMount(() => {
    if (!manageScreenshotMarker) return;
    document.documentElement.setAttribute("data-screenshot-ready", "onboarding");
    return () => {
      // Clear when this screen unmounts so the next screen's ready signal can settle.
      if (document.documentElement.getAttribute("data-screenshot-ready") === "onboarding") {
        document.documentElement.removeAttribute("data-screenshot-ready");
      }
    };
  });
</script>

<section class="route-narrow">
  {#if mode === "choose"}
    <h1>Welcome to Octi web</h1>
    <p style="opacity: 0.75;">
      Set this browser up as a new Octi device. Pick how you want to get started.
    </p>

    <div style="display: grid; gap: 0.75rem; margin-top: 1rem; max-width: 320px;">
      <button onclick={() => (mode = "create")}>Create a new account</button>
      <button data-testid="onboarding-paste" onclick={() => (mode = "paste")}>Link by paste</button>
      <button onclick={() => (mode = "scan")}>Link by QR scan</button>
    </div>
  {:else}
    <button style="margin-bottom: 1rem;" onclick={() => (mode = "choose")}>← Back</button>
    {#if mode === "create"}
      <CreateAccount {onDone} />
    {:else if mode === "paste"}
      <LinkPaste {onDone} />
    {:else if mode === "scan"}
      <LinkScan {onDone} />
    {/if}
  {/if}
</section>
