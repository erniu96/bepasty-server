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


_DARK = '#171e27', '#dbe3ee', '#7fb0f5'  # site --surface / --text / --link (dark)
_DOC_CSS = (
    ':root{color-scheme:light dark}'
    'body{margin:0 auto;padding:12px 16px;max-width:860px;font:16px/1.65 -apple-system,'
    'BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",sans-serif;overflow-wrap:anywhere}'
    'img,video{max-width:100%;height:auto}pre{overflow:auto;padding:10px;background:rgba(127,127,127,.12);'
    'border-radius:6px}code{font-family:ui-monospace,Menlo,monospace;font-size:.9em}'
    'table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid rgba(127,127,127,.4);'
    'padding:4px 8px}blockquote{margin:0;padding-left:12px;border-left:4px solid rgba(127,127,127,.4);color:GrayText}'
    + '@media (prefers-color-scheme:dark){html{background:%s;color:%s}a{color:%s}}' % _DARK
)
# Zero-specificity defaults for unstyled HTML; the page's own CSS still wins.
_HTML_CSS = ('<style>:root{color-scheme:light dark}@media (prefers-color-scheme:dark)'
             '{:where(html){background:%s;color:%s}:where(a){color:%s}}</style>' % _DARK)

# Declared code types (text/x-python, ...) keep highlighting; only generic text is sniffed.
_SNIFF_TYPES = {'text/plain', 'text/markdown', 'text/x-markdown', 'text/html', 'application/xhtml+xml',
                'application/octet-stream', ''}
_HTML_DOC = re.compile(r'\A\s*(<!--.*?-->\s*)*<(!doctype\s+html|html[\s>])', re.I | re.S)
_HTML_TAG = re.compile(r'<(p|div|span|a|img|h[1-6]|ul|ol|li|table|tr|td|br|hr|b|i|strong|em|pre|code|'
                       r'body|head|style|section|article|blockquote|figure|form|input|button|svg)[\s>/]', re.I)
_MD_RULES = [re.compile(r, re.M) for r in (
    r'^#{1,6} \S',                      # heading
    r'^\s{0,3}([-*+]|\d{1,3}[.)]) \S',   # list
    r'^```|^~~~',                        # fenced code
    r'^> ',                              # quote
    r'^\|?.*\|.*\n\|?\s*:?-{3,}',       # table
    r'\[[^\]\n]+\]\([^)\s]+\)',          # link
    r'\*\*[^*\n]+\*\*|__[^_\n]+__',       # bold
    r'^(---|\*\*\*)\s*$',               # rule
)]


def doc_kind(meta, text):
    """Return 'markdown', 'html' or None, judged by content rather than filename."""
    ct = meta.get('type', '').split(';')[0].strip().lower()
    if ct not in _SNIFF_TYPES:
        return None
    head = text[:65536]
    if _HTML_DOC.match(head):
        return 'html'
    # Markdown may embed HTML (README badges), so check it before loose tag counting.
    if sum(1 for r in _MD_RULES if r.search(head)) >= 2:
        return 'markdown'
    tags = len(_HTML_TAG.findall(head))
    if tags >= 3 or (tags and head.lstrip().startswith('<') and '</' in head):
        return 'html'
    return None


def rendered_doc(text, kind):
    """Full HTML document for a sandboxed iframe (scripts never run there)."""
    if kind == 'html':
        if re.search(r'background|color-scheme', text, re.I):
            return text  # page styles itself
        m = re.match(r'\s*<!doctype[^>]*>', text, re.I)
        at = m.end() if m else 0
        return text[:at] + _HTML_CSS + text[at:]
    import markdown
    body = markdown.markdown(text, extensions=['extra', 'sane_lists'])
    return ('<!doctype html><html><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<base target="_blank"><style>' + _DOC_CSS + '</style></head><body>' + body + '</body></html>')
