"""Index public pages linked from the Hachile directory into static, per-site volumes."""
import hashlib
import json
import os
import re
import sys
import tempfile
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree

import requests
from bs4 import BeautifulSoup, Comment
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public/data"
CONFIG = json.loads((ROOT / "scripts/sources.json").read_text(encoding="utf-8"))
AGENT = "HachileTerminal"
DIRECTORY = "https://site.hachile.org/"
BLOCKS = "address article aside blockquote br dd details div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tr ul".split()
SKIP_PATH = re.compile(r"/(?:api|auth|oauth|callback|admin|login|logout|dashboard|cdn-cgi|_astro|pagefind)(?:/|$)|/404(?:\.html|/|$)", re.I)


def read_json(path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else default


def save(path, value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False, mode="w", encoding="utf-8", newline="\n") as output:
        output.write(data)
    Path(output.name).replace(path)


def web_url(base, value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        full = urljoin(base, value.strip())
        dest = urlsplit(full)
        if dest.scheme in ("https", "http") and dest.hostname and not dest.username and not dest.password:
            return full
    except ValueError:
        pass
    return None


def site_id(url):
    host = urlsplit(url).hostname or ""
    if host == "hachile.org":
        return "portal"
    if re.fullmatch(r"[a-z0-9-]+\.hachile\.org", host):
        return host.split(".")[0]
    return None


def session():
    client = requests.Session()
    client.headers["User-Agent"] = "HachileTerminal/1.0 (+https://terminal.hachile.org/)"
    retries = Retry(total=2, connect=1, read=1, backoff_factor=0.5, allowed_methods={"GET"},
                    status_forcelist=(429, 500, 502, 503, 504), raise_on_status=False)
    for scheme in ("https://", "http://"):
        client.mount(scheme, HTTPAdapter(max_retries=retries))
    return client


def get(client, url, *, binary=False):
    # Only read the published site being mounted. External destinations stay links.
    for _ in range(6):
        with client.get(url, stream=True, allow_redirects=False, timeout=(5, 18)) as response:
            if response.is_redirect:
                target = web_url(url, response.headers.get("Location"))
                if not target or urlsplit(target).hostname != urlsplit(url).hostname:
                    raise ValueError("跳转到其他站点")
                url = target
                continue
            response.raise_for_status()
            mime = response.headers.get("Content-Type", "").split(";")[0].lower()
            if not binary and mime not in ("text/html", "application/xhtml+xml"):
                return url, mime, b""
            body = bytearray()
            for part in response.iter_content(65536):
                body.extend(part)
                if len(body) > 8_000_000:
                    raise ValueError("单页超过 8 MB")
            return url, mime, bytes(body)
    raise ValueError("重定向次数过多")


def registry(previous):
    try:
        _, _, content = get(session(), DIRECTORY)
        page = BeautifulSoup(content, "html.parser")
        sites = {}
        for item in page.select("#directory a.site-link[href]"):
            url = item["href"]
            ident = site_id(url)
            if not ident or urlsplit(url).path not in ("", "/"):
                continue
            title = item.select_one(".site-name")
            for arrow in title.select("[aria-hidden]"):
                arrow.decompose()
            sites[ident] = dict(id=ident, name=title.get_text(strip=True), url=url,
                                description=item.select_one(".site-description").get_text(" ", strip=True))
        if "blog" not in sites or "home" not in sites:
            raise ValueError("无法识别站点目录")
    except (requests.RequestException, ValueError, AttributeError) as exc:
        if not previous:
            raise
        print("沿用上次站点目录", type(exc).__name__, flush=True)
        sites = {s["id"]: {k: s[k] for k in ("id", "name", "url", "description")} for s in previous}
    for item in CONFIG["extraSites"]:
        sites[item["id"]] = {**sites.get(item["id"], {}), **item}
    return list(sites.values())


def rules_for(client, root):
    url = urljoin(root, "/robots.txt")
    rules = RobotFileParser(url)
    try:
        _, _, body = get(client, url, binary=True)
        rules.parse(body.decode("utf-8-sig", "replace").splitlines())
    except requests.HTTPError as exc:
        if exc.response.status_code not in (404, 410):
            raise
        rules.parse([])
    return rules


def candidate(root, url):
    if urlsplit(url).hostname != urlsplit(root).hostname:
        return None
    parts = urlsplit(url)
    path = unquote(parts.path)
    if parts.query or SKIP_PATH.search(path) or any(s.startswith(".") for s in path.split("/") if s):
        return None
    suffix = Path(path.rstrip("/")).suffix.lower()
    if suffix and suffix not in (".htm", ".html"):
        return None
    origin = urlsplit(root)
    return origin._replace(path=parts.path or "/", query="", fragment="").geturl()


def virtual_path(url):
    parts = urlsplit(url)
    path = unquote(parts.path).strip("/")
    if parts.fragment.startswith("/"):
        path = "/".join(filter(None, (path, unquote(parts.fragment).strip("/"))))
    pieces = [re.sub(r"[\x00-\x1f\\/:*?\"<>|]", "-", p) for p in path.split("/") if p and p not in (".", "..")]
    if pieces and pieces[-1].lower() in ("index.htm", "index.html"):
        pieces.pop()
    if pieces and pieces[-1].lower().endswith((".htm", ".html")):
        pieces[-1] = pieces[-1].rsplit(".", 1)[0]
    return "/".join([*pieces, "index.txt"])


def clean_text(node):
    # Preserve paragraphs, list items, source code lines and table rows.
    for node_ in node.find_all(string=lambda val: isinstance(val, Comment)):
        node_.extract()
    code_blocks = []
    for pre in node.find_all("pre"):
        for br in pre.find_all("br"):
            br.replace_with("\n")
        editor_lines = pre.select(".ec-line")
        value = "\n".join(line.get_text() for line in editor_lines) if editor_lines else pre.get_text()
        marker = "\ue000" + str(len(code_blocks)) + "\ue001"
        code_blocks.append((marker, value.rstrip("\n")))
        pre.replace_with("\n" + marker + "\n")
    for tag in node.find_all(BLOCKS):
        tag.insert_before("\n")
        tag.append("\n")
    for cell in node.find_all(["td", "th"]):
        cell.append("  ")
    for tag in node.find_all(["a", "button", "small", "strong", "span"]):
        tag.insert_before(" ")
        tag.insert_after(" ")
    lines = [re.sub(r"[^\S\n]+", " ", line).strip() for line in node.get_text().splitlines()]
    text = "\n".join(line for line in lines if line)
    for marker, value in code_blocks:
        text = text.replace(marker, value)
    return text


def html_doc(url, html):
    page = BeautifulSoup(html, "html.parser", from_encoding="utf-8" if isinstance(html, bytes) else None)
    meta = page.find("meta", attrs={"name": re.compile("^robots$", re.I)})
    if meta and re.search(r"\b(noindex|none)\b", meta.get("content", ""), re.I):
        return None, []
    title = page.title.get_text(" ", strip=True) if page.title else urlsplit(url).hostname
    if site_id(url) == "sky" and "/en/" in urlsplit(url).path:
        for tag in page.select("[data-en]"):
            tag.string = tag["data-en"]
    base = web_url(url, page.base.get("href")) if page.base else url
    base = base or url
    found = [web_url(base, a.get("href")) for a in page.select("a[href], area[href]")]
    for formula in page.select(".katex"):
        tex = formula.select_one('annotation[encoding="application/x-tex"]')
        if tex:
            formula.replace_with(" " + tex.get_text() + " ")
    for tag in page.select("script, style, template, svg, [aria-hidden=true]"):
        tag.decompose()
    body = page.body or page
    # Blog article bodies retain source text while excluding the repeated sidebar.
    article = body.select_one(".markdown-content, .prose, [itemprop=articleBody]") if site_id(url) == "blog" and "/posts/" in url else None
    content = article or body
    links = {}
    resources = "a[href],area[href],img,source[src],video,audio[src],iframe[src],object[data],button[data-full]"
    for tag in (article.select(resources) if article else []) + body.select(resources):
        attr = (tag.get("href") or tag.get("data-full") or tag.get("data-src") or tag.get("src")
                or tag.get("poster") or tag.get("data"))
        address = web_url(base, attr)
        if not address or attr.startswith("#") and not attr.startswith("#/"):
            continue
        label = tag.get("alt") or tag.get("aria-label") or tag.get("title") or tag.get_text(" ", strip=True)
        links.setdefault(address, label.strip() or unquote(urlsplit(address).path.rsplit("/", 1)[-1]) or address)
    for img in content.select("img[alt]"):
        alt = img.get("alt", "").strip()
        if alt:
            img.replace_with(" [" + alt + "] ")
    for btn in content.select("button[data-copy]"):
        value = btn["data-copy"].strip()
        if value and value not in btn.get_text(" ", strip=True):
            btn.append(" " + value)
    text = clean_text(content)
    if article:
        meta_lines = []
        for key, label in (("article:published_time", "发布日期"), ("article:modified_time", "更新日期"),
                           ("article:author", "作者"), ("article:section", "分类"), ("article:tag", "标签"),
                           ("og:description", "摘要")):
            values = [t["content"].strip() for t in page.find_all("meta", property=key, content=True)]
            if values:
                meta_lines.append(label + "  " + "，".join(dict.fromkeys(values)))
        text = "\n".join([*meta_lines, "", text]).lstrip("\n")
    doc = dict(path=virtual_path(url), title=title, url=url, text=text,
               links=[[label, address] for address, label in links.items()])
    return doc, [address for address in found if address]


def sitemaps(client, root, rules):
    maps = deque(rules.site_maps() or [])
    seen = set()
    while maps:
        url = maps.popleft()
        if url in seen or urlsplit(url).hostname != urlsplit(root).hostname:
            continue
        seen.add(url)
        _, _, xml = get(client, url, binary=True)
        tree = ElementTree.fromstring(xml)
        for loc in tree.findall(".//{*}loc"):
            link = web_url(root, loc.text)
            if not link:
                continue
            if tree.tag.endswith("sitemapindex"):
                maps.append(link)
            else:
                yield link


def render_special(ident, root, client, rules, put):
    """Read the actual gallery DOM and the public hash routes of the Guohao gazetteer."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("TERMINAL_CHROMIUM") or None, headless=True)
        try:
            page = browser.new_page(locale="zh-CN", service_workers="block")
            def route(request_route):
                req = request_route.request
                if (req.method == "GET" and urlsplit(req.url).hostname == urlsplit(root).hostname
                        and req.resource_type in ("document", "script", "xhr", "fetch")
                        and rules.can_fetch(AGENT, req.url)):
                    request_route.continue_()
                else:
                    request_route.abort()
            page.route("**/*", route)
            page.goto(root, wait_until="domcontentloaded", timeout=25000)
            if ident == "gallery":
                page.wait_for_selector("#gallery figure img", state="attached")
                content = page.content()
                put(html_doc(root, content)[0])
                gallery = BeautifulSoup(content, "html.parser")
                for figure in gallery.select("#gallery figure"):
                    img = figure.select_one("img[src]")
                    if not img:
                        continue
                    full = figure.select_one("[data-full]")
                    address = web_url(root, full["data-full"] if full else img["src"])
                    if not address:
                        continue
                    key = virtual_path(address).removesuffix("/index.txt").removeprefix("assets/images/")
                    caption = figure.get_text(" ", strip=True)
                    put(dict(path="images/" + key + ".txt", title=img.get("alt") or caption or key,
                             url=address, text=caption, links=[["原图", address], ["画廊", root]]))
                return
            if ident == "bronymap":
                # Read only the public language module; never request marker or user data.
                page.evaluate("""async () => {
                  const {translate} = await import('/i18n.js');
                  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = translate('en',e.dataset.i18n);
                  document.title = translate('en','documentTitle');
                }""")
                doc = html_doc(root, page.content())[0]
                put({**doc, "path":"en/index.txt"})
                return
            page.wait_for_selector("#app a[href*='entry']", state="attached")
            put(html_doc(root, page.content())[0])
            routes = ["archive", "wild"]
            for name, key, prefix, field in (("data.json","entries","entry","slug"),
                                              ("group-history.json","entries","entry","slug"),
                                              ("events.json","events","event","id")):
                resource = urljoin(root, name)
                if not rules.can_fetch(AGENT, resource):
                    raise ValueError("数据源不允许索引")
                _, _, data = get(client, resource, binary=True)
                routes.extend(prefix + "/" + str(item[field]) for item in json.loads(data)[key])
            for fragment in dict.fromkeys(routes):
                page.evaluate("""fragment => new Promise(resolve => {
                  window.addEventListener('hashchange', () => resolve(), {once:true});
                  location.hash = '/' + fragment;
                })""", fragment)
                put(html_doc(root + "#/" + fragment, page.content())[0])
        finally:
            browser.close()


def error_name(exc):
    if isinstance(exc, requests.HTTPError):
        return "HTTP " + str(exc.response.status_code)
    if isinstance(exc, requests.exceptions.SSLError):
        return "HTTPS 连接失败"
    if isinstance(exc, requests.RequestException):
        return "网络连接失败"
    if type(exc).__module__.startswith("playwright"):
        return "页面动态内容加载失败"
    return str(exc).split("\n")[0][:140] if isinstance(exc, (ValueError, ElementTree.ParseError)) else "内容索引失败"


def collect(site, old_meta, stamp, extra_paths):
    ident, root = site["id"], site["url"]
    dest = DATA / (ident + ".json")
    old_pages = {doc["path"]: doc for doc in read_json(dest, [])}
    pages, issues = {}, {}
    removed, tried = set(), set()
    restricted = False
    rules = None
    def put(doc):
        if doc:
            path = doc["path"]
            if path in pages and pages[path]["url"].rstrip("/") != doc["url"].rstrip("/"):
                if urlsplit(pages[path]["url"])._replace(scheme="") == urlsplit(doc["url"])._replace(scheme=""):
                    return
                if pages[path]["url"].endswith(("index.html","index.htm")) or doc["url"].endswith(("index.html","index.htm")):
                    return
                code = hashlib.sha256(doc["url"].encode()).hexdigest()[:8]
                path = path.removesuffix("index.txt") + code + ".txt"
            pages[path] = {**doc, "path":path}
    if site.get("mode") == "self":
        put(html_doc(root, (ROOT / "public/index.html").read_bytes())[0])
    elif site.get("mode") != "link":
        with session() as client:
            try:
                rules = rules_for(client, root)
                todo = deque([root, *(urljoin(root, p) for p in CONFIG["entryPaths"].get(ident, [])), *sorted(extra_paths)])
                try:
                    todo.extend(sitemaps(client, root, rules))
                except (requests.RequestException, ElementTree.ParseError, ValueError) as exc:
                    issues["sitemap"] = error_name(exc)
                seen = set()
                while todo:
                    address = candidate(root, todo.popleft())
                    if not address or address in seen:
                        continue
                    seen.add(address)
                    tried.add(virtual_path(address))
                    if not rules.can_fetch(AGENT, address):
                        removed.add(virtual_path(address))
                        continue
                    try:
                        final, mime, body = get(client, address)
                        if not body or not rules.can_fetch(AGENT, final):
                            removed.add(virtual_path(address))
                            continue
                        seen.add(final)
                        doc, links = html_doc(final, body)
                        if doc is None:
                            removed.add(virtual_path(address))
                        put(doc)
                        if doc and ident in ("dev", "research") and urlsplit(final).path == "/":
                            projects = BeautifulSoup(body, "html.parser", from_encoding="utf-8")
                            for article in projects.select("article.project, article.project-card"):
                                name = article.select_one("h2,h3")
                                slug = article.get("id") or next((c[6:] for c in article.get("class", []) if c.startswith("theme-")), "")
                                if not slug or not name:
                                    continue
                                original = final + ("#" + article["id"] if article.has_attr("id") else "#projects")
                                item, _ = html_doc(original, str(article))
                                put({**item, "path":"projects/" + slug + "/index.txt", "title":name.get_text(" ", strip=True)})
                            if ident == "dev" and projects.select_one("[data-en]"):
                                for tag in projects.select("[data-en]"):
                                    tag.string = tag["data-en"]
                                for tag in projects.select("[data-en-alt]"):
                                    tag["alt"] = tag["data-en-alt"]
                                english, _ = html_doc(final, str(projects))
                                put({**english, "path":"en/index.txt"})
                        todo.extend(links)
                    except (requests.RequestException, ValueError) as exc:
                        if isinstance(exc, requests.HTTPError) and exc.response.status_code in (401, 403, 404, 410):
                            removed.add(virtual_path(address))
                            if address == root:
                                restricted = True
                                issues[address] = error_name(exc)
                                break
                        else:
                            issues[address] = error_name(exc)
                            if address == root:
                                break
                if ident in ("ghc", "gallery", "bronymap") and rules.can_fetch(AGENT, root) and "index.txt" in pages:
                    render_special(ident, root, client, rules, put)
            except Exception as exc:
                issues[root] = error_name(exc)
                if isinstance(exc, requests.HTTPError) and exc.response.status_code in (401, 403):
                    restricted = True
                if ident in ("ghc", "gallery") and "index.txt" in old_pages:
                    pages["index.txt"] = old_pages["index.txt"]
    if issues and old_pages and not restricted:
        for path, doc in old_pages.items():
            if path not in removed and (rules is None or rules.can_fetch(AGENT, doc["url"])):
                pages.setdefault(path, doc)
    state = "ready"
    if site.get("mode") == "link":
        state = "link"
    elif issues:
        state = ("cached" if pages == old_pages else "partial") if pages else "unavailable"
    elif not pages:
        state = "unavailable"
    site = {**site, "state":state, "count":len(pages), "issues":issues,
            "updated":old_meta.get("updated") if state == "cached" else (stamp if pages else None)}
    save(dest, sorted(pages.values(), key=lambda d: d["path"]))
    print(ident, state, len(pages), str(issues)[:280] if issues else "", flush=True)
    return site, tried


def incoming_links(sites):
    """Discover new mounts and deep links only from links published on other Hachile sites."""
    targets = defaultdict(set)
    for site in sites:
        for doc in read_json(DATA / (site["id"] + ".json"), []):
            for _, address in doc["links"]:
                ident = site_id(address)
                if not ident or ident in (site["id"], "www") or ident.endswith("-api"):
                    continue
                url = candidate(address, address)
                if url:
                    targets[ident].add(url)
    return targets


def main():
    DATA.mkdir(parents=True, exist_ok=True)
    old = read_json(DATA / "catalog.json", {}).get("sites", [])
    previous = {s["id"]: s for s in old}
    sites = {s["id"]:s for s in registry(old)}
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    targets = incoming_links(old)
    volumes, attempted = {}, defaultdict(set)
    pending = set(sites)
    while pending:
        def build(ident):
            site = sites.get(ident) or dict(id=ident, name=ident, url="https://" + ident + ".hachile.org/",
                                            description="站群公开页面中链接的站点。")
            return collect(site, previous.get(ident, {}), stamp, targets[ident])
        with ThreadPoolExecutor(max_workers=6) as pool:
            for ident, (meta, tried) in zip(sorted(pending), pool.map(build, sorted(pending))):
                volumes[ident] = meta
                attempted[ident].update(tried | {virtual_path(u) for u in targets[ident]})
                attempted[ident].add("index.txt")
        targets = incoming_links(volumes.values())
        pending = {ident for ident, urls in targets.items()
                   if ident not in volumes or (volumes[ident]["state"] == "ready" and any(
                       virtual_path(u) not in attempted[ident] for u in urls))}
    volumes = list(volumes.values())
    if not all(next((s["count"] for s in volumes if s["id"] == ident), 0) for ident in ("home", "blog", "site")):
        sys.exit("缺少主要站点，保留上一次部署。")
    save(DATA / "catalog.json", {"schema":1, "updated":stamp, "sites":sorted(volumes, key=lambda s:s["id"])})
    print("公开页面", sum(s["count"] for s in volumes), flush=True)


if __name__ == "__main__":
    main()
