<script lang="ts">
  import { OCTI_WEB_CHANNEL, OCTI_WEB_GIT_SHA, OCTI_WEB_REPO_URL } from "../version";

  // Static at module load — channel/sha are baked into the bundle at build time
  // and don't change while the SPA runs.
  const isCanary = OCTI_WEB_CHANNEL === "canary";
  const shortSha = (OCTI_WEB_GIT_SHA || "dev").slice(0, 7);
  const commitUrl = `${OCTI_WEB_REPO_URL}/commit/${OCTI_WEB_GIT_SHA}`;
</script>

{#if isCanary}
  <div class="canary-banner" role="status" data-testid="canary-banner">
    <strong>Canary build</strong>
    (<a href={commitUrl} target="_blank" rel="noopener noreferrer"><code>{shortSha}</code></a>)
    — use <a href="https://web.octi.darken.eu/">web.octi.darken.eu</a> for stable.
    <span class="subtitle">This is a bleeding edge build.</span>
  </div>
{/if}

<style>
  .canary-banner {
    background: #5a2a14;
    color: #ffd9b3;
    padding: 0.5rem 1rem;
    text-align: center;
    font-size: 0.875rem;
    border-bottom: 1px solid #7a3a1c;
  }
  .canary-banner code {
    background: rgba(0, 0, 0, 0.25);
    padding: 0 0.25em;
    border-radius: 3px;
  }
  .canary-banner a {
    color: inherit;
    text-decoration: underline;
  }
  .canary-banner .subtitle {
    display: block;
    font-size: 0.75rem;
    opacity: 0.85;
    margin-top: 0.15rem;
  }
</style>
