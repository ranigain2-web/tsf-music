#!/usr/bin/env python3
"""Background upload to 0x0.st with 7-day expiry. Writes URL to upload/0x0-url.txt on success."""
import sys, os, time, urllib.request, mimetypes, uuid

TARBALL = "/home/z/my-project/upload/" + os.readlink("/home/z/my-project/upload/latest.txt") if os.path.islink("/home/z/my-project/upload/latest.txt") else open("/home/z/my-project/upload/latest.txt").read().strip()
print(f"Uploading {TARBALL} ({os.path.getsize(TARBALL)} bytes) to 0x0.st with 7-day expiry...", flush=True)

# Build multipart/form-data
boundary = uuid.uuid4().hex
with open(TARBALL, 'rb') as f:
    file_bytes = f.read()

body = []
body.append(f'--{boundary}'.encode())
body.append(b'Content-Disposition: form-data; name="expires"')
body.append(b'')
body.append(b'168')
body.append(f'--{boundary}'.encode())
body.append(b'Content-Disposition: form-data; name="file"; filename="' + os.path.basename(TARBALL).encode() + b'"')
body.append(b'Content-Type: application/gzip')
body.append(b'')
body.append(file_bytes)
body.append(f'--{boundary}--'.encode())
body.append(b'')
body_bytes = b'\r\n'.join(body)

req = urllib.request.Request(
    'https://0x0.st/',
    data=body_bytes,
    headers={'Content-Type': f'multipart/form-data; boundary={boundary}', 'User-Agent': 'tsf-music/1.0'},
    method='POST'
)

try:
    with urllib.request.urlopen(req, timeout=600) as resp:
        url = resp.read().decode().strip()
        print(f"Got response: {url}")
        if url.startswith('http'):
            with open('/home/z/my-project/upload/0x0-url.txt', 'w') as f:
                f.write(url + '\n')
            print(f"SUCCESS: {url}")
        else:
            print(f"Unexpected response: {url}")
            sys.exit(1)
except Exception as e:
    print(f"FAILED: {e}")
    sys.exit(2)
