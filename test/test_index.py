import unittest

from scripts.index_sites import candidate, html_doc


class PublicIndexTests(unittest.TestCase):
    def test_published_article_metadata_math_code_and_original_media(self):
        html = """<html><head><title>算法笔记</title>
        <meta property="article:published_time" content="2026-11-01">
        <meta property="article:tag" content="算法"></head><body>
        <nav><a href="/">首页</a></nav><article class="prose"><p>推导</p>
        <span class="katex"><math><semantics><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span>
        <pre><code>if active:
    print(1)

finish()</code></pre><img src="/plot.png" alt="结果图"></article></body></html>"""
        doc, _ = html_doc("https://blog.hachile.org/posts/example/", html)
        self.assertIn("发布日期  2026-11-01", doc["text"])
        self.assertIn("标签  算法", doc["text"])
        self.assertIn("x^2", doc["text"])
        self.assertIn("if active:\n    print(1)\n\nfinish()", doc["text"])
        self.assertEqual(doc["links"][0], ["结果图", "https://blog.hachile.org/plot.png"])
        self.assertNotIn("首页", doc["text"])

    def test_index_scope_and_equivalent_site_urls(self):
        root = "https://old.hachile.org/"
        self.assertEqual(candidate(root, "http://old.hachile.org/skyblue/#about"), root + "skyblue/")
        for address in ["https://example.com/", root + "auth/callback", root + "p?token=123", root + "a.jpg"]:
            self.assertIsNone(candidate(root, address))
        doc, links = html_doc(root, '<meta name="robots" content="noindex"><p>excluded</p>')
        self.assertIsNone(doc)
        self.assertEqual(links, [])
