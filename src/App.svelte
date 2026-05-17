<script lang="ts">
  import { onMount } from "svelte";

  import Onboarding from "./ui/Onboarding.svelte";
  import DashboardStub from "./ui/DashboardStub.svelte";
  import { credentialsRepo, type CredentialRecord } from "./storage/credentials-repo";

  let bootstrapping = $state(true);
  let record = $state<CredentialRecord | null>(null);

  async function reload() {
    record = (await credentialsRepo.getActive()) ?? null;
  }

  onMount(async () => {
    try {
      await reload();
    } finally {
      bootstrapping = false;
    }
  });
</script>

<main>
  {#if bootstrapping}
    <p style="opacity: 0.6;">Loading…</p>
  {:else if record}
    <DashboardStub {record} onSignOut={reload} />
  {:else}
    <Onboarding onDone={reload} />
  {/if}
</main>
