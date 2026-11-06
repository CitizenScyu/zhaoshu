import base64, glob, json, os, re, subprocess, sys, time, unicodedata, urllib.request

OUT = os.path.expanduser('~/.local/share/com.pofl.fanqienoveldownloader/downloads/FanqieNovels')
EK = 'element-6066-11e4-a52e-4f735466cecf'
FORCE = '--force' in sys.argv
IDS = [a for a in sys.argv[1:] if re.fullmatch(r'\d{15,20}', a)]
PER_BOOK = int(os.environ.get('FQ_PER_BOOK_SEC', '1500'))
STALL = int(os.environ.get('FQ_STALL_SEC', '300'))
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, file=sys.stderr, flush=True)


def call(m, p, b=None, t=60):
    d = json.dumps(b).encode() if b is not None else None
    r = urllib.request.Request('http://127.0.0.1:4455' + p, data=d, method=m, headers={'Content-Type': 'application/json'})
    return json.loads(op.open(r, timeout=t).read() or b'{}')


def book_files():
    m = {}
    for f in glob.glob(OUT + '/*.txt'):
        try:
            head = open(f, encoding='utf-8', errors='replace').read(600)
        except OSError:
            continue
        g = re.search(r'书籍 ?ID[:：]\s*(\d+)', head)
        if g:
            m[g.group(1)] = f
    return m


CN_DIGIT = dict(zip('零〇一二两三四五六七八九', (0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9)))
CN_UNIT = {'十': 10, '百': 100, '千': 1000}


def cn_num(s):
    if not re.search('[十百千万]', s):
        return int(''.join(str(CN_DIGIT[c]) for c in s))
    total = section = digit = 0
    for c in s:
        if c in CN_DIGIT:
            digit = CN_DIGIT[c]
        elif c == '万':
            total, section, digit = total + (section + digit) * 10000, 0, 0
        else:
            section, digit = section + (digit or 1) * CN_UNIT[c], 0
    return total + section + digit


def title_key(s):
    # the app writes 第一章 as 第1章 (and may change the separator), so compare chapter numbers as digits, sans punctuation
    s = re.sub('第([零〇一二两三四五六七八九十百千万]+)(?=[章节回卷集话部篇])', lambda m: '第%d' % cn_num(m.group(1)),
               unicodedata.normalize('NFKC', s))
    return re.sub(r'[\W_]+', '', s.lower())


def toc_check(bid, path):
    req = urllib.request.Request('https://fanqienovel.com/api/reader/directory/detail?bookId=' + bid,
                                 headers={'Referer': 'https://fanqienovel.com/', 'User-Agent': 'Mozilla/5.0'})
    d = json.load(op.open(req, timeout=30))
    data = d.get('data') or {}
    titles = [(c.get('title') or '').strip() for v in data.get('chapterListWithVolume') or [] for c in v]
    t = open(path, encoding='utf-8').read()
    lines = {title_key(l) for l in t.splitlines()}
    miss = [x for x in titles if title_key(x) not in lines]
    r = {'toc_code': d.get('code'), 'toc_chapters': len(titles), 'missing': len(miss), 'missing_sample': miss[:5],
         'pua': sum(1 for c in t if 0xE000 <= ord(c) <= 0xF8FF), 'replacement': t.count('�'),
         'cjk_ratio': round(sum(1 for c in t if 0x4E00 <= ord(c) <= 0x9FFF) / max(len(t), 1), 3)}
    if os.environ.get('FQ_TITLES') == '1':
        r['titles'] = titles
    return r


def emit(r):
    print(json.dumps(r, ensure_ascii=False), flush=True)


# single run under flock: any progress file here was left by a killed run and would block done detection
for p in glob.glob(OUT + '/*.progress.json'):
    os.remove(p)
todo = []
have = book_files()
for bid in IDS:
    if bid in have and not FORCE:
        r = {'book_id': bid, 'status': 'exists', 'file': os.path.basename(have[bid]), 'bytes': os.path.getsize(have[bid])}
        r.update(toc_check(bid, have[bid]))
        emit(r)
    else:
        if bid in have:
            os.replace(have[bid], have[bid] + '.bak')
        todo.append(bid)
if not todo:
    sys.exit(0)

env = dict(os.environ, DISPLAY=':99', TAURI_WEBVIEW_AUTOMATION='true', NO_PROXY='127.0.0.1,localhost', no_proxy='127.0.0.1,localhost')
subprocess.Popen(['Xvfb', ':99', '-screen', '0', '1600x1000x24'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)
subprocess.Popen(['WebKitWebDriver', '--host=127.0.0.1', '--port=4455'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)
S = '/session/' + call('POST', '/session', {'capabilities': {'alwaysMatch': {'webkitgtk:browserOptions': {'binary': '/usr/bin/fanqie-desktop', 'args': []}}}}, t=90)['value']['sessionId']
log('session ok')


def js(s, a=None):
    return call('POST', S + '/execute/sync', {'script': s, 'args': a or []})['value']


def visible(css):
    for e in call('POST', S + '/elements', {'using': 'css selector', 'value': css})['value']:
        if call('GET', S + '/element/%s/displayed' % e[EK])['value']:
            return e[EK]
    return None


def wait_for(fn, sec):
    end = time.time() + sec
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(1)
    return None


def snap(tag):
    try:
        open(OUT + '/.debug-%s.png' % tag, 'wb').write(base64.b64decode(call('GET', S + '/screenshot')['value']))
        return (js('return document.body.innerText') or '')[-600:].replace('\n', ' | ')
    except Exception as e:
        return 'snap failed: %s' % e


def download(bid):
    inp = wait_for(lambda: visible('input.text-input[type=search]'), 60)
    if not inp:
        return {'status': 'error', 'reason': 'no_search_input', 'ui': snap(bid)}
    call('POST', S + '/element/%s/clear' % inp, {})
    call('POST', S + '/element/%s/value' % inp, {'text': bid})
    time.sleep(2)
    btn = visible('button.accent-button')
    if btn:
        call('POST', S + '/element/%s/click' % btn, {})
    ok = wait_for(lambda: js("return (document.body.innerText||'').includes('Book ID ' + arguments[0]) && !!document.querySelector('button.detail-action-download')", [bid]), 90)
    if not ok:
        return {'status': 'error', 'reason': 'detail_not_loaded', 'ui': snap(bid)}
    dl = visible('button.detail-action-download')
    call('POST', S + '/element/%s/click' % dl, {})
    log(bid, 'download clicked')
    start = last_change = time.time()
    last = None
    while time.time() - start < PER_BOOK:
        f = book_files().get(bid)
        prog = glob.glob(OUT + '/*.progress.json')
        if f and not prog:
            s1 = os.path.getsize(f)
            time.sleep(5)
            if os.path.getsize(f) == s1 and not glob.glob(OUT + '/*.progress.json'):
                return {'status': 'done', 'file': os.path.basename(f), 'bytes': s1, 'seconds': int(time.time() - start)}
        n = None
        for p in prog:
            try:
                d = json.load(open(p))
                if str(d.get('book_id')) == bid:
                    n = len(d.get('chapters') or {})
            except Exception:
                pass
        if n is not None and n != last:
            last, last_change = n, time.time()
            log(bid, 'chapters', n)
        if time.time() - last_change > STALL:
            return {'status': 'error', 'reason': 'stalled', 'chapters_at_stall': last, 'ui': snap(bid)}
        time.sleep(5)
    return {'status': 'error', 'reason': 'timeout', 'chapters_at_timeout': last, 'ui': snap(bid)}


failed = False
for bid in todo:
    try:
        r = download(bid)
    except Exception as e:
        r = {'status': 'error', 'reason': 'exception: %s' % str(e)[:200]}
    r['book_id'] = bid
    if r['status'] == 'done':
        try:
            r.update(toc_check(bid, os.path.join(OUT, r['file'])))
            if r['missing'] or r['pua'] or r['replacement']:
                r['status'] = 'incomplete'
        except Exception as e:
            r['toc_error'] = str(e)[:200]
    emit(r)
    if r['status'] != 'done':
        failed = True
    if r['status'] == 'error' and r.get('reason') in ('stalled', 'timeout'):
        for p in glob.glob(OUT + '/*.progress.json'):
            os.rename(p, p + '.failed')
try:
    call('DELETE', S, t=20)
except Exception:
    pass
sys.exit(1 if failed else 0)
