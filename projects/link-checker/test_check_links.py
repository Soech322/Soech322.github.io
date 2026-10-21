import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from check_links import crawl

class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', 'https://example.com/external')
            self.end_headers()
            return
        self.send_response(404 if self.path == '/missing' else 200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        if self.path == '/':
            self.wfile.write(b'<a href="/ok">ok</a><a href="/missing">bad</a><a href="/ok#part">duplicate</a><a href="mailto:x@example.com">email</a><a href="https://example.com/">external</a><a href="/redirect">redirect</a>')
        elif self.path == '/ok':
            self.wfile.write(b'<a href="/">home</a>')
    def log_message(self, *args):
        pass

class CrawlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = 'http://127.0.0.1:' + str(cls.server.server_port) + '/'
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
    def test_statuses_scope_and_deduplication(self):
        report = crawl(self.url)
        self.assertEqual([r['status'] for r in report['results']], [200, 200, 404, 302])
        self.assertTrue(all(r['url'].startswith(self.url) for r in report['results']))
        self.assertEqual(report['results'][2]['source'], self.url)
        self.assertEqual(report['results'][3]['error'], 'External redirect skipped')
    def test_page_limit(self):
        report = crawl(self.url, max_pages=2)
        self.assertEqual(report['checked'], 2)
        self.assertTrue(report['limit_reached'])
    def test_bad_input(self):
        for value in ['file:///tmp/test', 'https://user:pass@example.com', 'not-a-url']:
            with self.assertRaises(ValueError):
                crawl(value)
        with self.assertRaises(ValueError):
            crawl(self.url, max_pages=0)

if __name__ == '__main__':
    unittest.main()
