# Caddy with the Cloudflare DNS module, for DNS-01 certificates on hosts the internet can't reach (CADDY_TLS=cloudflare).
# The Caddyfile is mounted by compose (TLS + security headers, everything proxied to web:3000).
FROM caddy:2.11.4-builder AS caddy
RUN xcaddy build --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy:2.11.4
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
