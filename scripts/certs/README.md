# Supabase database trust anchor

Public CA downloaded over certificate-verified HTTPS from the URL published in Supabase's official dashboard source:
https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json

Production URL: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

PEM SHA-256: `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`
DER SHA-256: `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`

The launcher checks the PEM hash and supplies this CA only to its exact allowlisted database connection. It does not alter the operating system trust store or disable TLS/hostname verification. Certificate rotation requires a reviewed update.

On 2026-10-03, a credential-free PostgreSQL SSLRequest/TLS probe to the user-confirmed `aws-0-us-east-1.pooler.supabase.com:5432` passed chain and hostname verification with TLS 1.3. Default Node and Mac trust stores lacked this CA. No database startup/authentication payload was sent. This does not prove project routing, password authentication or restricted login identity; those require the actual dedicated login.
