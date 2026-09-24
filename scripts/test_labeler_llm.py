#!/usr/bin/env python3
"""labeler.py LLM 调用层单测（llmchan41 §4：glm-5.3-agent 坏 JSON）。

覆盖：max_tokens 默认值与按模型覆盖（LABELER_MAX_TOKENS）；content 为空时从 reasoning_content
兜底取 JSON；completion_tokens 触顶 / finish_reason=length 报「输出被截断」并直接换模型；
上游空回单独报错；非 2xx 响应体摘要（脱敏、截断）进日志。
全离线：urlopen 被替换，不联网、不调真模型。
复跑：PYTHONIOENCODING=utf-8 python -m unittest discover -s scripts -p 'test_labeler_llm.py'
"""
import contextlib
import io
import json
import os
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labeler  # noqa: E402

LABELS = {'genre': '玄幻', 'title_guess': '斗破苍穹', 'confidence': 0.9}
FAKE_KEY = 'test-key-not-real-0123456789'   # 刻意不带 sk- 前缀：验证按已知秘密原值脱敏


def _sse(*chunks):
    """chunk dict 列表 → SSE 字节行（含结尾 [DONE]）。"""
    lines = [f'data: {json.dumps(c, ensure_ascii=False)}\n'.encode('utf-8') for c in chunks]
    return lines + [b'data: [DONE]\n']


def _delta(content=None, reasoning=None, finish=None):
    delta = {}
    if content is not None:
        delta['content'] = content
    if reasoning is not None:
        delta['reasoning_content'] = reasoning
    return {'choices': [{'delta': delta, 'finish_reason': finish}]}


def _usage(completion_tokens):
    return {'choices': [], 'usage': {'completion_tokens': completion_tokens}}


class FakeResponse:
    def __init__(self, lines):
        self.lines = lines

    def __enter__(self):
        return iter(self.lines)

    def __exit__(self, *exc):
        return False


class FakeLlm:
    """按模型返回预置结果；记录每次请求体（model、max_tokens）。
    results: {model: [SSE 行列表 | Exception, ...]}，按调用顺序取；取完重复最后一个。"""

    def __init__(self, results):
        self.results = {k: list(v) for k, v in results.items()}
        self.requests = []

    def __call__(self, req, timeout=None):
        body = json.loads(req.data.decode('utf-8'))
        self.requests.append((body['model'], body['max_tokens']))
        queue = self.results[body['model']]
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, Exception):
            raise item
        return FakeResponse(item)


def _http_error(code, body: bytes):
    return urllib.error.HTTPError('https://llm.invalid/v1/chat/completions', code,
                                  'Bad Request', {}, io.BytesIO(body))


class LlmCase(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(labeler.time, 'sleep')
        patcher.start()
        self.addCleanup(patcher.stop)

    def label(self, fake, models, max_tokens=None):
        err = io.StringIO()
        with mock.patch.object(labeler.urllib.request, 'urlopen', side_effect=fake), \
                contextlib.redirect_stderr(err):
            try:
                return labeler._label_once('正文', FAKE_KEY, models,
                                           max_tokens=max_tokens), err.getvalue()
            except Exception as e:     # 让用例同时拿到日志
                e.log = err.getvalue()
                raise


class TestResolveMaxTokens(unittest.TestCase):
    def test_default_is_raised_well_above_1800(self):
        cfg = labeler.resolve_max_tokens({})
        self.assertEqual(cfg, {'*': labeler.DEFAULT_MAX_TOKENS})
        self.assertGreaterEqual(labeler.DEFAULT_MAX_TOKENS, 6000)

    def test_default_and_per_model_override(self):
        cfg = labeler.resolve_max_tokens(
            {'LABELER_MAX_TOKENS': '8000, glm-5.3-agent=12000'})
        self.assertEqual(labeler.max_tokens_for('glm-5.3-agent', cfg), 12000)
        self.assertEqual(labeler.max_tokens_for('grok-4.6-wong', cfg), 8000)

    def test_invalid_items_are_ignored(self):
        with contextlib.redirect_stderr(io.StringIO()) as err:
            cfg = labeler.resolve_max_tokens(
                {'LABELER_MAX_TOKENS': 'abc,glm-5.3-agent=0,x=-5,grok=9000'})
        self.assertEqual(cfg, {'*': labeler.DEFAULT_MAX_TOKENS, 'grok': 9000})
        self.assertIn('不是正整数', err.getvalue())

    def test_none_config_uses_default(self):
        self.assertEqual(labeler.max_tokens_for('any', None), labeler.DEFAULT_MAX_TOKENS)


class TestLabelOnce(LlmCase):
    def test_request_uses_per_model_max_tokens(self):
        fake = FakeLlm({'m1': [_sse(_delta(content=json.dumps(LABELS)))]})
        labels, _ = self.label(fake, ['m1'], {'*': 6000, 'm1': 12000})
        self.assertEqual(labels, LABELS)
        self.assertEqual(fake.requests, [('m1', 12000)])

    def test_default_request_no_longer_1800(self):
        fake = FakeLlm({'m1': [_sse(_delta(content=json.dumps(LABELS)))]})
        self.label(fake, ['m1'])
        self.assertEqual(fake.requests, [('m1', labeler.DEFAULT_MAX_TOKENS)])

    def test_fenced_content_still_parses(self):
        fake = FakeLlm({'m1': [_sse(_delta(content='```json\n'), _delta(content=json.dumps(LABELS)),
                                    _delta(content='\n```', finish='stop'))]})
        labels, _ = self.label(fake, ['m1'])
        self.assertEqual(labels, LABELS)

    def test_empty_content_falls_back_to_reasoning_json(self):
        reasoning = '先看题材……判断为玄幻。最终输出：' + json.dumps(LABELS, ensure_ascii=False)
        fake = FakeLlm({'m1': [_sse(_delta(reasoning=reasoning[:20]),
                                    _delta(reasoning=reasoning[20:]),
                                    _delta(content='', finish='stop'))]})
        labels, log = self.label(fake, ['m1'])
        self.assertEqual(labels, LABELS)
        self.assertIn('取自 reasoning_content', log)

    def test_truncated_by_usage_reports_truncation_and_switches_model(self):
        # glm 形态：content 截在 JSON 中途，usage.completion_tokens 恰好等于上限
        cut = json.dumps(LABELS, ensure_ascii=False)[:15]
        fake = FakeLlm({'glm': [_sse(_delta(content=cut), _usage(6000))],
                        'm2': [_sse(_delta(content=json.dumps(LABELS)))]})
        labels, log = self.label(fake, ['glm', 'm2'], {'*': 6000})
        self.assertEqual(labels, LABELS)
        self.assertIn('输出被截断', log)
        self.assertIn('completion_tokens=6000/max_tokens=6000', log)
        self.assertNotIn('Unterminated', log)            # 不再是笼统的 JSON 解析失败
        # 截断不在同模型重试：glm 只请求 1 次就换 m2
        self.assertEqual([m for m, _ in fake.requests], ['glm', 'm2'])

    def test_finish_reason_length_with_reasoning_only(self):
        fake = FakeLlm({'glm': [_sse(_delta(reasoning='思考很长' * 50),
                                     _delta(content='', finish='length'))]})
        with self.assertRaises(RuntimeError) as ctx:
            self.label(fake, ['glm'])
        self.assertIn('输出被截断', ctx.exception.log)
        self.assertIn('思考内容耗尽输出预算', ctx.exception.log)
        self.assertIn('模型链', str(ctx.exception))       # 链耗尽口径不变（P3 分类仍是 LLM链耗尽）
        self.assertEqual(len(fake.requests), 1)

    def test_empty_reply_is_reported_and_switches_model(self):
        fake = FakeLlm({'m1': [_sse(_delta(content='', finish='stop'))],
                        'm2': [_sse(_delta(content=json.dumps(LABELS)))]})
        labels, log = self.label(fake, ['m1', 'm2'])
        self.assertEqual(labels, LABELS)
        self.assertIn('上游空回', log)
        self.assertNotIn('Expecting value', log)
        self.assertEqual([m for m, _ in fake.requests], ['m1', 'm2'])

    def test_non_truncated_bad_json_keeps_retry_semantics(self):
        # 未触顶的坏 JSON 仍按旧口径（原始解析错误 + 同模型重试 MODEL_RETRY 次）
        fake = FakeLlm({'m1': [_sse(_delta(content='{"genre": 玄幻}', finish='stop'))]})
        with self.assertRaises(RuntimeError) as ctx:
            self.label(fake, ['m1'])
        self.assertIn('Expecting value', ctx.exception.log)
        self.assertEqual(len(fake.requests), labeler.MODEL_RETRY)

    def test_http_error_body_summary_logged_redacted_and_truncated(self):
        body = json.dumps({'error': {'message': 'context length exceeded; key ' + FAKE_KEY
                                     + ' via https://upstream.invalid/x Bearer abc.def'
                                     + ' other sk-otherkey123456',
                                     'pad': 'x' * 1000}}).encode('utf-8')
        fake = FakeLlm({'m1': [_http_error(400, body)],
                        'm2': [_sse(_delta(content=json.dumps(LABELS)))]})
        labels, log = self.label(fake, ['m1', 'm2'])
        self.assertEqual(labels, LABELS)
        line = next(x for x in log.splitlines() if 'HTTP Error 400' in x)
        self.assertIn('响应体:', line)
        self.assertIn('context length exceeded', line)
        for leaked in (FAKE_KEY, 'upstream.invalid', 'abc.def', 'otherkey123456'):
            self.assertNotIn(leaked, line)
        summary = line.split('响应体: ', 1)[1]
        self.assertLessEqual(len(summary), labeler.HTTP_BODY_SUMMARY_CHARS)

    def test_http_error_empty_body(self):
        fake = FakeLlm({'m1': [_http_error(530, b'')]})
        with self.assertRaises(RuntimeError) as ctx:
            self.label(fake, ['m1'])
        self.assertIn('HTTP Error 530', ctx.exception.log)
        self.assertIn('响应体: （空）', ctx.exception.log)


class TestLabelsFromReply(unittest.TestCase):
    def test_last_json_object_in_reasoning_wins(self):
        reply = {'content': '', 'reasoning': '草稿 {"genre": "草稿"} 最终 ' + json.dumps(LABELS),
                 'finish_reason': 'stop', 'completion_tokens': 100}
        self.assertEqual(labeler._labels_from_reply(reply, 6000), (LABELS, 'reasoning'))

    def test_complete_json_at_limit_is_accepted(self):
        # 触顶但 JSON 已完整：照收（截断只在拿不到完整 JSON 时才报）
        reply = {'content': json.dumps(LABELS), 'reasoning': '', 'finish_reason': 'length',
                 'completion_tokens': 6000}
        self.assertEqual(labeler._labels_from_reply(reply, 6000), (LABELS, 'content'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
