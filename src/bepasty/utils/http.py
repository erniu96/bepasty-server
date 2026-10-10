import collections
import os
import re
import unicodedata
from urllib.parse import quote, urlparse, urljoin

from flask import request, redirect, url_for
from werkzeug.exceptions import BadRequest


_filename_ascii_re = re.compile(r'[a-zA-Z0-9 *+:;.,_-]')


def sanitize_filename(filename):
    """Keep the existing ASCII filename characters and printable Unicode.

    Filenames are labels, never storage paths. Exclude control/format characters,
    Unicode separators and surrogates as well as ASCII path and HTML delimiters.
    """
    return ''.join(char for char in filename
                   if _filename_ascii_re.fullmatch(char) or
                   (ord(char) > 127 and unicodedata.category(char)[0] not in ('C', 'Z') and
                    unicodedata.normalize('NFKC', char) not in ('/', '\\')))


def content_disposition(disposition, filename, fallback_name='download'):
    """Build an ASCII header with a UTF-8 filename for modern clients.

    RFC 6266 recommends putting the ASCII filename first so legacy clients can
    still save the file. Do not pass raw Unicode through WSGI response headers.
    """
    filename = sanitize_filename(filename) or fallback_name
    value = '{}; filename="{}"'
    if filename.isascii():
        return value.format(disposition, filename)

    stem, extension = os.path.splitext(filename)
    stem = sanitize_filename(unicodedata.normalize('NFKD', stem).encode('ascii', 'ignore').decode())
    extension = sanitize_filename(unicodedata.normalize('NFKD', extension).encode('ascii', 'ignore').decode())
    ascii_filename = (stem if stem.strip(' .') else fallback_name) + extension
    # RFC 5987 attr-char, also used by Werkzeug's send_file implementation.
    encoded = quote(filename, safe='!#$&+-.^_`|~')
    return value.format(disposition, ascii_filename) + "; filename*=UTF-8''" + encoded


# Safely and comfortably redirect
# Some code is taken from / inspired by http://flask.pocoo.org/snippets/62/

def is_safe_url(target):
    """
    Check whether the target URL will lead to the same server.
    """
    ref_url = urlparse(request.host_url)
    test_url = urlparse(urljoin(request.host_url, target))
    return test_url.scheme in ('http', 'https') and ref_url.netloc == test_url.netloc


def _redirect_target_url(d, use_referrer, endpoint, **values):
    """
    Return the redirect URL to (in this order):

    - <next> from d
    - referrer (if use_referrer is True)
    - the URL for endpoint/values
    """
    targets = [d.get('next'), request.referrer, url_for(endpoint, **values)]
    if not use_referrer:
        del targets[1]
    for target in targets:
        if target and is_safe_url(target):
            return target


# GET - for the next two helpers, you may want to create URLs with:
# url_for(endpoint, ..., next=something)

def get_redirect_target(endpoint, **values):
    return _redirect_target_url(request.values, False, endpoint, **values)


def get_redirect_target_referrer(endpoint, **values):
    return _redirect_target_url(request.values, True, endpoint, **values)


# POST - for the next two helpers, you may want this in the form:
# <input type="hidden" name="next" value="{{ next or '' }}">

def redirect_next(endpoint, **values):
    return redirect(_redirect_target_url(request.form, False, endpoint, **values))


def redirect_next_referrer(endpoint, **values):
    return redirect(_redirect_target_url(request.form, True, endpoint, **values))


class ContentRange(collections.namedtuple('ContentRange', ('begin', 'end', 'complete'))):
    """
    Work with Content-Range headers.
    """
    __slots__ = ()

    @classmethod
    def parse(cls, content_range):
        """
        Parse the Content-Range header.
        Format: "bytes 0-524287/2000000".
        """
        try:
            range_type, range_count = content_range.split(' ', 1)
        except ValueError:
            raise BadRequest(description='Content-Range header is incorrect')
        # There are no other types than "bytes"
        if range_type != 'bytes':
            raise BadRequest

        try:
            range_count, range_complete = range_count.split('/', 1)
        except ValueError:
            raise BadRequest(description='Content-Range header is incorrect')

        try:
            # For now, */2000000 format is not supported
            range_begin, range_end = range_count.split('-', 1)

            range_begin = int(range_begin)
            range_end = int(range_end)
        except ValueError:
            raise BadRequest(description='Content-Range header has an invalid range')

        # For now, 0-10/* format is not supported
        try:
            range_complete = int(range_complete)
        except ValueError:
            raise BadRequest(description='Content-Range header has an invalid length')

        if range_begin <= range_end < range_complete:
            return ContentRange(range_begin, range_end, range_complete)

        raise BadRequest

    @classmethod
    def from_request(cls):
        """
        Read the Content-Range header from the request and parse it.
        """
        content_range = request.headers.get('Content-Range')
        if content_range is not None:
            return cls.parse(content_range)

    @property
    def is_complete(self):
        return self.complete == self.end + 1

    @property
    def size(self):
        return self.end - self.begin + 1


class DownloadRange(collections.namedtuple('DownloadRange', ('begin', 'end'))):
    """
    Work with Range headers.
    """
    __slots__ = ()

    @classmethod
    def parse(cls, content_range):
        """
        Parse the Range header.
        Format: "bytes=0-524287".
        """
        try:
            range_type, range_count = content_range.split('=', 1)
        except ValueError:
            raise BadRequest(description='Range header is incorrect')
        # There are no other types than "bytes"
        if range_type != 'bytes':
            raise BadRequest(description='Range header is incorrect')

        try:
            range_begin, range_end = range_count.split('-', 1)
        except ValueError:
            raise BadRequest(description='Range header is incorrect')

        try:
            range_begin = int(range_begin)
        except ValueError:
            raise BadRequest(description='Range header has an invalid first')

        if range_end:
            # For now, set of ranges (e.g. 0-1,2-10) is not supported
            try:
                range_end = int(range_end)
            except ValueError:
                raise BadRequest(description='Range header has an invalid last')
        else:
            range_end = -1

        if range_begin <= range_end or range_end == -1:
            return DownloadRange(range_begin, range_end)

        raise BadRequest(description='Range header is incorrect')

    @classmethod
    def from_request(cls):
        """
        Read the Range header from the request and parse it.
        """
        download_range = request.headers.get('Range')
        if download_range is not None:
            return cls.parse(download_range)

    @property
    def size(self):
        return self.end - self.begin + 1
