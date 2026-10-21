"""Bounded, same-origin HTML link checker using only Python's standard library."""
import argparse
import json
import sys
from collections import deque
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urldefrag, urljoin, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.links.extend(v for k, v in attrs if k == 'href' and v)

def origin(url):
    parsed = urlsplit(url)
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    return parsed.scheme.lower(), (parsed.hostname or '').lower(), port

class SameOriginRedirect(HTTPRedirectHandler):
    def __init__(self, allowed):
        self.allowed = allowed
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if origin(newurl) != self.allowed:
            raise HTTPError(req.full_url, code, 'External redirect skipped', headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def crawl(start, max_pages=25, timeout=5):
    parts = urlsplit(start)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        raise ValueError('Provide an HTTP(S) URL without embedded credentials.')
    if not 1 <= max_pages <= 100 or not 0 < timeout <= 30:
        raise ValueError('max_pages must be 1–100; timeout must be greater than 0 and at most 30 seconds.')
    start = urldefrag(start)[0]
    allowed = origin(start)
    opener = build_opener(SameOriginRedirect(allowed))
    queue, seen, rows = deque([(start, None)]), set(), []
    while queue and len(rows) < max_pages:
        url, source = queue.popleft()
        if url in seen:
            continue
        seen.add(url)
        row = {'url': url, 'source': source, 'status': None, 'error': None}
        try:
            request = Request(url, headers={'User-Agent': 'PortfolioLinkCheck/1.0'})
            with opener.open(request, timeout=timeout) as response:
                row['status'] = response.status
                if response.headers.get_content_type() == 'text/html':
                    body = response.read(1_000_001)
                    if len(body) > 1_000_000:
                        row['error'] = 'HTML body exceeds 1 MB; links not extracted'
                    else:
                        parser = Links()
                        parser.feed(body.decode(response.headers.get_content_charset() or 'utf-8', errors='replace'))
                        for href in parser.links:
                            try:
                                link = urldefrag(urljoin(response.url, href))[0]
                                parsed = urlsplit(link)
                                if parsed.scheme in ('http', 'https') and not parsed.username and not parsed.password and origin(link) == allowed and link not in seen:
                                    if len(queue) < max_pages * 20:
                                        queue.append((link, url))
                            except ValueError:
                                continue
        except HTTPError as exc:
            row['status'], row['error'] = exc.code, str(exc.reason)
            exc.close()
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            row['error'] = str(exc)
        rows.append(row)
    return {'start_url': start, 'checked': len(rows), 'limit_reached': bool(queue), 'results': rows}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('--max-pages', type=int, default=25)
    parser.add_argument('--timeout', type=float, default=5)
    parser.add_argument('--output', default='report.json')
    args = parser.parse_args()
    try:
        report = crawl(args.url, args.max_pages, args.timeout)
    except ValueError as exc:
        parser.error(str(exc))
    with open(args.output, 'w', encoding='utf-8') as target:
        json.dump(report, target, indent=2, ensure_ascii=False)
    for row in report['results']:
        print(row['status'] or 'ERR', row['url'], row['error'] or '')
    print('Checked', report['checked'], 'URL(s). Report:', args.output)
    return 1 if any(row['error'] or not row['status'] or row['status'] >= 400 for row in report['results']) else 0

if __name__ == '__main__':
    sys.exit(main())
