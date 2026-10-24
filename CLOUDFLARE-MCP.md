# Fridge MCP through Cloudflare Tunnel

The MCP server runs on the Raspberry Pi in the existing fridge application.
Cloudflare provides HTTPS, OAuth login, and a tunnel to the Pi. No router port
forwarding, Mac runtime, or Worker is required.

## Deployment configuration (placeholders)

Use your own values below. Keep the actual login email and deployment identifiers
in private operational notes outside Git. These placeholders are not live settings.

| Setting | Value |
| --- | --- |
| MCP URL | `https://fridge-mcp.example.com/mcp` |
| Cloudflare account | `YOUR_CLOUDFLARE_ACCOUNT_ID` |
| DNS zone | `example.com` (`YOUR_DNS_ZONE_ID`) |
| Tunnel | `fridge-mcp` (`YOUR_TUNNEL_ID`) |
| Access application | `Fridge MCP` (`YOUR_ACCESS_APPLICATION_ID`) |
| Access team | `YOUR_ZERO_TRUST_TEAM.cloudflareaccess.com` |
| Allowed user | `you@example.com`, through email one-time PIN |
| Origin | `http://127.0.0.1:3000` on the Pi |
| Connector | `/home/YOUR_USER/.local/bin/cloudflared` |
| Connector secret | `/home/YOUR_USER/.config/fridge-mcp/tunnel-token`, mode `0600` |
| User service | `fridge-mcp-tunnel.service` |

The connector and fridge app start manually; neither is enabled at boot by this
setup. Both must be running for ChatGPT to retrieve inventory.

## Authentication and routing

ChatGPT connects to Cloudflare using OAuth. Access allows only the configured
email and forwards a signed `Cf-Access-Jwt-Assertion`. On the Pi, cloudflared
validates this JWT against the Access team and application audience **before**
forwarding the request to Express. The tunnel configuration must keep
`originRequest.access.required: true`; do not rely on the presence of a header.

Only the anchored path `^/mcp/?$` routes to the app. The final ingress rule returns
404 for all other paths. Access may reject a request before that 404 is reached.
The camera, frontend, agent, uploads, and inventory-write APIs are not routed
through this hostname. OAuth discovery and login endpoints are handled at
Cloudflare's edge, not by the Pi.

The existing LAN app remains unauthenticated, including its local `/mcp` route.
This deployment's public authentication boundary is Access plus cloudflared's
JWT validation. Do not expose Pi port 3000 through another public route. If you
change the ingress or proxy architecture, preserve token validation before the
origin becomes reachable.

The single tool is `get_fridge_contents`. It reads saved SQLite inventory without
invoking a model, capturing images, or writing inventory.

## Recreate the Cloudflare configuration

1. Choose a dedicated hostname in a Cloudflare-managed zone. Check that no DNS
   record, Access app, or tunnel already owns it. Use the same account for Access
   and the tunnel.
2. Create a **self-hosted Access application** protecting the entire hostname.
   Add an Allow policy containing only the intended email addresses. Reuse an
   existing identity provider or configure email one-time PIN. Do not add an
   Everyone, Bypass, or unauthenticated policy.
3. Enable **Managed OAuth** in the application's advanced settings. Enable
   dynamic client registration and configure these redirect URIs:

   ```text
   https://chatgpt.com/connector_platform_oauth_redirect
   https://chatgpt.com/connector/oauth/*
   ```

   ChatGPT can show a connection-specific callback URL. Prefer that exact URL
   when available; the second entry supports its callback-ID paths. Leave
   arbitrary localhost/loopback callbacks disabled unless intentionally adding
   a local OAuth client. The deployed configuration uses a 15-minute access
   token, a 336-hour OAuth grant session, and a 24-hour Access app session.
   Refresh tokens allow renewal within the grant session; subsequent login can
   still be required by policy or expiry.
4. Record the Access application's **AUD** tag and Zero Trust team name. These
   are configuration values, not secrets.
5. Create a **remotely managed** Cloudflare Tunnel, named `fridge-mcp` here
   (`config_src: "cloudflare"` in the API). Adapt
   [the ingress template](deploy/fridge-mcp-tunnel.config.example.json), replacing
   hostname, team name, and audience. Keep the exact MCP path and final 404 rule.
   Submit the configuration through the dashboard or
   `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations`.
6. Add a **proxied CNAME** from the dedicated hostname to
   `<TUNNEL_ID>.cfargotunnel.com`, with automatic TTL. Configure Access and the
   restricted ingress before publishing DNS.
7. Retrieve the tunnel connector token from Cloudflare. Store it directly on the
   Pi in the private file above. Never commit it, paste it into documentation,
   print it to logs, or pass it as a process argument. This connector credential
   is separate from the OAuth tokens used by ChatGPT.

Set the ingress audience to your Access application AUD:
`YOUR_ACCESS_APPLICATION_AUD`.
Recreating the Access application changes its audience: update the ingress too.

## Install and start on the Pi

Use the official [cloudflared downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
for the Pi's architecture (`aarch64` uses Linux ARM64). This deployment installed
cloudflared 2026.10.3 in `~/.local/bin/cloudflared`. `--token-file` requires a
version that supports that flag; check `cloudflared tunnel run --help`.

Create the private token directory with mode `0700` and token file with mode
`0600`. Install [the user unit](deploy/fridge-mcp-tunnel.user.service) as
`~/.config/systemd/user/fridge-mcp-tunnel.service`. Then run on the Pi:

```sh
systemctl --user daemon-reload
systemctl --user start fridge-ai
systemctl --user start fridge-mcp-tunnel
systemctl --user is-active fridge-ai fridge-mcp-tunnel
```

No `enable` or linger change is part of this setup. After a reboot, run the two
start commands again. For normal source deployment follow [AGENTS.md](AGENTS.md):
sync, install dependencies if changed, and rebuild/restart on the Pi.

### Deployment from a worktree behind the running application

Do not run a full `pi:sync` from an older worktree. On 2026-10-24 the Pi already
contained newer recording and chat features. The MCP deployment therefore copied
only `server/mcp.ts` and its test, added the MCP import/mount to the existing Pi
`server/app.ts` after its JSON parser, and installed `@modelcontextprotocol/sdk`
without replacing the Pi's dependency manifests. It did not replace frontend
assets, camera settings, databases, or `.env`.

The prior Pi `app.ts`, `package.json`, and `package-lock.json` were backed up under
`/home/YOUR_USER/fridge-data/mcp-deploy-backup-20261024`. Reconcile this feature with
the latest source before a future full sync, or that sync could remove the MCP
mount/dependency. A rollback must also preserve any changes made since backup.

## Connect in ChatGPT

1. On ChatGPT web, open Plugins and add a custom MCP server (older interfaces
   may show Apps/developer mode).
2. Enter `https://fridge-mcp.example.com/mcp` and select **OAuth**. Leave manual
   client credentials empty to use dynamic client registration. If a
   registration-method selector appears, choose DCR.
3. Complete Cloudflare's email-code login using the allowed email, then approve
   the connection. The user must complete their own login.
4. Install/select the resulting plugin and ask: “Use Fridge MCP to tell me what
   is currently in my fridge.” Only `get_fridge_contents` should be listed.

Do not choose No authentication or paste the tunnel token into ChatGPT. If the
connection displays a callback not covered above, add its exact HTTPS callback
to Access's allowed redirect URIs. Workspace permissions and client support may
affect availability. Test mobile use separately; a working tunnel alone does not
establish that a particular ChatGPT surface supports the custom plugin.

## Verification and troubleshooting

Deployment checks on 2026-10-24: both Pi services active, tunnel healthy with
four connections, token file mode `0600`, Pi type check and isolated MCP test
passed. A live SDK client discovered exactly `get_fridge_contents`, and its
19 returned inventory records matched `/api/items`. Missing and invalid public
bearer tokens returned 401. Resource and authorization-server discovery worked,
including DCR, PKCE S256, and refresh-token support. The user subsequently confirmed that ChatGPT sign-in and the MCP connection
work successfully.

Run service checks from the Mac over SSH:

```sh
ssh YOUR_USER@YOUR_PI_HOST 'systemctl --user is-active fridge-ai fridge-mcp-tunnel'
ssh YOUR_USER@YOUR_PI_HOST 'curl -fsS http://127.0.0.1:3000/api/status'
```

An unauthenticated public MCP call must return **401**, with a
`WWW-Authenticate` header pointing to OAuth resource metadata:

```sh
curl -i https://fridge-mcp.example.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Follow the exact metadata URL from that challenge. It should be publicly
readable and contain the authorization server location. Follow that server's
discovery metadata to verify authorization, token, and registration endpoints.
Do not assume every provider uses the same discovery path.

Test the following before declaring end-to-end setup complete:

- Local MCP initialization, tool listing, and a read-only call succeed.
- Cloudflare reports the tunnel healthy and Access has only the intended policy.
- Missing/invalid public credentials return 401 without inventory data.
- OAuth metadata is reachable without login.
- A real ChatGPT login and tool call succeed for the allowed user.
- An unauthorized identity is denied. Authenticated requests outside `/mcp`
  must still hit the tunnel's 404 rule, never the camera or write APIs.

Use `journalctl --user -u fridge-mcp-tunnel -n 50 --no-pager` on the Pi for
connector errors. Do not enable debug-level request/header logging. A healthy
tunnel does not prove OAuth completed. A 302 HTML login for an MCP request
usually means Managed OAuth is disabled or the request matched another Access
application. A 502 indicates the app is unavailable on the origin. A tunnel
offline error indicates the connector is stopped or cannot reach Cloudflare.
Review Access authentication logs for login-policy failures.

## Stop, revoke, and remove

For immediate shutdown without affecting the LAN app:

```sh
ssh YOUR_USER@YOUR_PI_HOST 'systemctl --user stop fridge-mcp-tunnel'
```

To revoke user access, remove that user from the Access policy and revoke their
Access sessions. To rotate a leaked connector credential, rotate the tunnel
token in Cloudflare, replace the Pi's private token file, and restart the
connector. Do not put the new token in shell history.

To remove the deployment, stop the connector, remove its dedicated DNS record,
then remove the dedicated tunnel and Access application. Keep Access protecting
the hostname until routing is removed. Remove the user unit/token only when no
longer needed. Do not delete shared identity providers or other tunnels.

## References

- [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [Cloudflare Tunnel origin parameters and Access validation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-configuration/)
- [Cloudflare tunnel run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/)
- [ChatGPT custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth)
