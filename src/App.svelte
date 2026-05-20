<script lang="ts">
  import { onMount } from "svelte";

  import CanaryBanner from "./ui/CanaryBanner.svelte";
  import Onboarding from "./ui/Onboarding.svelte";
  import DashboardStub from "./ui/DashboardStub.svelte";
  import { credentialsRepo, type CredentialRecord } from "./storage/credentials-repo";
  import { getOwnDeviceId } from "./storage/identity-settings";

  let bootstrapping = $state(true);
  let record = $state<CredentialRecord | null>(null);
  /**
   * Per-install own-device UUID resolved once at bootstrap so it can be passed
   * synchronously into every {@code OctiServerConnector} we construct
   * downstream. {@link getOwnDeviceId} seeds from an existing credential the
   * first time it's called, so users who linked before this PR don't
   * regenerate.
   */
  let ownDeviceId = $state<string | null>(null);

  async function reload() {
    record = (await credentialsRepo.getActive()) ?? null;
  }

  onMount(async () => {
    try {
      ownDeviceId = await getOwnDeviceId();
      await reload();
    } finally {
      bootstrapping = false;
    }
  });
</script>

<CanaryBanner />

<main>
  {#if bootstrapping || ownDeviceId == null}
    <p style="opacity: 0.6;">Loading…</p>
  {:else if record}
    <DashboardStub {record} {ownDeviceId} onSignOut={reload} />
  {:else}
    <Onboarding onDone={reload} />
  {/if}
</main>
