FROM ghcr.io/supabase/cli/auth@sha256:7eb303831d170865840dbb3f9018b48561c988704ad1d9a2bafabb4e93e92da5
COPY --chmod=0755 wget /usr/local/bin/wget
