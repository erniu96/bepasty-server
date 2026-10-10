Mobile browsers and local-network testing
========================================

Use the native file chooser on a phone. Drag and drop is an optional shortcut;
ordinary form uploads remain available when enhanced upload APIs are absent.

Local-network access
--------------------

Start the development server with ``bepasty-server --host 0.0.0.0 --port 5000``
and open ``http://SERVER_LAN_IP:5000/`` from a device on the same network.
The default trusted-network mode needs no password, login, or session cookie.
For optional legacy authentication over HTTP, set ``SESSION_COOKIE_SECURE = False``;
HTTPS deployments using authentication should keep secure cookies enabled.
This command runs the development server;
use the normal deployment instructions for a permanent installation.

iPhone Safari
-------------

* HTTP network addresses cannot use Safari's asynchronous Clipboard API. The
  copy button tries traditional copying and, if that fails, selects the complete
  visible URL for manual copying. It does not need a global Promise implementation.
* Keep the page in the foreground until uploads finish. iOS can suspend background
  tabs, so switching apps or locking the phone can interrupt a chunked upload.
  Pause and Resume retain the selected file while the page stays open. Resume
  checks the server's saved position before continuing; a chunk whose response
  was lost does not need to be sent again. Cancel removes an incomplete upload,
  and Retry after cancelling starts a new upload from the beginning.
* The server checks the received file or chunk size against the declared size
  before writing it. Empty or truncated requests cannot be reported as a complete
  nonempty upload; a genuinely empty file is still supported.
* All pages use the same always-visible Upload/List navigation. Buttons and form
  controls have a minimum height of 48 CSS pixels; inputs use at least 16-pixel
  text. Viewport scaling remains enabled, with safe-area padding and fallback
  padding for older browsers. Images and QR codes fit the available width.
* Capable browsers get a compact workspace with File/Text buttons and an
  independently scrolling queue. Text and collection submissions return a
  sharing row in place; viewing the file list does not discard an ongoing upload
  or the text draft. Completed rows align their visible URL, copy, open and
  download actions. File details and name editing open separately from this
  workspace so an upload keeps running.
* File and text submissions still have separate ordinary forms when enhancement
  is unavailable. Retention is a native select, and file management uses regular
  HTML forms. No framework, disclosure menu, or JavaScript is required for the
  ordinary upload/download path.
* Video previews use ``playsinline``. PDFs open through a normal link, leaving
  rendering to the device's PDF viewer rather than an embedded frame.

Resume applies to the enhanced browser uploader within the same open page.
Refreshing, closing the page, or iOS discarding the tab loses access to the
selected File object. Ordinary form uploads and the CLI do not gain resumability
from this feature. No background transfer or automatic retry is promised.

The server only acknowledges complete, sequential chunks. A chunk interrupted
before acknowledgement is sent again from the confirmed position. Upload status,
chunk commits and cancellation use process locks on the filesystem storage;
all workers must share a directory on a filesystem supporting these locks.

See WebKit's `Clipboard API explanation
<https://webkit.org/blog/10855/async-clipboard-api/>`_ and
`background-page lifecycle explanation
<https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/>`_.
Safe-area fallbacks follow `WebKit's viewport guidance
<https://webkit.org/blog/7929/designing-websites-for-iphone-x/>`_.

Device verification
-------------------

Responsive Chromium checks and JavaScript unit tests do not replace testing on
an actual iPhone. Record the device and iOS version when checking these flows:

* Select photos and files from Files, including multiple files, Unicode filenames
  and an empty file. Verify the downloaded bytes and names.
* Upload a large file, pause and resume it, interrupt Wi-Fi and resume, then
  cancel and retry. Check that resume keeps the same sharing item and continues
  at the saved position, and that success means the full file arrived.
* Switch apps or lock the phone during upload, then return and inspect its status.
* Copy a share link and paste it into another app. If copying is unavailable,
  verify that the selected URL can be copied manually without losing characters.
* Preview text, images, audio and video, and test portrait and landscape layouts.
* Check Upload, List, file details, metadata editing, QR, image collection, link
  redirects and missing-file pages at narrow widths and with the keyboard open.
* Open an uploaded file and its download link from another device on the network;
  all generated share links should use the address used to access the server.
