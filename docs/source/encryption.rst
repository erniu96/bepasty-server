Password-encrypted shares (LAN extension)
=========================================

The shared "加密" checkbox applies to the ordinary file picker, page-wide file
drops, pasted files/screenshots, and the text composer. Enter the password once
before selecting files or submitting text. Multiple files are encrypted separately.
There is no separate encrypted upload form. The option is shown only after the
JavaScript workspace is ready; native forms remain usable without JavaScript.

Use HTTPS (Web Crypto requires a secure context). Missing passwords, unsupported
crypto, or encryption errors stop the upload without sending plaintext. The choice
and password are captured when files are added; later changes do not downgrade
queued uploads. Ciphertext is generated lazily from 512 KiB source slices and sent
in bounded HTTP chunks. Resume accepts any acknowledged ciphertext offset and
recreates exactly the same bytes within that upload. Text enters the same queue;
if preparation fails its input remains, and failed queued uploads offer retry.

New uploads have no 128 MiB product limit. Each transfer retains at most one
cached ciphertext record plus its current transport buffers. The format supports
up to (2^32 - 1) 512 KiB data records; server storage and configured quotas still
apply. The shared retention selector also applies to encrypted shares. Passwords
are kept only in the current page; unchecking clears the input. This is not a
server login password and does not encrypt existing items in place.

Passwords, keys, plaintext, original filenames and original MIME types are not
sent to the server. The server stores an opaque application/x-bepasty-encrypted
item called 加密分享.bepenc and does not run automatic titles on it. Its size,
creation/expiry times and sharing identifier remain visible. Share the password
separately from the URL. A forgotten password cannot be recovered; choose a
long, unique password because the downloaded ciphertext permits offline guesses.

Opening, downloading or inline-viewing the item leads to a password prompt.
The browser obtains ciphertext with /<name>/+download?ciphertext=1, authenticates
and decrypts it locally, and then enables plaintext download. This ciphertext
endpoint is intentionally accessible without the item password: it never serves
plaintext. Existing READ, LOCKED, completeness and expiry checks still apply.
Small v2 files (up to 16 MiB) retain local Blob previews/downloads. Larger files
are unlocked by reading only the authenticated metadata, then downloaded through
an isolated same-origin Service Worker scope under static/app/crypto-download/.
It decrypts one record at a time and hands an attachment response to the browser,
respecting stream backpressure. It never caches plaintext or persists keys. The
one-use download ticket expires after 60 seconds; a new click creates a new ticket.
Browsers without HTTPS, readable response streams or Service Worker support cannot
use this large-file save path; they receive an explicit error instead of an
unbounded in-memory fallback. This requires device-specific browser verification.

Each record is authenticated before release. Corruption/truncation interrupts the
download; already-authenticated earlier records may exist in a partial download.
Check that the browser reports completion. Relocking clears the page session;
it does not cancel an already-started native browser download.

Text previews are rendered with textContent (no active HTML or scripts).
PNG/JPEG/GIF/WebP/AVIF, selected audio/video MIME types and PDF use local blob
previews. PDF is in a sandboxed iframe; browser PDF support varies. Other types
can be downloaded after decryption. Relock removes preview DOM, clears the
password field and revokes the blob URL; this is not a guarantee of secure memory
erasure. Browser extensions, an already-compromised client, or a malicious
server delivering altered JavaScript are outside this protection model.

Envelope v2 (new uploads)
-------------------------

All integers are unsigned big-endian. AES-256-GCM and the PBKDF2 parameters below
remain fixed. A fresh 16-byte salt and 8-byte nonce prefix are generated per file.

* Bytes 0..7: ASCII BEPAENC2.
* Bytes 8..23: salt; bytes 24..31: nonce prefix.
* Bytes 32..35: fixed plaintext chunk size 524288.
* Bytes 36..43: original file length (uint64, restricted to safe JS integers).
* Bytes 44..47: plaintext metadata JSON byte length, at most 16384.
* Record 0: encrypted UTF-8 JSON {name, type}, followed by its 16-byte GCM tag.
* Records 1..N: fixed-size plaintext chunks encrypted independently, each followed
  by its 16-byte GCM tag. The last chunk may be shorter. Empty files have only
  record 0, so the metadata/header still authenticate their empty length.
* Per-record nonce: nonce prefix || uint32 record index.
* Per-record additional authenticated data: full 48-byte header || uint32 index.

The authenticated header commits the total size, record count and metadata size.
Indexes bind order and position; readers reject truncated and trailing data.
Retries reuse the same File snapshot, key and header and produce identical
ciphertext slices. A new upload generates fresh salt/prefix, including duplicates.

Envelope v1 (read compatibility)
-------------------------------

Existing v1 files are still read with their original single-tag algorithm and
128 MiB historical size bound. They cannot be incrementally authenticated and
therefore still require whole-file decryption. New browser uploads use v2.


All integer fields are big-endian. Fixed parameters deliberately avoid
attacker-controlled KDF iteration counts.

* Bytes 0..7: ASCII BEPAENC1 (version marker).
* Bytes 8..23: cryptographically random 16-byte salt.
* Bytes 24..35: cryptographically random 12-byte AES-GCM nonce.
* Remaining bytes: AES-256-GCM ciphertext, followed by its 128-bit tag.
* Additional authenticated data: the full 36-byte header.
* Key derivation: PBKDF2-HMAC-SHA-256, 600,000 iterations, UTF-8 password bytes,
  no Unicode normalization, 256-bit derived key.
* Plaintext: uint32 metadata byte length, UTF-8 JSON {name, type}, original bytes.
  Metadata is capped at 16 KiB and is encrypted/authenticated with the data.

Wrong passwords or tampering do not release unauthenticated plaintext. Random
salt and nonce are fresh for every upload, including repeated input/password.
Keep format/algorithm versioning explicit if changing parameters in the future.
