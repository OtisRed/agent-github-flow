# Deployment profile on onboarding

Commit one agf-deployment.json at the root of each repository that has a runtime. Choose the two locations with the owner. The supported pairs (smoke/main) are server/server, local/server and local/local. A documentation-only repository may explicitly explain in its instructions why it has no runtime. Existing repositories without a file report missing; other onboarding checks remain available.

Prepare a JSON file containing exactly version (1), smoke and main. Each target contains location (local or server), start (project-specific activation or responsible service) and verify (how to observe the actual serving process and its full commit). Use plain instructions, without credentials. Include isolation, on-demand start/stop and retention of persistent data where relevant. Example structure:

```json
{
  "version": 1,
  "smoke": {"location": "local", "start": "Run the project's preview command in its isolated Docker project.", "verify": "Read revision from the local preview health endpoint and compare with refs/heads/smoke."},
  "main": {"location": "server", "start": "The project's release service follows main.", "verify": "Read revision from the public serving endpoint and compare with refs/heads/main."}
}
```

Replace example instructions with the actual command, service and version source. Preview with `node scripts/onboard.mjs --repo PATH --declare-deployment INPUT.json`; repeat with `--apply` to create the declaration in the repository checkout. Commit it through the project's normal flow. An identical declaration is a no-op. Edit an existing changed declaration through a reviewed diff. Ordinary Project onboarding includes the profile state in its result.

Diagnosis reports the declared pair and instructions separately from runtime evidence. Collect fresh observations using the project's read-only procedure. Use `node scripts/diagnose.mjs --repo PATH --live --observed-smoke stopped --observed-main FULL_SHA` only when both values have actually been observed. Supply one flag if only one target was checked. A stopped process, an unreachable endpoint, or a tag alone does not prove a running revision. Compare each observed SHA with its own branch. Record the observation time, method and scope in the issue. These defaults configure agent expectations; activation remains with each project.
