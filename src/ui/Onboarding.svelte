<script lang="ts">
  import CreateAccount from "./CreateAccount.svelte";
  import LinkPaste from "./LinkPaste.svelte";
  import LinkScan from "./LinkScan.svelte";

  type Mode = "choose" | "create" | "paste" | "scan";

  let mode = $state<Mode>("choose");

  let { onDone }: { onDone: () => void } = $props();
</script>

<section>
  {#if mode === "choose"}
    <h1>Welcome to Octi web</h1>
    <p style="opacity: 0.75;">
      Set this browser up as a new Octi device. Pick how you want to get started.
    </p>

    <div style="display: grid; gap: 0.75rem; margin-top: 1rem; max-width: 320px;">
      <button onclick={() => (mode = "create")}>Create a new account</button>
      <button onclick={() => (mode = "paste")}>Link by paste</button>
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
