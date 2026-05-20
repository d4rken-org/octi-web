<script lang="ts">
  import { onMount } from "svelte";

  import CanaryBanner from "./ui/CanaryBanner.svelte";
  import Onboarding from "./ui/Onboarding.svelte";
  import DashboardStub from "./ui/DashboardStub.svelte";
  import { credentialsRepo } from "./storage/credentials-repo";
  import { ConnectorManager } from "./sync/connector-manager.svelte";

  /**
   * The dashboard runs against a singleton {@link ConnectorManager} for the
   * life of the SPA. We construct it once at bootstrap, populate from
   * persistent storage, and pass it down to {@link DashboardStub}.
   *
   * Going through the manager (not the credential record directly) is what
   * lets multiple linked accounts coexist: the dashboard sees a merged peer
   * view, the link/create flows just append a new credential and call
   * {@code manager.addConnector(record)}.
   */
  const manager = new ConnectorManager();

  let bootstrapping = $state(true);
  /** True when at least one credential is linked; drives Onboarding vs Dashboard. */
  let hasAnyConnector = $state(false);

  async function reload() {
    await manager.bootstrap();
    const records = await credentialsRepo.listAll();
    hasAnyConnector = records.length > 0;
  }

  onMount(async () => {
    try {
      await reload();
    } finally {
      bootstrapping = false;
    }
  });
</script>

<CanaryBanner />

<main>
  {#if bootstrapping}
    <p style="opacity: 0.6;">Loading…</p>
  {:else if hasAnyConnector}
    <DashboardStub {manager} onSignOut={reload} />
  {:else}
    <Onboarding onDone={reload} />
  {/if}
</main>
