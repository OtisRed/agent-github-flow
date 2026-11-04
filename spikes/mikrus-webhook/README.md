# Webhook receiver spike

This is an isolated feasibility test, not the production controller. It receives a GitHub App webhook over an HTTPS reverse proxy, verifies the body HMAC, accepts only the configured installation and repository, and stores minimal metadata in SQLite before acknowledging delivery. It neither calls GitHub nor changes issues or Project statuses. Only the synthetic `agf_webhook_spike_v1` repository dispatch is required for the live test; issue and comment parsing are covered locally and are not enabled by the spike by default.

The service listens on loopback; a separately configured HTTPS proxy is required. Configure one fixed, restricted installation and repository ID through the service environment. Install the webhook secret separately via the owner-run helper; the helper assumes the configured SSH account is root. Never copy secrets into source, issue bodies, Actions logs, or chat. The state directory is private and must be backed up and access controlled like other private operational state. Request bodies and issue contents are not retained.

The standalone proxy provides per-spike shared rate and concurrency limits; these are not a DDoS guarantee. Test the host and its proxy arrangement before use. `DynamicUser` and `LoadCredential` require a compatible systemd. Service source code makes no outbound calls; address-family restrictions alone do not enforce outbound isolation.

A repeated delivery ID with matching metadata and body signature is acknowledged without inserting again. Since GitHub signs the body but not the delivery ID, a previously recorded signature presented with a new ID is rejected. Two legitimate byte-identical bodies can have the same signature, so this conservative rule may also reject valid deliveries. Live dispatches must include a unique nonsecret nonce. This is not a production deduplication design: replay before the first receipt or after loss/rollback of the database remains possible. A production worker must verify current GitHub state independently and have an explicit recovery strategy. Monitor and investigate non-2xx responses; GitHub webhook delivery retries and recovery must be designed separately.

Local verification: `python3 -m unittest discover -s spikes/mikrus-webhook -p 'test_*.py' -v`. This cannot establish a genuine GitHub delivery, proxy resilience, or production readiness.

## Stopping the experiment

Disable the App webhook at GitHub first, then stop the specific temporary tunnel, proxy and receiver units. The receiver and proxy units are not enabled for automatic startup. Check the existing service independently; stopping the spike does not prove the rest of the server is healthy. The temporary tunnel URL changes when a new tunnel is created and is not a production endpoint.

```sh
systemctl stop agf-webhook-tunnel-71.service
systemctl stop agf-webhook-proxy-71.service
systemctl stop agf-webhook-spike-71.service
systemctl is-active nginx
```

Stopping preserves the restricted webhook-secret file and the SQLite state for controlled review. Decide retention and deletion separately. If used again, verify configuration and provision a new test endpoint and secret as appropriate. SQLite WAL must be included in any consistent backup; a raw copy of only the main database while it is active is insufficient. No backup or unattended recovery has been demonstrated by this spike.

## Existing infrastructure domain

For a bounded test on an already configured HTTPS domain, `domain-nginx-location.conf` contains one exact-match webhook location and `domain-nginx-zones.conf` provides its dedicated rate and connection zones. Include it only in the intended virtual server after confirming the path is unused and preserve the site configuration and backup. The locations forward to the isolated, rate-limited local proxy on port 19072, not directly to the receiver. No changes are required to DNS or the existing Cloudflare tunnel. The paths, proxy and receiver are experimental and do not implement the controller.

Test the entire candidate configuration with `nginx -t` before reloading the site's nginx, check its existing route and the new route afterwards, and preserve a recoverable copy. A request with a deliberately invalid signature should return 403; separately verify an authentic test delivery without logging its body. A reload and an `active` status alone are not proof of successful routing. When concurrent configuration management cannot be coordinated, stop on any mismatch; advisory locks do not constrain unrelated deployers. Avoid logs containing signatures, webhook bodies or credentials.

The App has one webhook across its installation. During the bounded test, the domain route permits only `repository_dispatch` and `ping`; other event types receive HTTP 503 without reaching the experimental receiver. Those deliveries require investigation and possible recovery because GitHub does not automatically redeliver failures. Events from other repositories that reach the receiver are acknowledged and discarded. Disable the App webhook before stopping the test services; the receiver has no production failure recovery or backlog guarantees, and the static API response alone does not prove delivery.
