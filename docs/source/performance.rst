Transfer performance and compatibility
======================================

Browser fallback
----------------

The upload page starts with a normal HTML form and an Upload button. If the
browser supports the required File, FormData, XHR, Blob slicing and JSON APIs,
the upload widget enables multiple files, progress and chunked transfers.
Otherwise, the form remains available and sends one file per submission. It
also works with JavaScript disabled. File and text forms, retention settings
and navigation remain visible without expanding any panels.

``MAX_ALLOWED_FILE_SIZE = None`` removes the application file size cap.
Administrators can still configure a numeric limit in bytes. The REST info
endpoint advertises an unlimited file size as JSON ``null``; clients must
skip total-size validation in that case. ``MAX_BODY_SIZE`` remains the
per-request chunk limit, not a total file size limit. Browser chunked uploads
can therefore exceed the old 5 GB default without building a single large
request. Disk space and client capabilities still constrain usable capacity.

The ordinary form sends the whole file in one request. Its maximum usable file
size therefore depends on the reverse proxy's request body limit; increasing
``MAX_ALLOWED_FILE_SIZE`` alone does not increase that limit.

This fallback does not guarantee identical layout or media playback on every
old browser. The server currently requires Python 3.11 or newer; browser and
server operating system compatibility are separate concerns.

Storage streaming
-----------------

Uploads copy data to storage and downloads yield data in blocks of up to
256 KiB, keeping the transfer buffer bounded as file sizes grow. SHA-256
background hashing continues to use 1 MiB blocks. A truncated stored file
raises an error instead of yielding empty blocks indefinitely.

``scripts/benchmark-transfer.py`` compares the actual storage implementation
and transfer loops with different block sizes, using temporary files that it
removes afterwards. It uses only the Python standard library. For example::

    python scripts/benchmark-transfer.py --directory /var/tmp --sync-after > transfer-benchmark.json

Each case receives one warm-up and seven measurements in randomized order.
The script independently verifies the copied and streamed bytes with SHA-256.
``--sync-after`` flushes copied files after verification, outside the timing,
to reduce writeback interference between cases.

A local run on 2026-10-03 with Python 3.12.14, an Intel i3-12100F and ext4,
using a 256 MiB + 1234 byte file and a warm page cache, measured these median
rates (MiB/s):

.. list-table:: Application storage microbenchmark
   :header-rows: 1

   * - Block size
     - Upload copy and SHA-256
     - Download generator
   * - 16 KiB
     - 958.8
     - 6180.4
   * - 64 KiB
     - 1056.3
     - 10623.6
   * - 256 KiB
     - 1064.2
     - 11971.4
   * - 1 MiB
     - 1079.2
     - 10017.9

For this file, 256 KiB reduces the number of loop iterations from 16385 to
1025. These measurements exclude HTTP, WSGI, TLS, network transfer and timed
fsync. They measure application overhead, and cannot establish network
throughput or guarantee that a link will be saturated.

Deployment and network measurements
-----------------------------------

``scripts/benchmark-http.py`` measures the browser multipart upload protocol and
streams the resulting download with independent SHA-256 verification. Run it
from a separate client on the network to include the physical link::

    python scripts/benchmark-http.py --base-url http://SERVER:5000 \
        --size-mib 32 --chunk-mib 0.25 --chunk-mib 0.5 \
        --chunk-mib 0.9921875 --repeats 3 --cleanup --output http-results.json

It reads the public service limits, rejects chunks beyond the advertised limit,
uses independently generated random source bytes, and deletes only its own test
items. The example needs create, read and delete permissions. Upload timing
includes metadata, client encoding and every sequential response; download
timing includes client hashing. Source generation and cleanup are excluded.

A same-host run via the server's LAN address on 2026-10-03 with the Werkzeug
development server, 32 MiB random data and three measurements per case reported
median upload rates of 118.0, 147.2 and 209.3 MiB/s for 256 KiB, 512 KiB and
1016 KiB chunks. All nine downloaded hashes matched. These requests did not
traverse a physical network link. The development server returned
``Connection: close``; using a Session alone did not provide connection reuse.
This is a local HTTP baseline, not a bandwidth guarantee or a production result.

Use a production WSGI server as described in the quickstart. Verify persistent
connections on both the client-facing proxy and its upstream connection.
The CLI client reuses a Requests Session across chunks, but the server or
proxy can still close connections. See the `Requests Session documentation
<https://requests.readthedocs.io/en/stable/user/advanced/#session-objects>`_
and `Nginx upstream keepalive documentation
<https://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive>`_.

Keep ``MAX_BODY_SIZE`` within the reverse proxy's request body limit when
tuning browser upload chunk sizes. Account for multipart framing. The REST
upload protocol uses Base64, so a 1 MiB raw CLI block produces 1398104 bytes
before HTTP headers; a 1 MiB proxy body limit will reject it.

Chunks of a single file are sent sequentially. On a high latency connection,
each chunk waits for the server response before the next can start. Connection
reuse reduces setup costs, but increasing storage read sizes does not remove
this round trip. Parallelizing chunks requires changes to the upload protocol
and server completion tracking, since the current REST API checks sequential
offsets.

To measure a real deployment, transfer a large non-compressible file in both
directions and verify its size and SHA-256. Record client and server versions,
RTT, link speed, proxy and WSGI settings, CPU use, storage throughput, and
elapsed upload and download times. Compare application payload bytes per
second with the separately measured network capacity, and repeat runs to
distinguish startup costs and cache effects from sustained performance.
