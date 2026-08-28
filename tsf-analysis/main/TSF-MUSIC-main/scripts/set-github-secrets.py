#!/usr/bin/env python3
"""Set GitHub Actions secrets for TSF-MUSIC release signing.

Why secrets instead of committing the keystore: a release keystore is the
identity of the app — anyone holding it can sign updates that install over
the real app. GitHub encrypts secrets at rest with libsodium; the workflow
decrypts them only in-memory during CI.

Credentials are NEVER hardcoded here — pass them via env:
  GH_TOKEN, KEYSTORE_FILE, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD,
  TSF_SERVER_URL

Secrets set:
  ANDROID_KEYSTORE_BASE64  — the .keystore file, base64
  ANDROID_KEYSTORE_PASSWORD — store password
  ANDROID_KEY_ALIAS         — key alias
  ANDROID_KEY_PASSWORD      — key password
  TSF_SERVER_URL            — the Capacitor server.url baked into the APK
"""
import base64
import json
import os
import sys
import urllib.request
from nacl import encoding, public

REPO = 'mua47105-hue/TSF-MUSIC'
TOKEN = os.environ['GH_TOKEN']

def api(method: str, path: str, body: bytes | None = None):
    req = urllib.request.Request(
        f'https://api.github.com/repos/{REPO}/{path}',
        method=method,
        data=body,
        headers={
            'Authorization': f'token {TOKEN}',
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
        },
    )
    with urllib.request.urlopen(req) as r:
        raw = r.read()
        return r.status, json.loads(raw) if raw else {}

# 1. fetch the repo's public key
status, pk = api('GET', 'actions/secrets/public-key')
if status != 200:
    print('public-key failed:', status, pk); sys.exit(1)
print(f'pubkey: id={pk["key_id"]}')

pk_obj = public.PublicKey(pk['key_id'].encode() if False else pk['key'], encoding.Base64Encoder())
sealed = public.SealedBox(pk_obj)

ks_path = os.environ.get('KEYSTORE_FILE', '/tmp/tsf-release.keystore')
ks_b64 = base64.b64encode(open(ks_path, 'rb').read()).decode()

secrets = {
    'ANDROID_KEYSTORE_BASE64': ks_b64,
    'ANDROID_KEYSTORE_PASSWORD': os.environ['KEYSTORE_PASSWORD'],
    'ANDROID_KEY_ALIAS': os.environ['KEY_ALIAS'],
    'ANDROID_KEY_PASSWORD': os.environ['KEY_PASSWORD'],
    'TSF_SERVER_URL': os.environ.get('TSF_SERVER_URL', 'http://10.125.110.1:3000'),
}

for name, value in secrets.items():
    enc = sealed.encrypt(value.encode())
    body = json.dumps({'encrypted_value': base64.b64encode(enc).decode(), 'key_id': pk['key_id']}).encode()
    status, resp = api('PUT', f'actions/secrets/{name}', body)
    print(f'{name}: HTTP {status}')
    if status not in (201, 204):
        sys.exit(2)

print('\nAll signing secrets set.')
