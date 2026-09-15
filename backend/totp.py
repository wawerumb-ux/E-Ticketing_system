"""Minimal RFC 6238 TOTP (time-based one-time passwords) using only the stdlib.

Drop-in replacement for a third-party TOTP library. Base32 secrets, 6-digit codes,
30-second step, and a +/- window for clock drift.
"""
import base64
import hashlib
import hmac
import os
import struct
import time


def generate_secret() -> str:
    """Return a new random Base32 secret (160 bits) without padding."""
    return base64.b32encode(os.urandom(20)).decode('ascii')


def _decoded_key(secret: str) -> bytes:
    secret = secret.strip().upper().replace(' ', '')
    padding = (-len(secret)) % 8
    return base64.b32decode(secret + '=' * padding, casefold=True)


def _totp(secret: str, counter: int) -> str:
    key = _decoded_key(secret)
    msg = struct.pack('>Q', int(counter))
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[19] & 0x0F
    code = (struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f'{code:06d}'


def totp_now(secret: str) -> str:
    return _totp(secret, time.time() // 30)


def verify(secret: str, code, window: int = 1) -> bool:
    """Verify a submitted code allowing +/- `window` time-steps of drift."""
    if not secret or not code:
        return False
    step = int(time.time()) // 30
    for i in range(-window, window + 1):
        if _totp(secret, step + i) == str(code).strip():
            return True
    return False


def otpauth_uri(secret: str, username: str, issuer: str = 'ICT E-Ticketing') -> str:
    escaped = f'{issuer}:{username}'.replace(':', '%3A')
    return (f'otpauth://totp/{escaped}?secret={secret}'
            f'&issuer={issuer.replace(" ", "%20")}&algorithm=SHA1&digits=6&period=30')