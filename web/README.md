# Web docs — meadowprotocol.com/v2

The public protocol docs and the OpenAPI spec the service card (`card.json`)
points at. These are hosted on the canonical site, not on a supplier's staked
node hostname (which is a relay/peer endpoint, not a web server).

| File | URL |
|---|---|
| `v2/index.html` | https://meadowprotocol.com/v2/ |
| `v2/app.html` | https://meadowprotocol.com/v2/app |
| `v2/operators.html` | https://meadowprotocol.com/v2/operators |
| `v2/openapi.json` | https://meadowprotocol.com/v2/openapi.json |

## Hosting

Served by nginx on the `meadowprotocol.com` host from `/var/www/meadow/v2/`,
behind the site's existing Certbot TLS, alongside the Meadow v1 app (`/`,
`/v1/`, `/mcp/`, …) without touching it. The two directives in the site's 443
server block:

```nginx
location = /v2 { return 301 /v2/; }          # bare /v2 -> /v2/ (else v1 404s it)
location ^~ /v2/ {
    root /var/www/meadow;
    try_files $uri $uri.html $uri/index.html =404;   # /v2/operators -> operators.html
}
```

Redeploy from this folder:

```
scp v2/* <meadowprotocol-host>:/var/www/meadow/v2/
```

## Keeping it current

`v2/openapi.json` `info.version` tracks the node's software version. When the
`/v2` client API changes: update `v2/openapi.json`, redeploy, and — once the
document is frozen for a release — add its `sha256` to `card.json` `specs[]`.
