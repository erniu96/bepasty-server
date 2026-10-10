Quickstart
==========

Installing Bepasty
------------------

You can install Bepasty either from PyPI (latest release) or from the Git repository (latest available code).

::

    # from PyPI:
    pip install bepasty

    # if you'd like to have python-magic help determine files' MIME types, use:
    pip install bepasty[magic]

    # from Git repository
    pip install -e git+https://github.com/bepasty/bepasty-server.git#egg=bepasty-server

Configuring Bepasty
-------------------
Bepasty defaults to ``PASSWORDLESS = True`` for a trusted local network. Everyone
who can reach the service can upload, list, read, rename and delete files, including
previously locked files. No password, login cookie or ``SECRET_KEY`` is required.
Older CLI credentials and browser sessions do not limit access in this mode.

Choose a persistent storage directory before starting the service. To use the
optional password-based permissions instead, explicitly set ``PASSWORDLESS = False``
and configure ``SECRET_KEY``, ``PERMISSIONS`` and ``DEFAULT_PERMISSIONS``.

Here is the documentation straight from its config:

.. autoclass:: bepasty.config.Config
   :members:


To create a local and non-default configuration, copy ``bepasty/config.py`` to e.g. ``/srv/bepasty/bepasty.conf``
first, remove the ``class Config`` and remove all indents in the file.
The comments can be removed too, if you feel the need to.
Finally, modify these configuration variables:

::

    # Note: no Config class required, just simple KEY = value lines:
    PASSWORDLESS = True
    STORAGE = 'filesystem'
    STORAGE_FILESYSTEM_DIRECTORY = '/srv/bepasty/storage/'
    # ...


Important notes:

* if you copied the file from the ``bepasty/config.py`` it will have
  a "class Config" in it and all the settings are inside that class. This is
  **not** what you need. Due to how flask config files work, you need to
  remove the class statement and outdent all the settings, so you just have
  global KEY = VALUE statements left on the top level of the config file.
* Passwordless mode works over local HTTP without session-cookie configuration.
  If you enable password-based login over HTTP, set ``SESSION_COOKIE_SECURE = False``
  so the browser can send its login cookie.


Starting the Bepasty server
-----------------------

You can run the bepasty server with your local configuration by pointing to it via the BEPASTY_CONFIG
environment variable like this:

::

    BEPASTY_CONFIG=/srv/bepasty/bepasty.conf bepasty-server

Important note:

* Use an absolute path as value for BEPASTY_CONFIG.


The built-in WSGI server is recommended only for development and non-production use.

For production, you should use a WSGI server like Gunicorn, Apache + mod_wsgi, Nginx + uWSGI, etc.

::

    gunicorn bepasty.wsgi


Invoking CLI commands
---------------------

All Bepasty commands expect either a --config <configfilename> argument or that the BEPASTY_CONFIG environment
variable points to your configuration file.

The "object" command operates on objects stored in the storage. You can get infos about them ("info" subcommand),
you can set some flags on them ("set"), you can remove all or some ("purge"), you can check the consistency
("consistency"), etc...

To get help about the object command, use:

::

    bepasty-object --help


To get help about the object purge subcommand, use:

::

    bepasty-object purge --help


To run the object purge subcommand (here: dry-run == do not remove anything, files >= 10MiB AND age >= 14 days),
use something like:

::

    bepasty-object purge --dry-run --size 10 --age 14 '*'


If you upgraded bepasty, you might need to upgrade the stored metadata to the current bepasty metadata schema:

::

    bepasty-object migrate '*'


Note: the '*' needs to be quoted with single-quotes so the shell does not expand it. it tells the command to operate
on all names in the storage (you could also give some specific names instead of '*').
