"""Batch 25 browser regression: localhost only; every API and external asset is intercepted."""
import argparse
import copy
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def reader_index(title, local=False):
    version = 'a' * 40 if local else hashlib.sha1((title + ':v1').encode()).hexdigest()
    result = {
        'taskId': 7 if local else None, 'title': title, 'author': '测试作者', 'version': version,
        'totalBytes': 300 if local else 0,
        'chapters': [{'index': i, 'title': label, 'startByte': i * 100 if local else 0,
                      'endByte': (i + 1) * 100 if local else 0, 'partCount': 1}
                     for i, label in enumerate(['第一章 初见', '第二章 远行', '第三章 归来'])],
    }
    if not local:
        result['source'] = {'id': hashlib.sha1(title.encode()).hexdigest(), 'name': '演示书源',
                            'url': 'https://book15.net/books/details42.html', 'session': version}
    return result


def verify(browser, base, viewport, output):
    from playwright.sync_api import expect
    expect.set_options(timeout=30000)
    context = browser.new_context(viewport=viewport)
    page = context.new_page()
    page.set_default_timeout(30000)
    calls, errors, unexpected, dialogs, checks = [], [], [], [], []
    state = {'dialog': 'accept', 'profile_fail': False, 'feedback_mode': 'ok'}
    profile = {'seeds': [{'title': name, 'kind': 'love'} for name in ['保留甲', '减少乙', '保留丙']],
               'content': '喜欢严谨设定与细腻人物。', 'updatedAt': 'v1'}
    feedback = {'在线书': {'version': 4, 'status': 'want', 'note': '旧反馈：节奏值得期待'},
                '候选直读书': {'version': 9, 'status': 'want', 'note': '历史原因不能被清空'}}
    books = [{'id': i, 'title': title, 'author': '测试作者', 'category': '奇幻', 'primaryGenre': '奇幻',
              'quality': 8.5, 'finishStatus': '完结', 'charsLabeled': 12000, 'labels': {},
              'genre': '奇幻', 'intro': '这是一条本地验证用的书籍简介。', 'labeledAt': '2026-09-16T00:00:00Z',
              'readTaskId': 7 if i == 1 else None} for i, title in enumerate(['本地书', '在线书', '无源书'], 1)]
    candidate = {'title': '候选直读书', 'author': '测试作者', 'category': '奇幻', 'wordCount': '待核验', 'why': '模型推荐理由', 'source': 'llm'}
    evidence = {'status': 'matched', 'sourceName': '演示书源', 'url': 'https://book15.net/books/details42.html',
                'checkedAt': '2026-09-16T00:00:00Z', 'note': '仅提供匹配目录，不代表豆瓣收录、评分或全书可用。'}
    verified = {**candidate, 'douban': {'status': 'not_found', 'found': False}, 'sourceEvidence': evidence}
    sessions = {}
    origin = urlparse(base)
    page.on('pageerror', lambda error: errors.append(str(error)))

    def dialog_handler(dialog):
        dialogs.append(dialog.message)
        dialog.accept() if state['dialog'] == 'accept' else dialog.dismiss()
    page.on('dialog', dialog_handler)

    def respond(route, value, status=200):
        route.fulfill(status=status, content_type='application/json', body=json.dumps(value, ensure_ascii=False))

    def sse(route, events):
        route.fulfill(status=200, content_type='text/event-stream', body=''.join(
            'data: ' + json.dumps(event, ensure_ascii=False) + '\n\n' for event in events))

    def intercept(route):
        req = route.request
        url = urlparse(req.url)
        query = parse_qs(url.query)
        if (url.scheme, url.netloc) != (origin.scheme, origin.netloc):
            if req.resource_type == 'stylesheet':
                route.fulfill(status=200, content_type='text/css', body='/* local fallback font */')
            else:
                unexpected.append(req.url)
                route.abort()
            return
        if not url.path.startswith('/api/'):
            route.continue_()
            return
        payload = req.post_data_json if req.method == 'POST' or req.method == 'PUT' else None
        calls.append({'method': req.method, 'path': url.path, 'body': payload, 'query': query})
        if url.path == '/api/owner':
            respond(route, {'ok': True})
        elif url.path == '/api/library':
            term = query.get('q', [''])[0]
            selected = [book for book in books if not term or term in book['title']]
            respond(route, {'books': selected, 'total': len(selected), 'page': 1, 'pageSize': 30, 'maxPage': 10000,
                            'facets': {'categories': [{'name': '奇幻', 'count': 3}], 'finishStates': [{'name': '完结', 'count': 3}]}})
        elif url.path == '/api/download' and req.method == 'GET':
            respond(route, {'tasks': []})
        elif url.path == '/api/recommendations':
            note = feedback['在线书']
            respond(route, {'recommendations': [{'id': 12, 'query': '书库添加', 'title': '在线书', 'author': '测试作者',
                      'status': note['status'], 'note': note['note'], 'feedback_id': note['version'], 'meta': {},
                      'created_at': '2026-09-16T00:00:00Z', 'read_task_id': None}]})
        elif url.path == '/api/profile':
            if req.method == 'GET':
                respond(route, profile)
            elif req.method == 'PUT':
                if state['profile_fail']:
                    respond(route, {'error': '模拟保存失败'}, 500)
                elif payload['updatedAt'] != profile['updatedAt']:
                    respond(route, {'code': 'PROFILE_CONFLICT', 'profile': profile, 'draft': payload}, 409)
                else:
                    profile.update(seeds=payload['seeds'], content=payload.get('content', profile['content']), updatedAt=profile['updatedAt'] + '+')
                    respond(route, {'ok': True, **profile})
            else:
                profile.update(content='重新生成的画像', updatedAt=profile['updatedAt'] + '+')
                sse(route, [{'type': 'done', **profile}])
        elif url.path == '/api/feedback':
            title = payload['title'] if payload else query.get('title', [''])[0]
            note = feedback.setdefault(title, {'version': 0, 'status': None, 'note': ''})
            if req.method == 'GET':
                respond(route, {'current': note})
            elif state['feedback_mode'] == 'fail':
                respond(route, {'error': '模拟反馈失败'}, 500)
            elif state['feedback_mode'] == 'conflict':
                note.update(version=5, note='其他页面新增的完整反馈原因', status='want')
                state['feedback_mode'] = 'ok'
                respond(route, {'code': 'FEEDBACK_CONFLICT', 'current': note}, 409)
            elif payload.get('expectedFeedbackId') != note['version']:
                respond(route, {'code': 'FEEDBACK_CONFLICT', 'current': note}, 409)
            else:
                note.update(version=note['version'] + 1, note=payload['note'], status=payload['status'])
                respond(route, {'ok': True, 'profileUpdated': False})
        elif url.path == '/api/find':
            step = payload['step']
            events = [{'type': 'phase', 'step': step}]
            if step == 'recall':
                events.append({'type': 'result', 'step': step, 'candidates': [candidate]})
            elif step == 'verify':
                events.extend([{'type': 'progress', 'step': step, 'done': 1, 'total': 1, 'provider': 'source', 'sourceDone': 1, 'sourceTotal': 1},
                               {'type': 'result', 'step': step, 'verified': [verified]}])
            else:
                events.append({'type': 'result', 'step': step, 'persisted': True, 'items': [
                    {**verified, 'matchScore': 88, 'hitLikes': ['设定'], 'risks': '模型推断风险', 'reason': '适合尝试'}]})
            sse(route, events)
        elif url.path in ('/api/read/source/index', '/api/read/7/index'):
            local = '/7/' in url.path
            title = '本地书' if local else query.get('title', [''])[0]
            if title == '无源书':
                respond(route, {'error': '没有找到匹配书源，可尝试「下载全书」。', 'code': 'SOURCE_NOT_FOUND'}, 404)
            else:
                index = reader_index(title, local)
                sessions[index['version']] = index
                respond(route, index)
        elif url.path in ('/api/read/source/chapter', '/api/read/7/chapter'):
            index = sessions[query['version'][0]]
            chapter = int(query['chapter'][0])
            respond(route, {'taskId': index['taskId'], 'version': index['version'], 'chapterIndex': chapter,
                    'partIndex': 0, 'partCount': 1, 'title': index['chapters'][chapter]['title'],
                    'startByte': chapter * 100, 'endByte': (chapter + 1) * 100,
                    'text': index['chapters'][chapter]['title'] + '\n' + ('风过书页，故事仍在继续。' * 10 + '\n') * 15,
                    **({'sourceId': index['source']['id'], 'servedFrom': '演示书源'} if 'source' in index else {})})
        else:
            unexpected.append(req.url)
            route.abort()

    context.route('**/*', intercept)
    width = viewport['width']
    def shot(name):
        page.screenshot(path=str(output / f'{name}-{width}.png'), full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), name + ' horizontal overflow'
    def count(path, method):
        return len([call for call in calls if call['path'] == path and call['method'] == method])

    try:
        page.goto(base + '/?tab=library', wait_until='networkidle')
        page.get_by_label('访问口令', exact=True).fill('codex-25-offline-owner')
        page.get_by_role('button', name='提交口令', exact=True).click()
        expect(page.get_by_role('link', name='阅读《在线书》')).to_be_visible()
        expect(page.get_by_role('link', name='阅读《无源书》')).to_be_visible()
        expect(page.get_by_role('link', name='阅读《本地书》')).to_have_attribute('href', '/read/7?from=library')
        assert not any(call['path'].endswith('/availability') for call in calls)
        checks.append('书库所有卡片均有阅读入口，已下载书保持旧链接，不依赖文件探测')
        shot('library')
        page.get_by_role('button', name='查看在线书详情').click()
        expect(page.get_by_role('link', name='阅读《在线书》')).to_be_visible()
        checks.append('无 TXT 的详情页也有阅读入口')

        sentinel = {'schema': 1, 'version': 'a' * 40, 'chapterIndex': 2, 'partIndex': 0, 'ratio': 0, 'updatedAt': 1}
        page.evaluate("value => localStorage.setItem('novel-finder-reading-progress-7', JSON.stringify(value))", sentinel)
        page.get_by_role('link', name='阅读《在线书》').click()
        expect(page.get_by_role('heading', name='第一章 初见', exact=True)).to_be_visible()
        expect(page.get_by_text('测试作者 著 · 书源：演示书源')).to_be_visible()
        assert all(int(call['query']['chapter'][0]) < 2 for call in calls if call['path'] == '/api/read/source/chapter')
        checks.append('同一阅读器打开书源，只加载当前章及最多相邻预读')
        page.get_by_role('button', name='下一章 →', exact=True).click()
        expect(page.get_by_role('heading', name='第二章 远行', exact=True)).to_be_visible()
        source_key = 'novel-finder-reading-progress-source-' + reader_index('在线书')['source']['id']
        page.wait_for_function('key => JSON.parse(localStorage.getItem(key) || "null")?.chapterIndex === 1', arg=source_key)
        page.reload(wait_until='networkidle')
        expect(page.get_by_role('heading', name='第二章 远行', exact=True)).to_be_visible()
        assert page.evaluate("JSON.parse(localStorage.getItem('novel-finder-reading-progress-7'))") == sentinel
        checks.append('书源进度刷新后恢复，不覆盖 TXT 进度')
        shot('source-reader')
        page.get_by_role('link', name='← 返回书库', exact=True).click()
        page.get_by_role('link', name='阅读《本地书》').click()
        expect(page.get_by_role('heading', name='第三章 归来', exact=True)).to_be_visible()
        assert page.evaluate('key => JSON.parse(localStorage.getItem(key)).chapterIndex', source_key) == 1
        checks.append('旧 TXT 进度仍可恢复，且不覆盖书源进度')
        page.get_by_role('link', name='← 返回书库', exact=True).click()
        page.get_by_role('link', name='阅读《无源书》').click()
        expect(page.get_by_role('alert').filter(has_text='没有找到匹配书源')).to_be_visible()
        shot('source-missing')
        page.get_by_role('link', name='去书库下载全书').click()
        expect(page.get_by_label('书库搜索')).to_have_value('无源书')
        checks.append('无匹配源时明确提示错误，下载入口带书名返回书库')

        page.get_by_role('button', name='书架', exact=True).click()
        expect(page.get_by_role('link', name='阅读《在线书》')).to_be_visible()
        checks.append('书架无 TXT 的书也有阅读入口')
        page.get_by_role('button', name='将在线书标记为在读').click()
        note_input = page.get_by_role('textbox', name='补充说明（选填）', exact=True)
        expect(note_input).to_have_value('旧反馈：节奏值得期待')
        draft = '用户正在修改的反馈，补充了更多具体阅读感受。'
        note_input.fill(draft)
        state['feedback_mode'] = 'fail'
        page.get_by_role('button', name='记下反馈', exact=True).click()
        expect(page.get_by_role('alert').filter(has_text='模拟反馈失败')).to_be_visible()
        expect(note_input).to_have_value(draft)
        checks.append('切换书架状态继承旧原因，保存失败保留输入')
        state['feedback_mode'] = 'conflict'
        page.get_by_role('button', name='记下反馈', exact=True).click()
        expect(page.get_by_text('线上最新反馈', exact=True)).to_be_visible()
        expect(note_input).to_have_value(draft)
        expect(page.get_by_role('button', name='记下反馈', exact=True)).to_be_disabled()
        shot('feedback-conflict')
        page.get_by_role('button', name='已对比，保留草稿继续编辑').click()
        page.get_by_role('button', name='记下反馈', exact=True).click()
        expect(page.get_by_role('status').filter(has_text='反馈已记录')).to_be_visible()
        assert feedback['在线书']['note'] == draft
        assert [call for call in calls if call['path'] == '/api/feedback' and call['method'] == 'POST'][-1]['body']['expectedFeedbackId'] == 5
        checks.append('反馈冲突显示线上内容并保留草稿，显式对比后按新版本保存')
        page.get_by_role('button', name='清除在线书的反馈原因，保留阅读状态').click()
        expect(page.get_by_role('textbox', name='补充说明（选填）', exact=True)).to_have_value('')
        before = count('/api/feedback', 'POST')
        state['dialog'] = 'dismiss'
        page.get_by_role('button', name='清除原因', exact=True).click()
        assert count('/api/feedback', 'POST') == before
        state['dialog'] = 'accept'
        page.get_by_role('button', name='清除原因', exact=True).click()
        expect(page.get_by_role('button', name='清除在线书的反馈原因，保留阅读状态')).to_have_count(0)
        assert feedback['在线书']['note'] == ''
        checks.append('反馈清空需要确认，取消不发请求，确认后才清空')

        page.get_by_role('button', name='找书', exact=True).click()
        page.get_by_label('找书需求').fill('找一本适合我的奇幻书')
        page.get_by_role('button', name='找 书', exact=True).click()
        card = page.get_by_role('article').filter(has_text='候选直读书')
        expect(card.get_by_text('书源存在性补验', exact=True)).to_be_visible()
        expect(card.get_by_text('豆瓣未检索到条目，不等于作品不存在。')).to_be_visible()
        expect(card.get_by_text('已找到豆瓣条目', exact=True)).to_have_count(0)
        expect(card.get_by_role('link', name='直接阅读《候选直读书》')).to_be_visible()
        assert [call['body']['step'] for call in calls if call['path'] == '/api/find'] == ['recall', 'verify', 'rerank']
        checks.append('找书保留三步 SSE；豆瓣和书源证据区分展示，候选可直接阅读')
        shot('find-evidence')
        card.get_by_role('button', name='想读', exact=True).click()
        expect(page.get_by_role('textbox', name='补充说明（选填）', exact=True)).to_have_value('历史原因不能被清空')
        page.get_by_role('textbox', name='补充说明（选填）', exact=True).fill('在不同状态间仍保留这份草稿')
        card.get_by_role('button', name='在读', exact=True).click()
        expect(page.get_by_role('textbox', name='补充说明（选填）', exact=True)).to_have_value('在不同状态间仍保留这份草稿')
        checks.append('找书反馈先读线上旧原因，切换状态保留编辑草稿')
        page.get_by_role('button', name='取消', exact=True).click()
        card.get_by_role('link', name='直接阅读《候选直读书》').click()
        expect(page.get_by_role('heading', name='第一章 初见', exact=True)).to_be_visible()
        expect(page.get_by_role('link', name='← 返回找书', exact=True)).to_be_visible()
        checks.append('找书直读不经过下载任务，阅读器可返回找书')

        page.goto(base + '/?tab=profile', wait_until='networkidle')
        page.get_by_role('button', name='编辑书单', exact=True).click()
        page.get_by_role('button', name='删除减少乙', exact=True).click()
        state['dialog'] = 'dismiss'
        before = count('/api/profile', 'PUT')
        page.get_by_role('button', name='保存种子', exact=True).click()
        assert count('/api/profile', 'PUT') == before
        assert '减少乙' in dialogs[-1] and '3 本变为 2 本' in dialogs[-1]
        checks.append('种子减少确认显示书名与数量，取消不提交')
        state['dialog'], state['profile_fail'] = 'accept', True
        page.get_by_role('button', name='保存种子', exact=True).click()
        expect(page.get_by_role('status').filter(has_text='模拟保存失败')).to_be_visible()
        expect(page.get_by_label('书名', exact=True)).to_have_count(2)
        checks.append('画像保存失败保留完整表单草稿')
        state['profile_fail'] = False
        profile['seeds'].append({'title': '远端新增丁', 'kind': 'love'})
        profile['updatedAt'] = 'v2'
        page.get_by_role('button', name='保存种子', exact=True).click()
        expect(page.get_by_role('heading', name='画像有新版本')).to_be_visible()
        expect(page.get_by_label('书名', exact=True)).to_have_count(2)
        expect(page.get_by_label('服务器最新内容')).to_contain_text('远端新增丁')
        shot('profile-conflict')
        page.get_by_role('button', name='以当前草稿重新保存').click()
        expect(page.get_by_role('heading', name='画像有新版本')).to_have_count(0)
        assert '远端新增丁' in dialogs[-1] and '减少乙' in dialogs[-1]
        checks.append('画像版本冲突保留草稿，合并保存按线上最新书单再次确认减少项')
        page.get_by_role('button', name='编辑书单', exact=True).click()
        page.get_by_role('button', name='删除保留丙', exact=True).click()
        state['dialog'] = 'dismiss'
        before = count('/api/profile', 'PUT')
        page.get_by_role('button', name='生成画像', exact=True).click()
        assert count('/api/profile', 'PUT') == before
        state['dialog'], state['profile_fail'] = 'accept', True
        page.get_by_role('button', name='生成画像', exact=True).click()
        expect(page.get_by_role('status').filter(has_text='模拟保存失败')).to_be_visible()
        assert count('/api/profile', 'POST') == 0
        page.get_by_role('button', name='找书', exact=True).click()
        page.get_by_role('button', name='画像', exact=True).click()
        expect(page.get_by_label('书名', exact=True)).to_have_count(1)
        expect(page.get_by_label('书名', exact=True)).to_have_value('保留甲')
        checks.append('生成前保存同样需要确认；保存失败不调用模型，切换标签仍保留草稿')
        shot('profile-failed-draft')
        assert not errors, errors
        assert not unexpected, unexpected
        checks.append('桌面/手机布局无水平溢出，无运行时异常或未拦截 API/外部请求')
        return {'viewport': viewport, 'passed': len(checks), 'checks': checks, 'apiCalls': calls,
                'dialogs': dialogs, 'pageErrors': errors, 'unexpectedRequests': unexpected}
    except Exception:
        page.screenshot(path=str(output / f'failure-{width}.png'), full_page=True)
        (output / f'failure-{width}.json').write_text(json.dumps({'calls': calls, 'errors': errors, 'unexpected': unexpected}, ensure_ascii=False, indent=2), encoding='utf-8')
        raise
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='http://127.0.0.1:3125')
    parser.add_argument('--out', required=True)
    parser.add_argument('--playwright-path')
    args = parser.parse_args()
    if args.playwright_path:
        sys.path.insert(0, args.playwright_path)
    from playwright.sync_api import sync_playwright
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    parsed = urlparse(args.base_url)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.password:
        raise ValueError('Only a local mock server is allowed')
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='chrome', headless=True, args=['--disable-background-networking', '--disable-component-update', '--disable-sync'])
        try:
            runs = [verify(browser, args.base_url, copy.deepcopy(viewport), output) for viewport in
                    ({'width': 1280, 'height': 900}, {'width': 375, 'height': 812})]
            result = {'browser': browser.version, 'passed': sum(run['passed'] for run in runs), 'runs': runs}
            (output / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({'passed': result['passed'], 'runs': [{'viewport': run['viewport'], 'passed': run['passed']} for run in runs]}, ensure_ascii=False))
        finally:
            browser.close()


if __name__ == '__main__':
    main()
