bepasty
=======

bepasty is like a pastebin for all kinds of files (text, image, audio, video,
documents, ..., binary).

Trusted-network fork
--------------------

This fork adds a Chinese-language workspace, resumable browser uploads,
Unicode filenames, document previews, optional local automatic titles and
browser-side password encryption. Fork-specific documentation is in
``docs/source/``; upstream hosted documentation does not describe these changes.

.. warning::

   Defaults differ from upstream: ``PASSWORDLESS = True`` grants every visitor
   all permissions (including reading locked items, modifying and deleting),
   the development server listens on all IPv4 interfaces, and
   ``MAX_ALLOWED_FILE_SIZE = None`` removes the application file-size limit.
   Use only on a trusted, access-controlled network. Do not expose these defaults
   directly to the public Internet. For password-based access set
   ``PASSWORDLESS = False``, a strong ``SECRET_KEY`` and explicit ``PERMISSIONS``;
   also configure storage/request limits and appropriate network protection.
   Encrypted shares protect content, not availability: other authorized visitors
   can still delete ciphertext. Encryption is not a substitute for access control.

Install dependencies into a virtual environment before running ``bash command.txt``.
The launcher uses ``python3`` or the interpreter selected by ``PYTHON``; set
``BEPASTY_CONFIG`` to your configuration file. It does not start a production WSGI
server. Browser encryption requires HTTPS or localhost. Large encrypted downloads
use Service Workers and still require device/browser-specific verification.

Upstream documentation:
https://bepasty-server.readthedocs.org/en/latest/

Features
--------

* Generic:

  - you can upload multiple files at once, simply by drag and drop
  - after upload, you get a unique link to a view of each file
  - on that view, we show actions you can do with the file, metadata of the
    file and, if possible, we also render the file contents
  - if you uploaded multiple files, you can create a pastebin with the list
    of all these files - with a single click!
  - Set an expiration date for your files

* Text files:

  - we highlight all text file types supported by pygments (a lot!)
  - we display line numbers
  - we link from line numbers to their anchors, so you can easily get a link
    to a specific line

* Image files:

  - we show the image (format support depends on browser)
  - for image list items, we can show a slide show ("carousel" view)
  - in the items list, a thumbnail of images is shown

* Audio and video files:

  - we show the html5 player for it (format support depends on browser)

* asciinema recordings:

  - we show the asciinema player for .cast files

* URLs:

  - we support linking to / redirecting to external URLs, you can use
    this as a link shortener (avoiding privacy / data protection issues
    that may exist with other link shorteners)

* PDFs:

  - we support rendering PDFs in your browser (if your browser is able to)

* Storage: we use a storage backend api, currently we have backends for:

  - filesystem storage (just use a filesystem directory to store
    <uuid>.meta and <uuid>.data files)
  - currently there are no other storage implementations in master branch
    and releases. The "ceph cluster" storage implementation has issues and
    currently lives in branch "ceph-storage" until these issues are fixed.

* Keeping some control:

  - flexible permissions: read, create, modify, delete, list, admin
  - assign permissions to users of login secrets
  - assign default permissions to not-logged-in users
  - you can purge files from storage by age, inactivity, size, type, ...
  - you can do consistency checks on the storage
