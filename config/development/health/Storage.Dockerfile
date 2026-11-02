FROM ghcr.io/supabase/cli/storage@sha256:ac022dd6fba7ef5f84d676bbe776445c5e1955b786fe14b75a5669015ea771f2
COPY --chmod=0755 wget /usr/local/bin/wget
