# Deployment notes
Only Preview and Development may use Neon dev branch. Never migrate or seed main without explicit release approval. Database host IDs: dev ep-rapid-resonance-b30jzpx3, main ep-old-cell-b3jmmab7. Use pooled DATABASE_URL for runtime, direct DIRECT_URL for migrations. Preview NEXTAUTH_URL is derived from VERCEL_URL when unset. Development uses http://localhost:3000. Neon Free may scale to zero and introduce cold starts. Production remains unchanged. Auto-preview database branching requires manual integration setting verification.

## Dev migration and idempotent seed (owner-operated)
1. GitHub repository > Settings > Secrets and variables > Actions > New repository secret.
2. Name: DEV_DIRECT_URL. Value: the **Neon dev branch unpooled** connection string, not main. Obtain it from Vercel Preview DIRECT_URL. Do not paste it in issues, logs, or chat.
3. Open Actions > db-seed-dev > Run workflow > branch dev/p2-foundation. This workflow refuses other branches and checks the pinned dev hostname before migrate and seed.
4. Read the run's migrate deploy output, two seed runs, and the final equal row-count assertion. Never run against Neon main.
5. No Preview build automatically migrates the database. This avoids accidental production-mode migration and hidden writes during builds.
