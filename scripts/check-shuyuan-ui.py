"""G1：使用已安装的 Playwright，对本地 dev 页面拦截全部 API 和外部请求。"""
import argparse
import copy
import importlib.metadata
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

def source_fixture():
    return {
        "total": 4, "enabled": 2, "disabled": 2, "active": 1,
        "unprobed": 1, "pending": 1, "reachable": 1, "failed": 1,
        "collections": [{"id": 11, "title": "离线验证合集", "count": 4}],
        "refreshedAt": "2026-09-16T00:00:00Z", "sourcesLimit": 100,
        "sources": [
            {"url": "https://unknown.invalid", "name": "未知失效源", "disabled": True,
             "availability": "unprobed", "lastError": "历史连接超时", "checkedAt": None, "probeError": None},
            {"url": "https://changed.invalid", "name": "规则变化源", "disabled": True,
             "availability": "pending", "lastError": "历史规则失效", "checkedAt": None, "probeError": None},
            {"url": "https://book15.net/ok", "name": "已探测来源", "disabled": False,
             "availability": "reachable", "lastError": "", "checkedAt": "2026-09-16T00:00:00Z", "probeError": None},
            {"url": "https://book15.net/fail", "name": "探测失败源", "disabled": False,
             "availability": "failed", "lastError": "历史请求失败", "checkedAt": "2026-09-16T00:00:00Z",
             "probeError": "离线夹具 HTTP 503"},
        ],
    }


def stats_fixture(sources):
    zero = {"prompt": 0, "completion": 0, "total": 0, "cache": 0, "calls": 0, "missingUsageCalls": 0}
    return {
        "library": {"total": 0, "withQuality": 0, "avgQuality": None, "charsLabeled": 0, "genres": []},
        "download": {"total": 0, "done": 0, "chapters": 0, "chars": 0},
        "find": {"queries": 0, "recommendations": 0}, "shelf": {"statuses": []},
        "shuyuan": {key: sources[key] for key in (
            "total", "enabled", "disabled", "active", "unprobed", "pending", "reachable", "failed")},
        "tokens": {"total": zero, "last24h": zero,
                   "byPhase": [{"phase": phase, **zero} for phase in ("find_recall", "find_rerank", "profile", "feedback")]},
        "availability": {key: True for key in ("library", "download", "find", "shelf", "shuyuan", "tokens")},
    }


def verify(browser, base_url, viewport, output):
    from playwright.sync_api import expect

    context = browser.new_context(viewport=viewport)
    page = context.new_page()
    page.set_default_timeout(30000)
    state = source_fixture()
    api_calls, blocked, errors, checks, asset_fixtures = [], [], [], [], []
    refreshes = 0
    origin = urlparse(base_url)
    page.on("pageerror", lambda error: errors.append(str(error)))

    def respond(route, payload, status=200):
        route.fulfill(status=status, content_type="application/json",
                      body=json.dumps(payload, ensure_ascii=False))

    def intercept(route):
        nonlocal refreshes
        request = route.request
        parsed = urlparse(request.url)
        if request.url == "https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/style.css":
            asset_fixtures.append(request.url)
            route.fulfill(status=200, content_type="text/css", body="/* G1 离线验证使用本机备用字体。 */")
            return
        if (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc):
            blocked.append(request.url)
            route.abort()
            return
        if not parsed.path.startswith("/api/"):
            route.continue_()
            return
        api_calls.append({"method": request.method, "path": parsed.path})
        if parsed.path == "/api/owner" and request.method == "GET":
            respond(route, {"ok": True})
        elif parsed.path == "/api/shuyuan" and request.method == "GET":
            respond(route, state)
        elif parsed.path == "/api/shuyuan" and request.method == "POST":
            assert request.post_data_json == {"action": "refresh"}
            refreshes += 1
            if refreshes == 1:
                state["sources"][0]["availability"] = "pending"
                state["unprobed"], state["pending"] = 0, 2
                state["refreshedAt"] = "2026-09-16T00:01:00Z"
                respond(route, state)
            else:
                respond(route, {"error": "受控合集刷新失败，保留既有数据"}, 502)
        elif parsed.path == "/api/stats" and request.method == "GET":
            respond(route, stats_fixture(state))
        else:
            blocked.append(request.url)
            route.abort()

    context.route("**/*", intercept)
    width = viewport["width"]
    try:
        page.goto(base_url + "/?tab=shuyuan", wait_until="networkidle")
        expect(page.get_by_text("请先输入并提交访问口令，继续使用书径。", exact=True)).to_be_visible()
        assert not api_calls
        checks.append("未登录时不请求私有接口")

        page.get_by_label("访问口令", exact=True).focus()
        page.keyboard.type("task24-offline-owner")
        page.keyboard.press("Tab")
        expect(page.get_by_role("button", name="提交口令", exact=True)).to_be_focused()
        page.keyboard.press("Enter")
        panel = page.get_by_role("region", name="书源状态明细")
        expect(panel).to_be_visible()
        unknown = panel.get_by_role("listitem").filter(has_text="未知失效源")
        expect(unknown).to_contain_text("未探测")
        expect(unknown).to_contain_text("已禁用")
        expect(unknown).to_contain_text("历史连接超时")
        checks.append("键盘提交口令，未知失效源同时显示未探测、禁用和历史失败")

        expect(panel.get_by_role("listitem").filter(has_text="规则变化源")).to_contain_text("待核验")
        expect(panel.get_by_role("listitem").filter(has_text="探测失败源")).to_contain_text("最近探测失败")
        expect(page.get_by_label("书源状态统计")).to_contain_text("最近探测可达 1")
        checks.append("待核验、探测失败、启用与可达计数分别显示")
        page.screenshot(path=str(output / f"shuyuan-{width}-initial.png"), full_page=True)

        refresh_button = page.get_by_role("button", name="刷新合集", exact=True)
        refresh_button.focus()
        page.keyboard.press("Enter")
        expect(unknown).to_contain_text("待核验")
        expect(unknown).not_to_contain_text("最近探测可达")
        expect(unknown).to_contain_text("已禁用")
        expect(unknown).to_contain_text("历史连接超时")
        checks.append("键盘刷新后规则变化只进入待核验，保留禁用和失败信息")

        before_failure = panel.inner_text()
        refresh_button.focus()
        page.keyboard.press("Enter")
        expect(page.get_by_role("alert").filter(has_text="受控合集刷新失败")).to_be_visible()
        assert panel.inner_text() == before_failure
        assert refreshes == 2
        checks.append("刷新失败显示错误，旧明细和状态原样保留")
        page.screenshot(path=str(output / f"shuyuan-{width}-failed-refresh.png"), full_page=True)

        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        checks.append("书源页面没有水平溢出")
        page.get_by_role("button", name="统计", exact=True).focus()
        page.keyboard.press("Enter")
        # 统计页书源一笔账：task-24 口径（enabled/reachable 等分列），「另有书源资料」是旧文案。
        expect(page.get_by_text("共享书源资料", exact=False)).to_contain_text("最近探测可达 1 条")
        expect(page.get_by_text("共享书源资料", exact=False)).to_contain_text("启用 2 条")
        expect(page.get_by_text("共享书源资料", exact=False)).to_contain_text("待核验 2 条")
        expect(page.get_by_text("共享书源资料", exact=False)).not_to_contain_text("尚未接入找书验证")
        checks.append("键盘切到统计页，未知与待核验来源不显示为可达")
        page.screenshot(path=str(output / f"stats-{width}.png"), full_page=True)
        assert not blocked, blocked
        assert not errors, errors
        checks.append("没有未声明请求或浏览器运行时错误")
        return {"viewport": viewport, "checks": checks, "passed": len(checks),
                "apiCalls": api_calls, "blockedRequests": blocked, "pageErrors": errors,
                "assetFixtures": asset_fixtures,
                "finalSourceCounts": stats_fixture(state)["shuyuan"]}
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:3124")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "build/task24-verification/g1"))
    parser.add_argument("--playwright-path", help="可选：验证工具在当前 worktree 内的安装目录")
    args = parser.parse_args()
    if args.playwright_path:
        sys.path.insert(0, str(Path(args.playwright_path).resolve()))
    from playwright.sync_api import sync_playwright

    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parsed = urlparse(args.base_url)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost") or parsed.username or parsed.password:
        raise ValueError("只允许访问本地受控 dev 服务器")
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True,
            args=["--disable-background-networking", "--disable-component-update", "--disable-sync"])
        try:
            result = {"browser": "Chromium / installed Chrome", "browserVersion": browser.version,
                      "playwrightVersion": importlib.metadata.version("playwright"),
                      "baseUrl": args.base_url, "runs": []}
            for viewport in ({"width": 1280, "height": 900}, {"width": 375, "height": 812}):
                result["runs"].append(verify(browser, args.base_url, copy.deepcopy(viewport), output))
            result["passed"] = sum(run["passed"] for run in result["runs"])
            (output / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(result, ensure_ascii=False, indent=2))
        finally:
            browser.close()


if __name__ == "__main__":
    main()
