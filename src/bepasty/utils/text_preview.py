"""Bounded UTF-8 snippets and escaped HTTP links for text files."""
import re
from markupsafe import Markup, escape

_LINK = re.compile(r'https?://[^\s<>"\']+')


def is_txt(meta):
    return meta.get('filename', '').lower().endswith('.txt') or meta.get('type') == 'text/plain'


def linked_text(text):
    parts = []
    start = 0
    for match in _LINK.finditer(text):
        url = match.group().rstrip('.,;!?，。；！？”）')
        end = match.start() + len(url)
        parts.extend((escape(text[start:match.start()]),
                      Markup('<a href="{}" target="_blank" rel="noopener noreferrer">{}</a>').format(url, url)))
        start = end
    parts.append(escape(text[start:]))
    return Markup('').join(parts)


def text_head(item):
    # Bound I/O even when a file has a huge first line; never read the whole file.
    raw = item.data.read(min(item.data.size, 16384), 0)
    text = raw.decode('utf-8-sig', errors='replace')
    lines = text.splitlines()[:3]
    return linked_text('\n'.join(line[:500] for line in lines))
